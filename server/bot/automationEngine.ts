/**
 * Autonomous trading engine — hands-off SPY 0DTE entry and exit.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AUTONOMOUS EXECUTION — DEFAULTS OFF, MULTIPLE INDEPENDENT GUARDS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This module periodically reads the in-memory market snapshot, generates
 * signals, and — only when every guard passes — opens and manages real SPY 0DTE
 * positions through the SAME guarded Tradier adapter the manual routes use.
 *
 * Real autonomous orders require ALL of the following (any one missing → no order):
 *   1. TRADIER_AUTO_TRADE=true            (master autonomy switch)
 *   2. TRADIER_ENABLE_LIVE_TRADING=true   (existing live switch)
 *   3. TRADIER_ACCOUNT_ID + TRADIER_TOKEN (credentials)
 *   4. Kill switch OFF
 *   5. Runtime "running" flag on (default on; can be toggled off via API)
 *   6. Entry guards: session/cutoff, news blackout, risk limits, max positions
 *   7. ACTIONABLE same-day 0DTE signal (later-dated expiries are refused)
 *
 * The engine supplies confirmLiveOrder=true internally because the user
 * explicitly asked for autonomous entry/exit. It never bypasses the same-day
 * 0DTE guard (enforced inside the adapter) or any risk limit.
 *
 * When TRADIER_AUTO_TRADE is false (the default), or live env is incomplete,
 * the engine runs in OBSERVE-ONLY mode: it evaluates and logs what it WOULD do
 * but routes every order through the paper path — no real trade is placed.
 *
 * ⚠  HIGH-RISK AUTOMATION. 0DTE options can expire worthless. Not financial advice.
 */

import type { BotConfig } from "./config.js";
import {
  getBotConfig,
  isNearHighImpactEvent,
  etTimestamp,
  etZoneDiagnostics,
} from "./config.js";
import { isZeroDteSymbol } from "./occSymbol.js";
import {
  evaluateDataFreshness,
  generateSignals,
  type SnapshotForSignal,
  type BotSignal,
} from "./signalEngine.js";
import {
  buildOptionOrderPayload,
  executeOrder,
  fetchOptionQuote,
  waitForFill,
  cancelOrder,
} from "./tradierAdapter.js";
import { canOpenPosition, evaluatePosition, sizePosition } from "./riskManager.js";
import { fetchAccountSnapshot } from "./tradierAdapter.js";
import {
  reconcileBrokerPositions,
  type BrokerPositionClassification,
} from "./positionReconciler.js";
import {
  openPaperPosition,
  closePaperPosition,
  updateTrail,
  getOpenPositions,
  getDailyLossSnapshot,
  markExitPending,
  type PaperPosition,
} from "./paperState.js";

export type AutomationEventKind =
  | "tick"
  | "entry"
  | "exit"
  | "skip"
  | "block"
  | "error"
  | "lifecycle";

export interface AutomationEvent {
  /** UTC ISO instant the event was recorded. */
  at: string;
  /** Same instant rendered in Eastern time ("YYYY-MM-DD HH:MM:SS ET"), so logs
   * are self-verifying against the ET-gated session clock without UTC/local
   * conversion. */
  atEt: string;
  kind: AutomationEventKind;
  message: string;
  /** "LIVE" when a real order was sent, "PAPER" when simulated/observe-only. */
  mode: "LIVE" | "PAPER";
  detail?: Record<string, unknown>;
}

export interface AutomationStatus {
  /** TRADIER_AUTO_TRADE=true AND live env complete — real autonomous orders allowed. */
  enabled: boolean;
  /** Runtime toggle. When false the loops idle even if enabled. */
  running: boolean;
  /** True when the engine is in observe-only (paper) mode for any reason. */
  observeOnly: boolean;
  lastTick: string | null;
  lastEntryTick: string | null;
  lastExitTick: string | null;
  nextTickApprox: string | null;
  lastAction: string | null;
  /** Reasons currently preventing autonomous entry, for the UI. */
  blockers: string[];
  /** Whether exit management has a live mark source (Tradier quotes). */
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
    /** True when this position was adopted from a live Tradier broker position. */
    adoptedFromBroker: boolean;
    /** Premium at which the trail exits (peak × (1 − giveback)) once armed. */
    trailExitPrice: number | null;
    /** Give-back fraction used for the trailing exit (e.g. 0.05 = 5%). */
    trailGivebackFraction: number;
  }>;
  /** Symbols adopted from the broker in the most recent reconciliation pass. */
  adoptedSymbols: string[];
  /**
   * Broker positions the bot already handled (managed/exit-pending/closed) that
   * the broker is still reporting. Intentionally NOT re-adopted or re-exited —
   * shown so the operator sees them as pending settlement, not lost.
   */
  pendingBrokerPositions: string[];
  /** Broker positions surfaced for operator review (not managed by the bot). */
  reviewBrokerPositions: BrokerPositionClassification[];
  /**
   * Warning shown when the broker holds positions the bot cannot adopt for exit
   * management (e.g. shorts, non-SPY, non-0DTE), so the trail cannot act on them.
   */
  brokerReconcileWarning: string | null;
  recentEvents: AutomationEvent[];
  intervals: { entryMs: number; exitMs: number };
}

