/**
 * ThetaData v3 loader — real historical SPY 1m bars + 0DTE option NBBO quotes
 * for the backtest, served by the local Theta Terminal v3 (port 25503).
 *
 * ─── HOW IT WORKS ───────────────────────────────────────────────────────────
 * Run the v3 Theta Terminal locally (authenticated with YOUR account) and this
 * loader talks to it on localhost. Default base URL: http://127.0.0.1:25503.
 *
 * SPY underlying 1m bars: ThetaData gates intraday stock history behind a
 * Stock-Value subscription. When the terminal reports FREE for stock we
 * derive a 1m SPY tape from put-call parity on the real ATM 0DTE option
 * quotes that ARE in the Option-Value tier — SPY(t) ≈ K + Cmid(t) − Pmid(t).
 * The bars carry real, minute-aligned price discovery; OHLC collapses to the
 * minute mid (open=high=low=close), which is what the bot's per-bar driver
 * already consumes.
 *
 * Optional env:
 *   THETA_TERMINAL_URL       default http://127.0.0.1:25503
 *   THETA_REQUEST_DELAY_MS   default 350 (Value tier: max 2 concurrent — keep
 *                            throttle conservative; this is a serial floor)
 *   BOT_BACKTEST_SESSIONS    default 5
 *
 * Endpoints (v3):
 *   /v3/option/list/expirations            symbol
 *   /v3/stock/history/eod                  symbol, start_date, end_date  (free)
 *   /v3/stock/history/ohlc                 symbol, date, interval  (Value-stock)
 *   /v3/option/history/quote               symbol, expiration, strike, right,
 *                                          date, interval
 */

import type { MtfCandle } from "../server/bot/marketStructure.js";
import { loadYahooSpyOhlc1m } from "./yahooSpyLoader.js";

/** Underlying source preference: "yahoo" → free Yahoo 1m, "parity" → put-call
 *  parity from real options, "auto" → try the v3 stock endpoint first, then
 *  Yahoo, then parity. Yahoo is the default because the user's ThetaData
 *  Value tier is options-only (stock 1m gated) but parity-derived bars don't
 *  give the MTF gate enough intrabar structure. */
const SPY_SOURCE = (process.env.BOT_BACKTEST_SPY_SOURCE ?? "auto").toLowerCase();

const BASE = process.env.THETA_TERMINAL_URL ?? "http://127.0.0.1:25503";
const REQUEST_DELAY_MS = Number(process.env.THETA_REQUEST_DELAY_MS ?? 350);

