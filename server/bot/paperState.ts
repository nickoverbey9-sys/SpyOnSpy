/**
 * In-memory paper trading state.
 *
 * Tracks simulated positions, fills, and daily counters.
 * All state is ephemeral (lost on restart). For persistence across restarts,
 * set BOT_PAPER_STATE_FILE=/tmp/spy-bot-paper.json to write/read a JSON file.
 *
 * ⚠  This module NEVER contacts any brokerage. It is pure simulation.
 */

import fs from "node:fs";

export type Side = "Call" | "Put";

/**
 * Canonical setup-source buckets for the per-source scorecard. The fixed order
 * here is the display order the dashboard renders, and every bucket is always
 * shown (even with zero trades), so SETUP_SOURCES is the single source of truth.
 */
export type SetupSource =
  | "Pullback continuation"
  | "VWAP reclaim/fade"
  | "Generic continuation"
  | "Other / manual";

export const SETUP_SOURCES: readonly SetupSource[] = [
  "Pullback continuation",
  "VWAP reclaim/fade",
  "Generic continuation",
  "Other / manual",
];

/**
 * Map a setup TITLE (e.g. "VWAP reclaim (2m) [vwap-reclaim]") to its canonical
 * source bucket by keyword. Order matters: VWAP is checked before the generic
 * "continuation" keyword so a "VWAP reclaim continuation" lands in VWAP, not
 * Generic. A missing/empty title (manual orders, adopted broker positions)
 * buckets as "Other / manual".
 */
export function classifySetupSource(title?: string | null): SetupSource {
  const t = (title ?? "").toLowerCase();
  if (!t) return "Other / manual";
  if (t.includes("pullback")) return "Pullback continuation";
  if (t.includes("vwap")) return "VWAP reclaim/fade";
  if (t.includes("continuation")) return "Generic continuation";
  return "Other / manual";
}

export interface PaperPosition {
  id: string;
  symbol: string;       // OCC-style option symbol
  underlying: "SPY";
  side: Side;
  strike: number;
  expiry: string;       // YYYY-MM-DD
  contracts: number;
  entryPremium: number; // per-contract cost (ask price at entry)
  entryAt: string;      // ISO timestamp
  stopPrice: number;    // stop-loss threshold (entry × (1 − stopFraction))
  /**
   * Trailing-stop profit-exit levels. Applies to single contracts AND to the
   * remaining runner of a multi-contract position. There is no fixed full
   * take-profit: trailStartPrice only ARMS the trail; the winner then runs
   * until it gives back trailGivebackFraction from its post-arm peak.
   */
  takeProfitPrice: number; // DEPRECATED — retained for back-compat, not used for exits
  trailStartPrice: number; // premium at which the give-back trail arms (+trailStart)
  trailGivebackFraction: number; // fraction of peak to give back once armed
  trailArmed: boolean;     // true once trailStartPrice was reached
  peakPremium: number;     // highest observed premium (for the trail)
  /**
   * Premium at which the breakeven-protect stop arms (entry × (1 + breakeven
   * arm fraction), e.g. +15%). 0/absent when breakeven protection is disabled.
   */
  breakevenArmPrice?: number;
  /**
   * True once peakPremium has reached breakevenArmPrice and the stop was raised
   * to (at least) the entry premium. Once armed it stays armed; the stop is
   * never loosened below entry afterward.
   */
  breakevenArmed?: boolean;
  /**
   * Premium at which the profit-lock tier arms (entry × (1 + profit-lock arm
   * fraction), e.g. +15%). 0/absent when profit-lock is disabled. A second
   * protection tier ABOVE breakeven: when reached, the stop is raised to lock a
   * positive profit (profitLockStopPrice).
   */
  profitLockArmPrice?: number;
  /** Stop level the profit-lock tier raises to (entry × (1 + profit fraction), e.g. +5%). */
  profitLockStopPrice?: number;
  /**
   * True once peakPremium has reached profitLockArmPrice and the stop was raised
   * to profitLockStopPrice. Once armed it stays armed; the stop is never loosened
   * below the locked-profit level afterward.
   */
  profitLockArmed?: boolean;
  /** True when this position is managed as a single contract (qty < 2 at entry). */
  singleContract: boolean;
  /**
   * True when this position was ADOPTED from a live Tradier broker position
   * (e.g. after an app restart/redeploy lost local state) rather than opened by
   * the bot's own entry path. Adopted positions are managed for EXIT only — the
   * bot never re-opens or sizes them. Optional/absent for bot-opened positions.
   */
  adoptedFromBroker?: boolean;
  /** Broker-reported acquisition timestamp (ISO), when adopted. */
  brokerDateAcquired?: string;
  /** Stable broker-identity key (symbol|dateAcquired) for adopted positions. */
  brokerKey?: string;
  /**
   * Canonical setup-source bucket the entry was classified into at open time
   * (see classifySetupSource). Drives the per-source scorecard. Absent on
   * positions opened before source tagging shipped and on adopted broker
   * positions — both bucket as "Other / manual".
   */
  setupSource?: SetupSource;
  status: "open" | "closed";
  closeReason?: string;
  closePremium?: number;
  closeAt?: string;
  /** PnL in USD (positive = profit) — populated on close */
  pnl?: number;
}

export interface PaperFill {
  id: string;
  positionId: string;
  action: "buy-to-open" | "sell-to-close";
  contracts: number;
  premium: number;
  at: string;
  reason: string;
  simulated: true;
}

interface DailyCounter {
  date: string; // YYYY-MM-DD
  tradesOpened: number;
  /**
   * INFORMATIONAL ONLY: gross USD from losing closed trades today (positive
   * number = sum of |pnl| over losers, winners excluded). This is NOT the
   * day's P&L and must NOT drive the daily-loss guard — it ignores winners and
   * so overstates the loss. The daily-loss guard uses NET realized P&L (see
   * getDailyLossSnapshot). Retained as a metric to surface "how much was lost
   * on losers" distinct from net result.
   */
  grossLossToday: number;
}