const MAX_EVENTS = 60;

// ── Engine singleton state ─────────────────────────────────────────────────────
let entryTimer: NodeJS.Timeout | null = null;
let exitTimer: NodeJS.Timeout | null = null;
let running = true; // runtime toggle; env switch still required for real orders
let lastTick: string | null = null;
let lastEntryTick: string | null = null;
let lastExitTick: string | null = null;
let lastAction: string | null = null;
let exitManagement: "live-quotes" | "degraded" = "degraded";
let entryInFlight = false;
let exitInFlight = false;

const events: AutomationEvent[] = [];
/** symbol → epoch ms of last entry, for per-contract re-entry cooldown. */
const entryCooldown = new Map<string, number>();
/** position id → last observed option mark, for status display. */
const lastMarks = new Map<string, number>();
/**
 * position id → in-flight live EXIT order. Prevents submitting a second
 * sell_to_close while a prior one is still working at the broker; the exit
 * loop polls/escalates this order instead of stacking new ones.
 */
const pendingExitOrders = new Map<
  string,
  { orderId: string; qty: number; submittedAt: number; escalatedToMarket: boolean }
>();
/** position id → consecutive mark-fetch failures, for blind-exit alerting. */
const markFailureCounts = new Map<string, number>();

/** Last broker-reconciliation outcome, surfaced in status for visibility. */
let lastReconcile: {
  adopted: string[];
  pending: string[];
  review: BrokerPositionClassification[];
  warning: string | null;
} = { adopted: [], pending: [], review: [], warning: null };

let getSnapshotFn: (() => SnapshotForSignal) | null = null;

function logEvent(
  kind: AutomationEventKind,
  message: string,
  mode: "LIVE" | "PAPER",
  detail?: Record<string, unknown>,
): void {
  const nowDate = new Date();
  const evt: AutomationEvent = {
    at: nowDate.toISOString(),
    atEt: etTimestamp(nowDate),
    kind,
    message,
    mode,
  };
  if (detail) evt.detail = detail;
  events.push(evt);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (kind !== "tick") lastAction = `${message}`;
}

/** Real autonomous orders allowed only when the master switch + live env are all set. */
function autonomyLive(cfg: BotConfig): boolean {
  return cfg.autoTradeEnabled && cfg.liveEnabled && !cfg.killSwitchActive;
}

/**
 * Compute the list of current blockers preventing autonomous ENTRY. Empty when
 * the engine is clear to enter on the next ACTIONABLE signal.
 */
function entryBlockers(cfg: BotConfig, now = new Date()): string[] {
  const blockers: string[] = [];
  if (!cfg.autoTradeEnabled) blockers.push("TRADIER_AUTO_TRADE is not true (autonomy OFF)");
  if (!cfg.liveEnabled) blockers.push("Live trading not enabled (env incomplete)");
  if (cfg.killSwitchActive) blockers.push("Kill switch is ON");
  if (!running) blockers.push("Automation runtime toggle is OFF");
  // No time-of-day entry gates: entries may open at any time of the session.
  // The hard-flatten cutoffs only close existing positions in the exit loop.

  // Fresh-data readiness — surface a stale snapshot as a blocker so the operator
  // sees that the automation is not working off fresh candles (the most likely
  // cause of a missed open move). Only meaningful when a snapshot is available.
  if (getSnapshotFn) {
    try {
      const snap = getSnapshotFn();
      const freshness = evaluateDataFreshness(snap.spy?.candles, cfg, now, cfg.requireFreshData);
      if (freshness.enforced && !freshness.ready) blockers.push(freshness.detail);
    } catch {
      // ignore snapshot read errors here; surfaced elsewhere
    }
  }

  const loss = getDailyLossSnapshot();
  const openCount = getOpenPositions().length;
  const guard = canOpenPosition(
    { tradesOpened: loss.tradesOpened, dailyLossUsed: loss.dailyLossUsed, netRealizedPnlToday: loss.netRealizedPnlToday },
    openCount,
    cfg,
    now,
  );
  if (!guard.allowed) blockers.push(guard.reason);

  return blockers;
}

