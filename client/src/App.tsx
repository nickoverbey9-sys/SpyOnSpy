import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bot,
  CheckCircle2,
  CircleOff,
  Clock,
  Gauge,
  LineChart,
  Moon,
  Power,
  Radio,
  ShieldAlert,
  Sun,
  TrendingDown,
  TrendingUp,
  Wallet,
  Waves,
  XCircle,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Scatter,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Switch, Route, Router } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import NotFound from "@/pages/not-found";
import BotCockpit from "@/components/BotCockpit";

type Candle = {
  time: string;
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  ema200?: number;
  macd?: number;
  signal?: number;
  histogram?: number;
  williamsR?: number;
  liquidityIn?: number;
  liquidityOut?: number;
};

type Snapshot = {
  timestamp: string;
  connected: boolean;
  mode: "provider-live" | "live-seeded" | "simulation";
  dataNotice: string;
  provider: {
    name: "Tradier" | "Polygon/Massive" | "Finnhub" | "Public seed" | "Replay";
    status: "connected" | "connecting" | "missing-key" | "fallback" | "error";
    message: string;
    lastProviderUpdate?: string;
    capabilities: string[];
  };
  spy: {
    symbol: "SPY";
    price: number;
    change: number;
    changePercent: number;
    afterHoursPrice: number | null;
    afterHoursChange: number | null;
    afterHoursChangePercent: number | null;
    session: "pre-market" | "regular" | "after-hours" | "closed";
    dailyOpen: number;
    premarketHigh: number;
    premarketLow: number;
    candles: Candle[];
    candles5m: Candle[];
    candles2m: Candle[];
  };
  macro: {
    vix: number;
    vixChange: number;
    us10y: number;
    us10yChange: number;
  };
  sentiment: {
    label: "Bullish" | "Bearish" | "Neutral";
    score: number;
    drivers: string[];
  };
  liquidity: {
    netFlow: number;
    callWall: number;
    putWall: number;
    supportZones: number[];
    resistanceZones: number[];
  };
  setups: Array<{
    title: string;
    bias: "Call" | "Put" | "Wait";
    confidence: number;
    trigger: string;
    invalidation: string;
    rationale: string;
  }>;
  economicCalendar: Array<{
    time: string;
    event: string;
    impact: "High" | "Medium" | "Low";
    status: "Upcoming" | "Released" | "Watched";
  }>;
  breakingNews: Array<{
    id: string;
    title: string;
    source: string;
    url: string | null;
    publishedAt: string | null;
    impact: "Bullish" | "Bearish" | "Neutral" | "Volatility";
    severity: "High" | "Medium" | "Low";
    reason: string;
    tags: string[];
  }>;
  newsUpdatedAt: string | null;
  unusualOptions: Array<{
    symbol: string;
    expiry: string;
    strike: number;
    side: "Call" | "Put";
    last: number;
    bid: number;
    ask: number;
    volume: number;
    openInterest: number;
    volumeOiRatio: number;
    premium: number;
    unusualScore: number;
    flag: string;
  }>;
};

