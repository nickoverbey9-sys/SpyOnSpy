import type { Express } from "express";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket as WsSocket } from "ws";
import { storage } from "./storage";
import { registerBotRoutes } from "./bot/botRoutes.js";
import { startAutomationEngine } from "./bot/automationEngine.js";
import type { SnapshotForSignal } from "./bot/signalEngine.js";
import { marketDateNY } from "./bot/occSymbol.js";
import { getBotConfig } from "./bot/config.js";
import { inferSetups } from "./setups.js";

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

type MarketSnapshot = {
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
    candles15m: Candle[];
    candles30m: Candle[];
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
  breakingNews: BreakingNewsItem[];
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

type BreakingNewsItem = {
  id: string;
  title: string;
  source: string;
  url: string | null;
  publishedAt: string | null;
  impact: "Bullish" | "Bearish" | "Neutral" | "Volatility";
  severity: "High" | "Medium" | "Low";
  reason: string;
  tags: string[];
};

const SPY_FALLBACK = 520.42;
let snapshot = createInitialSnapshot();
let cycle = 0;
let persistCounter = 0;
let providerStarted = false;
let providerHeartbeat = 0;
let providerInterval: NodeJS.Timeout | undefined;
let providerSocket: WsSocket | undefined;
let lastMacroFetchMs = 0;
let lastNewsFetchMs = 0;
let newsRefreshInFlight: Promise<void> | null = null;

type ProviderConfig =
  | { kind: "tradier"; token: string }
  | { kind: "polygon"; token: string }
  | { kind: "finnhub"; token: string }
  | { kind: "none" };

function getProviderConfig(): ProviderConfig {
  if (process.env.TRADIER_TOKEN) {
    return { kind: "tradier", token: process.env.TRADIER_TOKEN };
  }

  if (process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY) {
    return {
      kind: "polygon",
      token: process.env.POLYGON_API_KEY ?? process.env.MASSIVE_API_KEY ?? "",
    };
  }

  if (process.env.FINNHUB_API_KEY) {
    return { kind: "finnhub", token: process.env.FINNHUB_API_KEY };
  }

  return { kind: "none" };
}

function providerName(config = getProviderConfig()): MarketSnapshot["provider"]["name"] {
  if (config.kind === "tradier") return "Tradier";
  if (config.kind === "polygon") return "Polygon/Massive";
  if (config.kind === "finnhub") return "Finnhub";
  return "Replay";
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Ensures a candle's high/low are valid price-domain values.
 * Guards against liquidity/volume values accidentally polluting OHLC fields.
 * Realistic 1m intraday wicks for SPY are typically 0.01–0.20% of price
 * (e.g. $0.08–$1.50 on a $750 stock). We cap at MAX_WICK_PCT (0.20%) and
 * cap the absolute fallback wick at MAX_WICK_ABS dollars.
 * Wide/non-finite values are rebuilt tightly from max/min of open and close.
 *
 * Note: the caps are exposed as hoisted functions rather than `const`s because
 * esbuild hoists the module-level `createInitialSnapshot()` initializer above
 * top-level const declarations; function declarations are hoisted with it, so
 * this avoids a temporal-dead-zone ReferenceError at module load.
 */
function maxWickPct(): number {
  return 0.002; // 0.20% — realistic max intraday wick for a single 1m SPY candle
}
function maxWickAbs(): number {
  return 1.5; // absolute cap in dollars (e.g. SPY at 750 → max wick = min(1.50, 750*0.002))
}
function sanitizeCandle(candle: Candle): Candle {
  const priceRef = Math.abs(candle.open + candle.close) / 2 || 1;
  const maxWick = Math.min(priceRef * maxWickPct(), maxWickAbs());
  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow  = Math.min(candle.open, candle.close);
  // Fallback wick: small random amount, capped tightly (0.01–0.12 dollars)
  const fallbackWickHigh = Math.random() * 0.12 + 0.02;
  const fallbackWickLow  = Math.random() * 0.12 + 0.02;
  const safeHigh =
    !Number.isFinite(candle.high) ||
    candle.high < bodyHigh ||
    candle.high > bodyHigh + maxWick
      ? bodyHigh + fallbackWickHigh
      : candle.high;
  const safeLow =
    !Number.isFinite(candle.low) ||
    candle.low > bodyLow ||
    candle.low < bodyLow - maxWick
      ? bodyLow - fallbackWickLow
      : candle.low;
  if (safeHigh === candle.high && safeLow === candle.low) return candle;
  return { ...candle, high: round(safeHigh, 2), low: round(safeLow, 2) };
}

function marketLabel(date = new Date()) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });
}

function minuteBucket(isoOrDate: string | Date) {
  const date = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  return Math.floor(date.getTime() / 60_000);
}

function todayAt(hour: number, minute: number) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

function getMarketSession(date = new Date()): MarketSnapshot["spy"]["session"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const minutes = hour * 60 + minute;
  const isWeekend = weekday === "Sat" || weekday === "Sun";

  if (isWeekend) return "closed";
  if (minutes >= 3 * 60 && minutes < 8 * 60 + 30) return "pre-market";
  if (minutes >= 8 * 60 + 30 && minutes < 15 * 60) return "regular";
  if (minutes >= 15 * 60 && minutes < 19 * 60) return "after-hours";
  return "closed";
}

function computeAfterHours(
  price: number,
  regularReference: number,
  session = getMarketSession(),
) {
  if (session === "regular") {
    return {
      afterHoursPrice: null,
      afterHoursChange: null,
      afterHoursChangePercent: null,
    };
  }

  const change = round(price - regularReference);
  return {
    afterHoursPrice: round(price),
    afterHoursChange: change,
    afterHoursChangePercent: regularReference
      ? round((change / regularReference) * 100)
      : null,
  };
}

function normalizeTenYearYield(value: number) {
  return round(value > 10 ? value / 10 : value, 3);
}

function applyMacroQuotes(vixValue?: number | null, us10yValue?: number | null) {
  const nextVix =
    typeof vixValue === "number" && Number.isFinite(vixValue) && vixValue > 0
      ? round(vixValue, 2)
      : snapshot.macro.vix;
  const nextUs10y =
    typeof us10yValue === "number" && Number.isFinite(us10yValue) && us10yValue > 0
      ? normalizeTenYearYield(us10yValue)
      : snapshot.macro.us10y;

  snapshot = {
    ...snapshot,
    macro: {
      vix: nextVix,
      vixChange: round(nextVix - snapshot.macro.vix, 2),
      us10y: nextUs10y,
      us10yChange: round(nextUs10y - snapshot.macro.us10y, 3),
    },
  };
}

async function refreshPublicMacroQuotes(force = false) {
  const now = Date.now();
  if (!force && now - lastMacroFetchMs < 60_000) return;
  lastMacroFetchMs = now;

  const [vix, us10y] = await Promise.all([fetchQuote("^VIX"), fetchQuote("^TNX")]);
  applyMacroQuotes(vix, us10y);
}

function generateCandles(anchor = SPY_FALLBACK): Candle[] {
  const candles: Candle[] = [];
  const now = new Date();
  let price = anchor - 2.4;

  for (let index = 80; index >= 0; index -= 1) {
    const time = new Date(now.getTime() - index * 60_000);
    const trend = Math.sin((80 - index) / 9) * 0.35;
    const pulse = Math.cos((80 - index) / 5) * 0.18;
    const open = price;
    const close = open + trend + pulse + (Math.random() - 0.5) * 0.38;
    const high = Math.max(open, close) + Math.random() * 0.32;
    const low = Math.min(open, close) - Math.random() * 0.32;
    const volume = Math.round(820_000 + Math.random() * 1_700_000);
    candles.push({
      time: time.toISOString(),
      label: marketLabel(time),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume,
    });
    price = close;
  }

  return addIndicators(candles);
}