// ── Entry loop ──────────────────────────────────────────────────────────────────

async function entryTick(): Promise<void> {
  if (entryInFlight) return;
  entryInFlight = true;
  try {
    const cfg = getBotConfig();
    const now = new Date();
    lastTick = now.toISOString();
    lastEntryTick = lastTick;

    if (!getSnapshotFn) return;
    const live = autonomyLive(cfg);
    const mode: "LIVE" | "PAPER" = live ? "LIVE" : "PAPER";

    if (!running) return; // idle but keep ticking for status

    // Hard guards before we even look at signals.
    const blockers = entryBlockers(cfg, now);
    // In observe-only mode we still evaluate signals (to surface intent), but a
    // real order is impossible. In live mode any blocker stops entry entirely.
    if (live && blockers.length) {
      return; // silent — status surfaces blockers; avoid log spam every tick
    }

    const snapshot = getSnapshotFn();
    const signals = generateSignals(snapshot, cfg, now);

    const actionable = signals.filter(
      (s) =>
        s.status === "ACTIONABLE" &&
        s.contract &&
        s.isZeroDte &&
        s.confidence >= cfg.autoMinConfidence,
    );

    if (!actionable.length) return;

    // Best-effort live account snapshot: used for sizing cash, the
    // broker-authoritative daily-loss figure, and the PDT guard. Fetched once
    // per tick.
    let availableCash: number | undefined;
    let brokerDayPnl: number | null = null;
    let accountType: string | null = null;
    let totalEquity: number | null = null;
    if (cfg.liveEnabled) {
      try {
        const acct = await fetchAccountSnapshot(cfg);
        availableCash =
          acct.optionBuyingPower ?? acct.cash ?? acct.buyingPower ?? undefined;
        brokerDayPnl = acct.dayPnl;
        accountType = acct.accountType;
        totalEquity = acct.totalEquity;
      } catch {
        availableCash = undefined;
      }
    }

    // BROKER-AUTHORITATIVE DAILY LOSS PATCH: when the broker reports a real day
    // P&L, the daily-loss guard runs on it instead of locally-assumed fills —
    // local counters reset on restart and previously tracked fictional fills.
    const loss = getDailyLossSnapshot(brokerDayPnl);
    let tradesOpenedThisDay = loss.tradesOpened;
    let openCount = getOpenPositions().length;

    // PDT GUARD: a margin account under $25k equity is limited to 3 day trades
    // per 5 business days. The bot only sees today's count, so it blocks the
    // 4th same-day round trip — conservative but prevents the most common
    // violation. Cash accounts are exempt from PDT.
    if (
      cfg.pdtGuardEnabled &&
      live &&
      accountType !== null &&
      accountType.toLowerCase().includes("margin") &&
      totalEquity !== null &&
      totalEquity < 25_000 &&
      tradesOpenedThisDay >= 3
    ) {
      logEvent(
        "block",
        `PDT guard: margin account equity $${totalEquity.toFixed(0)} < $25k and ${tradesOpenedThisDay} day trades already opened today — no further autonomous entries (set BOT_PDT_GUARD_ENABLED=false to override)`,
        mode,
      );
      return;
    }

    for (const sig of actionable) {
      const contract = sig.contract!;

      // Re-entry cooldown per contract symbol.
      const lastEntry = entryCooldown.get(contract.symbol) ?? 0;
      if (now.getTime() - lastEntry < cfg.autoEntryCooldownMs) {
        continue;
      }

      // Avoid duplicate open in the same contract symbol.
      const dup = getOpenPositions().some((p) => p.symbol === contract.symbol);
      if (dup) continue;

      // Risk gate (re-checked here so each entry respects live counters).
      const guard = canOpenPosition(
        { tradesOpened: tradesOpenedThisDay, dailyLossUsed: loss.dailyLossUsed, netRealizedPnlToday: loss.netRealizedPnlToday },
        openCount,
        cfg,
        now,
      );
      if (!guard.allowed) {
        logEvent("block", `Entry blocked: ${guard.reason}`, mode, { symbol: contract.symbol });
        break;
      }

      // Defensive: never open a non-same-day contract autonomously.
      if (!isZeroDteSymbol(contract.symbol, now)) {
        logEvent("block", `Refused non-0DTE contract ${contract.symbol}`, mode);
        continue;
      }

      const opened = await openOne(sig, cfg, live, mode, now, availableCash);
      if (opened) {
        openCount += 1;
        tradesOpenedThisDay += 1;
      }
    }
  } catch (err) {
    logEvent("error", `Entry loop error: ${err instanceof Error ? err.message : String(err)}`, "PAPER");
  } finally {
    entryInFlight = false;
  }
}

