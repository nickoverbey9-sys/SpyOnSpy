/**
 * Tradier execution adapter.
 *
 * ─── SAFETY DESIGN ────────────────────────────────────────────────────────────
 *
 * LIVE ORDERS ARE BLOCKED BY DEFAULT.
 *
 * To send a real order to Tradier all of the following must be true:
 *   1. TRADIER_ENABLE_LIVE_TRADING=true  (env var)
 *   2. TRADIER_ACCOUNT_ID=<id>           (env var)
 *   3. TRADIER_TOKEN=<token>             (env var)
 *   4. request.confirmLiveOrder === true  (per-request body field)
 *
 * If any condition is missing the function throws BEFORE any network call.
 *
 * Paper orders are always allowed and never touch Tradier's API.
 *
 * NOT FINANCIAL ADVICE. Verify your Tradier sandbox vs production URL.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BotConfig } from "./config.js";
import { isZeroDteSymbol, parseOccSymbol, marketDateNY } from "./occSymbol.js";

/**
 * Hard 0DTE guard for OPENING orders.
 *
 * Independent of the signal engine: even a hand-crafted request that bypasses
 * signal generation cannot open a position in a non-same-day contract. Expiry
 * is parsed from the OCC symbol itself — the exact string sent to the broker —
 * so there is no field the caller can spoof. Throws on violation; the route
 * turns the throw into a 400.
 *
 * Closing orders (sell_to_close) are intentionally NOT guarded here so an
 * existing position can always be flattened.
 */
export function assertZeroDteOpen(optionSymbol: string, now: Date = new Date()): void {
  const parsed = parseOccSymbol(optionSymbol);
  if (!parsed) {
    throw new Error(
      `0DTE GUARD: option symbol "${optionSymbol}" is not a parseable OCC symbol; refusing to open.`,
    );
  }
  if (!isZeroDteSymbol(optionSymbol, now)) {
    throw new Error(
      `0DTE GUARD: refusing later-dated expiry. Contract ${optionSymbol} expires ${parsed.expiry}, ` +
        `but only same-day SPY 0DTE (${marketDateNY(now)}) may be opened through the bot.`,
    );
  }
}

export type OrderAction = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderDuration = "day" | "gtc" | "pre" | "post";

export interface TradierOptionOrderPayload {
  /** Symbol in OCC format, e.g. SPY250117C00520000 */
  option_symbol: string;
  /** "buy_to_open" or "sell_to_close" */
  side: "buy_to_open" | "sell_to_close";
  quantity: number;
  type: OrderType;
  duration: OrderDuration;
  /** Required when type = "limit" */
  price?: number;
}

export interface OrderResult {
  simulated: boolean;
  orderId: string | null;
  status: "filled" | "pending" | "rejected" | "paper";
  payload: TradierOptionOrderPayload;
  sentAt: string;
  error?: string;
  /** Present only for live orders — the raw Tradier API response */
  tradierResponse?: unknown;
}

/**
 * Build a Tradier option order payload for SPY.
 * Does NOT send anything.
 */
export function buildOptionOrderPayload(params: {
  optionSymbol: string;
  side: "buy_to_open" | "sell_to_close";
  contracts: number;
  orderType: OrderType;
  limitPrice?: number;
}): TradierOptionOrderPayload {
  const payload: TradierOptionOrderPayload = {
    option_symbol: params.optionSymbol,
    side: params.side,
    quantity: params.contracts,
    type: params.orderType,
    duration: "day",
  };
  if (params.orderType === "limit" && params.limitPrice !== undefined) {
    payload.price = params.limitPrice;
  }
  return payload;
}

/**
 * Execute a PAPER order (never contacts Tradier).
 * Always succeeds and returns a simulated fill.
 */
export function executePaperOrder(
  payload: TradierOptionOrderPayload,
): OrderResult {
  // Even simulated opens must obey the same-day 0DTE rule so paper behavior
  // matches live and stale-dated test orders cannot slip through. Anything that
  // is not an explicit close is treated as an open.
  if (payload.side !== "sell_to_close") {
    assertZeroDteOpen(payload.option_symbol);
  }
  const orderId = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    simulated: true,
    orderId,
    status: "paper",
    payload,
    sentAt: new Date().toISOString(),
  };
}