function addIndicators(candles: Candle[]) {
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  let ema12 = candles[0]?.close ?? SPY_FALLBACK;
  let ema26 = candles[0]?.close ?? SPY_FALLBACK;
  let macdSignal = 0;
  let ema200 = candles[0]?.close ?? SPY_FALLBACK;

  // Sanitize each candle so high/low are always price-domain before indicator math.
  return candles.map(sanitizeCandle).map((candle, index) => {
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typical * candle.volume;
    cumulativeVolume += candle.volume;

    const k12 = 2 / (12 + 1);
    const k26 = 2 / (26 + 1);
    const k9 = 2 / (9 + 1);
    const k200 = 2 / (200 + 1);
    ema12 = candle.close * k12 + ema12 * (1 - k12);
    ema26 = candle.close * k26 + ema26 * (1 - k26);
    const macd = ema12 - ema26;
    macdSignal = macd * k9 + macdSignal * (1 - k9);
    ema200 = candle.close * k200 + ema200 * (1 - k200);

    const lookback = candles.slice(Math.max(0, index - 13), index + 1);
    const highestHigh = Math.max(...lookback.map((item) => item.high));
    const lowestLow = Math.min(...lookback.map((item) => item.low));
    const williamsR =
      highestHigh === lowestLow
        ? -50
        : ((highestHigh - candle.close) / (highestHigh - lowestLow)) * -100;

    const directionalVolume =
      candle.close >= candle.open ? candle.volume : candle.volume * -1;

    return {
      ...candle,
      vwap: round(cumulativePriceVolume / cumulativeVolume, 2),
      ema200: round(ema200, 2),
      macd: round(macd, 3),
      signal: round(macdSignal, 3),
      histogram: round(macd - macdSignal, 3),
      williamsR: round(williamsR, 1),
      liquidityIn: Math.max(0, directionalVolume),
      liquidityOut: Math.abs(Math.min(0, directionalVolume)),
    };
  });
}

function aggregateCandlesByMinutes(candles: Candle[], minutes: number): Candle[] {
  if (!candles.length) return [];
  const bucketSizeMs = minutes * 60_000;
  const buckets = new Map<number, Candle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(new Date(candle.time).getTime() / bucketSizeMs);
    const list = buckets.get(bucket);
    if (list) list.push(candle);
    else buckets.set(bucket, [candle]);
  }

  const aggregated: Candle[] = [];
  const sortedBuckets = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const bucket of sortedBuckets) {
    const items = buckets.get(bucket)!;
    items.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const open = items[0].open;
    const close = items[items.length - 1].close;
    // Compute OHLC exclusively from price-domain fields (open/close).
    // Explicitly map .high and .low — never pick up liquidityIn/Out or any other field.
    // Only accept highs/lows within a tight realistic band (MAX_WICK_PCT) around open/close.
    const bodyHigh = Math.max(open, close);
    const bodyLow  = Math.min(open, close);
    const aggMaxWick = Math.min(bodyHigh * maxWickPct(), maxWickAbs());
    const highValues = items.map((item) => item.high).filter((v) => Number.isFinite(v) && v >= bodyHigh && v <= bodyHigh + aggMaxWick);
    const lowValues  = items.map((item) => item.low).filter((v) => Number.isFinite(v) && v <= bodyLow && v >= bodyLow - aggMaxWick);
    const high = highValues.length
      ? Math.max(...highValues, open, close)
      : Math.max(open, close) + 0.05;
    const low = lowValues.length
      ? Math.min(...lowValues, open, close)
      : Math.min(open, close) - 0.05;
    const volume = items.reduce((sum, item) => sum + item.volume, 0);
    const time = new Date(bucket * bucketSizeMs);
    // Output a clean candle with ONLY price/volume fields — no liquidity contamination.
    aggregated.push({
      time: time.toISOString(),
      label: marketLabel(time),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume,
    });
  }

  // Sanitize before computing indicators to ensure high/low are price-domain.
  return addIndicators(aggregated.map(sanitizeCandle));
}

function aggregateFiveMinuteCandles(candles: Candle[]): Candle[] {
  return aggregateCandlesByMinutes(candles, 5);
}

function aggregateTwoMinuteCandles(candles: Candle[]): Candle[] {
  return aggregateCandlesByMinutes(candles, 2);
}

function aggregateFifteenMinuteCandles(candles: Candle[]): Candle[] {
  return aggregateCandlesByMinutes(candles, 15);
}

function aggregateThirtyMinuteCandles(candles: Candle[]): Candle[] {
  return aggregateCandlesByMinutes(candles, 30);
}

function getCalendar(): MarketSnapshot["economicCalendar"] {
  const now = new Date();
  const events = [
    { hour: 7, minute: 30, event: "Employment or inflation release window", impact: "High" as const },
    { hour: 8, minute: 45, event: "PMI / services data watch", impact: "Medium" as const },
    { hour: 9, minute: 0, event: "ISM, construction, or JOLTS window", impact: "High" as const },
    { hour: 12, minute: 0, event: "Treasury auction / Fed speaker watch", impact: "Medium" as const },
    { hour: 13, minute: 0, event: "FOMC minutes / Fed headline risk", impact: "High" as const },
  ];

  return events.map((item) => {
    const eventTime = todayAt(item.hour, item.minute);
    const status =
      Math.abs(now.getTime() - eventTime.getTime()) < 15 * 60_000
        ? "Watched"
        : eventTime > now
          ? "Upcoming"
          : "Released";

    return {
      time: eventTime.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }),
      event: item.event,
      impact: item.impact,
      status,
    };
  });
}

function inferSentiment(
  candles: Candle[],
  vix: number,
  us10y: number,
  dailyOpen: number,
): MarketSnapshot["sentiment"] {
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 8] ?? candles[0];
  let score = 0;
  const positiveDrivers: string[] = [];
  const negativeDrivers: string[] = [];

  if (last.close > (last.vwap ?? last.close)) {
    score += 22;
    positiveDrivers.push("SPY is holding above VWAP");
  } else {
    score -= 22;
    negativeDrivers.push("SPY is trading below VWAP");
  }

  if (last.close > dailyOpen) {
    score += 16;
    positiveDrivers.push("Price is above the daily open");
  } else {
    score -= 16;
    negativeDrivers.push("Price is below the daily open");
  }

  if ((last.histogram ?? 0) > 0) {
    score += 18;
    positiveDrivers.push("MACD momentum is positive");
  } else {
    score -= 18;
    negativeDrivers.push("MACD momentum is negative");
  }

  if ((last.williamsR ?? -50) > -35) {
    score += 9;
    positiveDrivers.push("Williams %R shows strong upside pressure");
  } else if ((last.williamsR ?? -50) < -65) {
    score -= 9;
    negativeDrivers.push("Williams %R shows downside pressure");
  }

  if (last.close > previous.close) {
    score += 10;
    positiveDrivers.push("Short-term price slope is rising");
  } else {
    score -= 10;
    negativeDrivers.push("Short-term price slope is falling");
  }

  if (vix < 16.5) {
    score += 10;
    positiveDrivers.push("VIX is supportive for risk-on flow");
  } else if (vix > 19) {
    score -= 10;
    negativeDrivers.push("VIX is elevated");
  }

  if (us10y > 4.75) {
    score -= 8;
    negativeDrivers.push("10Y yield is a valuation headwind");
  } else if (us10y < 4.25) {
    score += 8;
    positiveDrivers.push("10Y yield is less restrictive");
  }

  const bounded = clamp(score, -100, 100);
  const label = bounded > 18 ? "Bullish" : bounded < -18 ? "Bearish" : "Neutral";
  const drivers =
    label === "Bullish"
      ? positiveDrivers.slice(0, 4)
      : label === "Bearish"
        ? negativeDrivers.slice(0, 4)
        : [...positiveDrivers.slice(0, 2), ...negativeDrivers.slice(0, 2)];

  return {
    label,
    score: Math.round(bounded),
    drivers: drivers.length ? drivers : ["Signals are mixed; wait for confirmation"],
  };
}