async function openOne(
  sig: BotSignal,
  cfg: BotConfig,
  live: boolean,
  mode: "LIVE" | "PAPER",
  now: Date,
  availableCash?: number,
): Promise<boolean> {
  const contract = sig.contract!;
  const mid = sig.suggestedEntryPremium ?? contract.ask ?? contract.last ?? 0.5;
  const entryPremium = mid > 0 ? mid : 0.5;
  const useLimit = mid > 0;

  // Size under cash + per-trade-loss constraints. Skip entry if even the hard
  // minimum's projected stop loss exceeds the per-trade cap, or cash is short.
  const sizing = sizePosition(entryPremium, cfg, availableCash);
  if (!sizing.allowed || sizing.contracts < 1) {
    logEvent("skip", `Entry skipped for ${contract.symbol}: ${sizing.reason}`, mode, { symbol: contract.symbol });
    return false;
  }

  const payload = buildOptionOrderPayload({
    optionSymbol: contract.symbol,
    side: "buy_to_open",
    contracts: sizing.contracts,
    orderType: useLimit ? "limit" : "market",
    // For limit buys, allow a small slippage cushion above mid to improve fills.
    limitPrice: useLimit ? round(mid * 1.05) : undefined,
  });

  try {
    // confirmLiveOrder is supplied internally ONLY in live autonomy mode. When
    // observe-only, executeOrder routes to paper regardless.
    const result = await executeOrder(payload, cfg, live);

    // ── FILL-CONFIRMATION PATCH (live only) ─────────────────────────────────
    // Never assume a live limit order filled. Poll the order until it fills,
    // record the ACTUAL average fill price and executed quantity, and cancel
    // anything still working at the timeout. A local position is opened only
    // for contracts the broker actually executed.
    let filledContracts = sizing.contracts;
    let fillPremium = entryPremium;

    if (live && !result.simulated) {
      if (!result.orderId) {
        logEvent("error", `Entry order for ${contract.symbol} returned no order id — not opening local position; reconciler will adopt if it filled`, mode);
        return false;
      }
      const fill = await waitForFill(result.orderId, cfg, cfg.entryFillTimeoutMs);

      if (fill.outcome === "filled") {
        filledContracts = fill.execQuantity ?? sizing.contracts;
        fillPremium = fill.avgFillPrice ?? entryPremium;
      } else if (fill.outcome === "partial") {
        // Keep what executed, cancel the remainder.
        await cancelOrder(result.orderId, cfg);
        filledContracts = fill.execQuantity ?? 0;
        fillPremium = fill.avgFillPrice ?? entryPremium;
        if (filledContracts < 1) {
          logEvent("skip", `Entry for ${contract.symbol} canceled with no executed contracts`, mode);
          return false;
        }
        logEvent("entry", `Partial fill on ${contract.symbol}: ${filledContracts}/${sizing.contracts} executed @ ${fillPremium.toFixed(2)}; remainder canceled`, mode);
      } else if (fill.outcome === "unfilled" || fill.outcome === "rejected") {
        if (fill.outcome === "unfilled") await cancelOrder(result.orderId, cfg);
        logEvent("skip", `Entry order for ${contract.symbol} ${fill.outcome} (status ${fill.status ?? "?"}) — no position opened`, mode, { orderId: result.orderId });
        return false;
      } else {
        // "unknown": status endpoint unreachable. Do NOT assume a fill and do
        // NOT assume a non-fill — best-effort cancel, open NO local position,
        // and let the broker reconciler adopt the position if it turns out the
        // order executed. This avoids managing a phantom either way.
        await cancelOrder(result.orderId, cfg);
        logEvent("error", `Entry order status for ${contract.symbol} unverifiable — cancel attempted; reconciler will adopt if it filled`, mode, { orderId: result.orderId });
        return false;
      }
    }

    const pos = openPaperPosition({
      symbol: contract.symbol,
      side: contract.side,
      strike: contract.strike,
      expiry: contract.expiry,
      contracts: filledContracts,
      entryPremium: fillPremium,
      stopFraction: cfg.stopLossFraction,
      takeProfitFraction: cfg.takeProfitFraction,
      trailStartFraction: cfg.trailStartFraction,
      trailGivebackFraction: cfg.trailGivebackFraction,
      breakevenArmFraction: cfg.breakevenArmFraction,
      profitLockArmFraction: cfg.profitLockArmFraction,
      profitLockProfitFraction: cfg.profitLockProfitFraction,
      setupTitle: sig.setup?.title,
    });

    entryCooldown.set(contract.symbol, now.getTime());

    logEvent(
      "entry",
      `${mode === "LIVE" ? "LIVE" : "OBSERVE"} buy_to_open ${filledContracts}x ${contract.symbol} @ ${fillPremium.toFixed(2)}${live ? " (confirmed fill)" : ` (~${mid.toFixed(2)} assumed)`} (${contract.side}, conf ${sig.confidence}) — ${sizing.reason}`,
      mode,
      { orderId: result.orderId, status: result.status, positionId: pos.id, simulated: result.simulated, contracts: filledContracts },
    );
    return true;
  } catch (err) {
    logEvent(
      "error",
      `Entry order failed for ${contract.symbol}: ${err instanceof Error ? err.message : String(err)}`,
      mode,
    );
    return false;
  }
}