interface ThetaResponse<T = unknown> {
  header?: { error_type?: string; error_msg?: string; next_page?: string };
  response: T[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let lastRequestAt = 0;

async function thetaGetRaw(path: string, params: Record<string, string | number>): Promise<{ text: string; ok: boolean; status: number; url: string }> {
  const wait = lastRequestAt + REQUEST_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  qs.set("format", "json");
  const url = `${BASE}${path}?${qs.toString()}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  return { text, ok: response.ok, status: response.status, url };
}

async function thetaGet<T = unknown>(path: string, params: Record<string, string | number>): Promise<ThetaResponse<T>> {
  const r = await thetaGetRaw(path, params);
  if (!r.ok) throw new Error(`ThetaData ${path} HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  let data: ThetaResponse<T>;
  try {
    data = JSON.parse(r.text) as ThetaResponse<T>;
  } catch {
    throw new Error(`ThetaData ${path} returned non-JSON: ${r.text.slice(0, 200)}`);
  }
  if (data.header?.error_type && data.header.error_type !== "null") {
    throw new Error(`ThetaData ${path} error ${data.header.error_type}: ${data.header.error_msg ?? ""}`);
  }
  return data;
}

/** True when the local v3 Theta Terminal answers at all. */
export async function terminalReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/v3/option/list/expirations?symbol=SPY&format=json`, {
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** "2026-06-02" → 20260602 */
function toThetaDate(iso: string): number {
  return Number(iso.replace(/-/g, ""));
}

/** ET offset (minutes, ET − UTC) for a given date — handles EST/EDT. */
function etOffsetMinutes(isoDate: string): number {
  const probe = new Date(`${isoDate}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(probe);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m - 12 * 60;
}

/** Parse a v3 ET-local timestamp ("2026-06-12T09:31:00.000") → UTC epoch ms. */
function etTimestampToUtcMs(ts: string): number {
  // The string has no zone; treat as UTC, then shift by ET offset of the date.
  const naiveUtc = Date.parse(`${ts}Z`);
  const isoDate = ts.slice(0, 10);
  return naiveUtc - etOffsetMinutes(isoDate) * 60_000;
}

/**
 * The N most recent COMPLETED trading sessions. The stock EOD endpoint only
 * has rows for sessions whose data has finalized, so its date list IS the
 * authoritative completed-session calendar — more reliable than a
 * today-filter on the expiration list.
 */
export async function lastTradingSessions(n: number, today = new Date()): Promise<string[]> {
  const todayMs = today.getTime();
  const startMs = todayMs - 60 * 24 * 60 * 60_000;
  const fmt = (ms: number) => Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms)).replace(/-/g, ""),
  );
  const data = await thetaGet<EodRow>("/v3/stock/history/eod", {
    symbol: "SPY",
    start_date: fmt(startMs),
    end_date: fmt(todayMs),
  });
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(today);
  const dates = data.response
    .map((r) => r.last_trade?.slice(0, 10))
    .filter((d): d is string => Boolean(d) && d < todayIso)
    .sort();
  return dates.slice(-n);
}

interface EodRow {
  last_trade?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Real SPY EOD close for one date. Single-date range queries on the v3
 * /stock/history/eod endpoint sometimes return 472 No-data for the most
 * recent day, even when the same row is present in a bulk query — we widen
 * the window and pick the row whose last_trade matches the requested date.
 */
async function loadSpyEod(isoDate: string): Promise<EodRow | null> {
  const targetMs = Date.parse(`${isoDate}T12:00:00Z`);
  const fmt = (ms: number) => Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms)).replace(/-/g, ""),
  );
  const startMs = targetMs - 7 * 24 * 60 * 60_000;
  const endMs = targetMs + 7 * 24 * 60 * 60_000;
  const data = await thetaGet<EodRow>("/v3/stock/history/eod", {
    symbol: "SPY",
    start_date: fmt(startMs),
    end_date: fmt(endMs),
  });
  return data.response.find((r) => r.last_trade?.slice(0, 10) === isoDate) ?? null;
}