function inferLiquidity(candles: Candle[]): MarketSnapshot["liquidity"] {
  const recent = candles.slice(-18);
  const netFlow = recent.reduce(
    (sum, candle) => sum + (candle.liquidityIn ?? 0) - (candle.liquidityOut ?? 0),
    0,
  );
  const lastPrice = candles[candles.length - 1].close;
  const roundedStrike = Math.round(lastPrice);
  const highVolume = [...candles]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 8)
    .map((candle) => Math.round(candle.close * 2) / 2);
  const supports = Array.from(
    new Set(
      highVolume
        .filter((price) => price <= lastPrice)
        .concat([roundedStrike - 1, roundedStrike - 2]),
    ),
  )
    .sort((a, b) => b - a)
    .slice(0, 3);
  const resistances = Array.from(
    new Set(
      highVolume
        .filter((price) => price >= lastPrice)
        .concat([roundedStrike + 1, roundedStrike + 2]),
    ),
  )
    .sort((a, b) => a - b)
    .slice(0, 3);

  return {
    netFlow: Math.round(netFlow),
    callWall: round(resistances[0] ?? roundedStrike + 1, 1),
    putWall: round(supports[0] ?? roundedStrike - 1, 1),
    supportZones: supports.map((price) => round(price, 1)),
    resistanceZones: resistances.map((price) => round(price, 1)),
  };
}

function nextFridayExpiry(date = new Date()) {
  const expiry = new Date(date);
  const day = expiry.getDay();
  const daysUntilFriday = (5 - day + 7) % 7;
  expiry.setDate(expiry.getDate() + daysUntilFriday);
  return expiry.toISOString().slice(0, 10);
}

/**
 * Today's SPY 0DTE expiry — the New York market date. SPY lists daily (Mon–Fri)
 * expirations, so the same-day 0DTE contract always carries today's NY date.
 * The bot trades 0DTE only, so modeled/seeded options use this, NOT a future
 * weekly Friday. (Earlier the feed seeded nextFridayExpiry(), which made every
 * "unusual option" later-dated and impossible for the 0DTE bot to select.)
 */
function spyZeroDteExpiry(date = new Date()) {
  return marketDateNY(date);
}

function generateModeledUnusualOptions(
  price: number,
): MarketSnapshot["unusualOptions"] {
  const rounded = Math.round(price);
  const expiry = spyZeroDteExpiry();
  const baseContracts = [
    { side: "Call" as const, strike: rounded + 1, drift: 0.82, volume: 18420, oi: 3120 },
    { side: "Put" as const, strike: rounded - 2, drift: 0.76, volume: 14350, oi: 2680 },
    { side: "Call" as const, strike: rounded + 3, drift: 0.48, volume: 11280, oi: 1360 },
    { side: "Put" as const, strike: rounded - 4, drift: 0.41, volume: 9350, oi: 980 },
    { side: "Call" as const, strike: rounded, drift: 1.22, volume: 22400, oi: 6420 },
  ];

  return baseContracts.map((contract, index) => {
    const moneyness = Math.abs(contract.strike - price);
    const last = round(Math.max(0.08, contract.drift + Math.random() * 0.18 - moneyness * 0.07), 2);
    const bid = round(Math.max(0.01, last - 0.03), 2);
    const ask = round(last + 0.04, 2);
    const volume = Math.round(contract.volume * (0.9 + Math.random() * 0.25));
    const openInterest = Math.max(1, Math.round(contract.oi * (0.95 + Math.random() * 0.12)));
    const ratio = round(volume / openInterest, 2);
    const premium = Math.round(last * volume * 100);

    return {
      symbol: `SPY${expiry.replaceAll("-", "").slice(2)}${contract.side === "Call" ? "C" : "P"}${String(contract.strike * 1000).padStart(8, "0")}`,
      expiry,
      strike: contract.strike,
      side: contract.side,
      last,
      bid,
      ask,
      volume,
      openInterest,
      volumeOiRatio: ratio,
      premium,
      unusualScore: Math.min(99, Math.round(55 + ratio * 6 + index * 2)),
      flag:
        ratio > 5
          ? "Volume is multiple times open interest"
          : premium > 1_000_000
            ? "Large notional premium"
            : "Near-the-money 0DTE activity",
    };
  });
}

function normalizeTradierOption(raw: any): MarketSnapshot["unusualOptions"][number] | null {
  const optionType = String(raw.option_type ?? raw.type ?? "").toLowerCase();
  const side = optionType.includes("put") ? "Put" : optionType.includes("call") ? "Call" : null;
  const strike = Number(raw.strike);
  const volume = Number(raw.volume ?? 0);
  const openInterest = Number(raw.open_interest ?? raw.openInterest ?? 0);
  const last = Number(raw.last ?? raw.last_price ?? raw.close ?? 0);
  const bid = Number(raw.bid ?? 0);
  const ask = Number(raw.ask ?? 0);
  const expiry = String(raw.expiration_date ?? raw.expiry ?? raw.expiration ?? "");

  if (!side || !Number.isFinite(strike) || !volume || !expiry) return null;

  const ratio = openInterest > 0 ? volume / openInterest : volume;
  const mark = last || (bid && ask ? (bid + ask) / 2 : ask || bid || 0);
  const premium = Math.round(mark * volume * 100);

  return {
    symbol: String(raw.symbol ?? raw.root_symbol ?? "SPY"),
    expiry,
    strike: round(strike, 2),
    side,
    last: round(mark, 2),
    bid: round(bid, 2),
    ask: round(ask, 2),
    volume: Math.round(volume),
    openInterest: Math.round(openInterest),
    volumeOiRatio: round(ratio, 2),
    premium,
    unusualScore: Math.min(99, Math.round(45 + Math.min(ratio, 8) * 6 + Math.min(premium / 500_000, 20))),
    flag:
      ratio >= 3
        ? "Volume is elevated versus open interest"
        : premium >= 500_000
          ? "Large premium traded"
          : "High-volume SPY contract",
  };
}

async function fetchTradierOptionsChain(
  token: string,
  price: number,
  expiry: string,
) {
  try {
    const response = await fetch(
      `https://api.tradier.com/v1/markets/options/chains?symbol=SPY&expiration=${expiry}&greeks=false`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(5_500),
      },
    );

    if (!response.ok) return null;
    const body = (await response.json()) as any;
    const rawOptions = body.options?.option
      ? Array.isArray(body.options.option)
        ? body.options.option
        : [body.options.option]
      : [];

    const normalized = rawOptions
      .map(normalizeTradierOption)
      .filter(Boolean)
      .filter((option: MarketSnapshot["unusualOptions"][number]) => Math.abs(option.strike - price) <= 12)
      .filter((option: MarketSnapshot["unusualOptions"][number]) => option.volume >= 500 || option.premium >= 250_000)
      .sort(
        (
          a: MarketSnapshot["unusualOptions"][number],
          b: MarketSnapshot["unusualOptions"][number],
        ) => b.unusualScore - a.unusualScore || b.premium - a.premium,
      )
      .slice(0, 12);

    return normalized.length ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Fetch SPY unusual options, preferring today's 0DTE chain.
 *
 * Requests today's same-day expiration FIRST so the 0DTE bot can corroborate
 * setups with real same-day flow. Only if today's chain is empty (e.g. a
 * holiday/weekend with no SPY daily expiry) does it fall back to the nearest
 * weekly — and that fallback is for DASHBOARD display only; the bot's signal
 * engine and order guards independently reject any non-same-day expiry.
 */
async function fetchTradierUnusualOptions(token: string, price: number) {
  const todayExpiry = spyZeroDteExpiry();
  const sameDay = await fetchTradierOptionsChain(token, price, todayExpiry);
  if (sameDay && sameDay.length) return sameDay;
  // Dashboard-only fallback; bot still enforces 0DTE downstream.
  return fetchTradierOptionsChain(token, price, nextFridayExpiry());
}