// ── Exit / position-management loop ──────────────────────────────────────────────

async function exitTick(): Promise<void> {
  if (exitInFlight) return;
  exitInFlight = true;
  try {
    const cfg = getBotConfig();
    const now = new Date();
    lastExitTick = now.toISOString();

    // Reconcile broker positions FIRST so positions held at the broker but
    // missing from local state (after a restart/redeploy) are adopted into
    // managed state before exits are evaluated this same tick. Adoption only
    // runs when full live autonomy is armed; it never opens or sizes a trade.
    await reconcileTick(cfg, now);

    const open = getOpenPositions();
    if (!open.length) {
      exitManagement = cfg.tradierToken ? "live-quotes" : "degraded";
      return;
    }

    const live = autonomyLive(cfg);
    const mode: "LIVE" | "PAPER" = live ? "LIVE" : "PAPER";

    let anyLiveMark = false;
    for (const pos of open) {
      const mark = await resolveMark(pos, cfg);
      if (mark.source === "tradier") anyLiveMark = true;
      lastMarks.set(pos.id, mark.value);

      // Keep the trailing-stop peak/armed flags current for the full position
      // (single or multi contract — there is no partial trim ladder).
      updateTrail(pos.id, mark.value);

      const action = evaluatePosition(pos, mark.value, cfg, now);
      if (action.kind === "hold") continue;

      // stop or flatten — always allowed; closing is never blocked by 0DTE guard.
      await closePosition(pos, action.closePremium, action.reason, cfg, live, mode);
    }

    exitManagement = anyLiveMark ? "live-quotes" : "degraded";
  } catch (err) {
    logEvent("error", `Exit loop error: ${err instanceof Error ? err.message : String(err)}`, "PAPER");
  } finally {
    exitInFlight = false;
  }
}

/**
 * Adopt eligible live broker positions into managed state and record the
 * outcome for status visibility. Logs an event only when something is adopted
 * or when broker positions exist that cannot be adopted (avoids per-tick spam).
 */
async function reconcileTick(cfg: BotConfig, now: Date): Promise<void> {
  try {
    const result = await reconcileBrokerPositions(cfg, now);
    if (!result.ran) {
      lastReconcile = { adopted: [], pending: [], review: [], warning: null };
      return;
    }

    const warning = result.unmanagedBrokerPositions
      ? "Broker holds option position(s) the bot cannot adopt for exit management " +
        "(not SPY same-day 0DTE long). The trailing exit cannot act on these."
      : null;

    lastReconcile = {
      adopted: result.adopted,
      pending: result.pendingBrokerPositions,
      review: result.review,
      warning,
    };

    if (result.adopted.length) {
      logEvent(
        "lifecycle",
        `Adopted ${result.adopted.length} live broker position(s) for exit management: ${result.adopted.join(", ")}`,
        "LIVE",
        { adopted: result.adopted },
      );
    }
    // Pending (already-handled, still-reported) positions are deliberately NOT
    // logged every tick — that per-tick spam was the visible symptom of the bug.
    // They are surfaced in status only.
  } catch (err) {
    logEvent("error", `Reconcile error: ${err instanceof Error ? err.message : String(err)}`, "PAPER");
  }
}

