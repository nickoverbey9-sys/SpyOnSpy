/**
 * Yahoo Finance SPY 1m loader — free, no API key, ~30 days of recent 1m
 * history (Yahoo caps each request at 8 days; we fetch one session at a time).
 *
 * Used as the SPY underlying source when ThetaData's stock-1m endpoint is
 * gated to a higher subscription tier than the user has. Option NBBO quotes
 * still come from ThetaData; this loader only handles the 1m underlying.
 */

import type { MtfCandle } from "../server/bot/marketStructure.js";

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart/SPY";

interface YahooChartResponse {
  chart: {
    result?: Array<{
      timestamp: number[];
      indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

/** "2026-06-12" → unix seconds for 09:30 ET on that date (RTH open). */
function rthBoundsSec(isoDate: string): { start: number; end: number } {
  const probe = new Date(`${isoDate}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(probe);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const etOffsetMin = h * 60 + m - 12 * 60; // ET − UTC, minutes
  const utcMid = Date.parse(`${isoDate}T00:00:00Z`);
  // 09:00 ET → 09:30 ET window broadened slightly so Yahoo's bucket alignment
  // includes the 09:30 opening bar.
  const start = Math.floor((utcMid + (9 * 60 - etOffsetMin) * 60_000) / 1000);
  const end = Math.floor((utcMid + (16 * 60 + 5 - etOffsetMin) * 60_000) / 1000);
  return { start, end };
}

/** Real SPY 1m OHLC bars (RTH) for one session, from Yahoo Finance. */
export async function loadYahooSpyOhlc1m(isoDate: string): Promise<MtfCandle[]> {
  const { start, end } = rthBoundsSec(isoDate);
  const url = `${BASE}?interval=1m&period1=${start}&period2=${end}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status} for ${isoDate}`);
  const data = (await r.json()) as YahooChartResponse;
  if (data.chart.error) {
    throw new Error(`Yahoo error for ${isoDate}: ${data.chart.error.description ?? data.chart.error.code}`);
  }
  const result = data.chart.result?.[0];
  if (!result) throw new Error(`Yahoo returned no result for ${isoDate}`);
  const ts = result.timestamp ?? [];
  const q = result.indicators.quote[0];
  const bars: MtfCandle[] = [];
  // Filter strictly to RTH (09:30–16:00 ET) on the requested date. `start` is
  // 09:00 ET (the request window starts 30 min before open), so the RTH close
  // is start + 7h, not start + 6.5h.
  const rthOpen = start + 30 * 60;
  const rthClose = start + 7 * 60 * 60;
  for (let i = 0; i < ts.length; i += 1) {
    if (ts[i] < rthOpen || ts[i] >= rthClose) continue;
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    const v = q.volume[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!(o > 0) || !(c > 0)) continue;
    bars.push({
      time: new Date(ts[i] * 1000).toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
    });
  }
  return bars;
}