/**
 * Lifecycle of a broker position that the bot has taken responsibility for.
 *   • "managed"      — adopted and open; exit loop is managing it.
 *   • "exit-pending" — a sell_to_close was attempted/completed locally; we are
 *                      waiting for the broker to stop reporting the position. We
 *                      MUST NOT re-adopt or re-exit while in this state.
 *   • "closed"       — terminal; the identity was managed once and is done. Even
 *                      if the broker still reports it (settlement lag), it is
 *                      never re-adopted or re-exited.
 */
export type BrokerAdoptionStatus = "managed" | "exit-pending" | "closed";

/**
 * Stable identity for a broker position across reconciliation ticks. The same
 * underlying broker lot must map to the same identity so it is adopted/exited
 * exactly once, even if the broker keeps reporting it after a close attempt.
 *
 * Identity = OCC symbol + broker dateAcquired. A genuinely new position in the
 * same symbol (new dateAcquired) yields a different key and is adoptable.
 */
export interface BrokerAdoptionRecord {
  key: string;            // identity key (symbol|dateAcquired)
  symbol: string;
  dateAcquired: string | null;
  status: BrokerAdoptionStatus;
  positionId: string | null; // local PaperPosition.id, when one exists
  firstSeenAt: string;        // ISO
  lastUpdatedAt: string;      // ISO
}

interface PaperState {
  positions: PaperPosition[];
  fills: PaperFill[];
  daily: DailyCounter;
  /** Broker-position identities the bot has adopted/exited, keyed by identity. */
  brokerAdoptions: Record<string, BrokerAdoptionRecord>;
}

/**
 * Build the stable identity key for a broker position. Symbol is normalized;
 * dateAcquired is included so a NEW lot in the same symbol (different acquire
 * time) is treated as a distinct, separately-adoptable position. A null/missing
 * dateAcquired collapses to the symbol alone (best we can do without it).
 */
export function brokerAdoptionKey(symbol: string, dateAcquired: string | null | undefined): string {
  const sym = (symbol ?? "").trim().toUpperCase();
  const acq = dateAcquired ? String(dateAcquired) : "";
  return acq ? `${sym}|${acq}` : sym;
}

/**
 * PERSISTENCE PATCH: state now persists BY DEFAULT to .data/bot-state.json so
 * a midday restart/redeploy no longer resets the daily-loss counter and trade
 * counts. Override the path with BOT_PAPER_STATE_FILE, or set it to "none" /
 * "off" / "memory" to restore the old in-memory-only behavior.
 */
const STATE_FILE = (() => {
  const raw = process.env.BOT_PAPER_STATE_FILE;
  if (raw === undefined) return ".data/bot-state.json";
  const lowered = raw.trim().toLowerCase();
  if (lowered === "" || lowered === "none" || lowered === "off" || lowered === "memory") return null;
  return raw;
})();

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function loadFromFile(): PaperState | null {
  if (!STATE_FILE) return null;
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PaperState> & {
      daily?: Partial<DailyCounter> & { realizedLoss?: number };
    };
    // Back-compat: older state files predate brokerAdoptions and named the
    // gross-loss counter `realizedLoss`. Migrate it into grossLossToday.
    const pd = parsed.daily;
    const daily: DailyCounter = pd
      ? {
          date: pd.date ?? todayStr(),
          tradesOpened: pd.tradesOpened ?? 0,
          grossLossToday: pd.grossLossToday ?? pd.realizedLoss ?? 0,
        }
      : { date: todayStr(), tradesOpened: 0, grossLossToday: 0 };
    return {
      positions: parsed.positions ?? [],
      fills: parsed.fills ?? [],
      daily,
      brokerAdoptions: parsed.brokerAdoptions ?? {},
    };
  } catch {
    return null;
  }
}

function freshState(): PaperState {
  return {
    positions: [],
    fills: [],
    daily: { date: todayStr(), tradesOpened: 0, grossLossToday: 0 },
    brokerAdoptions: {},
  };
}

let state: PaperState = loadFromFile() ?? freshState();

function persistIfConfigured() {
  if (!STATE_FILE) return;
  try {
    const dir = STATE_FILE.includes("/") ? STATE_FILE.slice(0, STATE_FILE.lastIndexOf("/")) : null;
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Non-fatal: log but continue
    console.warn("[bot] Could not persist paper state to", STATE_FILE);
  }
}

/** Reset daily counters if date has rolled over */
function maybeRollDay() {
  const today = todayStr();
  if (state.daily.date !== today) {
    state.daily = { date: today, tradesOpened: 0, grossLossToday: 0 };
    // A 0DTE broker position cannot survive to a new trading day. Clearing the
    // adoption ledger lets a genuinely new same-symbol lot be adopted tomorrow
    // while still blocking same-day re-adoption of a closed/exited identity.
    state.brokerAdoptions = {};
  }
}

/** All open positions */
export function getOpenPositions(): PaperPosition[] {
  maybeRollDay();
  return state.positions.filter((p) => p.status === "open");
}

/** All positions (open + closed, capped at last 100 for memory) */
export function getAllPositions(): PaperPosition[] {
  return state.positions.slice(-100);
}

/** All fills (capped at last 200) */
export function getRecentFills(): PaperFill[] {
  return state.fills.slice(-200);
}

/** Daily stats */
export function getDailyStats() {
  maybeRollDay();
  return { ...state.daily };
}