/**
 * Execute a LIVE order against Tradier.
 *
 * Guards (in order):
 *  1. confirmLiveOrder must be true
 *  2. liveEnabled must be true (env vars all set)
 *  3. accountId and tradierToken must exist
 *
 * Throws descriptive errors if any guard fails — caller must handle.
 * Never silently falls back to paper.
 */
export async function executeLiveOrder(
  payload: TradierOptionOrderPayload,
  cfg: BotConfig,
  confirmLiveOrder: boolean,
): Promise<OrderResult> {
  // Guard 0: same-day 0DTE only (opening orders). Parsed from the OCC symbol
  // that is about to be sent to Tradier — last line of defense before network.
  // Anything that is not an explicit close is treated as an open.
  if (payload.side !== "sell_to_close") {
    assertZeroDteOpen(payload.option_symbol);
  }

  // Guard 1: per-request confirmation
  if (!confirmLiveOrder) {
    throw new Error(
      "LIVE ORDER REJECTED: confirmLiveOrder field is missing or false. " +
      "You must explicitly set { confirmLiveOrder: true } in your request body " +
      "to send a real order to Tradier.",
    );
  }

  // Guard 2: env switch
  if (!cfg.liveEnabled) {
    throw new Error(
      "LIVE ORDER REJECTED: Live trading is not enabled. " +
      "Set TRADIER_ENABLE_LIVE_TRADING=true, TRADIER_ACCOUNT_ID, and TRADIER_TOKEN.",
    );
  }

  // Guard 3: credentials
  if (!cfg.accountId || !cfg.tradierToken) {
    throw new Error(
      "LIVE ORDER REJECTED: TRADIER_ACCOUNT_ID and TRADIER_TOKEN must both be set.",
    );
  }

  // Build form-encoded body as Tradier requires
  const formParams = new URLSearchParams();
  formParams.set("class", "option");
  formParams.set("symbol", "SPY");
  formParams.set("option_symbol", payload.option_symbol);
  formParams.set("side", payload.side);
  formParams.set("quantity", String(payload.quantity));
  formParams.set("type", payload.type);
  formParams.set("duration", payload.duration);
  if (payload.price !== undefined) {
    formParams.set("price", String(payload.price));
  }

  const url = `${cfg.tradierBaseUrl}/v1/accounts/${cfg.accountId}/orders`;

  let tradierResponse: unknown;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.tradierToken}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formParams.toString(),
      signal: AbortSignal.timeout(8_000),
    });
    tradierResponse = await response.json();
  } catch (err) {
    throw new Error(`Tradier API request failed: ${String(err)}`);
  }

  if (!response.ok) {
    throw new Error(
      `Tradier returned HTTP ${response.status}: ${JSON.stringify(tradierResponse)}`,
    );
  }

  const resp = tradierResponse as any;
  const orderId = resp?.order?.id ? String(resp.order.id) : null;
  const status = resp?.order?.status ?? "pending";

  return {
    simulated: false,
    orderId,
    status,
    payload,
    sentAt: new Date().toISOString(),
    tradierResponse,
  };
}

/**
 * Fetch the current mark (mid of bid/ask, falling back to last) for an option
 * symbol from Tradier. Read-only — never places an order.
 *
 * Returns null when no token is configured or the request fails, so callers
 * (e.g. the exit-management loop) can flag exit management as "degraded"
 * rather than acting on a fabricated price. Never throws.
 */