function createInitialSnapshot(): MarketSnapshot {
  const config = getProviderConfig();
  const candles = generateCandles(SPY_FALLBACK);
  const candles5m = aggregateFiveMinuteCandles(candles);
  const candles2m = aggregateTwoMinuteCandles(candles);
  const candles15m = aggregateFifteenMinuteCandles(candles);
  const candles30m = aggregateThirtyMinuteCandles(candles);
  const dailyOpen = round(candles[0].open + 0.85);
  const premarketHigh = round(Math.max(...candles.slice(0, 25).map((item) => item.high)) + 0.55);
  const premarketLow = round(Math.min(...candles.slice(0, 25).map((item) => item.low)) - 0.45);
  const last = candles[candles.length - 1];
  const session = getMarketSession();
  const afterHours = computeAfterHours(last.close, dailyOpen, session);
  const vix = 17.8;
  const us10y = 4.48;
  const sentiment = inferSentiment(candles, vix, us10y, dailyOpen);
  const liquidity = inferLiquidity(candles);

  return {
    timestamp: new Date().toISOString(),
    connected: true,
    mode: "simulation",
    dataNotice:
      "Provider-ready stream. Live quote seeding is attempted; after-hours replay/simulation continues outside regular session. Institutional 0DTE options flow requires a licensed feed.",
    provider: {
      name: providerName(config),
      status: config.kind === "none" ? "missing-key" : "connecting",
      message:
        config.kind === "none"
          ? "Add TRADIER_TOKEN, POLYGON_API_KEY, MASSIVE_API_KEY, or FINNHUB_API_KEY to enable a real-time provider."
          : `Waiting for ${providerName(config)} real-time stream.`,
      capabilities:
        config.kind === "tradier"
          ? ["SPY quotes", "options chains", "options quotes", "streaming market data"]
          : config.kind === "polygon"
            ? ["SPY trades", "SPY aggregates", "options trades", "options quotes"]
            : config.kind === "finnhub"
              ? ["SPY trades", "economic calendar", "basic real-time quotes"]
              : ["replay candles", "indicator calculations", "setup engine"],
    },
    spy: {
      symbol: "SPY",
      price: last.close,
      change: round(last.close - dailyOpen),
      changePercent: round(((last.close - dailyOpen) / dailyOpen) * 100),
      ...afterHours,
      session,
      dailyOpen,
      premarketHigh,
      premarketLow,
      candles,
      candles5m,
      candles2m,
      candles15m,
      candles30m,
    },
    macro: {
      vix,
      vixChange: -0.18,
      us10y,
      us10yChange: 0.02,
    },
    sentiment,
    liquidity,
    setups: inferSetups(candles2m, sentiment, liquidity),
    economicCalendar: getCalendar(),
    breakingNews: [],
    newsUpdatedAt: null,
    unusualOptions: generateModeledUnusualOptions(last.close),
  };
}

async function fetchQuote(symbol: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?range=1d&interval=1m`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SPY0DTEWorkbench/1.0; +https://perplexity.ai)",
      },
      signal: AbortSignal.timeout(4_500),
    });

    if (!response.ok) return null;
    const body = (await response.json()) as any;
    const result = body.chart?.result?.[0];
    const prices = result?.indicators?.quote?.[0]?.close?.filter(
      (value: unknown) => typeof value === "number",
    );
    const last = prices?.at(-1);
    return typeof last === "number" && Number.isFinite(last) ? last : null;
  } catch {
    return null;
  }
}

const NEWS_FEEDS: Array<{ source: string; url: string }> = [
  { source: "CNBC Top News", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" },
  { source: "CNBC Markets", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069" },
  { source: "CNBC Economy", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258" },
  { source: "Reuters Markets", url: "https://news.google.com/rss/search?q=when:1d+SPY+OR+S%26P+500+OR+Federal+Reserve+OR+CPI+OR+jobs+OR+inflation&hl=en-US&gl=US&ceid=US:en" },
  { source: "Yahoo Finance Top", url: "https://news.google.com/rss/search?q=when:1d+stock+market+OR+wall+street+OR+Treasury+yield+OR+VIX&hl=en-US&gl=US&ceid=US:en" },
  { source: "MarketWatch", url: "https://feeds.marketwatch.com/marketwatch/topstories/" },
];

const NEWS_TAG_RULES: Array<{
  tag: string;
  pattern: RegExp;
  impact: BreakingNewsItem["impact"];
  severity: BreakingNewsItem["severity"];
  reason: string;
}> = [
  { tag: "FOMC", pattern: /\b(fomc|federal reserve|fed chair|powell|rate decision|fed minutes)\b/i, impact: "Volatility", severity: "High", reason: "Fed policy headlines drive SPY directly via rate expectations." },
  { tag: "Rate Cut", pattern: /\b(rate cut|cutting rates|dovish|easing)\b/i, impact: "Bullish", severity: "High", reason: "Cuts/dovish tone are typically bullish for SPY multiples." },
  { tag: "Rate Hike", pattern: /\b(rate hike|hiking rates|hawkish|tightening)\b/i, impact: "Bearish", severity: "High", reason: "Hikes/hawkish tone pressure SPY via higher discount rates." },
  { tag: "CPI", pattern: /\bcpi|consumer price\b/i, impact: "Volatility", severity: "High", reason: "CPI prints drive rate-cut odds and SPY tape immediately." },
  { tag: "PPI", pattern: /\bppi|producer price\b/i, impact: "Volatility", severity: "Medium", reason: "PPI feeds into core inflation expectations." },
  { tag: "Jobs", pattern: /\b(nfp|nonfarm payrolls|jobs report|unemployment|jobless claims|payrolls)\b/i, impact: "Volatility", severity: "High", reason: "Labor data shifts Fed path and risk appetite." },
  { tag: "GDP", pattern: /\bgdp|gross domestic product\b/i, impact: "Volatility", severity: "Medium", reason: "Growth prints affect cyclical SPY components." },
  { tag: "PMI", pattern: /\b(pmi|ism|purchasing managers)\b/i, impact: "Volatility", severity: "Medium", reason: "PMI/ISM tracks growth momentum, often a market mover." },
  { tag: "Retail Sales", pattern: /\bretail sales\b/i, impact: "Volatility", severity: "Medium", reason: "Retail sales gauge consumer health driving SPY." },
  { tag: "Yields", pattern: /\b(10[- ]year|treasury yield|bond yield|us10y|tnx)\b/i, impact: "Volatility", severity: "High", reason: "10Y yield moves are inversely correlated with SPY multiples." },
  { tag: "Dollar", pattern: /\b(dxy|dollar index|us dollar)\b/i, impact: "Volatility", severity: "Medium", reason: "Stronger/weaker USD shifts risk assets and SPY." },
  { tag: "VIX", pattern: /\b(vix|volatility index|fear gauge)\b/i, impact: "Volatility", severity: "High", reason: "VIX moves directly with SPY realized risk." },
  { tag: "Index", pattern: /\b(s&p ?500|spx|spy|nasdaq|dow jones|russell)\b/i, impact: "Neutral", severity: "Medium", reason: "Broad-index headline affecting SPY directly." },
  { tag: "Mega-Cap", pattern: /\b(nvidia|nvda|apple|aapl|microsoft|msft|amazon|amzn|alphabet|googl?|meta|tesla|tsla)\b/i, impact: "Neutral", severity: "Medium", reason: "Mega-cap concentration means single-name moves swing SPY." },
  { tag: "Earnings", pattern: /\b(earnings|guidance|profit warning|revenue beat|missed estimates)\b/i, impact: "Neutral", severity: "Medium", reason: "Mega-cap earnings/guidance often move SPY in size." },
  { tag: "Banks", pattern: /\b(bank|banking crisis|deposit|svb|liquidity|credit suisse|regional bank)\b/i, impact: "Bearish", severity: "High", reason: "Banking/liquidity stress is a major SPY risk-off driver." },
  { tag: "Geopolitics", pattern: /\b(war|attack|missile|israel|gaza|ukraine|russia|china|iran|north korea|taiwan|strait)\b/i, impact: "Bearish", severity: "High", reason: "Geopolitical escalation typically triggers SPY risk-off." },
  { tag: "Oil", pattern: /\b(oil price|crude|opec|brent|wti)\b/i, impact: "Volatility", severity: "Medium", reason: "Oil shocks feed inflation and SPY sector dispersion." },
  { tag: "Tariffs", pattern: /\b(tariff|trade war|sanctions)\b/i, impact: "Bearish", severity: "High", reason: "Tariff/trade-war headlines pressure SPY globals." },
  { tag: "Shutdown", pattern: /\b(government shutdown|debt ceiling|continuing resolution)\b/i, impact: "Bearish", severity: "High", reason: "Fiscal cliffs/shutdowns are SPY-negative event risks." },
  { tag: "Recession", pattern: /\b(recession|downturn|hard landing|stagflation)\b/i, impact: "Bearish", severity: "Medium", reason: "Recession narrative compresses SPY multiples." },
  { tag: "Rally", pattern: /\b(rally|record high|all[- ]time high|surge|soars)\b/i, impact: "Bullish", severity: "Low", reason: "Trend-confirming bullish framing." },
  { tag: "Selloff", pattern: /\b(selloff|sell-off|plunge|tumble|slump|rout|crash)\b/i, impact: "Bearish", severity: "Medium", reason: "Trend-confirming bearish framing." },
];

const SPY_TOPIC_PATTERN = /\b(spy|s&p ?500|spx|nasdaq|dow|wall street|stock market|federal reserve|fomc|cpi|ppi|inflation|jobs|payrolls|unemployment|gdp|pmi|ism|retail sales|treasury|10[- ]year|yield|vix|volatility|dollar|dxy|nvidia|nvda|apple|aapl|microsoft|msft|amazon|amzn|alphabet|googl?|meta|tesla|tsla|bank|recession|oil|crude|tariff|shutdown|debt ceiling|earnings|powell|rate cut|rate hike|hawkish|dovish|geopolit|war|israel|ukraine|russia|china)\b/i;

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function extractTag(xml: string, tag: string): string | null {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const cdataMatch = xml.match(cdata);
  if (cdataMatch) return decodeHtmlEntities(cdataMatch[1].trim());
  const plainMatch = xml.match(plain);
  if (plainMatch) return decodeHtmlEntities(plainMatch[1].replace(/<[^>]+>/g, "").trim());
  return null;
}

function parseRssItems(xml: string, source: string): BreakingNewsItem[] {
  const items: BreakingNewsItem[] = [];
  const itemRegex = /<item[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRegex) ?? [];
  for (const itemXml of matches.slice(0, 25)) {
    const title = extractTag(itemXml, "title");
    if (!title) continue;
    const link = extractTag(itemXml, "link");
    const pubDate = extractTag(itemXml, "pubDate") ?? extractTag(itemXml, "dc:date");
    const description = extractTag(itemXml, "description") ?? "";
    const haystack = `${title} ${description}`;
    if (!SPY_TOPIC_PATTERN.test(haystack)) continue;
    const classified = classifyNews(title, description);
    const isoDate = pubDate ? new Date(pubDate).toISOString() : null;
    const id = `${source}::${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 96);
    items.push({
      id,
      title: title.length > 220 ? `${title.slice(0, 217)}...` : title,
      source,
      url: link,
      publishedAt: isoDate && !Number.isNaN(new Date(isoDate).getTime()) ? isoDate : null,
      impact: classified.impact,
      severity: classified.severity,
      reason: classified.reason,
      tags: classified.tags,
    });
  }
  return items;
}