/** Open a new simulated position */
export function openPaperPosition(params: {
  symbol: string;
  side: Side;
  strike: number;
  expiry: string;
  contracts: number;
  entryPremium: number;
  stopFraction: number;
  takeProfitFraction?: number;
  trailStartFraction?: number;
  trailGivebackFraction?: number;
  breakevenArmFraction?: number;
  profitLockArmFraction?: number;
  profitLockProfitFraction?: number;
  /** Originating setup title; classified into a SetupSource bucket at open. */
  setupTitle?: string;
}): PaperPosition {
  maybeRollDay();
  const id = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const singleContract = params.contracts < 2;
  const tpFrac = params.takeProfitFraction ?? 0.40;
  const trailStartFrac = params.trailStartFraction ?? 0.25;
  const trailGiveback = params.trailGivebackFraction ?? 0.05;
  const breakevenArmFrac = params.breakevenArmFraction ?? 0.10;
  const profitLockArmFrac = params.profitLockArmFraction ?? 0.15;
  const profitLockProfitFrac = params.profitLockProfitFraction ?? 0.05;
  const pos: PaperPosition = {
    id,
    symbol: params.symbol,
    underlying: "SPY",
    side: params.side,
    strike: params.strike,
    expiry: params.expiry,
    contracts: params.contracts,
    entryPremium: params.entryPremium,
    entryAt: new Date().toISOString(),
    stopPrice: round(params.entryPremium * (1 - params.stopFraction)),
    takeProfitPrice: round(params.entryPremium * (1 + tpFrac)),
    trailStartPrice: round(params.entryPremium * (1 + trailStartFrac)),
    trailGivebackFraction: trailGiveback,
    trailArmed: false,
    peakPremium: params.entryPremium,
    breakevenArmPrice: breakevenArmFrac > 0 ? round(params.entryPremium * (1 + breakevenArmFrac)) : 0,
    breakevenArmed: false,
    profitLockArmPrice: profitLockArmFrac > 0 ? round(params.entryPremium * (1 + profitLockArmFrac)) : 0,
    profitLockStopPrice: profitLockArmFrac > 0 ? round(params.entryPremium * (1 + profitLockProfitFrac)) : 0,
    profitLockArmed: false,
    singleContract,
    setupSource: classifySetupSource(params.setupTitle),
    status: "open",
  };

  const fill: PaperFill = {
    id: `fill-${Date.now()}`,
    positionId: id,
    action: "buy-to-open",
    contracts: params.contracts,
    premium: params.entryPremium,
    at: pos.entryAt,
    reason: "Signal triggered buy-to-open (paper)",
    simulated: true,
  };

  state.positions.push(pos);
  state.fills.push(fill);
  state.daily.tradesOpened += 1;
  persistIfConfigured();
  return pos;
}

/**
 * Adopt an existing LIVE broker position into local managed state so the exit
 * loop (hard stop / +35% arm / 5% give-back trail / flatten) can manage it
 * after a restart/redeploy that wiped local state.
 *
 * This does NOT place any order — it only reconstructs a ManagedPosition from
 * broker data. The caller is responsible for all live/auto/kill-switch guards
 * and for only passing same-day 0DTE long option positions.
 *
 * Trail arming: if currentMark >= entry × (1 + trailStartFraction) the trail is
 * armed immediately and peak seeded to max(currentMark, entry). Otherwise the
 * trail is disarmed and peak tracks max(entry, currentMark) so a later rise can
 * arm it and a subsequent give-back can exit.
 *
 * Idempotency / de-duplication:
 *   • If a position for the same symbol is already OPEN, return it unchanged.
 *   • If the broker IDENTITY (symbol + dateAcquired) has EVER been adopted this
 *     trading day — whether it is still managed, exit-pending, or already
 *     closed — it is NOT re-adopted. This is the critical guard: after the bot
 *     exits an adopted position the broker may keep reporting it (settlement
 *     lag), and without this check reconcile would re-adopt it every tick,
 *     producing duplicate closed positions, compounded realized loss, and
 *     repeated sell_to_close orders/events.
 *   • A genuinely NEW lot in the same symbol (different dateAcquired) has a
 *     different identity key and IS adoptable.
 *
 * The returned `adopted` flag is true only when a brand-new managed position was
 * created. `reason` explains a refusal so callers/status can classify it.
 */