/**
 * Resolve a current mark for a position.
 *
 * MARK-FALLBACK PATCH: exits are evaluated against the BID (the side a long
 * actually sells at) when available, falling back to mid/last. On a failed
 * quote fetch the LAST KNOWN mark is reused — never the entry premium, which
 * made the position appear exactly flat and silently disabled stops during
 * data outages. Consecutive failures are counted and alerted past the
 * configured threshold so the operator knows exit management is blind.
 */
async function resolveMark(
  pos: PaperPosition,
  cfg: BotConfig,
): Promise<{ value: number; source: "tradier" | "stale" | "none" }> {
  const quote = await fetchOptionQuote(pos.symbol, cfg);
  const liveValue = quote.bid ?? quote.mid ?? quote.last;
  if (liveValue !== null) {
    markFailureCounts.delete(pos.id);
    return { value: liveValue, source: "tradier" };
  }

  const failures = (markFailureCounts.get(pos.id) ?? 0) + 1;
  markFailureCounts.set(pos.id, failures);
  if (failures === Math.max(1, cfg.markFailureAlertCount)) {
    logEvent(
      "error",
      `No quote for ${pos.symbol} for ${failures} consecutive exit ticks — stops are operating on a STALE mark. Consider manual intervention.`,
      "PAPER",
      { positionId: pos.id },
    );
  }

  const lastKnown = lastMarks.get(pos.id);
  if (lastKnown !== undefined) return { value: lastKnown, source: "stale" };
  // Never observed a mark and the quote failed: hold at entry, flagged "none"
  // so the caller does not treat it as a live quote.
  return { value: pos.entryPremium, source: "none" };
}