export async function fetchOptionMark(
  optionSymbol: string,
  cfg: BotConfig,
): Promise<number | null> {
  if (!cfg.tradierToken) return null;
  const url = `${cfg.tradierBaseUrl}/v1/markets/quotes?symbols=${encodeURIComponent(optionSymbol)}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.tradierToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as any;
    const q = data?.quotes?.quote;
    const quote = Array.isArray(q) ? q[0] : q;
    if (!quote) return null;
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return Math.round(((bid + ask) / 2) * 100) / 100;
    }
    const last = Number(quote.last);
    return Number.isFinite(last) && last > 0 ? last : null;
  } catch {
    return null;
  }
}

// ─── Account / balances (read-only) ──────────────────────────────────────────

/**
 * Normalized Tradier account snapshot. All monetary fields are USD and may be
 * null when the broker does not return them (varies by account type/margin vs.
 * cash). Never contains secrets — only derived numeric values.
 */
export interface TradierAccountSnapshot {
  /** True when the values came from a live Tradier API call. */
  available: boolean;
  /** "live-api" when fetched from Tradier, "unavailable" otherwise. */
  source: "live-api" | "unavailable";
  /** Human-readable reason when unavailable (no secrets). */
  reason: string | null;
  accountNumber: string | null;
  accountType: string | null;
  totalEquity: number | null;
  cash: number | null;
  /** Stock buying power (cash + margin). */
  buyingPower: number | null;
  /** Option-specific buying power, when reported. */
  optionBuyingPower: number | null;
  longMarketValue: number | null;
  shortMarketValue: number | null;
  /** Intraday open P&L on positions, when reported. */
  openPnl: number | null;
  /** Total P&L for the account, when reported. */
  totalPnl: number | null;
  /** Day P&L, when reported. */
  dayPnl: number | null;
  fetchedAt: string;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function firstNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v === undefined || v === null || v === "") continue;
    const n = numOrNull(v);
    if (n !== null) return n;
  }
  return null;
}

function unavailableAccount(reason: string): TradierAccountSnapshot {
  return {
    available: false,
    source: "unavailable",
    reason,
    accountNumber: null,
    accountType: null,
    totalEquity: null,
    cash: null,
    buyingPower: null,
    optionBuyingPower: null,
    longMarketValue: null,
    shortMarketValue: null,
    openPnl: null,
    totalPnl: null,
    dayPnl: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch the Tradier account balances (read-only). Best-effort normalization of
 * Tradier's `/v1/accounts/{id}/balances` response. Never places an order and
 * never throws — returns an "unavailable" snapshot (no secrets) on any error or
 * when TRADIER_TOKEN / TRADIER_ACCOUNT_ID are missing.
 *
 * Tradier reports a different balance shape for cash vs. margin vs. pdt
 * accounts; we read whichever sub-object is present and fall back across the
 * common field names.
 */
export async function fetchAccountSnapshot(
  cfg: BotConfig,
): Promise<TradierAccountSnapshot> {
  if (!cfg.tradierToken) return unavailableAccount("TRADIER_TOKEN not set");
  if (!cfg.accountId) return unavailableAccount("TRADIER_ACCOUNT_ID not set");

  const url = `${cfg.tradierBaseUrl}/v1/accounts/${cfg.accountId}/balances`;
  let data: any;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.tradierToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return unavailableAccount(`Tradier balances HTTP ${response.status}`);
    }
    data = await response.json();
  } catch (err) {
    // Surface a generic network message — never include the token.
    const msg = err instanceof Error ? err.name : "request failed";
    return unavailableAccount(`Tradier balances request failed (${msg})`);
  }

  const b = data?.balances;
  if (!b || typeof b !== "object") {
    return unavailableAccount("Tradier returned no balances object");
  }

  // Sub-objects are present only for the matching account class.
  const margin = b.margin ?? {};
  const cashSub = b.cash ?? {};
  const pdt = b.pdt ?? {};

  const totalEquity = firstNum(b.total_equity, b.equity);
  const cash = firstNum(
    cashSub.cash_available,
    cashSub.cash,
    b.total_cash,
    b.cash,
  );
  const buyingPower = firstNum(
    margin.stock_buying_power,
    pdt.stock_buying_power,
    cashSub.cash_available,
    b.stock_buying_power,
  );
  const optionBuyingPower = firstNum(
    margin.option_buying_power,
    pdt.option_buying_power,
    b.option_buying_power,
  );

  return {
    available: true,
    source: "live-api",
    reason: null,
    accountNumber: b.account_number ? String(b.account_number) : cfg.accountId,
    accountType: b.account_type ? String(b.account_type) : null,
    totalEquity,
    cash,
    buyingPower,
    optionBuyingPower,
    longMarketValue: firstNum(b.long_market_value),
    shortMarketValue: firstNum(b.short_market_value),
    openPnl: firstNum(b.open_pl, b.open_pnl),
    totalPnl: firstNum(b.total_pl, b.close_pl),
    dayPnl: firstNum(b.day_pl, b.day_pnl),
    fetchedAt: new Date().toISOString(),
  };
}

/** A single broker-reported position (best-effort normalized, read-only). */
export interface TradierBrokerPosition {
  symbol: string;
  quantity: number | null;
  costBasis: number | null;
  dateAcquired: string | null;
}

/**
 * Fetch broker-reported positions (read-only). Best-effort; returns an empty
 * array on any error or when credentials are missing. Never throws, never
 * places an order. Used for display/reconciliation context only — local paper
 * state remains the source of truth for bot-managed P&L.
 */
export async function fetchBrokerPositions(
  cfg: BotConfig,
): Promise<{ available: boolean; positions: TradierBrokerPosition[] }> {
  if (!cfg.tradierToken || !cfg.accountId) {
    return { available: false, positions: [] };
  }
  const url = `${cfg.tradierBaseUrl}/v1/accounts/${cfg.accountId}/positions`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.tradierToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { available: false, positions: [] };
    const data = (await response.json()) as any;
    const p = data?.positions?.position;
    if (!p) return { available: true, positions: [] };
    const arr = Array.isArray(p) ? p : [p];
    return {
      available: true,
      positions: arr.map((row: any) => ({
        symbol: String(row?.symbol ?? ""),
        quantity: numOrNull(row?.quantity),
        costBasis: numOrNull(row?.cost_basis),
        dateAcquired: row?.date_acquired ? String(row.date_acquired) : null,
      })),
    };
  } catch {
    return { available: false, positions: [] };
  }
}

/**
 * Unified entry point: routes to paper or live depending on cfg.liveEnabled
 * and the per-request confirmLiveOrder flag.
 *
 * If cfg.liveEnabled is false, always paper regardless of confirmLiveOrder.
 * If cfg.liveEnabled is true, requires confirmLiveOrder=true to go live.
 */
export async function executeOrder(
  payload: TradierOptionOrderPayload,
  cfg: BotConfig,
  confirmLiveOrder: boolean,
): Promise<OrderResult> {
  if (!cfg.liveEnabled) {
    // Always paper when live is not enabled — safe default
    return executePaperOrder(payload);
  }
  // Live is enabled: enforce per-request confirmation
  return executeLiveOrder(payload, cfg, confirmLiveOrder);
}

// ─── Order status / fill confirmation (added in execution-correctness patch) ──

export interface OptionQuote {
  bid: number | null;
  ask: number | null;
  /** Mid of bid/ask when both sides present, else last, else null. */
  mid: number | null;
  last: number | null;
}

/**
 * Select a usable mark from a quote, enforcing the fallback order
 *
 *     bid → mid → last
 *
 * A value is usable only when it is finite and strictly positive — so a
 * zero/absent bid (the June-12 zero-bid bug) is NEVER treated as a valid mark
 * and the next source is tried instead. Returns null when no source yields a
 * positive price, so the caller can fail safe rather than act on a bad mark.
 *
 * Pure and side-effect free (no network) so the fallback policy is unit-tested
 * directly. The exit loop prefers the BID — the side a long actually sells at —
 * which this ordering encodes.
 */
export function selectMarkFromQuote(quote: OptionQuote): number | null {
  const usable = (v: number | null): v is number =>
    v !== null && Number.isFinite(v) && v > 0;
  if (usable(quote.bid)) return quote.bid;
  if (usable(quote.mid)) return quote.mid;
  if (usable(quote.last)) return quote.last;
  return null;
}

/**
 * Fetch the full bid/ask/last quote for an option symbol (read-only).
 * Returns nulls on failure — never throws, never fabricates a price.
 */
export async function fetchOptionQuote(
  optionSymbol: string,
  cfg: BotConfig,
): Promise<OptionQuote> {
  const empty: OptionQuote = { bid: null, ask: null, mid: null, last: null };
  if (!cfg.tradierToken) return empty;
  const url = `${cfg.tradierBaseUrl}/v1/markets/quotes?symbols=${encodeURIComponent(optionSymbol)}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.tradierToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return empty;
    const data = (await response.json()) as any;
    const q = data?.quotes?.quote;
    const quote = Array.isArray(q) ? q[0] : q;
    if (!quote) return empty;
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    const last = Number(quote.last);
    const bidOk = Number.isFinite(bid) && bid > 0;
    const askOk = Number.isFinite(ask) && ask > 0;
    const lastOk = Number.isFinite(last) && last > 0;
    const mid = bidOk && askOk ? Math.round(((bid + ask) / 2) * 100) / 100 : lastOk ? last : null;
    return {
      bid: bidOk ? bid : null,
      ask: askOk ? ask : null,
      mid,
      last: lastOk ? last : null,
    };
  } catch {
    return empty;
  }
}