function classifyNews(title: string, description: string) {
  const haystack = `${title} ${description}`;
  const matchedTags: string[] = [];
  let impact: BreakingNewsItem["impact"] = "Neutral";
  let severity: BreakingNewsItem["severity"] = "Low";
  const reasons: string[] = [];
  const severityRank = { Low: 0, Medium: 1, High: 2 } as const;

  for (const rule of NEWS_TAG_RULES) {
    if (!rule.pattern.test(haystack)) continue;
    matchedTags.push(rule.tag);
    if (severityRank[rule.severity] > severityRank[severity]) {
      severity = rule.severity;
    }
    if (impact === "Neutral" || (impact === "Volatility" && rule.impact !== "Neutral")) {
      impact = rule.impact;
    }
    if (reasons.length < 2) reasons.push(rule.reason);
  }

  if (!matchedTags.length) {
    matchedTags.push("Market");
    reasons.push("Broad market headline; monitor for SPY follow-through.");
  }

  return {
    impact,
    severity,
    reason: reasons.join(" "),
    tags: Array.from(new Set(matchedTags)),
  };
}

async function fetchFeed(source: string, url: string): Promise<BreakingNewsItem[]> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SPY0DTEWorkbench/1.0; +https://perplexity.ai)",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(5_500),
    });
    if (!response.ok) return [];
    const text = await response.text();
    return parseRssItems(text, source);
  } catch {
    return [];
  }
}

async function refreshBreakingNews(force = false) {
  const now = Date.now();
  if (!force && now - lastNewsFetchMs < 60_000) return;
  if (newsRefreshInFlight) {
    await newsRefreshInFlight;
    return;
  }

  newsRefreshInFlight = (async () => {
    lastNewsFetchMs = now;
    try {
      const results = await Promise.all(
        NEWS_FEEDS.map((feed) => fetchFeed(feed.source, feed.url)),
      );
      const merged = new Map<string, BreakingNewsItem>();
      for (const items of results) {
        for (const item of items) {
          const existing = merged.get(item.id);
          if (!existing) merged.set(item.id, item);
        }
      }
      const sorted = Array.from(merged.values()).sort((a, b) => {
        const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return bTime - aTime;
      });

      if (sorted.length === 0) {
        snapshot = {
          ...snapshot,
          newsUpdatedAt: snapshot.newsUpdatedAt ?? null,
        };
        return;
      }

      snapshot = {
        ...snapshot,
        breakingNews: sorted.slice(0, 30),
        newsUpdatedAt: new Date().toISOString(),
      };
    } finally {
      newsRefreshInFlight = null;
    }
  })();

  await newsRefreshInFlight;
}

function applyProviderPrice(price: number, providerMessage: string) {
  if (!Number.isFinite(price) || price <= 0) return;

  const candles = [...snapshot.spy.candles];
  // Sanitize last candle first so running high/low accumulation cannot inherit bad values.
  const lastRaw = candles[candles.length - 1];
  const last = sanitizeCandle(lastRaw);
  candles[candles.length - 1] = last;
  const now = new Date();
  const nowMinute = minuteBucket(now);
  const lastMinute = minuteBucket(last.time);
  const isSameMinute = nowMinute === lastMinute;
  const isFutureCandle = lastMinute > nowMinute;
  const candleTime = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const volume = Math.round(900_000 + Math.random() * 1_800_000);
  // Tight price-domain high/low: use clean open/close body + small plausible wick.
  // Do NOT inherit last.high/last.low — that accumulates wide values across ticks.
  const bodyHigh = Math.max(last.close, price);
  const bodyLow  = Math.min(last.close, price);
  const high = bodyHigh + Math.random() * 0.12 + 0.02;
  const low  = bodyLow  - Math.random() * 0.12 - 0.02;

  if (isSameMinute || isFutureCandle) {
    // Running same-minute update: expand high/low only within tight wick band
    const prevBodyHigh = Math.max(last.open ?? last.close, last.close);
    const prevBodyLow  = Math.min(last.open ?? last.close, last.close);
    const maxWick = Math.min(Math.max(prevBodyHigh, price) * maxWickPct(), maxWickAbs());
    const updHigh = Math.min(Math.max(last.high, high), Math.max(prevBodyHigh, price) + maxWick);
    const updLow  = Math.max(Math.min(last.low,  low),  Math.min(prevBodyLow,  price) - maxWick);
    candles[candles.length - 1] = {
      ...last,
      time: candleTime.toISOString(),
      label: marketLabel(candleTime),
      high: round(updHigh, 2),
      low: round(updLow, 2),
      close: round(price),
      volume: last.volume + volume,
    };
  } else {
    candles.push({
      time: candleTime.toISOString(),
      label: marketLabel(candleTime),
      open: round(last.close),
      high: round(high, 2),
      low: round(low, 2),
      close: round(price),
      volume,
    });
  }

  const updatedCandles = addIndicators(candles.slice(-160));
  const updatedLast = updatedCandles[updatedCandles.length - 1];
  const updatedCandles5m = aggregateFiveMinuteCandles(updatedCandles);
  const updatedCandles2m = aggregateTwoMinuteCandles(updatedCandles);
  const updatedCandles15m = aggregateFifteenMinuteCandles(updatedCandles);
  const updatedCandles30m = aggregateThirtyMinuteCandles(updatedCandles);
  const sentiment = inferSentiment(
    updatedCandles,
    snapshot.macro.vix,
    snapshot.macro.us10y,
    snapshot.spy.dailyOpen,
  );
  const liquidity = inferLiquidity(updatedCandles);
  const session = getMarketSession(now);
  const afterHours = computeAfterHours(updatedLast.close, snapshot.spy.dailyOpen, session);

  snapshot = {
    ...snapshot,
    timestamp: now.toISOString(),
    mode: "provider-live",
    dataNotice:
      "Real-time provider stream is active. Options-flow depth depends on your provider subscription and OPRA permissions.",
    provider: {
      ...snapshot.provider,
      name: providerName(),
      status: "connected",
      message: providerMessage,
      lastProviderUpdate: now.toISOString(),
    },
    spy: {
      ...snapshot.spy,
      price: updatedLast.close,
      change: round(updatedLast.close - snapshot.spy.dailyOpen),
      changePercent: round(
        ((updatedLast.close - snapshot.spy.dailyOpen) / snapshot.spy.dailyOpen) * 100,
      ),
      ...afterHours,
      session,
      candles: updatedCandles,
      candles5m: updatedCandles5m,
      candles2m: updatedCandles2m,
      candles15m: updatedCandles15m,
      candles30m: updatedCandles30m,
    },
    sentiment,
    liquidity,
    setups: inferSetups(updatedCandles2m, sentiment, liquidity),
    economicCalendar: getCalendar(),
    breakingNews: snapshot?.breakingNews ?? [],
    newsUpdatedAt: snapshot?.newsUpdatedAt ?? null,
    unusualOptions: snapshot.unusualOptions.length
      ? snapshot.unusualOptions
      : generateModeledUnusualOptions(updatedLast.close),
  };
}