interface StockOhlcRow {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Real SPY 1m OHLC bars (regular trading hours) for one session via the v3
 * stock endpoint. Throws when the terminal blocks the request (insufficient
 * subscription) so the caller can fall back to a PCP-derived tape.
 */
async function loadSpyOhlc1mDirect(isoDate: string): Promise<MtfCandle[]> {
  const d = toThetaDate(isoDate);
  const r = await thetaGetRaw("/v3/stock/history/ohlc", {
    symbol: "SPY",
    start_date: d,
    end_date: d,
    interval: "1m",
  });
  if (!r.ok || r.text.includes("subscription")) {
    throw new Error(`stock-1m-blocked: ${r.text.slice(0, 200)}`);
  }
  let data: ThetaResponse<StockOhlcRow>;
  try { data = JSON.parse(r.text) as ThetaResponse<StockOhlcRow>; }
  catch { throw new Error(`stock-1m-blocked: non-JSON: ${r.text.slice(0, 200)}`); }
  if (!data.response?.length) throw new Error(`ThetaData returned no SPY 1m bars for ${isoDate}`);
  const bars: MtfCandle[] = [];
  for (const row of data.response) {
    if (!(row.open > 0) || !(row.close > 0)) continue;
    bars.push({
      time: new Date(etTimestampToUtcMs(row.timestamp)).toISOString(),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume ?? 0,
    });
  }
  return bars;
}

interface OptionContract { expiration: string; right: string; strike: number; symbol: string; }
interface OptionQuoteRow {
  timestamp: string;
  bid: number;
  ask: number;
  bid_size?: number;
  ask_size?: number;
}
interface OptionQuoteSeriesRow { contract: OptionContract; data: OptionQuoteRow[]; }

/**
 * Fetch the full 1m NBBO quote series for one same-day SPY option contract
 * (RTH only).
 */
async function fetchOptionQuoteSeries(
  isoDate: string,
  strike: number,
  right: "C" | "P",
): Promise<OptionQuoteRow[]> {
  const d = toThetaDate(isoDate);
  const data = await thetaGet<OptionQuoteSeriesRow>("/v3/option/history/quote", {
    symbol: "SPY",
    expiration: d,
    strike: strike.toFixed(3),
    right: right === "C" ? "call" : "put",
    date: d,
    interval: "1m",
  });
  const rows = data.response?.[0]?.data ?? [];
  return rows;
}

/**
 * SPY 1m bars derived from put-call parity on the real ATM 0DTE option
 * quotes: SPY(t) ≈ K + Cmid(t) − Pmid(t). Same-expiry call+put at one strike
 * eliminates carry/divs to good approximation for 0DTE. Two API calls per
 * session — the cheapest path that surfaces real minute-level price discovery.
 *
 * Returns minute bars where open=high=low=close=derived mid (1m flat candle).
 * The bot's per-bar driver consumes close primarily; intrabar wicks are a
 * documented known approximation.
 */
async function loadSpyOhlc1mFromParity(isoDate: string): Promise<MtfCandle[]> {
  const eod = await loadSpyEod(isoDate);
  if (!eod) throw new Error(`ThetaData has no EOD row for SPY on ${isoDate}`);
  const atm = Math.round(eod.close);
  const [calls, puts] = await Promise.all([
    fetchOptionQuoteSeries(isoDate, atm, "C"),
    fetchOptionQuoteSeries(isoDate, atm, "P"),
  ]);
  if (!calls.length || !puts.length) {
    throw new Error(`ThetaData option quotes empty for SPY ATM ${atm} on ${isoDate}`);
  }
  const putByMinute = new Map<number, OptionQuoteRow>();
  for (const p of puts) putByMinute.set(Math.floor(etTimestampToUtcMs(p.timestamp) / 60_000), p);

  // High/low from the parity bid/ask boundaries: SPY_hi ≈ K + Cask − Pbid,
  // SPY_lo ≈ K + Cbid − Pask. Open carries from the prior minute's close
  // (the minute snapshot is a single quote — no intrabar "open" exists). This
  // gives the MTF signal engine real candle structure to gate on.
  const bars: MtfCandle[] = [];
  let prevClose: number | null = null;
  for (const c of calls) {
    if (!(c.ask > 0)) continue;
    const minute = Math.floor(etTimestampToUtcMs(c.timestamp) / 60_000);
    const p = putByMinute.get(minute);
    if (!p || !(p.ask > 0)) continue;
    const cMid = (c.bid + c.ask) / 2;
    const pMid = (p.bid + p.ask) / 2;
    const close = atm + cMid - pMid;
    if (!(close > 0)) continue;
    const hi = atm + c.ask - (p.bid > 0 ? p.bid : p.ask);
    const lo = atm + (c.bid > 0 ? c.bid : c.ask) - p.ask;
    const open = prevClose ?? close;
    bars.push({
      time: new Date(minute * 60_000).toISOString(),
      open,
      high: Math.max(open, close, hi),
      low: Math.min(open, close, lo),
      close,
      volume: 0,
    });
    prevClose = close;
  }
  if (bars.length < 100) {
    throw new Error(`ThetaData PCP-derived SPY 1m bars for ${isoDate} look incomplete (${bars.length} bars)`);
  }
  return bars;
}

/**
 * Real SPY 1m OHLC for one session. Source order is controlled by
 * BOT_BACKTEST_SPY_SOURCE:
 *   "auto"   (default) — ThetaData stock 1m → Yahoo Finance → parity
 *   "yahoo"  — Yahoo Finance only
 *   "parity" — put-call parity from real option quotes only
 *   "theta"  — ThetaData stock 1m only (loud-fail on subscription gate)
 */
export async function loadSpyOhlc1m(isoDate: string): Promise<MtfCandle[]> {
  const tryYahoo = async () => {
    const bars = await loadYahooSpyOhlc1m(isoDate);
    if (bars.length < 100) {
      throw new Error(`Yahoo SPY 1m bars for ${isoDate} look incomplete (${bars.length} bars)`);
    }
    console.log(`[spy-1m] source=yahoo for ${isoDate}`);
    return bars;
  };
  const tryParity = async () => {
    console.warn(`[spy-1m] source=parity for ${isoDate} (derived from real option quotes)`);
    return await loadSpyOhlc1mFromParity(isoDate);
  };
  const tryTheta = async () => {
    const bars = await loadSpyOhlc1mDirect(isoDate);
    console.log(`[spy-1m] source=theta-stock for ${isoDate}`);
    return bars;
  };

  if (SPY_SOURCE === "yahoo") return tryYahoo();
  if (SPY_SOURCE === "parity") return tryParity();
  if (SPY_SOURCE === "theta") return tryTheta();

  // auto: theta → yahoo → parity
  try {
    return await tryTheta();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("stock-1m-blocked")) throw err;
    try {
      return await tryYahoo();
    } catch (yahooErr) {
      console.warn(`[spy-1m] yahoo failed for ${isoDate}: ${yahooErr instanceof Error ? yahooErr.message : yahooErr}`);
      return await tryParity();
    }
  }
}