/** Normalized live order status from GET /v1/accounts/{id}/orders/{orderId}. */
export interface OrderStatusResult {
  available: boolean;
  /** Raw Tradier status string, lowercased (e.g. "filled", "open", "canceled"). */
  status: string | null;
  /** Average fill price per share (premium), when reported. */
  avgFillPrice: number | null;
  /** Contracts executed so far. */
  execQuantity: number | null;
  remainingQuantity: number | null;
}

const TERMINAL_ORDER_STATUSES = new Set([
  "filled",
  "canceled",
  "cancelled",
  "rejected",
  "expired",
  "error",
]);

export function isTerminalOrderStatus(status: string | null): boolean {
  return !!status && TERMINAL_ORDER_STATUSES.has(status.toLowerCase());
}

/**
 * Fetch the current status of a live order (read-only). Never throws.
 */
export async function getOrderStatus(
  orderId: string,
  cfg: BotConfig,
): Promise<OrderStatusResult> {
  const empty: OrderStatusResult = {
    available: false,
    status: null,
    avgFillPrice: null,
    execQuantity: null,
    remainingQuantity: null,
  };
  if (!cfg.tradierToken || !cfg.accountId) return empty;
  const url = `${cfg.tradierBaseUrl}/v1/accounts/${cfg.accountId}/orders/${encodeURIComponent(orderId)}`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.tradierToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return empty;
    const data = (await response.json()) as any;
    const o = data?.order;
    if (!o) return empty;
    const num = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      available: true,
      status: o.status ? String(o.status).toLowerCase() : null,
      avgFillPrice: num(o.avg_fill_price),
      execQuantity: num(o.exec_quantity),
      remainingQuantity: num(o.remaining_quantity),
    };
  } catch {
    return empty;
  }
}