const WS_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function getWsUrl() {
  if (!WS_BASE) {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/ws`;
  }

  const normalized = WS_BASE.replace(/^http/, "ws");
  return `${normalized}/ws`;
}

function currency(value: number) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function compact(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString("en-US");
}

function percent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function premium(value: number) {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return currency(value);
}

// ─── Safe numeric formatting ────────────────────────────────────────────────
// API fields typed as `number` can arrive null/undefined at runtime; calling
// `.toFixed` on those throws and blanks the whole app. These helpers degrade to
// a sensible placeholder instead of crashing the render.

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeFixed(
  value: number | null | undefined,
  digits = 2,
  fallback = "--",
): string {
  return isFiniteNumber(value) ? value.toFixed(digits) : fallback;
}

function safeUsd(
  value: number | null | undefined,
  digits = 2,
  fallback = "$0.00",
): string {
  return isFiniteNumber(value) ? `$${value.toFixed(digits)}` : fallback;
}

// Fraction (0–1) rendered as a whole-number percentage, e.g. 0.2 → "20".
function safeFractionPct(
  value: number | null | undefined,
  digits = 0,
  fallback = "0",
): string {
  return isFiniteNumber(value) ? (value * 100).toFixed(digits) : fallback;
}

function timeAgo(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Toggle theme"
      data-testid="button-theme-toggle"
      onClick={() => setDark((current) => !current)}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-3" data-testid="logo-app">
      <svg
        aria-label="Zero Delta dashboard logo"
        className="h-9 w-9 text-primary"
        fill="none"
        viewBox="0 0 42 42"
      >
        <rect
          x="4"
          y="4"
          width="34"
          height="34"
          rx="8"
          stroke="currentColor"
          strokeWidth="2.2"
        />
        <path
          d="M12 26.5L18.1 15.5L23.7 26.5L30.5 15.5"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.8"
        />
        <path
          d="M12 31H30"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="2.2"
        />
      </svg>
      <div>
        <p className="font-semibold leading-tight">Zero Delta</p>
        <p className="text-xs text-muted-foreground">SPY 0DTE cockpit</p>
      </div>
    </div>
  );
}

function useLiveSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [socketState, setSocketState] = useState<"connecting" | "live" | "offline">(
    "connecting",
  );

  const initial = useQuery<Snapshot>({
    queryKey: ["/api/snapshot"],
  });

  useEffect(() => {
    if (initial.data) setSnapshot(initial.data);
  }, [initial.data]);

  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let retry: number | undefined;

    function connect() {
      setSocketState("connecting");
      ws = new WebSocket(getWsUrl());

      ws.onopen = () => {
        if (active) setSocketState("live");
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "snapshot") {
            setSnapshot(message.payload);
          }
        } catch {
          setSocketState("offline");
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setSocketState("offline");
        retry = window.setTimeout(connect, 2_000);
      };

      ws.onerror = () => {
        if (active) setSocketState("offline");
      };
    }

    connect();

    return () => {
      active = false;
      if (retry) window.clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return {
    snapshot,
    isLoading: initial.isLoading && !snapshot,
    socketState,
  };
}

function StatCard({
  label,
  value,
  delta,
  icon,
  intent = "neutral",
  direction,
  testId,
}: {
  label: string;
  value: string;
  delta?: string;
  icon: React.ReactNode;
  intent?: "positive" | "negative" | "neutral";
  direction?: "up" | "down" | "flat";
  testId: string;
}) {
  const intentClass =
    intent === "positive"
      ? "text-emerald-400"
      : intent === "negative"
        ? "text-rose-400"
        : "text-muted-foreground";

  return (
    <Card className="border-card-border bg-card/88" data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              {label}
            </p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
              {value}
            </p>
          </div>
          <div className="rounded-md bg-secondary p-2 text-muted-foreground">{icon}</div>
        </div>
        {delta && (
          <p className={`mt-3 flex items-center gap-1 text-sm ${intentClass}`}>
            {direction === "up" ? (
              <ArrowUpRight className="h-4 w-4" />
            ) : direction === "down" ? (
              <ArrowDownRight className="h-4 w-4" />
            ) : (
              <Activity className="h-4 w-4" />
            )}
            <span>{delta}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SetupBadge({ bias }: { bias: "Call" | "Put" | "Wait" }) {
  if (bias === "Call") {
    return <Badge className="bg-emerald-500/15 text-emerald-300">Call bias</Badge>;
  }
  if (bias === "Put") {
    return <Badge className="bg-rose-500/15 text-rose-300">Put bias</Badge>;
  }
  return <Badge variant="secondary">Wait</Badge>;
}

function ProviderBadge({ snapshot }: { snapshot: Snapshot }) {
  const status = snapshot.provider.status;
  const className =
    status === "connected"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "connecting"
        ? "bg-sky-500/15 text-sky-300"
        : status === "error"
          ? "bg-rose-500/15 text-rose-300"
          : "bg-amber-500/15 text-amber-300";

  return (
    <Badge className={className} data-testid="status-provider">
      {snapshot.provider.name} · {status}
    </Badge>
  );
}

function ProviderPanel({ snapshot }: { snapshot: Snapshot }) {
  const hasKey = snapshot.provider.status !== "missing-key";

  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-provider">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          Data feed
          <ProviderBadge snapshot={snapshot} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground" data-testid="text-provider-message">
          {snapshot.provider.message}
        </p>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {snapshot.provider.capabilities.map((capability) => (
            <div className="rounded bg-secondary/55 px-2 py-1" key={capability}>
              {capability}
            </div>
          ))}
        </div>
        {!hasKey && (
          <div className="rounded-md border border-amber-600/35 bg-amber-100 p-3 text-xs leading-relaxed text-amber-950 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-100">
            Add one server variable, then restart: TRADIER_TOKEN, POLYGON_API_KEY,
            MASSIVE_API_KEY, or FINNHUB_API_KEY.
          </div>
        )}
        {snapshot.provider.lastProviderUpdate && (
          <p className="font-mono text-xs text-muted-foreground">
            Provider tick {timeAgo(snapshot.provider.lastProviderUpdate)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SentimentPanel({ snapshot }: { snapshot: Snapshot }) {
  const score = snapshot.sentiment.score;
  const meter = ((score + 100) / 200) * 100;
  const bullish = snapshot.sentiment.label === "Bullish";
  const bearish = snapshot.sentiment.label === "Bearish";

  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-sentiment">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          Market sentiment
          <Badge
            className={
              bullish
                ? "bg-emerald-500/15 text-emerald-300"
                : bearish
                  ? "bg-rose-500/15 text-rose-300"
                  : "bg-amber-500/15 text-amber-300"
            }
            data-testid="status-sentiment-label"
          >
            {snapshot.sentiment.label}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-2 flex justify-between font-mono text-sm tabular-nums">
            <span>-100</span>
            <span>+100</span>
          </div>
          <div className="relative h-2 rounded-full bg-secondary">
            <div
              className={`h-2 rounded-full ${
                bullish ? "bg-emerald-400" : bearish ? "bg-rose-400" : "bg-amber-400"
              }`}
              style={{ width: `${meter}%` }}
            />
          </div>
          <p
            className="mt-2 text-center font-mono text-xs text-muted-foreground"
            data-testid="text-sentiment-score"
          >
            Score {score}
          </p>
        </div>
        <ul className="space-y-2 text-sm text-muted-foreground">
          {snapshot.sentiment.drivers.map((driver) => (
            <li className="flex gap-2" key={driver}>
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>{driver}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CandlestickShape(props: any) {
  const { x, y, width, height, payload } = props;
  if (!payload || typeof x !== "number" || typeof width !== "number") {
    return null;
  }
  const { open, close, high, low } = payload as {
    open: number;
    close: number;
    high: number;
    low: number;
  };
  if (high === low) return null;

  const wickX = x + width / 2;
  const isUp = close >= open;
  const fill = isUp ? "#34d399" : "#fb7185";
  const stroke = isUp ? "#10b981" : "#f43f5e";
  const range = high - low;
  const pxPerUnit = range > 0 ? height / range : 0;
  const bodyTop = y + (high - Math.max(open, close)) * pxPerUnit;
  const bodyBottom = y + (high - Math.min(open, close)) * pxPerUnit;
  const bodyHeight = Math.max(1, bodyBottom - bodyTop);
  const bodyWidth = Math.max(2, width * 0.62);
  const bodyX = x + (width - bodyWidth) / 2;

  return (
    <g>
      <line
        stroke={stroke}
        strokeWidth={1}
        x1={wickX}
        x2={wickX}
        y1={y}
        y2={y + height}
      />
      <rect
        fill={fill}
        fillOpacity={isUp ? 0.85 : 0.85}
        height={bodyHeight}
        rx={1}
        ry={1}
        stroke={stroke}
        strokeWidth={1}
        width={bodyWidth}
        x={bodyX}
        y={bodyTop}
      />
    </g>
  );
}

function PriceChart({ snapshot }: { snapshot: Snapshot }) {
  const candles5m = snapshot.spy.candles5m ?? [];

  // Compute liquidity flow separately BEFORE stripping fields from chart data.
  // This keeps netFlow/liquidityIn/Out out of the ComposedChart data array
  // so Recharts YAxis domain computation cannot pick up volume-scale numbers.
  const flowData = useMemo(
    () =>
      candles5m.slice(-48).map((candle) => ({
        label: candle.label,
        time: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        vwap: candle.vwap,
        ema200: candle.ema200,
        macd: candle.macd,
        signal: candle.signal,
        histogram: candle.histogram,
        williamsR: candle.williamsR,
        liquidityIn: candle.liquidityIn,
        liquidityOut: candle.liquidityOut,
        netFlow: (candle.liquidityIn ?? 0) - (candle.liquidityOut ?? 0),
      })),
    [candles5m],
  );

  // Price-only data for the candlestick chart.
  // Explicitly omit liquidityIn, liquidityOut, netFlow, and any other non-price numeric
  // fields so Recharts YAxis domain='dataMin'/'dataMax' stays in price territory.
  const data = useMemo(
    () =>
      flowData.map(({ label, time, open, high, low, close, volume, vwap, ema200, macd, signal, histogram, williamsR }) => ({
        label,
        time,
        open,
        high,
        low,
        close,
        volume,
        vwap,
        ema200,
        macd,
        signal,
        histogram,
        williamsR,
        range: [low, high] as [number, number],
      })),
    [flowData],
  );

  // Compute explicit price-domain YAxis bounds from open/high/low/close only.
  // Never use 'dataMin'/'dataMax' on the full data object (would pick up indicator numbers).
  const yDomain = useMemo((): [number, number] => {
    if (!data.length) return [0, 1000];
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const c of data) {
      if (typeof c.low === "number" && Number.isFinite(c.low)) yMin = Math.min(yMin, c.low);
      if (typeof c.high === "number" && Number.isFinite(c.high)) yMax = Math.max(yMax, c.high);
      if (typeof c.open === "number" && Number.isFinite(c.open)) {
        yMin = Math.min(yMin, c.open);
        yMax = Math.max(yMax, c.open);
      }
      if (typeof c.close === "number" && Number.isFinite(c.close)) {
        yMin = Math.min(yMin, c.close);
        yMax = Math.max(yMax, c.close);
      }
      if (typeof c.vwap === "number" && Number.isFinite(c.vwap)) {
        yMin = Math.min(yMin, c.vwap);
        yMax = Math.max(yMax, c.vwap);
      }
      if (typeof c.ema200 === "number" && Number.isFinite(c.ema200)) {
        yMin = Math.min(yMin, c.ema200);
        yMax = Math.max(yMax, c.ema200);
      }
    }
    // Guard: if values are still clearly wrong (outside 1-10000 SPY price range), fall back.
    if (!Number.isFinite(yMin) || yMin < 1) yMin = snapshot.spy.price - 5;
    if (!Number.isFinite(yMax) || yMax > 10000) yMax = snapshot.spy.price + 5;
    return [Math.floor(yMin - 1), Math.ceil(yMax + 1)];
  }, [data, snapshot.spy.price]);

  const buyerCandle = flowData.length
    ? flowData.reduce(
        (best, candle) => (candle.netFlow > best.netFlow ? candle : best),
        flowData[0],
      )
    : null;
  const sellerCandle = flowData.length
    ? flowData.reduce(
        (best, candle) => (candle.netFlow < best.netFlow ? candle : best),
        flowData[0],
      )
    : null;

  const flowMarkers = [
    buyerCandle && {
      label: buyerCandle.label,
      // Use price-domain close/low values for chart positioning.
      close: buyerCandle.low,
      kind: "buyers" as const,
      flow: buyerCandle.netFlow,
      price: buyerCandle.close,
    },
    sellerCandle && {
      label: sellerCandle.label,
      close: sellerCandle.high,
      kind: "sellers" as const,
      flow: sellerCandle.netFlow,
      price: sellerCandle.close,
    },
  ].filter(Boolean) as Array<{
    label: string;
    close: number;
    kind: "buyers" | "sellers";
    flow: number;
    price: number;
  }>;

  return (
    <Card className="border-card-border bg-card/88" data-testid="chart-spy">
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <LineChart className="h-4 w-4 text-primary" />
            SPY price map · 5m candles
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            5m OHLC, VWAP, MACD, Williams %R, 200 EMA, daily open, premarket range, last price
          </p>
        </div>
        <div className="text-right font-mono tabular-nums">
          <p className="text-2xl font-semibold" data-testid="text-spy-price">
            {currency(snapshot.spy.price)}
          </p>
          <p
            className={
              snapshot.spy.change >= 0 ? "text-sm text-emerald-400" : "text-sm text-rose-400"
            }
          >
            {snapshot.spy.change >= 0 ? "+" : ""}
            {snapshot.spy.change.toFixed(2)} / {percent(snapshot.spy.changePercent)}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                minTickGap={32}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 12 }}
              />
              <YAxis
                domain={yDomain}
                orientation="right"
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--popover-border))",
                  borderRadius: 8,
                  color: "hsl(var(--popover-foreground))",
                }}
                formatter={(value: any, name: string) => {
                  if (Array.isArray(value)) {
                    const [low, high] = value as [number, number];
                    return [`${low.toFixed(2)} – ${high.toFixed(2)}`, "RANGE"];
                  }
                  return [
                    typeof value === "number" ? value.toFixed(2) : value,
                    name.toUpperCase(),
                  ];
                }}
                labelFormatter={(label: string, payload: any) => {
                  const candle = payload?.[0]?.payload;
                  if (!candle) return label;
                  return `${label} · O ${candle.open?.toFixed(2)} · H ${candle.high?.toFixed(2)} · L ${candle.low?.toFixed(2)} · C ${candle.close?.toFixed(2)}`;
                }}
              />
              <ReferenceLine
                y={snapshot.spy.dailyOpen}
                stroke="#f59e0b"
                strokeDasharray="5 5"
              />
              <ReferenceLine
                y={snapshot.spy.premarketHigh}
                stroke="#38bdf8"
                strokeDasharray="4 4"
              />
              <ReferenceLine
                y={snapshot.spy.premarketLow}
                stroke="#a78bfa"
                strokeDasharray="4 4"
              />
              <ReferenceLine
                y={snapshot.spy.price}
                stroke="#34d399"
                strokeDasharray="2 2"
              />
              <Bar
                dataKey="range"
                isAnimationActive={false}
                name="ohlc"
                shape={<CandlestickShape />}
              />
              <Line
                dataKey="vwap"
                dot={false}
                isAnimationActive={false}
                name="vwap"
                stroke="#f59e0b"
                strokeWidth={2}
                type="monotone"
              />
              <Line
                dataKey="ema200"
                dot={false}
                isAnimationActive={false}
                name="200 ema"
                stroke="#e879f9"
                strokeWidth={1.8}
                type="monotone"
              />
              <Scatter
                data={flowMarkers}
                dataKey="close"
                name="Buyer / seller step-in"
                shape={(props: any) => {
                  const isBuyer = props.payload.kind === "buyers";
                  return (
                    <g>
                      <circle
                        cx={props.cx}
                        cy={props.cy}
                        fill={isBuyer ? "#34d399" : "#fb7185"}
                        r={7}
                        stroke="hsl(var(--background))"
                        strokeWidth={2}
                      />
                      <text
                        fill={isBuyer ? "#34d399" : "#fb7185"}
                        fontSize="11"
                        fontWeight="700"
                        textAnchor="middle"
                        x={props.cx}
                        y={props.cy + (isBuyer ? 22 : -14)}
                      >
                        {isBuyer ? "Buyers" : "Sellers"}
                      </text>
                    </g>
                  );
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <IndicatorChart data={data} type="macd" />
          <IndicatorChart data={data} type="williams" />
        </div>
        <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-5 rounded bg-amber-400" />
            <span>Daily open {currency(snapshot.spy.dailyOpen)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-5 rounded bg-sky-400" />
            <span>Premarket high {currency(snapshot.spy.premarketHigh)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-5 rounded bg-violet-400" />
            <span>Premarket low {currency(snapshot.spy.premarketLow)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-5 rounded bg-emerald-400" />
            <span>Last {currency(snapshot.spy.price)}</span>
          </div>
        </div>
        <div className="grid gap-3 text-sm md:grid-cols-2">
          {flowMarkers.map((marker) => (
            <div
              className="rounded-md bg-secondary/45 p-3"
              data-testid={`card-flow-marker-${marker.kind}`}
              key={marker.kind}
            >
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                {marker.kind === "buyers" ? "Most buyers stepped in" : "Most sellers stepped in"}
              </p>
              <p className="mt-2 font-mono text-lg font-semibold">
                {currency(marker.price)} · {marker.label}
              </p>
              <p
                className={`mt-1 font-mono text-sm ${
                  marker.kind === "buyers" ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {marker.flow >= 0 ? "+" : ""}
                {compact(marker.flow)} net flow
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function IndicatorChart({ data, type }: { data: Candle[]; type: "macd" | "williams" }) {
  const isMacd = type === "macd";

  return (
    <div className="rounded-md bg-secondary/45 p-3" data-testid={`chart-${type}`}>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium">{isMacd ? "MACD" : "Williams %R"}</p>
        <p className="font-mono text-xs text-muted-foreground">
          {isMacd ? "Histogram + signal" : "14-period pressure"}
        </p>
      </div>
      <div className="h-[150px]">
        <ResponsiveContainer width="100%" height="100%">
          {isMacd ? (
            <ComposedChart data={data} margin={{ top: 4, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" hide />
              <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--popover-border))",
                  borderRadius: 8,
                }}
              />
              <Bar dataKey="histogram" name="histogram">
                {data.map((entry) => (
                  <Cell
                    fill={(entry.histogram ?? 0) >= 0 ? "#34d399" : "#fb7185"}
                    key={entry.time}
                  />
                ))}
              </Bar>
              <Line dataKey="macd" dot={false} stroke="#38bdf8" strokeWidth={1.8} />
              <Line dataKey="signal" dot={false} stroke="#f59e0b" strokeWidth={1.5} />
            </ComposedChart>
          ) : (
            <AreaChart data={data} margin={{ top: 4, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" hide />
              <YAxis
                domain={[-100, 0]}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--popover-border))",
                  borderRadius: 8,
                }}
              />
              <ReferenceLine y={-20} stroke="#f59e0b" strokeDasharray="3 3" />
              <ReferenceLine y={-80} stroke="#fb7185" strokeDasharray="3 3" />
              <Area
                dataKey="williamsR"
                fill="rgba(56, 189, 248, 0.14)"
                stroke="#38bdf8"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function LiquidityChart({ snapshot }: { snapshot: Snapshot }) {
  const data = useMemo(
    () =>
      snapshot.spy.candles.slice(-42).map((candle) => ({
        ...candle,
        net: (candle.liquidityIn ?? 0) - (candle.liquidityOut ?? 0),
      })),
    [snapshot],
  );

  return (
    <Card className="border-card-border bg-card/88" data-testid="tab-liquidity-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Waves className="h-4 w-4 text-primary" />
          Liquidity in / out
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Directional volume proxy with inferred strike magnets and shelves
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md bg-secondary/45 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Net flow</p>
            <p
              className={`mt-2 font-mono text-2xl font-semibold ${
                snapshot.liquidity.netFlow >= 0 ? "text-emerald-300" : "text-rose-300"
              }`}
              data-testid="text-net-flow"
            >
              {compact(snapshot.liquidity.netFlow)}
            </p>
          </div>
          <div className="rounded-md bg-secondary/45 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Call wall</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-sky-300">
              {snapshot.liquidity.callWall.toFixed(1)}
            </p>
          </div>
          <div className="rounded-md bg-secondary/45 p-4">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Put wall</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-violet-300">
              {snapshot.liquidity.putWall.toFixed(1)}
            </p>
          </div>
        </div>
        <div className="h-[340px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                minTickGap={30}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 12 }}
              />
              <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 12 }} />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--popover-border))",
                  borderRadius: 8,
                }}
                formatter={(value: number) => compact(value)}
              />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
              <Bar dataKey="net" name="liquidity flow">
                {data.map((entry) => (
                  <Cell fill={entry.net >= 0 ? "#34d399" : "#fb7185"} key={entry.time} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <ZoneList title="Support shelves" zones={snapshot.liquidity.supportZones} />
          <ZoneList title="Resistance shelves" zones={snapshot.liquidity.resistanceZones} />
        </div>
      </CardContent>
    </Card>
  );
}

function ZoneList({ title, zones }: { title: string; zones: number[] }) {
  return (
    <div className="rounded-md bg-secondary/45 p-4">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {zones.map((zone) => (
          <Badge className="font-mono" key={zone} variant="outline">
            {zone.toFixed(1)}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function Setups({ snapshot }: { snapshot: Snapshot }) {
  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-setups">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-primary" />
          Real-time 0DTE setup analysis · 2m
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Education-only triggers built from 2m close, VWAP, MACD, 200 EMA, and liquidity
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {snapshot.setups.map((setup, index) => (
          <article
            className="rounded-md bg-secondary/45 p-4"
            data-testid={`card-setup-${index}`}
            key={setup.title}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{setup.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{setup.rationale}</p>
              </div>
              <div className="flex items-center gap-2">
                <SetupBadge bias={setup.bias} />
                <Badge variant="outline" className="font-mono">
                  {setup.confidence}%
                </Badge>
              </div>
            </div>
            <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Trigger</dt>
                <dd className="mt-1">{setup.trigger}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Invalidation</dt>
                <dd className="mt-1">{setup.invalidation}</dd>
              </div>
            </dl>
          </article>
        ))}
      </CardContent>
    </Card>
  );
}

function NewsImpactBadge({
  impact,
}: {
  impact: "Bullish" | "Bearish" | "Neutral" | "Volatility";
}) {
  const className =
    impact === "Bullish"
      ? "bg-emerald-500/15 text-emerald-300"
      : impact === "Bearish"
        ? "bg-rose-500/15 text-rose-300"
        : impact === "Volatility"
          ? "bg-amber-500/15 text-amber-300"
          : "bg-secondary text-secondary-foreground";
  return <Badge className={className}>{impact}</Badge>;
}

function NewsSeverityBadge({ severity }: { severity: "High" | "Medium" | "Low" }) {
  const className =
    severity === "High"
      ? "bg-rose-500/15 text-rose-300"
      : severity === "Medium"
        ? "bg-amber-500/15 text-amber-300"
        : "bg-secondary text-secondary-foreground";
  return (
    <Badge className={className} variant="outline">
      {severity}
    </Badge>
  );
}

function BreakingNews({ snapshot }: { snapshot: Snapshot }) {
  const [filter, setFilter] = useState<"all" | "high" | "bullish" | "bearish" | "volatility">(
    "all",
  );
  const news = snapshot.breakingNews ?? [];

  const filtered = useMemo(() => {
    if (filter === "all") return news;
    if (filter === "high") return news.filter((item) => item.severity === "High");
    if (filter === "bullish") return news.filter((item) => item.impact === "Bullish");
    if (filter === "bearish") return news.filter((item) => item.impact === "Bearish");
    return news.filter((item) => item.impact === "Volatility");
  }, [news, filter]);

  const updated = snapshot.newsUpdatedAt;
  const filters: Array<{ value: typeof filter; label: string }> = [
    { value: "all", label: `All (${news.length})` },
    { value: "high", label: "High impact" },
    { value: "bullish", label: "Bullish" },
    { value: "bearish", label: "Bearish" },
    { value: "volatility", label: "Volatility" },
  ];

  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-breaking-news">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-primary" />
            Breaking news · SPY impact
          </span>
          <span
            className="font-mono text-xs text-muted-foreground"
            data-testid="text-news-updated"
          >
            {updated ? `Updated ${timeAgo(updated)}` : "Awaiting first refresh..."}
          </span>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Real-time RSS sweep of Fed, macro, indices, mega-cap, banking, geopolitics, and risk
          headlines that move SPY. Refreshed every 90s.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" data-testid="news-filters">
          {filters.map((option) => {
            const active = filter === option.value;
            return (
              <Button
                className={
                  active
                    ? "h-8 rounded-full border border-primary/40 bg-primary/15 px-3 text-xs text-primary"
                    : "h-8 rounded-full border border-card-border bg-secondary/45 px-3 text-xs text-muted-foreground"
                }
                data-testid={`button-news-filter-${option.value}`}
                key={option.value}
                onClick={() => setFilter(option.value)}
                type="button"
                variant="ghost"
              >
                {option.label}
              </Button>
            );
          })}
        </div>
        {news.length === 0 && (
          <div className="rounded-md border border-card-border bg-secondary/30 p-4 text-sm text-muted-foreground">
            No SPY-impacting headlines yet. The server retries upstream RSS feeds every 90
            seconds; this panel will populate as soon as a relevant story lands.
          </div>
        )}
        {news.length > 0 && filtered.length === 0 && (
          <div className="rounded-md border border-card-border bg-secondary/30 p-4 text-sm text-muted-foreground">
            No headlines match this filter right now. Switch back to "All" to see the full feed.
          </div>
        )}
        <ul className="space-y-3">
          {filtered.map((item) => (
            <li
              className="rounded-md bg-secondary/45 p-3"
              data-testid={`row-news-${item.id}`}
              key={item.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {item.url ? (
                    <a
                      className="font-medium leading-snug hover:underline"
                      href={item.url}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      {item.title}
                    </a>
                  ) : (
                    <p className="font-medium leading-snug">{item.title}</p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.source}
                    {item.publishedAt ? ` · ${timeAgo(item.publishedAt)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <NewsImpactBadge impact={item.impact} />
                  <NewsSeverityBadge severity={item.severity} />
                </div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{item.reason}</p>
              {item.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.tags.map((tag) => (
                    <Badge
                      className="bg-sky-500/10 font-mono text-xs text-sky-200"
                      key={`${item.id}-${tag}`}
                      variant="outline"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function UnusualOptions({ snapshot }: { snapshot: Snapshot }) {
  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-unusual-options">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Unusual SPY options contracts
          </span>
          <Badge variant="outline">{snapshot.unusualOptions.length} flagged</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Flags elevated volume, premium, and volume-to-open-interest activity near SPY.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="py-3 text-left font-medium">Contract</th>
                <th className="py-3 text-left font-medium">Side</th>
                <th className="py-3 text-right font-medium">Last</th>
                <th className="py-3 text-right font-medium">Bid / Ask</th>
                <th className="py-3 text-right font-medium">Volume</th>
                <th className="py-3 text-right font-medium">OI</th>
                <th className="py-3 text-right font-medium">Vol/OI</th>
                <th className="py-3 text-right font-medium">Premium</th>
                <th className="py-3 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.unusualOptions.map((option) => (
                <tr
                  className="border-b border-border/60 last:border-0"
                  data-testid={`row-option-${option.symbol}`}
                  key={`${option.symbol}-${option.strike}-${option.side}`}
                >
                  <td className="py-3 pr-4">
                    <p className="font-mono font-medium">{option.symbol}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {option.expiry} · {option.strike.toFixed(0)} strike · {option.flag}
                    </p>
                  </td>
                  <td className="py-3">
                    <Badge
                      className={
                        option.side === "Call"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-rose-500/15 text-rose-300"
                      }
                    >
                      {option.side}
                    </Badge>
                  </td>
                  <td className="py-3 text-right font-mono">{option.last.toFixed(2)}</td>
                  <td className="py-3 text-right font-mono">
                    {option.bid.toFixed(2)} / {option.ask.toFixed(2)}
                  </td>
                  <td className="py-3 text-right font-mono">{compact(option.volume)}</td>
                  <td className="py-3 text-right font-mono">{compact(option.openInterest)}</td>
                  <td className="py-3 text-right font-mono">{option.volumeOiRatio.toFixed(2)}x</td>
                  <td className="py-3 text-right font-mono">{premium(option.premium)}</td>
                  <td className="py-3 text-right">
                    <Badge className="bg-sky-500/15 font-mono text-sky-300">
                      {option.unusualScore}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Sidebar({
  snapshot,
  socketState,
}: {
  snapshot: Snapshot;
  socketState: "connecting" | "live" | "offline";
}) {
  return (
    <aside className="hidden border-r border-sidebar-border bg-sidebar p-4 lg:block">
      <Logo />
      <div className="mt-8 space-y-2 text-sm">
        <a className="flex items-center gap-2 rounded-md bg-sidebar-accent px-3 py-2" href="#/">
          <BarChart3 className="h-4 w-4" />
          Dashboard
        </a>
        <a className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground" href="#/">
          <Waves className="h-4 w-4" />
          Liquidity
        </a>
        <a className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground" href="#/">
          <Radio className="h-4 w-4" />
          Breaking news
        </a>
        <a className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground" href="#/">
          <ShieldAlert className="h-4 w-4" />
          Options
        </a>
      </div>
      <div className="mt-8 rounded-md bg-card p-4 text-sm">
        <div className="mb-3 flex items-center gap-2">
          <Radio
            className={`h-4 w-4 ${
              socketState === "live" ? "text-emerald-400" : "text-amber-400"
            }`}
          />
          <span className="font-medium" data-testid="status-stream">
            {socketState === "live" ? "Stream live" : socketState}
          </span>
        </div>
        <p className="text-muted-foreground">
          Updated <span data-testid="text-updated-ago">{timeAgo(snapshot.timestamp)}</span>
        </p>
        <div className="mt-3">
          <ProviderBadge snapshot={snapshot} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{snapshot.provider.message}</p>
      </div>
    </aside>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md rounded-md border border-card-border bg-card p-6">
        <div className="mb-4 h-5 w-40 animate-pulse rounded bg-secondary" />
        <div className="space-y-3">
          <div className="h-3 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-secondary" />
        </div>
      </div>
    </div>
  );
}

// ─── Bot types ───────────────────────────────────────────────────────────────

type BotMode = "LIVE" | "PAPER";

type LiveCheck = { label: string; ok: boolean; detail: string };

type BotStatus = {
  mode: BotMode;
  liveEnabled: boolean;
  autoTradeEnabled: boolean;
  killSwitchActive: boolean;
  liveReadiness: {
    liveEnabled: boolean;
    checks: LiveCheck[];
    blockingCount: number;
  };
  autoTradeReadiness: {
    autoReady: boolean;
    checks: LiveCheck[];
    blockingCount: number;
  };
  entryGuards: {
    allowed: boolean;
    reason: string;
    nearHighImpactNews: boolean;
    timeGuard?: {
      enabled: boolean;
      openBlackoutMin: number;
      closeBlackoutMin: number;
      blocked: boolean;
      reason: string;
    };
  };
  flattenExit?: {
    pastFlatten: boolean;
    flattenCT: string;
  };
  riskLimits: {
    maxContractsPerTrade: number;
    preferredContractsPerTrade: number;
    minContractsPerTrade: number;
    maxOpenPositions: number;
    maxTradesPerDay: number;
    maxDailyLoss: number;
    stopLossFraction: number;
  };
  smallAccountProfile?: {
    accountStartBalance: number;
    maxLossPerTrade: number;
    trailStartFraction: number;
    trailGivebackFraction: number;
    breakevenArmFraction?: number;
    profitLockArmFraction?: number;
    profitLockProfitFraction?: number;
    minOptionPremium?: number;
    maxSpreadPct?: number;
    note: string;
  };
  daily: {
    date: string;
    tradesOpened: number;
    netRealizedPnlToday: number;
    dailyLossUsed: number;
    dailyLossRemaining: number;
    grossLosingTradesToday: number;
    dailyLossSource: "broker-day-pnl" | "local-net-realized";
    maxDailyLoss: number;
  };
  openPositions: number;
  tradierBaseUrl: string;
  warnings: string[];
};

type ContractCandidate = {
  symbol: string;
  expiry: string;
  strike: number;
  side: "Call" | "Put";
  last: number;
  bid: number;
  ask: number;
  unusualScore: number;
  selectionReason: string;
  moneyness: "OTM" | "ATM" | "ITM";
  otmStrikes: number;
  strikeDistance: number;
  selectionRule: string;
};

type BotSignal = {
  id: string;
  generatedAt: string;
  status: "ACTIONABLE" | "REQUIRES_REVIEW" | "BLOCKED" | "NO_SETUP";
  bias: "Call" | "Put" | null;
  confidence: number;
  setup: {
    title: string;
    trigger: string;
    invalidation: string;
    rationale: string;
  } | null;
  contract: ContractCandidate | null;
  isZeroDte: boolean;
  contractExpiry: string | null;
  blockReason: string | null;
  reviewReason: string | null;
  triggerText: string;
  invalidationText: string;
  suggestedEntryPremium: number | null;
  impliedStopPremium: number | null;
  impliedTrailArmPremium: number | null;
  corroborating: unknown[];
  mtf: MtfAnalysis | null;
  disclaimer: string;
  sizing?: {
    contracts: number;
    allowed: boolean;
    projectedStopLoss: number;
    cost: number;
    preferred: number;
    minimum: number;
    fellBackFromPreferred: boolean;
    reason: string;
  } | null;
};

type Trend = "bullish" | "bearish" | "neutral";

type TimeframeTrend = {
  timeframe: "30m" | "15m" | "5m" | "1m";
  trend: Trend;
  score: number;
  close: number;
  vwap: number | null;
  ema200: number | null;
  histogram: number | null;
  drivers: string[];
};

type SrLevel = {
  price: number;
  type: "support" | "resistance";
  source: string;
  timeframe: "30m" | "15m" | "daily" | "premarket";
  strength: number;
};

type MtfAnalysis = {
  direction: "Call" | "Put";
  higherTimeframeTrend: {
    trend30m: TimeframeTrend;
    trend15m: TimeframeTrend;
    trend5m: TimeframeTrend;
    alignment: "aligned" | "neutral" | "contradicts";
    alignmentReason: string;
  };
  supportResistance: SrLevel[];
  nearestSupport: SrLevel | null;
  nearestResistance: SrLevel | null;
  entryTimeframe: {
    setup5m: { confirmed: boolean; kind: string; detail: string };
    trigger1m: { triggered: boolean; detail: string; invalidationPrice: number | null };
  };
  entryPlan: {
    trigger: string;
    invalidation: string;
    target: number | null;
    runnerTarget: number | null;
  };
  gate: "allow" | "downgrade" | "block";
  gateReason: string;
  confidenceDelta: number;
};

// ─── Bot hooks ────────────────────────────────────────────────────────────────

function useBotStatus() {
  return useQuery<BotStatus>({
    queryKey: ["/api/bot/status"],
    refetchInterval: 5_000,
  });
}

function useBotSignals() {
  return useQuery<{ signals: BotSignal[]; mode: BotMode; disclaimer: string }>({
    queryKey: ["/api/bot/signals"],
    refetchInterval: 8_000,
  });
}

type AutomationEvent = {
  at: string;
  kind: "tick" | "entry" | "exit" | "skip" | "block" | "error" | "lifecycle";
  message: string;
  mode: "LIVE" | "PAPER";
};

type AutomationStatus = {
  enabled: boolean;
  running: boolean;
  observeOnly: boolean;
  lastTick: string | null;
  lastEntryTick: string | null;
  lastExitTick: string | null;
  nextTickApprox: string | null;
  lastAction: string | null;
  blockers: string[];
  exitManagement: "live-quotes" | "degraded";
  managedPositions: Array<{
    id: string;
    symbol: string;
    side: "Call" | "Put";
    contracts: number;
    entryPremium: number;
    stopPrice: number;
    trailStartPrice: number;
    trailArmed: boolean;
    peakPremium: number;
    lastMark: number | null;
    adoptedFromBroker: boolean;
    trailExitPrice: number | null;
    trailGivebackFraction: number;
  }>;
  adoptedSymbols: string[];
  pendingBrokerPositions: string[];
  reviewBrokerPositions: Array<{
    symbol: string;
    disposition: "adopt" | "skip" | "review";
    reason: string;
  }>;
  brokerReconcileWarning: string | null;
  recentEvents: AutomationEvent[];
  intervals: { entryMs: number; exitMs: number };
  autoTradeReadiness: { autoReady: boolean; checks: LiveCheck[]; blockingCount: number };
  note: string;
};

function useAutomationStatus() {
  return useQuery<AutomationStatus>({
    queryKey: ["/api/bot/automation/status"],
    refetchInterval: 5_000,
  });
}

type AccountSnapshot = {
  available: boolean;
  source: "live-api" | "unavailable";
  reason: string | null;
  accountNumber: string | null;
  accountType: string | null;
  totalEquity: number | null;
  cash: number | null;
  buyingPower: number | null;
  optionBuyingPower: number | null;
  longMarketValue: number | null;
  shortMarketValue: number | null;
  openPnl: number | null;
  totalPnl: number | null;
  dayPnl: number | null;
  fetchedAt: string;
};

type BotPnl = {
  realizedPnl: number;
  realizedPnlToday: number;
  unrealizedPnl: number | null;
  openPositionCount: number;
  markedPositionCount: number;
  unrealizedPartial: boolean;
  totalPnl: number;
};

type AccountResponse = {
  fetchedAt: string;
  mode: BotMode;
  account: AccountSnapshot;
  botPnl: BotPnl;
  brokerPositions: { available: boolean; count: number };
  warnings: string[];
  note: string;
};

function useBotAccount() {
  return useQuery<AccountResponse>({
    queryKey: ["/api/bot/account"],
    refetchInterval: 10_000,
  });
}

type ExitReasonBucket =
  | "hardStop"
  | "breakevenStop"
  | "trailingStop"
  | "hardFlatten"
  | "manualOther";

type DailyScorecard = {
  date: string;
  realizedPnlToday: number;
  tradeCount: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number;
  avgWinner: number;
  avgLoser: number;
  bestTrade: number;
  worstTrade: number;
  openPositionCount: number;
  contractsTraded: number;
  unrealizedPnl: number | null;
  markedPositionCount: number;
  unrealizedPartial: boolean;
  exitReasons: Record<ExitReasonBucket, number>;
  sizingDistribution: Record<string, number>;
};

type ScorecardResponse = {
  generatedAt: string;
  mode: BotMode;
  scorecard: DailyScorecard;
  strategy: {
    preferredContractsPerTrade: number;
    minContractsPerTrade: number;
    maxContractsPerTrade: number;
    stopLossFraction: number;
    breakevenArmFraction: number;
    trailStartFraction: number;
    trailGivebackFraction: number;
    contractSelectionMode: "fixed_otm" | "best_liquid";
    maxDailyLoss: number;
    maxLossPerTrade: number;
    liveEnabled: boolean;
    autoTradeEnabled: boolean;
    killSwitchActive: boolean;
    autoReady: boolean;
  };
  note: string;
};

function useBotScorecard() {
  return useQuery<ScorecardResponse>({
    queryKey: ["/api/bot/scorecard"],
    refetchInterval: 8_000,
  });
}

type SetupSourceRow = {
  source: string;
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number;
  netPnl: number;
  openPositions: number;
};

type SetupSourceResponse = {
  generatedAt: string;
  mode: BotMode;
  scorecard: { date: string; rows: SetupSourceRow[] };
  note: string;
};

function useBotScorecardBySource() {
  return useQuery<SetupSourceResponse>({
    queryKey: ["/api/bot/scorecard/by-source"],
    refetchInterval: 8_000,
  });
}

type WeeklyDayRollup = {
  date: string;
  weekday: string;
  realizedPnl: number;
  tradeCount: number;
  wins: number;
  losses: number;
  contractsTraded: number;
};

type WeeklyScorecard = {
  weekStart: string;
  weekEnd: string;
  realizedPnlWeek: number;
  tradeCount: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number;
  avgWinner: number;
  avgLoser: number;
  bestTrade: number;
  worstTrade: number;
  contractsTraded: number;
  activeDays: number;
  exitReasons: Record<ExitReasonBucket, number>;
  sizingDistribution: Record<string, number>;
  perDay: WeeklyDayRollup[];
};

type WeeklyScorecardResponse = {
  generatedAt: string;
  mode: BotMode;
  scorecard: WeeklyScorecard;
  note: string;
};

function useBotWeeklyScorecard() {
  return useQuery<WeeklyScorecardResponse>({
    queryKey: ["/api/bot/scorecard/weekly"],
    refetchInterval: 15_000,
  });
}

// ─── Live Readiness Checklist ─────────────────────────────────────────────────

function LiveReadinessChecklist({ status }: { status: BotStatus }) {
  const { liveEnabled, checks, blockingCount } = status.liveReadiness;

  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-live-readiness">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-300" />
            Live trading readiness
          </span>
          <Badge
            className={
              liveEnabled
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-rose-500/15 text-rose-300"
            }
          >
            {liveEnabled ? "LIVE ENABLED" : `${blockingCount} missing`}
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {liveEnabled
            ? "All env vars configured. Live orders will be sent to Tradier when confirmLiveOrder=true."
            : "Configure the items below on your server to enable live order submission."}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {checks.map((check) => (
          <div
            key={check.label}
            className={`flex items-start gap-3 rounded-md p-3 ${
              check.label === "confirmLiveOrder (per-request)"
                ? "bg-sky-500/10 border border-sky-500/20"
                : check.ok
                ? "bg-emerald-500/10 border border-emerald-500/20"
                : "bg-rose-500/10 border border-rose-500/20"
            }`}
          >
            {check.label === "confirmLiveOrder (per-request)" ? (
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
            ) : check.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            )}
            <div className="min-w-0">
              <p className="font-mono text-xs font-semibold">{check.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
            </div>
          </div>
        ))}
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <p className="font-semibold">Trading URL: {status.tradierBaseUrl}</p>
          <p className="mt-1">
            {status.liveEnabled
              ? "Production Tradier API — real orders submitted here."
              : "Sandbox URL active. Set all 3 env vars + TRADIER_ENABLE_LIVE_TRADING=true to switch to production."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Multi-timeframe stack ─────────────────────────────────────────────────────

function trendChipClass(trend: Trend) {
  return trend === "bullish"
    ? "bg-emerald-500/15 text-emerald-300"
    : trend === "bearish"
    ? "bg-rose-500/15 text-rose-300"
    : "bg-secondary text-secondary-foreground";
}

function TrendCell({ label, tf }: { label: string; tf: TimeframeTrend }) {
  return (
    <div className="rounded bg-secondary/55 p-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <Badge className={`${trendChipClass(tf.trend)} text-[10px]`}>{tf.trend}</Badge>
      </div>
      <p className="mt-1 font-mono text-xs">score {tf.score}</p>
      {tf.drivers[0] && (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={tf.drivers.join(" · ")}>
          {tf.drivers[0]}
        </p>
      )}
    </div>
  );
}

function MtfStack({ mtf }: { mtf: MtfAnalysis }) {
  const htf = mtf.higherTimeframeTrend;
  const alignChip =
    htf.alignment === "aligned"
      ? "bg-emerald-500/15 text-emerald-300"
      : htf.alignment === "contradicts"
      ? "bg-rose-500/15 text-rose-300"
      : "bg-amber-500/15 text-amber-300";
  const gateChip =
    mtf.gate === "allow"
      ? "bg-emerald-500/15 text-emerald-300"
      : mtf.gate === "block"
      ? "bg-rose-500/15 text-rose-300"
      : "bg-amber-500/15 text-amber-300";

  return (
    <div className="rounded-md border border-card-border bg-secondary/40 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
          <Activity className="h-3.5 w-3.5" /> Multi-timeframe stack
        </p>
        <div className="flex items-center gap-2">
          <Badge className={alignChip}>{htf.alignment}</Badge>
          <Badge className={gateChip}>gate: {mtf.gate}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TrendCell label="30m Trend" tf={htf.trend30m} />
        <TrendCell label="15m Structure" tf={htf.trend15m} />
        <TrendCell label="5m Setup" tf={htf.trend5m} />
        <div className="rounded bg-secondary/55 p-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">1m Trigger</p>
          <Badge
            className={`mt-1 text-[10px] ${
              mtf.entryTimeframe.trigger1m.triggered
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-secondary text-secondary-foreground"
            }`}
          >
            {mtf.entryTimeframe.trigger1m.triggered ? "fired" : "pending"}
          </Badge>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={mtf.entryTimeframe.trigger1m.detail}>
            {mtf.entryTimeframe.trigger1m.detail}
          </p>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">{mtf.gateReason}</p>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded bg-emerald-500/10 p-2">
          <p className="text-muted-foreground">Nearest support</p>
          <p className="mt-0.5 font-mono font-semibold text-emerald-300">
            {mtf.nearestSupport ? `${mtf.nearestSupport.price}` : "—"}
          </p>
          {mtf.nearestSupport && (
            <p className="text-[11px] text-muted-foreground">
              {mtf.nearestSupport.source} · str {mtf.nearestSupport.strength}
            </p>
          )}
        </div>
        <div className="rounded bg-rose-500/10 p-2">
          <p className="text-muted-foreground">Nearest resistance</p>
          <p className="mt-0.5 font-mono font-semibold text-rose-300">
            {mtf.nearestResistance ? `${mtf.nearestResistance.price}` : "—"}
          </p>
          {mtf.nearestResistance && (
            <p className="text-[11px] text-muted-foreground">
              {mtf.nearestResistance.source} · str {mtf.nearestResistance.strength}
            </p>
          )}
        </div>
      </div>

      <div className="rounded bg-secondary/55 p-2 text-xs">
        <p className="text-muted-foreground">Entry plan</p>
        <p className="mt-0.5">Trigger: {mtf.entryPlan.trigger}</p>
        <p className="mt-0.5">Invalidation: {mtf.entryPlan.invalidation}</p>
        <p className="mt-0.5 font-mono">
          Target {mtf.entryPlan.target ?? "—"} · Runner {mtf.entryPlan.runnerTarget ?? "—"}
        </p>
      </div>
    </div>
  );
}

// ─── Signal card ──────────────────────────────────────────────────────────────

function SignalCard({ signal }: { signal: BotSignal }) {
  const statusColor =
    signal.status === "ACTIONABLE"
      ? "bg-emerald-500/15 text-emerald-300"
      : signal.status === "REQUIRES_REVIEW"
      ? "bg-amber-500/15 text-amber-300"
      : signal.status === "BLOCKED"
      ? "bg-rose-500/15 text-rose-300"
      : "bg-secondary text-secondary-foreground";

  const biasIcon =
    signal.bias === "Call" ? (
      <TrendingUp className="h-4 w-4 text-emerald-400" />
    ) : signal.bias === "Put" ? (
      <TrendingDown className="h-4 w-4 text-rose-400" />
    ) : (
      <CircleOff className="h-4 w-4 text-muted-foreground" />
    );

  return (
    <article
      className="rounded-md border border-card-border bg-secondary/45 p-4 space-y-3"
      data-testid={`card-signal-${signal.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {biasIcon}
          <span className="font-semibold">
            {signal.bias ?? "No signal"} · {signal.setup?.title ?? signal.blockReason ?? "Waiting"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={statusColor}>{signal.status}</Badge>
          {signal.confidence > 0 && (
            <Badge variant="outline" className="font-mono">
              {signal.confidence}%
            </Badge>
          )}
        </div>
      </div>

      {signal.blockReason && (
        <p className="text-sm text-muted-foreground">{signal.blockReason}</p>
      )}
      {signal.reviewReason && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
          {signal.reviewReason}
        </div>
      )}

      {signal.contract && (
        <div className="rounded-md bg-secondary/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Contract</p>
            <div className="flex items-center gap-1.5">
              <Badge
                className={
                  signal.contract.moneyness === "OTM"
                    ? "bg-amber-500/20 text-amber-300"
                    : signal.contract.moneyness === "ATM"
                      ? "bg-sky-500/20 text-sky-300"
                      : "bg-violet-500/20 text-violet-300"
                }
              >
                {signal.contract.selectionRule}
              </Badge>
              <Badge
                className={
                  signal.isZeroDte
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-rose-500/20 text-rose-300"
                }
              >
                {signal.isZeroDte ? "0DTE: YES" : "0DTE: NO"}
              </Badge>
            </div>
          </div>
          <p className="font-mono font-semibold">{signal.contract.symbol}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Strike {signal.contract.strike} · {signal.contract.moneyness} (
            {isFiniteNumber(signal.contract.strikeDistance) && signal.contract.strikeDistance >= 0 ? "+" : ""}
            {safeFixed(signal.contract.strikeDistance)}) · Expiry{" "}
            {signal.contractExpiry ?? signal.contract.expiry} · Score{" "}
            {signal.contract.unusualScore}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{signal.contract.selectionReason}</p>
        </div>
      )}

      {signal.suggestedEntryPremium !== null && (
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          <div className="rounded bg-secondary/55 p-2">
            <p className="text-muted-foreground">Entry (mid)</p>
            <p className="mt-1 font-mono font-semibold">{safeUsd(signal.suggestedEntryPremium)}</p>
          </div>
          <div className="rounded bg-rose-500/10 p-2">
            <p className="text-muted-foreground">Hard stop (-20%)</p>
            <p className="mt-1 font-mono font-semibold text-rose-300">{safeUsd(signal.impliedStopPremium)}</p>
          </div>
          <div className="rounded bg-emerald-500/10 p-2">
            <p className="text-muted-foreground">Trail arms (+25%)</p>
            <p className="mt-1 font-mono font-semibold text-emerald-300">{safeUsd(signal.impliedTrailArmPremium)}</p>
          </div>
        </div>
      )}

      {signal.sizing && (
        <div
          className={`rounded-md p-2 text-xs ${
            !signal.sizing.allowed
              ? "bg-rose-500/10 border border-rose-500/20 text-rose-300"
              : signal.sizing.fellBackFromPreferred
                ? "bg-amber-500/10 border border-amber-500/20 text-amber-300"
                : "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
          }`}
        >
          <p className="font-semibold">
            {!signal.sizing.allowed
              ? "Size: entry skipped"
              : `Size: ${signal.sizing.contracts} contract${signal.sizing.contracts === 1 ? "" : "s"}`}{" "}
            <span className="font-normal opacity-80">
              (preferred {signal.sizing.preferred}, min {signal.sizing.minimum})
            </span>
          </p>
          <p className="mt-0.5 font-normal opacity-90">{signal.sizing.reason}</p>
        </div>
      )}

      {signal.setup && (
        <dl className="grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-muted-foreground text-xs">Trigger</dt>
            <dd className="mt-0.5">{signal.triggerText}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Invalidation</dt>
            <dd className="mt-0.5">{signal.invalidationText}</dd>
          </div>
        </dl>
      )}

      {signal.mtf && <MtfStack mtf={signal.mtf} />}

      <p className="text-xs text-muted-foreground border-t border-border pt-2">
        {signal.disclaimer}
      </p>
    </article>
  );
}

// ─── Kill switch button ───────────────────────────────────────────────────────

function KillSwitchButton({ active, onToggle }: { active: boolean; onToggle: (v: boolean) => void }) {
  const { toast } = useToast();

  async function toggle() {
    const next = !active;
    try {
      const res = await fetch("/api/bot/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      const data = await res.json();
      onToggle(next);
      toast({
        title: next ? "Kill switch activated" : "Kill switch deactivated",
        description: data.message ?? "",
      });
    } catch {
      toast({ title: "Error", description: "Could not toggle kill switch", variant: "destructive" });
    }
  }

  return (
    <Button
      type="button"
      variant={active ? "destructive" : "outline"}
      className={active ? "" : "border-rose-500/40 text-rose-400 hover:bg-rose-500/10"}
      onClick={toggle}
      data-testid="button-kill-switch"
    >
      {active ? (
        <><XCircle className="mr-2 h-4 w-4" /> Kill switch ON — click to resume</>
      ) : (
        <><ShieldAlert className="mr-2 h-4 w-4" /> Activate kill switch</>
      )}
    </Button>
  );
}

// ─── Automation runtime toggle ────────────────────────────────────────────────

function AutomationRuntimeButton({ running }: { running: boolean }) {
  const { toast } = useToast();

  async function toggle() {
    const next = !running;
    try {
      const res = await fetch("/api/bot/automation/start-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ running: next }),
      });
      const data = await res.json();
      toast({
        title: next ? "Automation runtime resumed" : "Automation runtime paused",
        description: data.message ?? "",
      });
    } catch {
      toast({ title: "Error", description: "Could not toggle automation runtime", variant: "destructive" });
    }
  }

  return (
    <Button
      type="button"
      variant={running ? "outline" : "default"}
      onClick={toggle}
      data-testid="button-automation-runtime"
    >
      <Power className="mr-2 h-4 w-4" />
      {running ? "Pause automation runtime" : "Resume automation runtime"}
    </Button>
  );
}

// ─── Manual close trade button (per live/adopted position) ─────────────────────

function CloseTradeButton({
  position,
}: {
  position: { id: string; symbol: string; contracts: number; lastMark: number | null; entryPremium: number };
}) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  async function close() {
    // Explicit user confirmation before any close request is sent.
    const ok = window.confirm(
      `Close ${position.contracts}x ${position.symbol}? In live mode this submits a sell-to-close order to Tradier.`,
    );
    if (!ok) return;

    // Use the latest known mark as the close premium; fall back to entry when no
    // mark is available so the local ledger still records a defined exit.
    const closePremium = isFiniteNumber(position.lastMark) ? position.lastMark : position.entryPremium;

    setPending(true);
    try {
      const res = await fetch("/api/bot/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positionId: position.id,
          symbol: position.symbol,
          expectedContracts: position.contracts,
          closePremium,
          confirmLiveOrder: true,
          reason: "Manual close via dashboard button",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: "Close failed",
          description: data.error ?? "Could not close the position.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: data.mode === "LIVE" ? "Live close submitted" : "Position closed (paper)",
        description: data.note ?? `${position.symbol} closed.`,
      });
      // Refresh Live Bot state so the closed position drops off immediately.
      queryClient.invalidateQueries({ queryKey: ["/api/bot/automation/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/positions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/scorecard"] });
    } catch {
      toast({ title: "Close failed", description: "Network error closing the position.", variant: "destructive" });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="mt-1 h-6 border-rose-500/40 text-[10px] text-rose-300 hover:bg-rose-500/10"
      onClick={close}
      disabled={pending}
      data-testid={`button-close-trade-${position.id}`}
    >
      {pending ? "Closing…" : "Close trade"}
    </Button>
  );
}

// ─── Setup-source scorecard ───────────────────────────────────────────────────

function SetupSourceScorecard() {
  const query = useBotScorecardBySource();
  const rows = query.data?.scorecard.rows ?? [];

  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-setup-source-scorecard">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4 text-primary" />
          Setup-source scorecard
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Today's paper/live performance by setup source. Read-only.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="py-2 text-left font-medium">Source</th>
                <th className="py-2 text-right font-medium">Trades</th>
                <th className="py-2 text-right font-medium">W / L</th>
                <th className="py-2 text-right font-medium">Win rate</th>
                <th className="py-2 text-right font-medium">Net P&amp;L</th>
                <th className="py-2 text-right font-medium">Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const decided = row.wins + row.losses;
                return (
                  <tr
                    className="border-b border-border/60 last:border-0"
                    data-testid={`row-source-${row.source}`}
                    key={row.source}
                  >
                    <td className="py-2 pr-4 font-medium">{row.source}</td>
                    <td className="py-2 text-right font-mono">{row.trades}</td>
                    <td className="py-2 text-right font-mono">
                      <span className="text-emerald-300">{row.wins}</span>
                      {" / "}
                      <span className="text-rose-300">{row.losses}</span>
                    </td>
                    <td className="py-2 text-right font-mono">
                      {decided > 0 ? `${(row.winRate * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td
                      className={`py-2 text-right font-mono ${
                        row.netPnl > 0
                          ? "text-emerald-300"
                          : row.netPnl < 0
                            ? "text-rose-300"
                            : "text-muted-foreground"
                      }`}
                    >
                      {row.trades > 0 ? safeUsd(row.netPnl) : "—"}
                    </td>
                    <td className="py-2 text-right font-mono text-muted-foreground">
                      {row.openPositions || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Autonomous engine panel ──────────────────────────────────────────────────

function AutomationPanel() {
  const query = useAutomationStatus();
  const auto = query.data;
  if (!auto) {
    return <div className="h-24 animate-pulse rounded-md bg-secondary/50" data-testid="panel-automation-loading" />;
  }

  const armed = auto.enabled && auto.running;

  return (
    <div className="space-y-4" data-testid="panel-automation">
      {/* Autonomy banner */}
      <div
        className={`rounded-lg border p-4 ${
          armed
            ? "border-rose-500/50 bg-rose-500/10"
            : "border-amber-500/30 bg-amber-500/10"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Bot className={`h-6 w-6 ${armed ? "text-rose-400" : "text-amber-300"}`} />
            <div>
              <p className="font-semibold">
                {armed ? "🔴 AUTO TRADING ON — ARMED" : "🟡 AUTO TRADING OFF"}
              </p>
              <p className="text-xs text-muted-foreground">
                {armed
                  ? "The bot is entering and exiting REAL SPY 0DTE positions autonomously. High-risk."
                  : auto.enabled
                    ? "Autonomy env is set but the runtime is paused — click resume to arm."
                    : "Observe-only. Set TRADIER_AUTO_TRADE=true + live env to allow autonomous orders."}
              </p>
            </div>
          </div>
          <AutomationRuntimeButton running={auto.running} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3 text-xs">
          <Badge className={auto.enabled ? "bg-rose-500/15 text-rose-300" : "bg-secondary/60"}>
            {auto.enabled ? "ENV ARMED" : "ENV OFF"}
          </Badge>
          <Badge className={auto.running ? "bg-emerald-500/15 text-emerald-300" : "bg-secondary/60"}>
            {auto.running ? "RUNTIME ON" : "RUNTIME PAUSED"}
          </Badge>
          <Badge className={auto.observeOnly ? "bg-amber-500/15 text-amber-300" : "bg-rose-500/15 text-rose-300"}>
            {auto.observeOnly ? "OBSERVE-ONLY" : "LIVE ORDERS"}
          </Badge>
          <Badge className={auto.exitManagement === "live-quotes" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}>
            EXIT: {auto.exitManagement === "live-quotes" ? "LIVE MARKS" : "DEGRADED"}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Auto-trade readiness */}
        <Card className="border-card-border bg-card/88">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between gap-3 text-base">
              <span className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-300" />
                Auto-trade readiness
              </span>
              <Badge
                className={
                  auto.autoTradeReadiness.autoReady
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-rose-500/15 text-rose-300"
                }
              >
                {auto.autoTradeReadiness.autoReady ? "AUTO READY" : `${auto.autoTradeReadiness.blockingCount} missing`}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {auto.autoTradeReadiness.checks.map((check) => (
              <div key={check.label} className="flex items-start gap-2 text-sm">
                {check.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                )}
                <div>
                  <p className="font-mono text-xs font-semibold">{check.label}</p>
                  <p className="text-xs text-muted-foreground">{check.detail}</p>
                </div>
              </div>
            ))}
            {auto.blockers.length > 0 && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-300">
                <p className="font-semibold">Current entry blockers</p>
                <ul className="mt-1 list-disc pl-4">
                  {auto.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tick + managed positions */}
        <Card className="border-card-border bg-card/88">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              Automation activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded bg-secondary/55 p-2">
                <p className="text-muted-foreground">Last tick</p>
                <p className="mt-1 font-mono">{auto.lastTick ? new Date(auto.lastTick).toLocaleTimeString() : "—"}</p>
              </div>
              <div className="rounded bg-secondary/55 p-2">
                <p className="text-muted-foreground">Next tick ≈</p>
                <p className="mt-1 font-mono">{auto.nextTickApprox ? new Date(auto.nextTickApprox).toLocaleTimeString() : "—"}</p>
              </div>
            </div>
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Last action</p>
              <p className="mt-1">{auto.lastAction ?? "No action yet"}</p>
            </div>
            <div>
              <p className="mb-1 text-muted-foreground">Managed positions ({auto.managedPositions.length})</p>
              {auto.brokerReconcileWarning ? (
                <p className="mb-1 rounded bg-amber-500/15 p-2 text-amber-300">{auto.brokerReconcileWarning}</p>
              ) : null}
              {auto.pendingBrokerPositions?.length ? (
                <p className="mb-1 rounded bg-sky-500/15 p-2 text-sky-300">
                  {auto.pendingBrokerPositions.length} position(s) already exited by the bot are still reported by
                  Tradier (pending settlement): {auto.pendingBrokerPositions.join(", ")}. Not re-exited — P&L counted once.
                </p>
              ) : null}
              {auto.managedPositions.length === 0 ? (
                <p className="text-muted-foreground">None open.</p>
              ) : (
                <div className="space-y-1">
                  {auto.managedPositions.map((p) => (
                    <div key={p.id} className="rounded bg-secondary/40 p-2 font-mono">
                      <span className={p.side === "Call" ? "text-emerald-300" : "text-rose-300"}>{p.symbol}</span>
                      {p.adoptedFromBroker ? (
                        <span className="ml-1 rounded bg-sky-500/20 px-1 text-[10px] text-sky-300">adopted from Tradier</span>
                      ) : null}
                      {" · "}{p.contracts}x · entry {safeFixed(p.entryPremium)} · mark {isFiniteNumber(p.lastMark) ? p.lastMark.toFixed(2) : "—"}
                      {" · stop "}{safeFixed(p.stopPrice)} · trail arms {safeFixed(p.trailStartPrice)}
                      {p.trailArmed
                        ? ` · armed @ peak ${safeFixed(p.peakPremium)} · exits @ ${isFiniteNumber(p.trailExitPrice) ? p.trailExitPrice.toFixed(2) : "—"} (${safeFractionPct(p.trailGivebackFraction)}% giveback)`
                        : ""}
                      <div>
                        <CloseTradeButton position={p} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent automation events */}
      <Card className="border-card-border bg-card/88">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4 text-primary" />
            Recent automation events
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs font-mono max-h-64 overflow-y-auto">
          {auto.recentEvents.length === 0 ? (
            <p className="text-muted-foreground">No events yet.</p>
          ) : (
            auto.recentEvents.map((e, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">{new Date(e.at).toLocaleTimeString()}</span>
                <span
                  className={`shrink-0 rounded px-1 ${
                    e.kind === "entry"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : e.kind === "exit"
                        ? "bg-sky-500/15 text-sky-300"
                        : e.kind === "error" || e.kind === "block"
                          ? "bg-rose-500/15 text-rose-300"
                          : "bg-secondary/60 text-muted-foreground"
                  }`}
                >
                  {e.kind}
                </span>
                <span>{e.message}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Bot Control Panel ────────────────────────────────────────────────────────

function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pnlColor(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "text-foreground";
  return v > 0 ? "text-emerald-400" : "text-rose-400";
}

function AccountStat({
  label,
  value,
  emphasize = false,
  pnl = false,
}: {
  label: string;
  value: number | null | undefined;
  emphasize?: boolean;
  pnl?: boolean;
}) {
  const unavailable = value === null || value === undefined || !Number.isFinite(value);
  return (
    <div className="rounded-md border border-card-border bg-secondary/30 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`mt-1 font-mono ${emphasize ? "text-lg" : "text-base"} ${
          pnl ? pnlColor(value) : "text-foreground"
        }`}
      >
        {unavailable ? <span className="text-muted-foreground">unavailable</span> : formatUsd(value)}
      </p>
    </div>
  );
}

function AccountPanel() {
  const query = useBotAccount();
  const data = query.data;

  if (query.isLoading && !data) {
    return (
      <div
        className="h-40 animate-pulse rounded-md bg-secondary/50"
        data-testid="panel-account-loading"
      />
    );
  }

  if (query.isError || !data) {
    return (
      <Card className="border-rose-500/30 bg-rose-500/5" data-testid="panel-account-error">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4 text-rose-300" />
            Account balance & P&amp;L
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-rose-300">
            Could not load account data from /api/bot/account. The server may be unreachable.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { account, botPnl, warnings } = data;

  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-account">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Account balance &amp; P&amp;L
          </span>
          <Badge
            className={
              account.available
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-amber-500/15 text-amber-300"
            }
          >
            {account.available ? "TRADIER LIVE" : "UNAVAILABLE"}
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {account.available
            ? `Account ${account.accountNumber ?? "—"}${
                account.accountType ? ` · ${account.accountType}` : ""
              } · read-only from Tradier`
            : "Set TRADIER_TOKEN and TRADIER_ACCOUNT_ID to track real account equity and P&L."}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {warnings.length > 0 && (
          <div className="space-y-2" data-testid="account-warnings">
            {warnings.map((w, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 p-2.5 text-xs text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {/* Broker account values */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Tradier account
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <AccountStat label="Equity / Account value" value={account.totalEquity} emphasize />
            <AccountStat label="Cash" value={account.cash} />
            <AccountStat label="Buying power" value={account.buyingPower} />
            <AccountStat label="Option buying power" value={account.optionBuyingPower} />
            <AccountStat label="Open P&L" value={account.openPnl} pnl />
            <AccountStat label="Day P&L" value={account.dayPnl} pnl />
          </div>
        </div>

        {/* Bot-managed P&L */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Bot-managed P&L · {botPnl.openPositionCount} open
            {botPnl.openPositionCount === 1 ? " position" : " positions"}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <AccountStat label="Bot realized (total)" value={botPnl.realizedPnl} pnl emphasize />
            <AccountStat label="Bot realized (today)" value={botPnl.realizedPnlToday} pnl />
            <AccountStat label="Bot unrealized" value={botPnl.unrealizedPnl} pnl />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Bot P&L is computed from locally tracked positions and may differ from real Tradier
            fills. Long/short market value: {formatUsd(account.longMarketValue)} /{" "}
            {formatUsd(account.shortMarketValue)}.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

const EXIT_REASON_LABELS: Record<ExitReasonBucket, string> = {
  hardStop: "Hard stop",
  breakevenStop: "Breakeven/entry stop",
  trailingStop: "Trailing winner",
  hardFlatten: "Flatten/cutoff",
  manualOther: "Manual/other",
};

function ScoreStat({
  label,
  value,
  pnl,
  emphasize = false,
}: {
  label: string;
  value: string;
  pnl?: number | null;
  emphasize?: boolean;
}) {
  return (
    <div className="rounded-md border border-card-border bg-secondary/30 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`mt-1 font-mono font-semibold ${emphasize ? "text-lg" : "text-sm"} ${
          pnl !== undefined ? pnlColor(pnl) : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function DailyScorecardPanel() {
  const query = useBotScorecard();
  const data = query.data;

  if (query.isLoading && !data) {
    return (
      <div
        className="h-48 animate-pulse rounded-md bg-secondary/50"
        data-testid="panel-scorecard-loading"
      />
    );
  }

  if (query.isError || !data) {
    return (
      <Card className="border-rose-500/30 bg-rose-500/5" data-testid="panel-scorecard-error">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-rose-300" />
            Daily scorecard
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-rose-300">
            Could not load scorecard from /api/bot/scorecard. The server may be unreachable.
          </p>
        </CardContent>
      </Card>
    );
  }

  const s = data.scorecard;
  const st = data.strategy;
  const winRatePct = safeFractionPct(s.winRate);
  const sizingKeys = Object.keys(s.sizingDistribution)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  const ladderKeys = Array.from(new Set([4, 3, 2, ...sizingKeys])).sort((a, b) => b - a);

  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-scorecard">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            Daily scorecard
          </span>
          <Badge variant="outline" className="font-mono text-[11px]">
            {s.date}
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Today&apos;s realized result and behavior from locally tracked bot positions. Read-only —
          may differ from real Tradier fills.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Headline P&L row */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ScoreStat
            label="Realized P&L (today)"
            value={formatUsd(s.realizedPnlToday)}
            pnl={s.realizedPnlToday}
            emphasize
          />
          <ScoreStat
            label="Open unrealized"
            value={s.unrealizedPnl === null ? "n/a" : formatUsd(s.unrealizedPnl)}
            pnl={s.unrealizedPnl}
          />
          <ScoreStat label="Trades closed" value={String(s.tradeCount)} />
          <ScoreStat label="Open positions" value={String(s.openPositionCount)} />
        </div>

        {/* Win/loss metrics */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <ScoreStat label="Wins" value={String(s.wins)} pnl={s.wins > 0 ? 1 : 0} />
          <ScoreStat label="Losses" value={String(s.losses)} pnl={s.losses > 0 ? -1 : 0} />
          <ScoreStat
            label="Win rate"
            value={s.wins + s.losses > 0 ? `${winRatePct}%` : "—"}
          />
          <ScoreStat label="Avg winner" value={formatUsd(s.avgWinner)} pnl={s.avgWinner} />
          <ScoreStat label="Avg loser" value={formatUsd(s.avgLoser)} pnl={s.avgLoser} />
          <ScoreStat label="Contracts" value={String(s.contractsTraded)} />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ScoreStat label="Best trade" value={formatUsd(s.bestTrade)} pnl={s.bestTrade} />
          <ScoreStat label="Worst trade" value={formatUsd(s.worstTrade)} pnl={s.worstTrade} />
          {s.scratches > 0 && (
            <ScoreStat label="Scratch (BE)" value={String(s.scratches)} />
          )}
          {s.unrealizedPartial && (
            <ScoreStat
              label="Marked open"
              value={`${s.markedPositionCount}/${s.openPositionCount}`}
            />
          )}
        </div>

        {/* Exit reasons */}
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Exit reasons (closed today)
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {(Object.keys(EXIT_REASON_LABELS) as ExitReasonBucket[]).map((k) => (
              <div
                key={k}
                className="rounded-md border border-card-border bg-secondary/30 p-2 text-center"
                data-testid={`scorecard-exit-${k}`}
              >
                <p className="font-mono text-base font-semibold">{s.exitReasons[k]}</p>
                <p className="text-[10px] text-muted-foreground">{EXIT_REASON_LABELS[k]}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Sizing distribution */}
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Sizing distribution (entries today · verify 4/3/2)
          </p>
          <div className="flex flex-wrap gap-2">
            {ladderKeys.map((n) => (
              <div
                key={n}
                className="rounded-md border border-card-border bg-secondary/30 px-3 py-2 text-center"
                data-testid={`scorecard-size-${n}`}
              >
                <p className="font-mono text-base font-semibold">{s.sizingDistribution[String(n)] ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">{n}-contract</p>
              </div>
            ))}
          </div>
        </div>

        {/* Active strategy settings */}
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Active strategy settings
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Sizing ladder</p>
              <p className="mt-1 font-mono font-semibold">
                {st.preferredContractsPerTrade} → {st.minContractsPerTrade}
                {st.maxContractsPerTrade > 0 ? ` · cap ${st.maxContractsPerTrade}` : ""}
              </p>
            </div>
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Hard stop</p>
              <p className="mt-1 font-mono font-semibold text-rose-300">
                -{safeFractionPct(st.stopLossFraction)}%
              </p>
            </div>
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Breakeven trigger</p>
              <p className="mt-1 font-mono font-semibold">
                {isFiniteNumber(st.breakevenArmFraction) && st.breakevenArmFraction > 0 ? `+${safeFractionPct(st.breakevenArmFraction)}%` : "off"}
              </p>
            </div>
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Trail arm / giveback</p>
              <p className="mt-1 font-mono font-semibold text-emerald-300">
                +{safeFractionPct(st.trailStartFraction)}% / {safeFractionPct(st.trailGivebackFraction)}%
              </p>
            </div>
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Selector mode</p>
              <p className="mt-1 font-mono font-semibold">{st.contractSelectionMode}</p>
            </div>
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Max daily loss</p>
              <p className="mt-1 font-mono font-semibold">{safeUsd(st.maxDailyLoss, 0)}</p>
            </div>
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Max loss / trade</p>
              <p className="mt-1 font-mono font-semibold">{safeUsd(st.maxLossPerTrade, 0)}</p>
            </div>
            <div className="rounded bg-secondary/55 p-2">
              <p className="text-muted-foreground">Live / auto</p>
              <p className="mt-1 font-mono font-semibold">
                <span className={st.liveEnabled ? "text-rose-300" : "text-amber-300"}>
                  {st.liveEnabled ? "LIVE" : "PAPER"}
                </span>
                {" · "}
                <span className={st.autoReady ? "text-rose-300" : "text-muted-foreground"}>
                  {st.autoReady ? "AUTO ARMED" : "manual"}
                </span>
                {st.killSwitchActive ? " · 🛑 kill" : ""}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function WeeklyScorecardPanel() {
  const query = useBotWeeklyScorecard();
  const data = query.data;

  if (query.isLoading && !data) {
    return (
      <div
        className="h-48 animate-pulse rounded-md bg-secondary/50"
        data-testid="panel-weekly-scorecard-loading"
      />
    );
  }

  if (query.isError || !data) {
    return (
      <Card className="border-rose-500/30 bg-rose-500/5" data-testid="panel-weekly-scorecard-error">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-rose-300" />
            Weekly scorecard
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-rose-300">
            Could not load weekly scorecard from /api/bot/scorecard/weekly. The server may be unreachable.
          </p>
        </CardContent>
      </Card>
    );
  }

  const s = data.scorecard;
  const winRatePct = safeFractionPct(s.winRate);
  const sizingKeys = Object.keys(s.sizingDistribution)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  const ladderKeys = Array.from(new Set([4, 3, 2, ...sizingKeys])).sort((a, b) => b - a);

  return (
    <Card className="border-card-border bg-card/88" data-testid="panel-weekly-scorecard">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            Weekly scorecard
          </span>
          <Badge variant="outline" className="font-mono text-[11px]">
            {s.weekStart} → {s.weekEnd}
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Mon–Fri rollup of locally tracked bot positions for the current NY-local trading week.
          Read-only — may differ from real Tradier fills.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Headline */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ScoreStat
            label="Realized P&L (week)"
            value={formatUsd(s.realizedPnlWeek)}
            pnl={s.realizedPnlWeek}
            emphasize
          />
          <ScoreStat label="Trades closed" value={String(s.tradeCount)} />
          <ScoreStat label="Active days" value={`${s.activeDays} / 5`} />
          <ScoreStat label="Contracts traded" value={String(s.contractsTraded)} />
        </div>

        {/* Win/loss metrics */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <ScoreStat label="Wins" value={String(s.wins)} pnl={s.wins > 0 ? 1 : 0} />
          <ScoreStat label="Losses" value={String(s.losses)} pnl={s.losses > 0 ? -1 : 0} />
          <ScoreStat
            label="Win rate"
            value={s.wins + s.losses > 0 ? `${winRatePct}%` : "—"}
          />
          <ScoreStat label="Avg winner" value={formatUsd(s.avgWinner)} pnl={s.avgWinner} />
          <ScoreStat label="Avg loser" value={formatUsd(s.avgLoser)} pnl={s.avgLoser} />
          {s.scratches > 0 ? (
            <ScoreStat label="Scratch (BE)" value={String(s.scratches)} />
          ) : (
            <ScoreStat label="Best / worst" value={`${formatUsd(s.bestTrade)} / ${formatUsd(s.worstTrade)}`} />
          )}
        </div>

        {s.scratches > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <ScoreStat label="Best trade" value={formatUsd(s.bestTrade)} pnl={s.bestTrade} />
            <ScoreStat label="Worst trade" value={formatUsd(s.worstTrade)} pnl={s.worstTrade} />
          </div>
        )}

        {/* Per-day breakdown */}
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Per day breakdown
          </p>
          <div className="grid grid-cols-5 gap-2">
            {s.perDay.map((d) => (
              <div
                key={d.date}
                className="rounded-md border border-card-border bg-secondary/30 p-2 text-center"
                data-testid={`weekly-day-${d.weekday}`}
              >
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{d.weekday}</p>
                <p className={`mt-1 font-mono text-sm font-semibold tabular-nums ${
                  d.realizedPnl > 0
                    ? "text-emerald-300"
                    : d.realizedPnl < 0
                      ? "text-rose-300"
                      : "text-muted-foreground"
                }`}>
                  {d.tradeCount === 0 ? "—" : formatUsd(d.realizedPnl)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {d.tradeCount === 0
                    ? "no trades"
                    : `${d.tradeCount} trade${d.tradeCount === 1 ? "" : "s"} · ${d.wins}W/${d.losses}L`}
                </p>
                <p className="text-[10px] text-muted-foreground">{d.date.slice(5)}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Exit reasons */}
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Exit reasons (closed this week)
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {(Object.keys(EXIT_REASON_LABELS) as ExitReasonBucket[]).map((k) => (
              <div
                key={k}
                className="rounded-md border border-card-border bg-secondary/30 p-2 text-center"
                data-testid={`weekly-exit-${k}`}
              >
                <p className="font-mono text-base font-semibold">{s.exitReasons[k]}</p>
                <p className="text-[10px] text-muted-foreground">{EXIT_REASON_LABELS[k]}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Sizing distribution */}
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Sizing distribution (entries this week · verify 4/3/2)
          </p>
          <div className="flex flex-wrap gap-2">
            {ladderKeys.map((n) => (
              <div
                key={n}
                className="rounded-md border border-card-border bg-secondary/30 px-3 py-2 text-center"
                data-testid={`weekly-size-${n}`}
              >
                <p className="font-mono text-base font-semibold">{s.sizingDistribution[String(n)] ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">{n}-contract</p>
              </div>
            ))}
          </div>
        </div>

        <p className="text-[11px] italic text-muted-foreground">{data.note}</p>
      </CardContent>
    </Card>
  );
}

// Isolates render errors in the Live Bot tab so a single bad field shows an
// inline fallback instead of unmounting the entire dashboard.
class BotErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown) {
    console.error("Live Bot panel render error:", error);
  }

  handleRetry = () => {
    this.setState({ hasError: false, message: "" });
  };

  render() {
    if (this.state.hasError) {
      return (
        <Card className="border-rose-500/30 bg-rose-500/5" data-testid="panel-bot-error">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-rose-300" />
              Live Bot panel hit a display error
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The bot data couldn&apos;t be rendered, but the rest of the dashboard is unaffected.
              Trading and order logic are not impacted by this view error.
            </p>
            {this.state.message ? (
              <p className="font-mono text-xs text-rose-300">{this.state.message}</p>
            ) : null}
            <Button variant="outline" size="sm" onClick={this.handleRetry} data-testid="button-bot-retry">
              Retry
            </Button>
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}

function BotControlPanel() {
  const statusQuery = useBotStatus();
  const signalsQuery = useBotSignals();
  const [killActive, setKillActive] = useState(false);

  const status = statusQuery.data;
  const signalsData = signalsQuery.data;

  // Sync kill switch state from server
  if (status && status.killSwitchActive !== killActive) {
    setKillActive(status.killSwitchActive);
  }

  const isLive = status?.liveEnabled ?? false;

  return (
    <div className="space-y-5" data-testid="panel-bot-control">
      {/* ── Top banner ─────────────────────────────────────────────────── */}
      <div
        className={`rounded-lg border p-4 ${
          isLive
            ? "border-rose-500/40 bg-rose-500/10"
            : "border-amber-500/30 bg-amber-500/10"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Bot className={`h-6 w-6 ${isLive ? "text-rose-400" : "text-amber-300"}`} />
            <div>
              <p className="font-semibold">
                {isLive ? "🔴 LIVE TRADING BOT" : "🟡 Bot — Paper/Test Mode"}
              </p>
              <p className="text-xs text-muted-foreground">
                {isLive
                  ? "Real orders will be submitted to Tradier when confirmLiveOrder=true. High-risk 0DTE options."
                  : "No real orders. Configure TRADIER_ENABLE_LIVE_TRADING=true + credentials for live mode."}
              </p>
            </div>
          </div>
          {status && (
            <KillSwitchButton
              active={killActive}
              onToggle={setKillActive}
            />
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground border-t border-white/10 pt-3">
          ⚠ HIGH-RISK INSTRUMENT — 0DTE options can expire completely worthless.
          This dashboard is software infrastructure only. It is NOT financial advice and does NOT
          guarantee any trading outcomes. Always verify signals and risk parameters manually.
        </p>
      </div>

      {/* ── Autonomous engine ─────────────────────────────────────────── */}
      <AutomationPanel />

      {/* ── Account balance & P&L ─────────────────────────────────────── */}
      <AccountPanel />

      {/* ── Daily scorecard ───────────────────────────────────────────── */}
      <DailyScorecardPanel />

      {/* ── Setup-source scorecard ────────────────────────────────────── */}
      <SetupSourceScorecard />

      {/* ── Main grid ─────────────────────────────────────────────────── */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.8fr)]">
        {/* Left: Signals */}
        <div className="space-y-4">
          <Card className="border-card-border bg-card/88">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-3 text-base">
                <span className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-primary" />
                  Live trade signals · SPY 0DTE
                </span>
                {signalsData && (
                  <Badge variant="outline" className="font-mono">
                    {signalsData.signals.length} signal{signalsData.signals.length !== 1 ? "s" : ""}
                  </Badge>
                )}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Derived from 2m setup analysis and unusual options flow. Signals are trade plans
                requiring manual review — not automated orders.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {signalsQuery.isLoading && (
                <div className="space-y-3">
                  <div className="h-24 animate-pulse rounded-md bg-secondary/50" />
                  <div className="h-24 animate-pulse rounded-md bg-secondary/50" />
                </div>
              )}
              {signalsData?.signals.map((signal) => (
                <SignalCard key={signal.id} signal={signal} />
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Right: Status + readiness */}
        <div className="space-y-4">
          {/* Entry guard status */}
          {status && (
            <Card className="border-card-border bg-card/88">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Gauge className="h-4 w-4 text-primary" />
                  Entry guards
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div
                  className={`rounded-md p-3 text-sm ${
                    status.entryGuards.allowed
                      ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
                      : "bg-rose-500/10 border border-rose-500/20 text-rose-300"
                  }`}
                >
                  <p className="font-semibold">
                    {status.entryGuards.allowed ? "✓ Entry allowed" : "✗ Entry blocked"}
                  </p>
                  <p className="mt-1 text-xs">{status.entryGuards.reason}</p>
                </div>
                {status.entryGuards.timeGuard && (
                  <div
                    className={`rounded-md p-3 text-xs ${
                      status.entryGuards.timeGuard.blocked
                        ? "bg-rose-500/10 border border-rose-500/20 text-rose-300"
                        : "bg-secondary/55 border border-border/40 text-muted-foreground"
                    }`}
                  >
                    <p className="font-semibold">
                      Open/close entry window{" "}
                      {status.entryGuards.timeGuard.enabled
                        ? `(first ${status.entryGuards.timeGuard.openBlackoutMin}m / last ${status.entryGuards.timeGuard.closeBlackoutMin}m blocked)`
                        : "(disabled)"}
                    </p>
                    <p className="mt-1">{status.entryGuards.timeGuard.reason}</p>
                    <p className="mt-1 italic opacity-80">Exits are unaffected by this guardrail.</p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded bg-secondary/55 p-2">
                    <p className="text-muted-foreground">Trades today</p>
                    <p className="mt-1 font-mono font-semibold">
                      {status.daily.tradesOpened} /{" "}
                      {status.riskLimits.maxTradesPerDay > 0
                        ? status.riskLimits.maxTradesPerDay
                        : "∞ Unlimited"}
                    </p>
                  </div>
                  <div className="rounded bg-secondary/55 p-2">
                    <p className="text-muted-foreground">Open positions</p>
                    <p className="mt-1 font-mono font-semibold">
                      {status.openPositions} /{" "}
                      {status.riskLimits.maxOpenPositions > 0
                        ? status.riskLimits.maxOpenPositions
                        : "∞ Unlimited"}
                    </p>
                  </div>
                  <div className="rounded bg-secondary/55 p-2">
                    <p className="text-muted-foreground">Daily loss (net realized)</p>
                    <p className="mt-1 font-mono font-semibold">
                      {safeUsd(status.daily.dailyLossUsed, 0)} / ${status.riskLimits.maxDailyLoss}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Guard uses NET realized P&amp;L {safeUsd(status.daily.netRealizedPnlToday, 0)}{" "}
                      (winners offset losers) · {safeUsd(status.daily.dailyLossRemaining, 0)} left ·
                      gross losers {safeUsd(status.daily.grossLosingTradesToday, 0)} (info only, not the blocker)
                    </p>
                  </div>
                  <div className="rounded bg-secondary/55 p-2">
                    <p className="text-muted-foreground">Flatten CT (exit)</p>
                    <p className={`mt-1 font-mono font-semibold ${
                      status.flattenExit?.pastFlatten ? "text-rose-300" : ""
                    }`}>
                      {status.flattenExit?.flattenCT ?? "—"}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded bg-secondary/55 p-2 text-center">
                    <p className="text-muted-foreground">Hard stop</p>
                    <p className="font-mono font-semibold text-rose-300">
                      -{safeFractionPct(status.riskLimits.stopLossFraction)}%
                    </p>
                  </div>
                  <div className="rounded bg-secondary/55 p-2 text-center">
                    <p className="text-muted-foreground">Trail arms</p>
                    <p className="font-mono font-semibold text-emerald-300">
                      {status.smallAccountProfile
                        ? `+${safeFractionPct(status.smallAccountProfile.trailStartFraction)}%`
                        : "—"}
                    </p>
                  </div>
                  <div className="rounded bg-secondary/55 p-2 text-center">
                    <p className="text-muted-foreground">Give-back</p>
                    <p className="font-mono font-semibold text-sky-300">
                      {status.smallAccountProfile
                        ? `${safeFractionPct(status.smallAccountProfile.trailGivebackFraction)}%`
                        : "—"}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded bg-secondary/55 p-2 text-center">
                    <p className="text-muted-foreground">Preferred</p>
                    <p className="font-mono font-semibold text-emerald-300">
                      {status.riskLimits.preferredContractsPerTrade} contracts
                    </p>
                  </div>
                  <div className="rounded bg-secondary/55 p-2 text-center">
                    <p className="text-muted-foreground">Hard minimum</p>
                    <p className="font-mono font-semibold text-amber-300">
                      {status.riskLimits.minContractsPerTrade} contract{status.riskLimits.minContractsPerTrade === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div className="rounded bg-secondary/55 p-2 text-center">
                    <p className="text-muted-foreground">Max cap</p>
                    <p className="font-mono font-semibold">
                      {status.riskLimits.maxContractsPerTrade > 0
                        ? status.riskLimits.maxContractsPerTrade
                        : "∞ None"}
                    </p>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Targets {status.riskLimits.preferredContractsPerTrade} contracts per trade, then steps down
                  the ladder ({status.riskLimits.preferredContractsPerTrade} →{" "}
                  {status.riskLimits.minContractsPerTrade}) when cash or max-loss-per-trade can't support a
                  larger size. Skips the entry only if even{" "}
                  {status.riskLimits.minContractsPerTrade} contract{status.riskLimits.minContractsPerTrade === 1 ? "" : "s"} fails.
                </p>
                {status.smallAccountProfile && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground">
                      Trailing exit profile (no fixed take-profit — let it run)
                    </p>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="rounded bg-secondary/55 p-2 text-center">
                        <p className="text-muted-foreground">Hard stop</p>
                        <p className="font-mono font-semibold text-rose-300">
                          -{safeFractionPct(status.riskLimits.stopLossFraction)}%
                        </p>
                      </div>
                      <div className="rounded bg-secondary/55 p-2 text-center">
                        <p className="text-muted-foreground">Trail arms</p>
                        <p className="font-mono font-semibold text-sky-300">
                          +{safeFractionPct(status.smallAccountProfile.trailStartFraction)}%
                        </p>
                      </div>
                      <div className="rounded bg-secondary/55 p-2 text-center">
                        <p className="text-muted-foreground">Give-back</p>
                        <p className="font-mono font-semibold text-amber-300">
                          {safeFractionPct(status.smallAccountProfile.trailGivebackFraction)}%
                        </p>
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      No partial trims. The full position (2 or 3+ contracts) runs together: hard stop
                      -{safeFractionPct(status.riskLimits.stopLossFraction)}%, trail arms at
                      +{safeFractionPct(status.smallAccountProfile.trailStartFraction)}% and exits the
                      full position on a {safeFractionPct(status.smallAccountProfile.trailGivebackFraction)}%
                      give-back from peak, plus flatten/invalidation safety exits.
                    </p>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded bg-secondary/55 p-2 text-center">
                        <p className="text-muted-foreground">Max loss / trade</p>
                        <p className="font-mono font-semibold text-rose-300">
                          {safeUsd(status.smallAccountProfile.maxLossPerTrade, 0)}
                        </p>
                      </div>
                      <div className="rounded bg-secondary/55 p-2 text-center">
                        <p className="text-muted-foreground">Start balance</p>
                        <p className="font-mono font-semibold">
                          {safeUsd(status.smallAccountProfile.accountStartBalance)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                <div className="mt-3 space-y-1 text-xs">
                  <p className="font-semibold text-muted-foreground">Entry timing</p>
                  <p className="font-mono">
                    No time-of-day entry blocks — entries allowed any time the session
                    is open when other guards pass. Positions hard-flatten at{" "}
                    {status.flattenExit?.flattenCT ?? "the flatten cutoff"}.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Live readiness */}
          {status && <LiveReadinessChecklist status={status} />}

          {/* API reference */}
          <Card className="border-card-border bg-card/88">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Radio className="h-4 w-4 text-primary" />
                API endpoints
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs font-mono">
              {[
                ["GET",  "/api/bot/status",       "Mode, readiness, limits"],
                ["GET",  "/api/bot/account",      "Tradier balances + bot P&L"],
                ["GET",  "/api/bot/signals",      "Current trade signals"],
                ["GET",  "/api/bot/positions",    "Tracked positions"],
                ["GET",  "/api/bot/fills",        "Order log"],
                ["POST", "/api/bot/paper-order",  "Simulate paper trade"],
                ["POST", "/api/bot/order",        "Real order (guarded)"],
                ["POST", "/api/bot/close",        "Close a position"],
                ["POST", "/api/bot/kill-switch",  "Toggle bot on/off"],
                ["POST", "/api/bot/risk-pass",    "Run risk evaluation"],
                ["GET",  "/api/bot/automation/status",     "Autonomous engine state"],
                ["POST", "/api/bot/automation/start-stop", "Pause/resume runtime"],
              ].map(([method, path, desc]) => (
                <div key={path} className="flex gap-2 items-start">
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      method === "GET"
                        ? "bg-sky-500/15 text-sky-300"
                        : "bg-amber-500/15 text-amber-300"
                    }`}
                  >
                    {method}
                  </span>
                  <div>
                    <span className="text-foreground">{path}</span>
                    <span className="ml-2 text-muted-foreground">{desc}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Dashboard() {
  const { snapshot, isLoading, socketState } = useLiveSnapshot();

  if (isLoading || !snapshot) {
    return <LoadingState />;
  }

  const marketPositive = snapshot.spy.change >= 0;
  const modeLabel =
    snapshot.mode === "provider-live"
      ? "Provider live stream"
      : snapshot.mode === "live-seeded"
        ? "Live-seeded quote stream"
        : "Simulation stream";

  return (
    <div className="dashboard-shell min-h-screen bg-background text-foreground">
      <Sidebar snapshot={snapshot} socketState={socketState} />
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-background/88 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 lg:hidden">
              <Logo />
            </div>
            <div className="hidden lg:block">
              <h1 className="text-xl font-semibold tracking-tight">SPY 0DTE command center</h1>
              <p className="text-sm text-muted-foreground">
                Live-updating price, flow, macro, sentiment, and setup analysis
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                className={
                  snapshot.mode === "provider-live"
                    ? "bg-emerald-500/15 text-emerald-300"
                    : snapshot.mode === "live-seeded"
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-amber-500/15 text-amber-300"
                }
                data-testid="status-data-mode"
              >
                {modeLabel}
              </Badge>
              <ProviderBadge snapshot={snapshot} />
              <Badge variant="outline" data-testid="status-socket">
                {socketState}
              </Badge>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="main-scroll min-h-0 flex-1 p-4 md:p-6">
          <section className="mb-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
              delta={`${marketPositive ? "+" : ""}${snapshot.spy.change.toFixed(2)} ${percent(
                snapshot.spy.changePercent,
              )}`}
              direction={snapshot.spy.change >= 0 ? "up" : "down"}
              icon={<Activity className="h-4 w-4" />}
              intent={marketPositive ? "positive" : "negative"}
              label="SPY"
              testId="card-spy"
              value={currency(snapshot.spy.price)}
            />
            <StatCard
              delta={`${snapshot.macro.vixChange >= 0 ? "+" : ""}${snapshot.macro.vixChange.toFixed(
                2,
              )} pts`}
              direction={snapshot.macro.vixChange >= 0 ? "up" : "down"}
              icon={<ShieldAlert className="h-4 w-4" />}
              intent={snapshot.macro.vixChange >= 0 ? "positive" : "negative"}
              label="VIX"
              testId="card-vix"
              value={snapshot.macro.vix.toFixed(2)}
            />
            <StatCard
              delta={`${snapshot.macro.us10yChange >= 0 ? "+" : ""}${snapshot.macro.us10yChange.toFixed(
                3,
              )} pts`}
              direction={snapshot.macro.us10yChange >= 0 ? "up" : "down"}
              icon={<Gauge className="h-4 w-4" />}
              intent={snapshot.macro.us10yChange >= 0 ? "positive" : "negative"}
              label="US 10Y"
              testId="card-us10y"
              value={`${snapshot.macro.us10y.toFixed(3)}%`}
            />
            <StatCard
              delta={`${snapshot.liquidity.netFlow >= 0 ? "+" : ""}${compact(
                snapshot.liquidity.netFlow,
              )} net`}
              direction={snapshot.liquidity.netFlow >= 0 ? "up" : "down"}
              icon={<Waves className="h-4 w-4" />}
              intent={snapshot.liquidity.netFlow >= 0 ? "positive" : "negative"}
              label="Liquidity"
              testId="card-liquidity"
              value={compact(snapshot.liquidity.netFlow)}
            />
            <StatCard
              delta={
                snapshot.spy.afterHoursChange == null
                  ? "Regular session"
                  : `${snapshot.spy.afterHoursChange >= 0 ? "+" : ""}${snapshot.spy.afterHoursChange.toFixed(
                      2,
                    )} ${percent(snapshot.spy.afterHoursChangePercent ?? 0)}`
              }
              direction={
                (snapshot.spy.afterHoursChange ?? 0) >= 0 ? "up" : "down"
              }
              icon={<Moon className="h-4 w-4" />}
              intent={
                snapshot.spy.afterHoursChange == null
                  ? "neutral"
                  : snapshot.spy.afterHoursChange >= 0
                    ? "positive"
                    : "negative"
              }
              label={snapshot.spy.session.replace("-", " ")}
              testId="card-after-hours"
              value={
                snapshot.spy.afterHoursPrice == null
                  ? currency(snapshot.spy.price)
                  : currency(snapshot.spy.afterHoursPrice)
              }
            />
          </section>

          <Tabs defaultValue="overview" className="space-y-5">
            <TabsList className="grid w-full grid-cols-6 md:w-[980px]" data-testid="tabs-main">
              <TabsTrigger value="overview" data-testid="tab-overview">
                Overview
              </TabsTrigger>
              <TabsTrigger value="liquidity" data-testid="tab-liquidity">
                Liquidity flow
              </TabsTrigger>
              <TabsTrigger value="news" data-testid="tab-news">
                Breaking news
              </TabsTrigger>
              <TabsTrigger value="options" data-testid="tab-options">
                Options
              </TabsTrigger>
              <TabsTrigger value="weekly" data-testid="tab-weekly">
                Weekly
              </TabsTrigger>
              <TabsTrigger value="bot" data-testid="tab-bot" className="text-amber-300">
                <Bot className="mr-1.5 h-3.5 w-3.5" />
                Live Bot
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-5">
              <BotCockpit snapshot={snapshot} />
            </TabsContent>

            <TabsContent value="liquidity" className="space-y-5">
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.75fr)]">
                <LiquidityChart snapshot={snapshot} />
                <div className="space-y-5">
                  <ProviderPanel snapshot={snapshot} />
                  <SentimentPanel snapshot={snapshot} />
                  <Setups snapshot={snapshot} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="news" className="space-y-5">
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,0.85fr)]">
                <BreakingNews snapshot={snapshot} />
                <div className="space-y-5">
                  <ProviderPanel snapshot={snapshot} />
                  <Card className="border-card-border bg-card/88" data-testid="panel-risk-rules">
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <AlertTriangle className="h-4 w-4 text-amber-300" />
                        0DTE execution rules
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm text-muted-foreground">
                      <p>
                        Avoid fresh entries five minutes before high-impact releases unless already
                        risk-reduced.
                      </p>
                      <p>
                        Treat VWAP loss after a call trigger or VWAP reclaim after a put trigger as
                        invalidation.
                      </p>
                      <p>
                        Analysis is educational and does not place trades or guarantee outcomes.
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="options" className="space-y-5">
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.75fr)]">
                <UnusualOptions snapshot={snapshot} />
                <div className="space-y-5">
                  <ProviderPanel snapshot={snapshot} />
                  <SentimentPanel snapshot={snapshot} />
                  <Setups snapshot={snapshot} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="weekly" className="space-y-5">
              <WeeklyScorecardPanel />
            </TabsContent>

            <TabsContent value="bot" className="space-y-5">
              <BotErrorBoundary>
                <BotControlPanel />
              </BotErrorBoundary>
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