async function seedFromPublicQuotes() {
  const [spy, vix, us10y] = await Promise.all([
    fetchQuote("SPY"),
    fetchQuote("^VIX"),
    fetchQuote("^TNX"),
  ]);

  if (!spy) return;

  const candles = generateCandles(spy);
  const candles5m = aggregateFiveMinuteCandles(candles);
  const candles2m = aggregateTwoMinuteCandles(candles);
  const candles15m = aggregateFifteenMinuteCandles(candles);
  const candles30m = aggregateThirtyMinuteCandles(candles);
  const last = candles[candles.length - 1];
  const dailyOpen = round(spy - 0.65 + Math.random() * 1.3);
  const premarketHigh = round(spy + 1.2);
  const premarketLow = round(spy - 1.8);
  const vixValue = round(vix ?? snapshot.macro.vix, 2);
  const rawUs10y = us10y ?? snapshot.macro.us10y;
  const us10yValue = normalizeTenYearYield(rawUs10y);
  lastMacroFetchMs = Date.now();
  const sentiment = inferSentiment(candles, vixValue, us10yValue, dailyOpen);
  const liquidity = inferLiquidity(candles);
  const session = getMarketSession();
  const afterHours = computeAfterHours(last.close, dailyOpen, session);

  snapshot = {
    ...snapshot,
    timestamp: new Date().toISOString(),
    mode: "live-seeded",
    dataNotice:
      "Live quote seeded; replay/simulation keeps the dashboard moving outside regular market hours. Institutional 0DTE options flow requires a licensed feed.",
    provider:
      snapshot.provider.status === "connected"
        ? snapshot.provider
        : {
            ...snapshot.provider,
            name: providerName() === "Replay" ? "Public seed" : providerName(),
            status: getProviderConfig().kind === "none" ? "missing-key" : "connecting",
            message:
              getProviderConfig().kind === "none"
                ? "No real-time provider key detected. Public quotes seed the dashboard; replay continues between updates."
                : `${providerName()} key detected; waiting for streaming connection.`,
          },
    spy: {
      ...snapshot.spy,
      price: last.close,
      dailyOpen,
      premarketHigh,
      premarketLow,
      change: round(last.close - dailyOpen),
      changePercent: round(((last.close - dailyOpen) / dailyOpen) * 100),
      ...afterHours,
      session,
      candles,
      candles5m,
      candles2m,
      candles15m,
      candles30m,
    },
    macro: {
      vix: vixValue,
      vixChange: round(vixValue - snapshot.macro.vix, 2),
      us10y: us10yValue,
      us10yChange: round(us10yValue - snapshot.macro.us10y, 3),
    },
    sentiment,
    liquidity,
    setups: inferSetups(candles2m, sentiment, liquidity),
    economicCalendar: getCalendar(),
    breakingNews: snapshot?.breakingNews ?? [],
    newsUpdatedAt: snapshot?.newsUpdatedAt ?? null,
    unusualOptions: generateModeledUnusualOptions(last.close),
  };
}

function advanceSnapshot() {
  const isProviderFresh =
    snapshot.provider.status === "connected" &&
    snapshot.provider.lastProviderUpdate &&
    Date.now() - new Date(snapshot.provider.lastProviderUpdate).getTime() < 12_000;

  if (isProviderFresh) return;

  cycle += 1;
  const candles = [...snapshot.spy.candles];
  // Sanitize last candle so running high/low max/min cannot inherit corrupted values.
  const lastRaw = candles[candles.length - 1];
  const last = sanitizeCandle(lastRaw);
  candles[candles.length - 1] = last;
  const pressure =
    (snapshot.sentiment.score / 100) * 0.11 +
    Math.sin(cycle / 6) * 0.06 +
    (Math.random() - 0.5) * 0.3;
  const open = last.close;
  const close = Math.max(1, open + pressure);
  const high = Math.max(open, close) + Math.random() * 0.12 + 0.02;
  const low = Math.min(open, close) - Math.random() * 0.12 - 0.02;
  const volume = Math.round(700_000 + Math.random() * 2_800_000);
  const now = new Date();
  const nowMinute = minuteBucket(now);
  const lastMinute = minuteBucket(last.time);
  const isSameMinute = nowMinute === lastMinute;
  const isFutureCandle = lastMinute > nowMinute;
  const candleTime = new Date(Math.floor(now.getTime() / 60_000) * 60_000);

  if (isSameMinute || isFutureCandle) {
    // Running same-minute update: only expand high/low within a tight wick band to avoid accumulation
    const prevBodyHigh = Math.max(last.open ?? last.close, last.close);
    const prevBodyLow  = Math.min(last.open ?? last.close, last.close);
    const maxWick = Math.min(Math.max(prevBodyHigh, close) * maxWickPct(), maxWickAbs());
    const updHigh = Math.min(Math.max(last.high, high), Math.max(prevBodyHigh, close) + maxWick);
    const updLow  = Math.max(Math.min(last.low,  low),  Math.min(prevBodyLow,  close) - maxWick);
    candles[candles.length - 1] = {
      ...last,
      time: candleTime.toISOString(),
      label: marketLabel(candleTime),
      high: round(updHigh, 2),
      low: round(updLow, 2),
      close: round(close),
      volume: last.volume + volume,
    };
  } else {
    candles.push({
      time: candleTime.toISOString(),
      label: marketLabel(candleTime),
      open: round(open),
      high: round(high, 2),
      low: round(low, 2),
      close: round(close),
      volume,
    });
  }

  const updatedCandles = addIndicators(candles.slice(-120));
  const updatedLast = updatedCandles[updatedCandles.length - 1];
  const updatedCandles5m = aggregateFiveMinuteCandles(updatedCandles);
  const updatedCandles2m = aggregateTwoMinuteCandles(updatedCandles);
  const updatedCandles15m = aggregateFifteenMinuteCandles(updatedCandles);
  const updatedCandles30m = aggregateThirtyMinuteCandles(updatedCandles);
  const vix = round(
    clamp(snapshot.macro.vix + (Math.random() - 0.5) * 0.12 - pressure * 0.06, 10, 38),
    2,
  );
  const us10y = round(
    clamp(snapshot.macro.us10y + (Math.random() - 0.5) * 0.012, 2.5, 6.5),
    3,
  );
  const sentiment = inferSentiment(
    updatedCandles,
    vix,
    us10y,
    snapshot.spy.dailyOpen,
  );
  const liquidity = inferLiquidity(updatedCandles);
  const session = getMarketSession(now);
  const afterHours = computeAfterHours(
    updatedLast.close,
    snapshot.spy.dailyOpen,
    session,
  );

  snapshot = {
    ...snapshot,
    timestamp: now.toISOString(),
    mode: snapshot.provider.status === "connected" ? "provider-live" : snapshot.mode,
    dataNotice:
      snapshot.provider.status === "connected"
        ? "Provider feed is active; replay smoothing fills brief gaps between provider ticks."
        : snapshot.dataNotice,
    provider:
      snapshot.provider.status === "connected" &&
      snapshot.provider.lastProviderUpdate &&
      Date.now() - new Date(snapshot.provider.lastProviderUpdate).getTime() >= 12_000
        ? {
            ...snapshot.provider,
            status: "fallback",
            message:
              "Provider stream has not sent a recent SPY tick; replay smoothing is filling the gap.",
          }
        : snapshot.provider,
    spy: {
      ...snapshot.spy,
      price: updatedLast.close,
      change: round(updatedLast.close - snapshot.spy.dailyOpen),
      changePercent: round(
        ((updatedLast.close - snapshot.spy.dailyOpen) / snapshot.spy.dailyOpen) * 100,
      ),
      ...afterHours,
      session,
      candles: updatedCandles,
      candles5m: updatedCandles5m,
      candles2m: updatedCandles2m,
      candles15m: updatedCandles15m,
      candles30m: updatedCandles30m,
    },
    macro: {
      vix,
      vixChange: round(vix - snapshot.macro.vix, 2),
      us10y,
      us10yChange: round(us10y - snapshot.macro.us10y, 3),
    },
    sentiment,
    liquidity,
    setups: inferSetups(updatedCandles2m, sentiment, liquidity),
    economicCalendar: getCalendar(),
    breakingNews: snapshot?.breakingNews ?? [],
    newsUpdatedAt: snapshot?.newsUpdatedAt ?? null,
    unusualOptions: snapshot.unusualOptions.length
      ? snapshot.unusualOptions
      : generateModeledUnusualOptions(updatedLast.close),
  };
}