/**
 * Cancel a live order. Best-effort: returns true when Tradier accepted the
 * cancel request. Never throws.
 */
export async function cancelOrder(orderId: string, cfg: BotConfig): Promise<boolean> {
  if (!cfg.tradierToken || !cfg.accountId) return false;
  const url = `${cfg.tradierBaseUrl}/v1/accounts/${cfg.accountId}/orders/${encodeURIComponent(orderId)}`;
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${cfg.tradierToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface FillWaitResult {
  /** "filled" | "partial" | "unfilled" | "rejected" | "unknown" */
  outcome: "filled" | "partial" | "unfilled" | "rejected" | "unknown";
  status: string | null;
  avgFillPrice: number | null;
  execQuantity: number | null;
}

/**
 * Poll a live order until it reaches a terminal status or the timeout elapses.
 *
 *   filled   — fully executed; avgFillPrice is the real per-share premium.
 *   partial  — timeout hit with some contracts executed (caller decides:
 *              typically cancel the remainder and keep the executed quantity).
 *   unfilled — timeout hit with zero executed (caller should cancel).
 *   rejected — terminal reject/cancel/expire with zero executed.
 *   unknown  — status endpoint unreachable; caller must treat the order as
 *              possibly live and reconcile rather than assume.
 */
export async function waitForFill(
  orderId: string,
  cfg: BotConfig,
  timeoutMs = 20_000,
  pollMs = 1_500,
): Promise<FillWaitResult> {
  const deadline = Date.now() + timeoutMs;
  let last: OrderStatusResult | null = null;
  let everAvailable = false;

  while (Date.now() < deadline) {
    const st = await getOrderStatus(orderId, cfg);
    if (st.available) {
      everAvailable = true;
      last = st;
      if (st.status === "filled") {
        return {
          outcome: "filled",
          status: st.status,
          avgFillPrice: st.avgFillPrice,
          execQuantity: st.execQuantity,
        };
      }
      if (isTerminalOrderStatus(st.status)) {
        const exec = st.execQuantity ?? 0;
        return {
          outcome: exec > 0 ? "partial" : "rejected",
          status: st.status,
          avgFillPrice: st.avgFillPrice,
          execQuantity: st.execQuantity,
        };
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (!everAvailable) {
    return { outcome: "unknown", status: null, avgFillPrice: null, execQuantity: null };
  }
  const exec = last?.execQuantity ?? 0;
  return {
    outcome: exec > 0 ? "partial" : "unfilled",
    status: last?.status ?? null,
    avgFillPrice: last?.avgFillPrice ?? null,
    execQuantity: last?.execQuantity ?? null,
  };
}