async function closePosition(
  pos: PaperPosition,
  premium: number,
  reason: string,
  cfg: BotConfig,
  live: boolean,
  mode: "LIVE" | "PAPER",
): Promise<void> {
  // The full remaining position is always sold — no partial trims.
  const sellQty = pos.contracts;

  // ── EXIT FILL-CONFIRMATION PATCH (live path) ──────────────────────────────
  // The previous behavior closed the LOCAL position the moment the broker
  // ACCEPTED the sell order — an unfilled limit left a real 0DTE position that
  // the bot believed was closed and the reconciler deliberately never re-exited.
  // Now: price the limit at the BID, poll until filled, escalate an unfilled
  // limit to a MARKET order, and only close local state on confirmed execution.
  let closeFillPremium = premium;

  if (live) {
    try {
      // If a prior exit order for this position is still working, manage IT
      // instead of stacking a second sell_to_close.
      const pending = pendingExitOrders.get(pos.id);
      if (pending) {
        const fill = await waitForFill(pending.orderId, cfg, 2_000, 1_000);
        if (fill.outcome === "filled") {
          closeFillPremium = fill.avgFillPrice ?? premium;
          pendingExitOrders.delete(pos.id);
          // fall through to local close below
        } else if (!pending.escalatedToMarket) {
          // Still working — cancel and escalate to market.
          await cancelOrder(pending.orderId, cfg);
          const mktPayload = buildOptionOrderPayload({
            optionSymbol: pos.symbol,
            side: "sell_to_close",
            contracts: sellQty,
            orderType: "market",
          });
          const mkt = await executeOrder(mktPayload, cfg, true);
          if (mkt.orderId) {
            pendingExitOrders.set(pos.id, {
              orderId: mkt.orderId,
              qty: sellQty,
              submittedAt: Date.now(),
              escalatedToMarket: true,
            });
            const mfill = await waitForFill(mkt.orderId, cfg, cfg.exitFillTimeoutMs);
            if (mfill.outcome === "filled" || mfill.outcome === "partial") {
              closeFillPremium = mfill.avgFillPrice ?? premium;
              pendingExitOrders.delete(pos.id);
            } else {
              logEvent("error", `Market exit for ${pos.symbol} not confirmed (${mfill.outcome}) — will re-check next tick`, mode, { orderId: mkt.orderId });
              return; // keep position open locally; re-check next tick
            }
          } else {
            logEvent("error", `Market-escalation order for ${pos.symbol} returned no id — will retry next tick`, mode);
            return;
          }
        } else {
          // Market order already in flight and not yet confirmed — wait.
          logEvent("block", `Exit for ${pos.symbol} pending market-order confirmation — re-checking next tick`, mode, { orderId: pending.orderId });
          return;
        }
      } else {
        // No prior exit in flight: submit a limit at the BID (the realistic
        // sell side), fall back to the supplied mark less a cushion.
        const quote = await fetchOptionQuote(pos.symbol, cfg);
        const limitPrice =
          quote.bid !== null ? quote.bid : premium > 0 ? round(premium * 0.95) : undefined;
        const closePayload = buildOptionOrderPayload({
          optionSymbol: pos.symbol,
          side: "sell_to_close",
          contracts: sellQty,
          orderType: limitPrice !== undefined ? "limit" : "market",
          limitPrice,
        });
        const result = await executeOrder(closePayload, cfg, true);
        if (!result.orderId) {
          logEvent("error", `Live close for ${pos.symbol} returned no order id — will retry next tick`, mode);
          return;
        }
        pendingExitOrders.set(pos.id, {
          orderId: result.orderId,
          qty: sellQty,
          submittedAt: Date.now(),
          escalatedToMarket: closePayload.type === "market",
        });
        const fill = await waitForFill(result.orderId, cfg, cfg.exitFillTimeoutMs);
        if (fill.outcome === "filled") {
          closeFillPremium = fill.avgFillPrice ?? premium;
          pendingExitOrders.delete(pos.id);
        } else if (fill.outcome === "partial") {
          // Cancel the remainder and escalate it to market immediately.
          await cancelOrder(result.orderId, cfg);
          const remaining = sellQty - (fill.execQuantity ?? 0);
          if (remaining > 0) {
            const mktPayload = buildOptionOrderPayload({
              optionSymbol: pos.symbol,
              side: "sell_to_close",
              contracts: remaining,
              orderType: "market",
            });
            const mkt = await executeOrder(mktPayload, cfg, true);
            if (mkt.orderId) {
              const mfill = await waitForFill(mkt.orderId, cfg, cfg.exitFillTimeoutMs);
              if (mfill.outcome !== "filled" && mfill.outcome !== "partial") {
                pendingExitOrders.set(pos.id, {
                  orderId: mkt.orderId,
                  qty: remaining,
                  submittedAt: Date.now(),
                  escalatedToMarket: true,
                });
                logEvent("error", `Exit remainder for ${pos.symbol} unconfirmed — re-checking next tick`, mode);
                return;
              }
            }
          }
          closeFillPremium = fill.avgFillPrice ?? premium;
          pendingExitOrders.delete(pos.id);
        } else if (fill.outcome === "unfilled" || fill.outcome === "rejected" || fill.outcome === "unknown") {
          // Cancel (best-effort) and escalate straight to market — an exit
          // signal means we WANT out; a working limit that missed is risk.
          await cancelOrder(result.orderId, cfg);
          const mktPayload = buildOptionOrderPayload({
            optionSymbol: pos.symbol,
            side: "sell_to_close",
            contracts: sellQty,
            orderType: "market",
          });
          const mkt = await executeOrder(mktPayload, cfg, true);
          if (!mkt.orderId) {
            logEvent("error", `Exit escalation for ${pos.symbol} returned no id — will retry next tick`, mode);
            return;
          }
          pendingExitOrders.set(pos.id, {
            orderId: mkt.orderId,
            qty: sellQty,
            submittedAt: Date.now(),
            escalatedToMarket: true,
          });
          const mfill = await waitForFill(mkt.orderId, cfg, cfg.exitFillTimeoutMs);
          if (mfill.outcome === "filled" || mfill.outcome === "partial") {
            closeFillPremium = mfill.avgFillPrice ?? premium;
            pendingExitOrders.delete(pos.id);
          } else {
            logEvent("error", `Market exit for ${pos.symbol} not confirmed (${mfill.outcome}) — will re-check next tick`, mode, { orderId: mkt.orderId });
            return; // keep open locally; managed again next tick
          }
        }
      }
    } catch (err) {
      logEvent("error", `Live close failed for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`, mode);
      // Do not mutate local state if the broker order errored — retry next tick.
      return;
    }
    // A live sell_to_close EXECUTED. Flag the broker identity as exit-pending so
    // that if the broker keeps reporting the position before settlement, the
    // reconciler does NOT submit another sell_to_close or re-adopt it.
    markExitPending(pos.id);
  }

  const closed = closePaperPosition(pos.id, closeFillPremium, reason);
  if (closed) {
    lastMarks.delete(pos.id);
    markFailureCounts.delete(pos.id);
    pendingExitOrders.delete(pos.id);
    logEvent("exit", `${mode === "LIVE" ? "LIVE" : "OBSERVE"} sell_to_close ${sellQty}x ${pos.symbol} @ ${closeFillPremium.toFixed(2)}${live ? " (confirmed fill)" : ""} — ${reason} (PnL $${closed.pnl?.toFixed(2) ?? "?"})`, mode, { positionId: pos.id });
  }
}