function broadcast(wss: WebSocketServer, data: MarketSnapshot) {
  const message = JSON.stringify({ type: "snapshot", payload: data });
  wss.clients.forEach((client) => {
    if (client.readyState === WsSocket.OPEN) {
      client.send(message);
    }
  });
}

function parseProviderPrice(payload: any, config: ProviderConfig): number | null {
  if (!payload) return null;

  const messages = Array.isArray(payload) ? payload : [payload];

  for (const message of messages) {
    if (config.kind === "polygon") {
      if (
        (message.ev === "A" || message.ev === "AM" || message.ev === "T") &&
        (message.sym === "SPY" || message.sym === "SPY ") &&
        typeof (message.c ?? message.p) === "number"
      ) {
        return message.c ?? message.p;
      }
    }

    if (config.kind === "finnhub") {
      const trade = Array.isArray(message.data) ? message.data.find((item: any) => item.s === "SPY") : null;
      if (trade && typeof trade.p === "number") return trade.p;
    }

    if (config.kind === "tradier") {
      if (
        (message.symbol === "SPY" || message.sym === "SPY") &&
        typeof (message.price ?? message.last ?? message.bid) === "number"
      ) {
        return message.price ?? message.last ?? message.bid;
      }
    }
  }

  return null;
}

async function pollTradierQuote(token: string, wss: WebSocketServer) {
  try {
    const response = await fetch(
      "https://api.tradier.com/v1/markets/quotes?symbols=SPY,VIX--,TNX--",
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(4_500),
      },
    );

    if (!response.ok) {
      snapshot = {
        ...snapshot,
        provider: {
          ...snapshot.provider,
          name: "Tradier",
          status: "error",
          message: `Tradier quote request failed with HTTP ${response.status}.`,
        },
      };
      broadcast(wss, snapshot);
      return;
    }

    const body = (await response.json()) as any;
    const quotes = body.quotes?.quote
      ? Array.isArray(body.quotes.quote)
        ? body.quotes.quote
        : [body.quotes.quote]
      : [];
    const spy = quotes.find((quote: any) => quote.symbol === "SPY");
    const vixQuote = quotes.find((quote: any) =>
      String(quote.symbol ?? "").toUpperCase().includes("VIX"),
    );
    const tenYearQuote = quotes.find((quote: any) => {
      const symbol = String(quote.symbol ?? "").toUpperCase();
      return symbol.includes("TNX") || symbol.includes("10Y");
    });
    const tradierVix = typeof vixQuote?.last === "number" ? vixQuote.last : null;
    const tradierTenYear = typeof tenYearQuote?.last === "number" ? tenYearQuote.last : null;
    applyMacroQuotes(tradierVix, tradierTenYear);
    if (!tradierVix || !tradierTenYear) {
      await refreshPublicMacroQuotes();
    }

    if (typeof spy?.last === "number") {
      const extendedPrice =
        typeof spy.postmarket_last === "number"
          ? spy.postmarket_last
          : typeof spy.premarket_last === "number"
            ? spy.premarket_last
            : spy.last;
      applyProviderPrice(
        extendedPrice,
        "Tradier real-time quote polling active for SPY, including extended-hours fields when available.",
      );
      const unusualOptions = await fetchTradierUnusualOptions(token, extendedPrice);
      snapshot = {
        ...snapshot,
        unusualOptions: unusualOptions ?? generateModeledUnusualOptions(extendedPrice),
      };
      broadcast(wss, snapshot);
    }
  } catch {
    snapshot = {
      ...snapshot,
      provider: {
        ...snapshot.provider,
        name: "Tradier",
        status: "fallback",
        message: "Tradier did not respond in time; replay smoothing remains active.",
      },
    };
    broadcast(wss, snapshot);
  }
}

function startPolygonStream(token: string, wss: WebSocketServer) {
  providerSocket?.close();
  const socket = new WsSocket("wss://socket.polygon.io/stocks");
  providerSocket = socket;

  snapshot = {
    ...snapshot,
    provider: {
      ...snapshot.provider,
      name: "Polygon/Massive",
      status: "connecting",
      message: "Connecting to Polygon/Massive stock WebSocket for SPY.",
    },
  };

  socket.on("open", () => {
    socket.send(JSON.stringify({ action: "auth", params: token }));
    socket.send(JSON.stringify({ action: "subscribe", params: "T.SPY,A.SPY,AM.SPY" }));
  });

  socket.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      const price = parseProviderPrice(payload, { kind: "polygon", token });
      if (price) {
        applyProviderPrice(price, "Polygon/Massive stock WebSocket active for SPY.");
        broadcast(wss, snapshot);
      }
    } catch {
      // Ignore malformed provider packets.
    }
  });

  socket.on("close", () => {
    snapshot = {
      ...snapshot,
      provider: {
        ...snapshot.provider,
        name: "Polygon/Massive",
        status: "fallback",
        message: "Polygon/Massive stream closed; replay smoothing remains active.",
      },
    };
    broadcast(wss, snapshot);
  });

  socket.on("error", () => {
    snapshot = {
      ...snapshot,
      provider: {
        ...snapshot.provider,
        name: "Polygon/Massive",
        status: "error",
        message: "Polygon/Massive stream errored. Check API key and subscription entitlements.",
      },
    };
    broadcast(wss, snapshot);
  });
}