export interface QuoteBar {
  /** UTC epoch ms of the interval start. */
  timeMs: number;
  bid: number;
  ask: number;
}

/**
 * Per-contract 1m NBBO quote series for one session, lazily fetched and
 * cached. Key = `${date}|${strike}|${right}`.
 */
export class OptionQuoteCache {
  private cache = new Map<string, Map<number, QuoteBar> | null>();
  /** Contracts that returned no data — remembered so we don't refetch. */
  readonly missing = new Set<string>();

  private key(isoDate: string, strike: number, right: "C" | "P"): string {
    return `${isoDate}|${strike}|${right}`;
  }

  /**
   * The 1m quote bar covering utcMs for the given same-day contract, or null
   * when the contract has no data (free-tier limit / never traded).
   */
  async getQuote(
    isoDate: string,
    strike: number,
    right: "C" | "P",
    utcMs: number,
  ): Promise<QuoteBar | null> {
    const k = this.key(isoDate, strike, right);
    if (this.missing.has(k)) return null;

    let series = this.cache.get(k);
    if (series === undefined) {
      series = await this.fetchSeries(isoDate, strike, right);
      this.cache.set(k, series);
      if (series === null) this.missing.add(k);
    }
    if (!series) return null;

    const minuteMs = Math.floor(utcMs / 60_000) * 60_000;
    return series.get(minuteMs) ?? null;
  }

  private async fetchSeries(
    isoDate: string,
    strike: number,
    right: "C" | "P",
  ): Promise<Map<number, QuoteBar> | null> {
    let rows: OptionQuoteRow[];
    try {
      rows = await fetchOptionQuoteSeries(isoDate, strike, right);
    } catch (err) {
      console.warn(`[thetadata] quote fetch failed for SPY ${isoDate} ${strike}${right}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
    if (!rows.length) return null;

    const series = new Map<number, QuoteBar>();
    for (const row of rows) {
      const bid = Number(row.bid);
      const ask = Number(row.ask);
      if (!(ask > 0)) continue;
      const timeMs = etTimestampToUtcMs(row.timestamp);
      series.set(Math.floor(timeMs / 60_000) * 60_000, {
        timeMs,
        bid: bid > 0 ? bid : 0,
        ask,
      });
    }
    return series.size ? series : null;
  }
}