export function adoptBrokerPosition(params: {
  symbol: string;
  side: Side;
  strike: number;
  expiry: string;
  contracts: number;
  entryPremium: number;
  currentMark: number;
  stopFraction: number;
  trailStartFraction: number;
  trailGivebackFraction: number;
  breakevenArmFraction?: number;
  profitLockArmFraction?: number;
  profitLockProfitFraction?: number;
  brokerDateAcquired?: string | null;
}): { position: PaperPosition | null; adopted: boolean; reason?: string } {
  maybeRollDay();

  const key = brokerAdoptionKey(params.symbol, params.brokerDateAcquired);
  const nowIso = new Date().toISOString();

  // De-dup by stable broker identity: once an identity has been adopted this
  // day (in any lifecycle state), never adopt it again.
  const prior = state.brokerAdoptions[key];
  if (prior) {
    if (prior.status === "managed" && prior.positionId) {
      const open = state.positions.find(
        (p) => p.id === prior.positionId && p.status === "open",
      );
      if (open) return { position: open, adopted: false, reason: "already-managed" };
    }
    // exit-pending or closed (or managed but local position gone) → do not
    // re-adopt. The broker is still reporting a position we already handled.
    prior.lastUpdatedAt = nowIso;
    persistIfConfigured();
    return { position: null, adopted: false, reason: prior.status };
  }

  // Never create a duplicate local position for a symbol already managed
  // (defensive — covers a managed position whose identity key drifted).
  const existing = state.positions.find(
    (p) => p.status === "open" && p.symbol === params.symbol,
  );
  if (existing) return { position: existing, adopted: false, reason: "already-managed" };

  const id = `adopted-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const entry = params.entryPremium;
  const trailStartPrice = round(entry * (1 + params.trailStartFraction));
  const armed = params.currentMark >= trailStartPrice;
  const peak = round(Math.max(entry, params.currentMark));
  // Breakeven protection works for adopted positions too when the peak (here the
  // best mark known at adoption) already reached the +breakeven threshold: the
  // stop is raised to entry immediately and never loosened afterward.
  const breakevenArmFrac = params.breakevenArmFraction ?? 0.10;
  const breakevenArmPrice = breakevenArmFrac > 0 ? round(entry * (1 + breakevenArmFrac)) : 0;
  const breakevenArmed = breakevenArmPrice > 0 && peak >= breakevenArmPrice;
  const profitLockArmFrac = params.profitLockArmFraction ?? 0.15;
  const profitLockProfitFrac = params.profitLockProfitFraction ?? 0.05;
  const profitLockArmPrice = profitLockArmFrac > 0 ? round(entry * (1 + profitLockArmFrac)) : 0;
  const profitLockStopPrice = profitLockArmFrac > 0 ? round(entry * (1 + profitLockProfitFrac)) : 0;
  const profitLockArmed = profitLockArmPrice > 0 && peak >= profitLockArmPrice;
  const baseStop = round(entry * (1 - params.stopFraction));
  // Never loosen: a breakeven/profit-lock-armed adopted position starts with its
  // stop raised to the highest applicable protected level (≥ the -stopFraction
  // hard stop). Profit-lock (+profit) is above breakeven (entry) when armed.
  let stopPrice = baseStop;
  if (breakevenArmed) stopPrice = Math.max(stopPrice, round(entry));
  if (profitLockArmed) stopPrice = Math.max(stopPrice, profitLockStopPrice);

  const pos: PaperPosition = {
    id,
    symbol: params.symbol,
    underlying: "SPY",
    side: params.side,
    strike: params.strike,
    expiry: params.expiry,
    contracts: params.contracts,
    entryPremium: entry,
    entryAt: params.brokerDateAcquired ?? new Date().toISOString(),
    stopPrice,
    takeProfitPrice: round(entry * (1 + params.trailStartFraction)),
    trailStartPrice,
    trailGivebackFraction: params.trailGivebackFraction,
    trailArmed: armed,
    peakPremium: peak,
    breakevenArmPrice,
    breakevenArmed,
    profitLockArmPrice,
    profitLockStopPrice,
    profitLockArmed,
    singleContract: params.contracts < 2,
    adoptedFromBroker: true,
    brokerDateAcquired: params.brokerDateAcquired ?? undefined,
    brokerKey: key,
    status: "open",
  };

  state.positions.push(pos);
  state.brokerAdoptions[key] = {
    key,
    symbol: params.symbol,
    dateAcquired: params.brokerDateAcquired ?? null,
    status: "managed",
    positionId: id,
    firstSeenAt: nowIso,
    lastUpdatedAt: nowIso,
  };
  persistIfConfigured();
  return { position: pos, adopted: true };
}

/**
 * Update the running peak premium for the give-back trailing stop and arm the
 * trail once the start threshold has been reached. Applies to single contracts
 * and to the runner of a multi-contract position. No-op for closed/missing
 * positions. Returns the updated position (or null).
 */
export function updateTrail(positionId: string, currentPremium: number): PaperPosition | null {
  const pos = state.positions.find((p) => p.id === positionId && p.status === "open");
  if (!pos) return null;
  if (currentPremium > pos.peakPremium) pos.peakPremium = round(currentPremium);
  if (!pos.trailArmed && currentPremium >= pos.trailStartPrice) pos.trailArmed = true;

  // Breakeven protection: once the position's PEAK (max favorable excursion) has
  // reached the +breakeven threshold, raise the stop to the entry premium. This
  // only ever RAISES the stop (Math.max), so it can never loosen an existing
  // tighter stop, and it persists even if price later falls back below the arm
  // level. The +trailStart give-back trail still supersedes it once armed.
  if (pos.breakevenArmPrice && pos.breakevenArmPrice > 0 && pos.peakPremium >= pos.breakevenArmPrice) {
    pos.breakevenArmed = true;
    const breakevenStop = round(pos.entryPremium);
    if (breakevenStop > pos.stopPrice) pos.stopPrice = breakevenStop;
  }

  // Profit-lock tier: a second protection step ABOVE breakeven. Once the PEAK
  // reaches the +profit-lock arm threshold (e.g. +15%), raise the stop to lock a
  // positive profit (e.g. +5%). Like breakeven this only ever RAISES the stop
  // (Math.max via the > guard) and persists if price later falls back. The
  // +trailStart give-back trail still supersedes it once the bigger winner arms.
  if (pos.profitLockArmPrice && pos.profitLockArmPrice > 0 && pos.peakPremium >= pos.profitLockArmPrice) {
    pos.profitLockArmed = true;
    const profitLockStop = pos.profitLockStopPrice ?? 0;
    if (profitLockStop > pos.stopPrice) pos.stopPrice = profitLockStop;
  }

  persistIfConfigured();
  return pos;
}

/** Close an open paper position */
export function closePaperPosition(
  positionId: string,
  closePremium: number,
  reason: string,
): PaperPosition | null {
  const pos = state.positions.find((p) => p.id === positionId && p.status === "open");
  if (!pos) return null;

  const pnl = round((closePremium - pos.entryPremium) * pos.contracts * 100);
  pos.status = "closed";
  pos.closeReason = reason;
  pos.closePremium = closePremium;
  pos.closeAt = new Date().toISOString();
  pos.pnl = pnl;

  // Track gross loss on losers only — INFORMATIONAL. The daily-loss guard uses
  // NET realized P&L (getDailyLossSnapshot), not this figure.
  if (pnl < 0) {
    state.daily.grossLossToday = round(state.daily.grossLossToday + Math.abs(pnl));
  }

  // Mark the broker identity as terminally closed so reconciliation never
  // re-adopts (and never re-exits) it, even if the broker keeps reporting the
  // position due to settlement lag. This is what stops the duplicate
  // sell_to_close / compounded-loss loop for adopted positions.
  if (pos.brokerKey && state.brokerAdoptions[pos.brokerKey]) {
    state.brokerAdoptions[pos.brokerKey].status = "closed";
    state.brokerAdoptions[pos.brokerKey].lastUpdatedAt = pos.closeAt;
  }

  const fill: PaperFill = {
    id: `fill-${Date.now()}`,
    positionId,
    action: "sell-to-close",
    contracts: pos.contracts,
    premium: closePremium,
    at: pos.closeAt,
    reason: `${reason} (paper)`,
    simulated: true,
  };
  state.fills.push(fill);
  persistIfConfigured();
  return pos;
}

/**
 * Mark an adopted broker identity as "exit-pending": a live sell_to_close has
 * been submitted but we have NOT yet confirmed the broker dropped the position.
 * Prevents re-adoption/re-exit on subsequent ticks while the order settles.
 * No-op when the symbol/identity isn't a tracked adoption.
 */
export function markExitPending(positionId: string): void {
  const pos = state.positions.find((p) => p.id === positionId);
  if (!pos?.brokerKey) return;
  const rec = state.brokerAdoptions[pos.brokerKey];
  if (rec && rec.status === "managed") {
    rec.status = "exit-pending";
    rec.lastUpdatedAt = new Date().toISOString();
    persistIfConfigured();
  }
}

/** Read-only view of broker-adoption identities (for status/visibility). */
export function getBrokerAdoptions(): BrokerAdoptionRecord[] {
  maybeRollDay();
  return Object.values(state.brokerAdoptions);
}

export interface BotPnlSummary {
  /** Realized P&L (USD) across all closed bot-tracked positions. */
  realizedPnl: number;
  /** Realized P&L for closed positions opened today (USD). */
  realizedPnlToday: number;
  /**
   * Unrealized P&L (USD) on open positions, valued at supplied marks. Null when
   * no open position has a usable mark (so the UI can show "unavailable").
   */
  unrealizedPnl: number | null;
  /** Count of currently open bot-tracked positions. */
  openPositionCount: number;
  /** How many open positions had a usable mark for the unrealized figure. */
  markedPositionCount: number;
  /** True when at least one open position lacked a mark (unrealized is partial). */
  unrealizedPartial: boolean;
  /** realizedPnl + unrealizedPnl when computable, else realizedPnl. */
  totalPnl: number;
}

/**
 * Compute bot-managed P&L from locally tracked paper/live positions.
 *
 * Realized P&L is the sum of `pnl` on closed positions (already in USD, signed).
 * Unrealized P&L values each open position at `marks[positionId]` (per-contract
 * premium); positions without a mark are excluded and flagged as partial. When
 * no open position has a mark, unrealizedPnl is null (UI shows "unavailable").
 *
 * Local tracking is the source of truth for bot-managed P&L; it is independent
 * of the broker account balance and may diverge from real fills.
 */
export function computeBotPnl(marks?: Map<string, number>): BotPnlSummary {
  maybeRollDay();
  const today = todayStr();

  let realizedPnl = 0;
  let realizedPnlToday = 0;
  for (const p of state.positions) {
    if (p.status !== "closed" || typeof p.pnl !== "number") continue;
    realizedPnl += p.pnl;
    if (p.entryAt.slice(0, 10) === today) realizedPnlToday += p.pnl;
  }

  const open = state.positions.filter((p) => p.status === "open");
  let unrealized = 0;
  let markedPositionCount = 0;
  for (const p of open) {
    const mark = marks?.get(p.id);
    if (mark === undefined || !Number.isFinite(mark)) continue;
    unrealized += (mark - p.entryPremium) * p.contracts * 100;
    markedPositionCount += 1;
  }

  const hasUnrealized = markedPositionCount > 0;
  const unrealizedPnl = hasUnrealized ? round(unrealized) : null;

  return {
    realizedPnl: round(realizedPnl),
    realizedPnlToday: round(realizedPnlToday),
    unrealizedPnl,
    openPositionCount: open.length,
    markedPositionCount,
    unrealizedPartial: hasUnrealized && markedPositionCount < open.length,
    totalPnl: round(realizedPnl + (unrealizedPnl ?? 0)),
  };
}

/**
 * Canonical exit-reason buckets for the daily scorecard. Derived from the
 * free-text closeReason string written by evaluatePosition (riskManager) and
 * the manual/auto close paths, so the dashboard can show WHY trades closed
 * without coupling the UI to exact reason wording.
 *
 *   • hardStop      — "Stop loss: …" (the -stopLossFraction hard stop)
 *   • breakevenStop — "Breakeven stop: …" (stop raised to entry after +BE MFE)
 *   • profitLockStop— "Profit-lock stop: …" (stop raised to +profit after +PL MFE)
 *   • trailingStop  — "Trailing stop: …" (give-back exit on an armed winner)
 *   • hardFlatten   — "Hard flatten: …" / auto-flatten near the close/cutoff
 *   • manualOther   — manual API closes and anything else not matched above
 */
export type ExitReasonBucket =
  | "hardStop"
  | "breakevenStop"
  | "profitLockStop"
  | "trailingStop"
  | "hardFlatten"
  | "manualOther";

/**
 * Classify a closeReason string into a canonical bucket. Matching is done on
 * stable prefixes/keywords that evaluatePosition (riskManager) emits. Order
 * matters: breakeven is checked before the generic hard stop because the
 * breakeven reason also closes at/under the stop price.
 */
export function classifyExitReason(reason: string | undefined): ExitReasonBucket {
  const r = (reason ?? "").toLowerCase();
  if (!r) return "manualOther";
  if (r.includes("profit-lock")) return "profitLockStop";
  if (r.includes("breakeven")) return "breakevenStop";
  if (r.includes("trailing stop")) return "trailingStop";
  if (r.includes("hard flatten") || r.includes("flatten") || r.includes("cutoff")) return "hardFlatten";
  if (r.includes("stop loss") || r.startsWith("stop")) return "hardStop";
  return "manualOther";
}

export interface DailyScorecard {
  date: string;
  /** NET realized P&L (USD) on closed positions opened today (winners net losers). */
  realizedPnlToday: number;
  /** Closed trades opened today. */
  tradeCount: number;
  wins: number;
  losses: number;
  /** Closed today with exactly $0 P&L (scratch). Not counted as win or loss. */
  scratches: number;
  /** wins / (wins + losses), 0..1. 0 when no decided trades. */
  winRate: number;
  /** Average winner P&L (USD, positive) over winning trades; 0 when none. */
  avgWinner: number;
  /** Average loser P&L (USD, negative) over losing trades; 0 when none. */
  avgLoser: number;
  /** Largest single-trade P&L today (USD); 0 when no closed trades. */
  bestTrade: number;
  /** Smallest single-trade P&L today (USD); 0 when no closed trades. */
  worstTrade: number;
  /** Currently open tracked positions (any entry date). */
  openPositionCount: number;
  /** Total option contracts traded today (sum of contracts on trades opened today, open + closed). */
  contractsTraded: number;
  /** Unrealized P&L (USD) on open positions valued at supplied marks; null when no mark. */
  unrealizedPnl: number | null;
  /** How many open positions had a usable mark for the unrealized figure. */
  markedPositionCount: number;
  /** True when at least one open position lacked a mark (unrealized is partial). */
  unrealizedPartial: boolean;
  /** Counts of closed trades today by canonical exit-reason bucket. */
  exitReasons: Record<ExitReasonBucket, number>;
  /** Counts of trades opened today by entry contract size (e.g. {"2":1,"3":0,"4":3}). */
  sizingDistribution: Record<string, number>;
}

/**
 * Compute the dashboard daily scorecard for the current trading day from
 * locally tracked positions. Read-only: never contacts a broker and never
 * mutates state. Unrealized P&L mirrors computeBotPnl (open positions valued at
 * supplied marks; null when none have a mark).
 *
 * "Today" is matched on entryAt date (positions opened today). Realized figures
 * count closed positions opened today; sizing distribution and contractsTraded
 * count every position opened today (open + closed) so the operator can verify
 * the 4/3/2 sizing ladder regardless of whether a trade has closed yet.
 */
export function computeDailyScorecard(marks?: Map<string, number>): DailyScorecard {
  maybeRollDay();
  const today = todayStr();

  const exitReasons: Record<ExitReasonBucket, number> = {
    hardStop: 0,
    breakevenStop: 0,
    profitLockStop: 0,
    trailingStop: 0,
    hardFlatten: 0,
    manualOther: 0,
  };
  const sizingDistribution: Record<string, number> = {};

  let realizedPnlToday = 0;
  let tradeCount = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let winnerSum = 0;
  let loserSum = 0;
  let bestTrade = 0;
  let worstTrade = 0;
  let contractsTraded = 0;

  for (const p of state.positions) {
    const openedToday = p.entryAt.slice(0, 10) === today;
    if (!openedToday) continue;

    // Sizing distribution + total contracts cover every position opened today,
    // whether still open or already closed, so 4/3/2 behavior is verifiable.
    const sizeKey = String(p.contracts);
    sizingDistribution[sizeKey] = (sizingDistribution[sizeKey] ?? 0) + 1;
    contractsTraded += p.contracts;

    if (p.status !== "closed" || typeof p.pnl !== "number") continue;

    tradeCount += 1;
    realizedPnlToday += p.pnl;
    exitReasons[classifyExitReason(p.closeReason)] += 1;

    if (p.pnl > 0) {
      wins += 1;
      winnerSum += p.pnl;
    } else if (p.pnl < 0) {
      losses += 1;
      loserSum += p.pnl;
    } else {
      scratches += 1;
    }

    if (tradeCount === 1) {
      bestTrade = p.pnl;
      worstTrade = p.pnl;
    } else {
      if (p.pnl > bestTrade) bestTrade = p.pnl;
      if (p.pnl < worstTrade) worstTrade = p.pnl;
    }
  }

  const open = state.positions.filter((p) => p.status === "open");
  let unrealized = 0;
  let markedPositionCount = 0;
  for (const p of open) {
    const mark = marks?.get(p.id);
    if (mark === undefined || !Number.isFinite(mark)) continue;
    unrealized += (mark - p.entryPremium) * p.contracts * 100;
    markedPositionCount += 1;
  }
  const hasUnrealized = markedPositionCount > 0;

  const decided = wins + losses;

  return {
    date: today,
    realizedPnlToday: round(realizedPnlToday),
    tradeCount,
    wins,
    losses,
    scratches,
    winRate: decided > 0 ? round(wins / decided, 4) : 0,
    avgWinner: wins > 0 ? round(winnerSum / wins) : 0,
    avgLoser: losses > 0 ? round(loserSum / losses) : 0,
    bestTrade: round(bestTrade),
    worstTrade: round(worstTrade),
    openPositionCount: open.length,
    contractsTraded,
    unrealizedPnl: hasUnrealized ? round(unrealized) : null,
    markedPositionCount,
    unrealizedPartial: hasUnrealized && markedPositionCount < open.length,
    exitReasons,
    sizingDistribution,
  };
}

/** Per-source performance row for the setup-source scorecard. */
export interface SetupSourceRow {
  source: SetupSource;
  /** Closed trades opened today attributed to this source. */
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  /** wins / (wins + losses), 0..1; 0 when no decided trades. */
  winRate: number;
  /** NET realized P&L (USD) over this source's closed trades today. */
  netPnl: number;
  /** Open positions (any entry date) attributed to this source. */
  openPositions: number;
}

export interface SetupSourceScorecard {
  date: string;
  rows: SetupSourceRow[];
}

/**
 * Per-setup-source daily scorecard. Buckets today's closed trades by the
 * SetupSource recorded at entry and rolls up trades / win-rate / net P&L per
 * bucket. Read-only; never contacts a broker. Every canonical bucket in
 * SETUP_SOURCES is always present (zeroed when it had no activity) so the
 * dashboard renders a stable set of rows. Positions with no recorded source
 * (legacy or adopted) fall into "Other / manual" via classifySetupSource.
 */
export function computeSetupSourceScorecard(): SetupSourceScorecard {
  maybeRollDay();
  const today = todayStr();

  const blank = (): Omit<SetupSourceRow, "source" | "winRate"> => ({
    trades: 0,
    wins: 0,
    losses: 0,
    scratches: 0,
    netPnl: 0,
    openPositions: 0,
  });
  const acc = new Map<SetupSource, ReturnType<typeof blank>>();
  for (const s of SETUP_SOURCES) acc.set(s, blank());

  for (const p of state.positions) {
    if (p.entryAt.slice(0, 10) !== today) continue;
    const source = p.setupSource ?? classifySetupSource(undefined);
    const row = acc.get(source)!;

    if (p.status === "open") {
      row.openPositions += 1;
      continue;
    }
    if (typeof p.pnl !== "number") continue;

    row.trades += 1;
    row.netPnl += p.pnl;
    if (p.pnl > 0) row.wins += 1;
    else if (p.pnl < 0) row.losses += 1;
    else row.scratches += 1;
  }

  const rows: SetupSourceRow[] = SETUP_SOURCES.map((source) => {
    const r = acc.get(source)!;
    const decided = r.wins + r.losses;
    return {
      source,
      trades: r.trades,
      wins: r.wins,
      losses: r.losses,
      scratches: r.scratches,
      winRate: decided > 0 ? round(r.wins / decided, 4) : 0,
      netPnl: round(r.netPnl),
      openPositions: r.openPositions,
    };
  });

  return { date: today, rows };
}

// ─── Weekly scorecard ───────────────────────────────────────────────────────────

export interface WeeklyDayRollup {
  /** YYYY-MM-DD (NY market date). */
  date: string;
  /** Short weekday label (Mon, Tue, ...). */
  weekday: string;
  /** NET realized P&L (USD) on closed positions opened this day. */
  realizedPnl: number;
  tradeCount: number;
  wins: number;
  losses: number;
  contractsTraded: number;
}

export interface WeeklyScorecard {
  /** Monday of the current NY-local week (YYYY-MM-DD). */
  weekStart: string;
  /** Friday of the current NY-local week (YYYY-MM-DD). */
  weekEnd: string;
  /** NET realized P&L (USD) across every closed position opened this week. */
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
  /** Distinct dates this week with at least one closed trade. */
  activeDays: number;
  exitReasons: Record<ExitReasonBucket, number>;
  sizingDistribution: Record<string, number>;
  /** Mon → Fri rollup (always 5 entries; zero-filled for days with no trades). */
  perDay: WeeklyDayRollup[];
}

/**
 * NY-local YYYY-MM-DD for a JS Date.
 */
function nyDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

/**
 * Monday of the current NY-local week as YYYY-MM-DD. Weekend → previous Monday.
 */
function weekStartNy(now: Date = new Date()): string {
  const todayIso = nyDateStr(now);
  const dt = new Date(`${todayIso}T12:00:00Z`); // midday probe avoids DST edge
  // JS getUTCDay on a midday-UTC anchor returns the NY weekday for most of the
  // year. To be safe, use Intl to pull the weekday name directly.
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = map[wd] ?? 0;
  const monday = new Date(dt.getTime() - offset * 24 * 60 * 60_000);
  return nyDateStr(monday);
}

/**
 * Compute the weekly scorecard (Mon → Fri of the current NY week) by
 * aggregating locally tracked positions across the week. Mirrors the daily
 * scorecard's field set so the UI can reuse the same `ScoreStat` layout, and
 * adds a 5-row per-day breakdown so the operator can see each session's P&L.
 *
 * Read-only: never contacts the broker, never mutates state.
 */
export function computeWeeklyScorecard(): WeeklyScorecard {
  maybeRollDay();
  const monday = weekStartNy();
  const fridayDate = new Date(`${monday}T12:00:00Z`);
  fridayDate.setUTCDate(fridayDate.getUTCDate() + 4);
  const friday = nyDateStr(fridayDate);

  const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const perDayMap = new Map<string, WeeklyDayRollup>();
  for (let i = 0; i < 5; i += 1) {
    const probe = new Date(`${monday}T12:00:00Z`);
    probe.setUTCDate(probe.getUTCDate() + i);
    const iso = nyDateStr(probe);
    perDayMap.set(iso, {
      date: iso,
      weekday: weekdayNames[i],
      realizedPnl: 0,
      tradeCount: 0,
      wins: 0,
      losses: 0,
      contractsTraded: 0,
    });
  }

  const exitReasons: Record<ExitReasonBucket, number> = {
    hardStop: 0,
    breakevenStop: 0,
    profitLockStop: 0,
    trailingStop: 0,
    hardFlatten: 0,
    manualOther: 0,
  };
  const sizingDistribution: Record<string, number> = {};

  let realizedPnlWeek = 0;
  let tradeCount = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let winnerSum = 0;
  let loserSum = 0;
  let bestTrade = 0;
  let worstTrade = 0;
  let contractsTraded = 0;

  for (const p of state.positions) {
    const entryDay = p.entryAt.slice(0, 10);
    if (entryDay < monday || entryDay > friday) continue;

    const sizeKey = String(p.contracts);
    sizingDistribution[sizeKey] = (sizingDistribution[sizeKey] ?? 0) + 1;
    contractsTraded += p.contracts;
    const day = perDayMap.get(entryDay);
    if (day) day.contractsTraded += p.contracts;

    if (p.status !== "closed" || typeof p.pnl !== "number") continue;

    tradeCount += 1;
    realizedPnlWeek += p.pnl;
    exitReasons[classifyExitReason(p.closeReason)] += 1;
    if (day) {
      day.realizedPnl += p.pnl;
      day.tradeCount += 1;
    }

    if (p.pnl > 0) {
      wins += 1;
      winnerSum += p.pnl;
      if (day) day.wins += 1;
    } else if (p.pnl < 0) {
      losses += 1;
      loserSum += p.pnl;
      if (day) day.losses += 1;
    } else {
      scratches += 1;
    }

    if (tradeCount === 1) {
      bestTrade = p.pnl;
      worstTrade = p.pnl;
    } else {
      if (p.pnl > bestTrade) bestTrade = p.pnl;
      if (p.pnl < worstTrade) worstTrade = p.pnl;
    }
  }

  const decided = wins + losses;
  const perDay = Array.from(perDayMap.values()).map((d) => ({
    ...d,
    realizedPnl: round(d.realizedPnl),
  }));
  const activeDays = perDay.filter((d) => d.tradeCount > 0).length;

  return {
    weekStart: monday,
    weekEnd: friday,
    realizedPnlWeek: round(realizedPnlWeek),
    tradeCount,
    wins,
    losses,
    scratches,
    winRate: decided > 0 ? round(wins / decided, 4) : 0,
    avgWinner: wins > 0 ? round(winnerSum / wins) : 0,
    avgLoser: losses > 0 ? round(loserSum / losses) : 0,
    bestTrade: round(bestTrade),
    worstTrade: round(worstTrade),
    contractsTraded,
    activeDays,
    exitReasons,
    sizingDistribution,
    perDay,
  };
}

/** Source used for the day's loss figure that drives the daily-loss guard. */
export type DailyLossSource = "broker-day-pnl" | "local-net-realized";

export interface DailyLossSnapshot {
  date: string;
  tradesOpened: number;
  /**
   * NET realized P&L for closed positions opened today (USD, signed; winners
   * net against losers). De-duplicated per adopted broker identity because each
   * identity is closed exactly once (see closePaperPosition / adoptBrokerPosition).
   * This is the figure the daily-loss guard is built on.
   */
  netRealizedPnlToday: number;
  /**
   * USD of net realized LOSS consumed against maxDailyLoss today:
   * max(0, -loss source). 0 when the day is net flat or net positive. The guard
   * blocks new entries when this reaches maxDailyLoss.
   */
  dailyLossUsed: number;
  /**
   * INFORMATIONAL: gross USD lost on losing trades only (winners excluded).
   * Always >= dailyLossUsed because it ignores offsetting winners. Surfaced so a
   * dashboard can show "lost on losers" without confusing it for the day's P&L.
   */
  grossLossToday: number;
  /** Which figure netRealizedPnlToday/dailyLossUsed was derived from. */
  source: DailyLossSource;
}

/**
 * Compute the day's loss snapshot that drives the daily-loss guard.
 *
 * The guard is based on NET realized P&L for the day — losers offset by winners
 * — NOT the gross sum of losing trades. Gross loss (state.daily.grossLossToday)
 * is retained only as an informational metric.
 *
 * Source selection:
 *   • If a live broker DAY P&L is supplied AND it is a finite number, use it as
 *     the day's realized result (broker is the source of truth for real money).
 *     The caller must pass ONLY a real day P&L (e.g. Tradier balances.day_pl) —
 *     never an all-time/total P&L and never a null/stale field. When the broker
 *     day figure is null/unavailable the caller should omit it.
 *   • Otherwise fall back to the local de-duplicated net realized P&L from
 *     closed positions opened today.
 *
 * dailyLossUsed = max(0, -netRealizedPnlToday). A net-positive or flat day uses 0.
 */
export function getDailyLossSnapshot(brokerDayPnl?: number | null): DailyLossSnapshot {
  maybeRollDay();
  const today = todayStr();

  let localNet = 0;
  for (const p of state.positions) {
    if (p.status !== "closed" || typeof p.pnl !== "number") continue;
    if (p.entryAt.slice(0, 10) === today) localNet += p.pnl;
  }
  localNet = round(localNet);

  const brokerUsable = typeof brokerDayPnl === "number" && Number.isFinite(brokerDayPnl);
  const netRealizedPnlToday = brokerUsable ? round(brokerDayPnl as number) : localNet;
  const source: DailyLossSource = brokerUsable ? "broker-day-pnl" : "local-net-realized";

  return {
    date: state.daily.date,
    tradesOpened: state.daily.tradesOpened,
    netRealizedPnlToday,
    dailyLossUsed: round(Math.max(0, -netRealizedPnlToday)),
    grossLossToday: round(state.daily.grossLossToday),
    source,
  };
}

/** Reset all paper state (for testing) */
export function resetPaperState() {
  state = freshState();
  persistIfConfigured();
}

function round(v: number, dp = 2) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