function startFinnhubStream(token: string, wss: WebSocketServer) {
  providerSocket?.close();
  const socket = new WsSocket(`wss://ws.finnhub.io?token=${token}`);
  providerSocket = socket;

  snapshot = {
    ...snapshot,
    provider: {
      ...snapshot.provider,
      name: "Finnhub",
      status: "connecting",
      message: "Connecting to Finnhub WebSocket for SPY trades.",
    },
  };

  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "subscribe", symbol: "SPY" }));
  });

  socket.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      const price = parseProviderPrice(payload, { kind: "finnhub", token });
      if (price) {
        applyProviderPrice(price, "Finnhub WebSocket active for SPY trades.");
        broadcast(wss, snapshot);
      }
    } catch {
      // Ignore malformed provider packets.
    }
  });

  socket.on("close", () => {
    snapshot = {
      ...snapshot,
      provider: {
        ...snapshot.provider,
        name: "Finnhub",
        status: "fallback",
        message: "Finnhub stream closed; replay smoothing remains active.",
      },
    };
    broadcast(wss, snapshot);
  });

  socket.on("error", () => {
    snapshot = {
      ...snapshot,
      provider: {
        ...snapshot.provider,
        name: "Finnhub",
        status: "error",
        message: "Finnhub stream errored. Check API key and subscription entitlements.",
      },
    };
    broadcast(wss, snapshot);
  });
}

/**
 * Real SPY 1m historical backfill from Tradier's timesales endpoint, so the
 * MTF candle stream the bot reasons over at boot is real bars — not the
 * synthetic random-walk seed from createInitialSnapshot. Returns null when
 * Tradier doesn't respond or the response is empty (caller keeps the seed).
 *
 * Includes pre-market 1m bars so we can derive a real dailyOpen and
 * premarketHigh/premarketLow for the open-window overrides.
 */
async function fetchTradierBackfill(token: string): Promise<{
  rthCandles: Candle[];
  premarketHigh: number | null;
  premarketLow: number | null;
  dailyOpen: number | null;
} | null> {
  const now = new Date();
  const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const start = `${nyDate} 04:00`;
  const end = `${nyDate} 20:00`;
  const url =
    `https://api.tradier.com/v1/markets/timesales?symbol=SPY&interval=1min` +
    `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&session_filter=all`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: any;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const seriesData = body?.series?.data;
  const raw: any[] = Array.isArray(seriesData) ? seriesData : seriesData ? [seriesData] : [];
  if (!raw.length) return null;

  // ET → UTC offset for today (handles EST/EDT).
  const probe = new Date(`${nyDate}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(probe);
  const etH = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  const etM = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const etOffsetMin = etH * 60 + etM - 12 * 60; // ET − UTC, minutes

  // 09:30 ET in UTC ms for the requested date.
  const rthOpenMs = Date.parse(`${nyDate}T09:30:00Z`) - etOffsetMin * 60_000;

  const rthCandles: Candle[] = [];
  let premarketHigh: number | null = null;
  let premarketLow: number | null = null;
  let dailyOpen: number | null = null;

  for (const row of raw) {
    if (typeof row?.open !== "number" || typeof row?.close !== "number") continue;
    const ts: string | undefined = typeof row.time === "string" ? row.time : undefined;
    if (!ts) continue;
    const utcMs = Date.parse(`${ts}Z`) - etOffsetMin * 60_000;
    if (!Number.isFinite(utcMs)) continue;

    const isPremarket = utcMs < rthOpenMs;
    if (isPremarket) {
      if (typeof row.high === "number" && (premarketHigh == null || row.high > premarketHigh)) premarketHigh = row.high;
      if (typeof row.low === "number" && (premarketLow == null || row.low < premarketLow)) premarketLow = row.low;
      continue;
    }
    if (dailyOpen == null) dailyOpen = row.open;
    const t = new Date(utcMs);
    rthCandles.push({
      time: t.toISOString(),
      label: marketLabel(t),
      open: row.open,
      high: typeof row.high === "number" ? row.high : row.open,
      low: typeof row.low === "number" ? row.low : row.open,
      close: row.close,
      volume: typeof row.volume === "number" ? row.volume : 0,
    });
  }

  if (!rthCandles.length) return null;
  return {
    rthCandles: addIndicators(rthCandles),
    premarketHigh,
    premarketLow,
    dailyOpen,
  };
}

function startProviderFeed(wss: WebSocketServer) {
  if (providerStarted) return;
  providerStarted = true;
  const config = getProviderConfig();

  if (config.kind === "none") return;

  snapshot = {
    ...snapshot,
    provider: {
      ...snapshot.provider,
      name: providerName(config),
      status: "connecting",
      message: `Starting ${providerName(config)} real-time feed.`,
    },
  };

  if (config.kind === "tradier") {
    // Backfill before polling so the engine never reasons over the synthetic
    // random-walk seed once Tradier is the configured provider.
    void (async () => {
      const backfill = await fetchTradierBackfill(config.token);
      if (backfill && backfill.rthCandles.length >= 5) {
        const candles = backfill.rthCandles;
        const last = candles[candles.length - 1];
        const candles5m = aggregateFiveMinuteCandles(candles);
        const candles2m = aggregateTwoMinuteCandles(candles);
        const candles15m = aggregateFifteenMinuteCandles(candles);
        const candles30m = aggregateThirtyMinuteCandles(candles);
        const sentiment = inferSentiment(
          candles,
          snapshot.macro.vix,
          snapshot.macro.us10y,
          backfill.dailyOpen ?? last.open,
        );
        const liquidity = inferLiquidity(candles);
        snapshot = {
          ...snapshot,
          spy: {
            ...snapshot.spy,
            price: last.close,
            dailyOpen: backfill.dailyOpen ?? last.open,
            premarketHigh: backfill.premarketHigh ?? snapshot.spy.premarketHigh,
            premarketLow: backfill.premarketLow ?? snapshot.spy.premarketLow,
            candles,
            candles5m,
            candles2m,
            candles15m,
            candles30m,
          },
          sentiment,
          liquidity,
          setups: inferSetups(candles2m, sentiment, liquidity),
          mode: "provider-live",
        };
        broadcast(wss, snapshot);
        console.log(
          `[tradier-backfill] seeded ${candles.length} real SPY 1m RTH bars; ` +
            `dailyOpen=${backfill.dailyOpen} premarketHigh/Low=${backfill.premarketHigh}/${backfill.premarketLow}`,
        );
      } else {
        console.warn("[tradier-backfill] no historical bars returned — engine will boot on synthetic seed until live ticks arrive");
      }
      void pollTradierQuote(config.token, wss);
      providerInterval = setInterval(() => {
        providerHeartbeat += 1;
        void pollTradierQuote(config.token, wss);
      }, 2_500);
    })();
  }

  if (config.kind === "polygon") {
    startPolygonStream(config.token, wss);
  }

  if (config.kind === "finnhub") {
    startFinnhubStream(config.token, wss);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  await seedFromPublicQuotes();

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  startProviderFeed(wss);
  void refreshBreakingNews(true)
    .then(() => broadcast(wss, snapshot))
    .catch(() => {});

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", payload: snapshot }));
  });

  app.get("/api/snapshot", (_req, res) => {
    res.json(snapshot);
  });

  app.get("/api/news", (_req, res) => {
    res.json({
      updatedAt: snapshot.newsUpdatedAt,
      items: snapshot.breakingNews,
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mode: snapshot.mode,
      updatedAt: snapshot.timestamp,
      newsUpdatedAt: snapshot.newsUpdatedAt,
      newsItems: snapshot.breakingNews.length,
    });
  });

  // ── Bot routes: /api/bot/* ────────────────────────────────────────────────
  registerBotRoutes(app, () => snapshot);

  // ── Autonomous engine ─────────────────────────────────────────────────────
  // Always started so /api/bot/automation/status stays live, but real orders
  // require TRADIER_AUTO_TRADE=true plus the full live env (defaults OFF).
  startAutomationEngine(() => snapshot as unknown as SnapshotForSignal);

  setInterval(async () => {
    advanceSnapshot();
    broadcast(wss, snapshot);
    persistCounter += 1;

    if (persistCounter % 10 === 0) {
      await storage.createDashboardSnapshot({
        createdAt: new Date().toISOString(),
        payload: JSON.stringify(snapshot),
      });
    }
  }, 2_500);

  setInterval(() => {
    void refreshBreakingNews()
      .then(() => broadcast(wss, snapshot))
      .catch(() => {});
  }, 90_000);

  return httpServer;
}