// ── Public control surface ────────────────────────────────────────────────────

/**
 * Start the automation engine. Safe to call once at server boot. The timers
 * always run (so status stays fresh), but real orders require the env switches.
 */
export function startAutomationEngine(getSnapshot: () => SnapshotForSignal): void {
  getSnapshotFn = getSnapshot;
  if (entryTimer || exitTimer) return; // already started

  const cfg = getBotConfig();
  logEvent(
    "lifecycle",
    cfg.autoTradeEnabled && cfg.liveEnabled
      ? "Automation engine started — AUTONOMOUS LIVE trading ARMED"
      : "Automation engine started — observe-only (set TRADIER_AUTO_TRADE=true + live env to arm)",
    cfg.autoTradeEnabled && cfg.liveEnabled ? "LIVE" : "PAPER",
    // Record the resolved ET clock source on the start event so a mis-zoned run
    // is visible at a glance in the dashboard event log, not just stdout.
    { etClock: etZoneDiagnostics() },
  );

  entryTimer = setInterval(() => void entryTick(), cfg.automationIntervalMs);
  exitTimer = setInterval(() => void exitTick(), cfg.exitManagementIntervalMs);
  // Prevent the timers from keeping a test process alive.
  entryTimer.unref?.();
  exitTimer.unref?.();
}

export function stopAutomationEngine(): void {
  if (entryTimer) clearInterval(entryTimer);
  if (exitTimer) clearInterval(exitTimer);
  entryTimer = null;
  exitTimer = null;
}

/** Runtime toggle — does NOT enable real orders by itself (env switch still required). */
export function setAutomationRunning(value: boolean): void {
  running = value;
  logEvent("lifecycle", value ? "Automation runtime RESUMED" : "Automation runtime PAUSED", "PAPER");
}

export function getAutomationStatus(): AutomationStatus {
  const cfg = getBotConfig();
  const now = new Date();
  const enabled = cfg.autoTradeEnabled && cfg.liveEnabled;
  const observeOnly = !autonomyLive(cfg) || !running;

  const managed = getOpenPositions().map((p) => ({
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    contracts: p.contracts,
    entryPremium: p.entryPremium,
    stopPrice: p.stopPrice,
    trailStartPrice: p.trailStartPrice,
    trailArmed: p.trailArmed,
    peakPremium: p.peakPremium,
    breakevenArmPrice: p.breakevenArmPrice ?? null,
    breakevenArmed: p.breakevenArmed === true,
    lastMark: lastMarks.get(p.id) ?? null,
    adoptedFromBroker: p.adoptedFromBroker === true,
    trailExitPrice: p.trailArmed
      ? round(p.peakPremium * (1 - p.trailGivebackFraction))
      : null,
    trailGivebackFraction: p.trailGivebackFraction,
  }));

  const nextTickApprox = lastEntryTick
    ? new Date(new Date(lastEntryTick).getTime() + cfg.automationIntervalMs).toISOString()
    : null;

  return {
    enabled,
    running,
    observeOnly,
    lastTick,
    lastEntryTick,
    lastExitTick,
    nextTickApprox,
    lastAction,
    blockers: entryBlockers(cfg, now),
    exitManagement,
    managedPositions: managed,
    adoptedSymbols: lastReconcile.adopted,
    pendingBrokerPositions: lastReconcile.pending,
    reviewBrokerPositions: lastReconcile.review,
    brokerReconcileWarning: lastReconcile.warning,
    recentEvents: events.slice(-MAX_EVENTS).reverse(),
    intervals: { entryMs: cfg.automationIntervalMs, exitMs: cfg.exitManagementIntervalMs },
  };
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Snapshot of the last observed option marks keyed by position id. Used by the
 * account/P&L endpoint to value open positions for unrealized P&L. Marks are
 * only populated while the exit-management loop is running and a live quote was
 * reachable; positions absent from this map have no fresh mark.
 */
export function getMarkSnapshot(): Map<string, number> {
  return new Map(lastMarks);
}
