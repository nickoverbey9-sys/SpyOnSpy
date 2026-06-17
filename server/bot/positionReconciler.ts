/**
 * Broker-position reconciliation / adoption.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The autonomous exit loop only evaluates LOCAL managed positions. If the app
 * restarts or redeploys after an entry (or local state is otherwise lost), the
 * broker still holds the option but the engine has nothing in managedPositions,
 * so the hard stop / +35% arm / 5% give-back trailing exit silently does
 * nothing for that live position.
 *
 * This module reconciles the broker's reported positions into local managed
 * state so exit management resumes after a restart. It is EXIT-ONLY: it never
 * places an entry order and never sizes a new trade. The only order it can
 * cause is a sell_to_close, which the existing 0DTE guard always permits.
 *
 * ─── SAFETY SCOPING ───────────────────────────────────────────────────────────
 * A broker position is only ADOPTED when ALL of the following hold:
 *   • live autonomy is fully armed (autoTradeEnabled + liveEnabled, kill off),
 *   • the OCC symbol parses and is SPY,
 *   • the symbol is same-day 0DTE for the current NY market date,
 *   • quantity > 0 (LONG only — shorts are never managed),
 *   • not already present in local managed state (no duplicates).
 *
 * Positions that parse as SPY 0DTE long but cannot be valued (no live mark) are
 * still adopted (mark falls back to entry premium, exit loop flags degraded).
 * Anything that fails a hard scope rule is SKIPPED with a reason; anything
 * uncertain (parses but is not clearly SPY 0DTE long) is reported for REVIEW
 * and never adopted — no orders are placed for review items.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BotConfig } from "./config.js";
import { parseOccSymbol, isZeroDteSymbol } from "./occSymbol.js";
import { fetchBrokerPositions, fetchOptionMark, type TradierBrokerPosition } from "./tradierAdapter.js";
import {
  adoptBrokerPosition,
  getOpenPositions,
  getBrokerAdoptions,
  brokerAdoptionKey,
  type Side,
} from "./paperState.js";

export type ReconcileDisposition = "adopt" | "skip" | "review";

export interface BrokerPositionClassification {
  symbol: string;
  disposition: ReconcileDisposition;
  reason: string;
  /** Parsed contract details when the OCC symbol was understood. */
  side?: Side;
  strike?: number;
  expiry?: string;
  quantity?: number;
  /** Per-contract entry premium derived from broker cost basis (USD). */
  entryPremium?: number;
}

/**
 * Real autonomous management (incl. adoption-driven closes) is allowed only when
 * the master switch + live env are all set and the kill switch is off. Mirrors
 * automationEngine.autonomyLive so adoption never runs in observe-only mode.
 */
export function reconciliationLive(cfg: BotConfig): boolean {
  return cfg.autoTradeEnabled && cfg.liveEnabled && !cfg.killSwitchActive;
}

/**
 * Derive a per-contract entry premium from a Tradier option cost basis.
 *
 * Tradier reports option `cost_basis` as the TOTAL dollar cost (premium ×
 * quantity × 100). We divide by (quantity × 100) to get per-contract premium.
 * To be robust against an account/endpoint that already reports a per-contract
 * figure, if the naive total-dollar interpretation yields an implausibly small
 * premium (< $0.01) we fall back to treating the value as already per-contract.
 */
export function deriveEntryPremium(costBasis: number, quantity: number): number {
  const qty = Math.abs(quantity);
  if (!(qty > 0)) return Math.abs(costBasis);
  const perContractFromTotal = Math.abs(costBasis) / (qty * 100);
  if (perContractFromTotal >= 0.01) {
    return round(perContractFromTotal);
  }
  // Total-dollar interpretation produced a sub-penny premium — the value is very
  // likely already per-contract (or per-share). Use it directly.
  return round(Math.abs(costBasis));
}

/**
 * Pure classification of a single broker position for the current market date.
 * No network, no state mutation — decides adopt / skip / review and why.
 */
export function classifyBrokerPosition(
  pos: TradierBrokerPosition,
  now: Date = new Date(),
): BrokerPositionClassification {
  const symbol = pos.symbol ?? "";
  const parsed = parseOccSymbol(symbol);

  // Not an option / unparseable → could be SPY shares or another instrument.
  // Never adopt; surface for review so the operator knows it exists.
  if (!parsed) {
    return {
      symbol,
      disposition: "review",
      reason: "Not a parseable OCC option symbol — not managed by the bot.",
    };
  }

  const base = {
    symbol,
    side: parsed.side,
    strike: parsed.strike,
    expiry: parsed.expiry,
    quantity: pos.quantity ?? undefined,
  };

  // Only SPY options are in scope for this bot.
  if (parsed.root !== "SPY") {
    return { ...base, disposition: "review", reason: `Non-SPY option (${parsed.root}) — not managed by the bot.` };
  }

  // Long only — never manage a short option (negative/zero quantity).
  const qty = pos.quantity;
  if (qty === null || qty === undefined || !(qty > 0)) {
    return {
      ...base,
      disposition: "skip",
      reason: `Quantity ${qty ?? "null"} is not a long position — shorts/closed are never managed.`,
    };
  }

  // Same-day 0DTE only — expiry parsed from the symbol itself.
  if (!isZeroDteSymbol(symbol, now)) {
    return {
      ...base,
      disposition: "skip",
      reason: `Expiry ${parsed.expiry} is not today's SPY 0DTE — not adopted.`,
    };
  }

  // Cost basis must be usable to reconstruct an entry premium.
  if (pos.costBasis === null || pos.costBasis === undefined || !Number.isFinite(pos.costBasis)) {
    return {
      ...base,
      disposition: "review",
      reason: "Broker did not report a usable cost basis — cannot reconstruct entry premium.",
    };
  }

  const entryPremium = deriveEntryPremium(pos.costBasis, qty);
  if (!(entryPremium > 0)) {
    return {
      ...base,
      disposition: "review",
      reason: "Derived entry premium was not positive — left for review.",
    };
  }

  return {
    ...base,
    disposition: "adopt",
    reason: "SPY same-day 0DTE long option — eligible for exit management.",
    entryPremium,
    quantity: qty,
  };
}

export interface ReconcileResult {
  /** True when live autonomy was armed and reconciliation actually ran. */
  ran: boolean;
  /** Reason reconciliation was skipped (observe-only / no creds), when ran=false. */
  skippedReason: string | null;
  /** Symbols newly adopted into managed state this pass. */
  adopted: string[];
  /** Positions surfaced for operator review (broker positions we won't manage). */
  review: BrokerPositionClassification[];
  /** Positions deliberately skipped (shorts, non-0DTE) with reasons. */
  skipped: BrokerPositionClassification[];
  /** True when the broker reported positions but none could be adopted. */
  unmanagedBrokerPositions: boolean;
  /**
   * Broker positions the bot already handled (already managed, exit-pending, or
   * closed this day) that the broker is STILL reporting. These are intentionally
   * NOT re-adopted or re-exited — surfaced so status can show them as pending
   * settlement rather than silently dropping them.
   */
  pendingBrokerPositions: string[];
}

export interface ReconcileDeps {
  fetchBrokerPositions: typeof fetchBrokerPositions;
  fetchOptionMark: typeof fetchOptionMark;
  adoptBrokerPosition: typeof adoptBrokerPosition;
  getOpenPositions: typeof getOpenPositions;
  getBrokerAdoptions: typeof getBrokerAdoptions;
}

const defaultDeps: ReconcileDeps = {
  fetchBrokerPositions,
  fetchOptionMark,
  adoptBrokerPosition,
  getOpenPositions,
  getBrokerAdoptions,
};

/**
 * Reconcile live broker positions into local managed state. Adopts eligible SPY
 * same-day 0DTE long options that are not already managed, so the exit loop can
 * manage them after a restart/redeploy. Never opens or sizes a new trade.
 *
 * Returns a structured result for status/visibility. Dependencies are injected
 * so tests can run with synthetic broker data and a mock mark fetcher — no real
 * network and no real orders.
 */
export async function reconcileBrokerPositions(
  cfg: BotConfig,
  now: Date = new Date(),
  deps: ReconcileDeps = defaultDeps,
): Promise<ReconcileResult> {
  const empty: ReconcileResult = {
    ran: false,
    skippedReason: null,
    adopted: [],
    review: [],
    skipped: [],
    unmanagedBrokerPositions: false,
    pendingBrokerPositions: [],
  };

  // Adoption can lead to a real sell_to_close, so it runs ONLY when full live
  // autonomy is armed. In observe-only mode we do not touch local state.
  if (!reconciliationLive(cfg)) {
    return { ...empty, skippedReason: "Observe-only (autonomous live trading not armed)" };
  }

  const broker = await deps.fetchBrokerPositions(cfg);
  if (!broker.available) {
    return { ...empty, ran: true, skippedReason: "Broker positions unavailable" };
  }

  const adopted: string[] = [];
  const review: BrokerPositionClassification[] = [];
  const skipped: BrokerPositionClassification[] = [];
  const pendingBrokerPositions: string[] = [];
  let anyManageable = false;

  // Identities the bot has already taken responsibility for this day (managed,
  // exit-pending, or closed). Re-reporting any of these must NOT trigger a new
  // adoption or a new exit — that is the duplicate-loss / repeated-order bug.
  const handledKeys = new Set(deps.getBrokerAdoptions().map((a) => a.key));

  for (const bp of broker.positions) {
    const cls = classifyBrokerPosition(bp, now);

    if (cls.disposition === "review") {
      review.push(cls);
      continue;
    }
    if (cls.disposition === "skip") {
      skipped.push(cls);
      continue;
    }

    // disposition === "adopt"
    anyManageable = true;

    // Idempotency: if this exact broker identity was already adopted/exited this
    // day, skip it without placing any order or creating a new position.
    const key = brokerAdoptionKey(cls.symbol, bp.dateAcquired);
    if (handledKeys.has(key)) {
      pendingBrokerPositions.push(cls.symbol);
      continue;
    }

    // Best-effort live mark; fall back to entry premium when unavailable so the
    // position is still adopted and managed (exit loop flags degraded).
    let mark: number | null = null;
    try {
      mark = await deps.fetchOptionMark(cls.symbol, cfg);
    } catch {
      mark = null;
    }
    const currentMark = mark != null && mark > 0 ? mark : cls.entryPremium!;

    const { adopted: didAdopt, reason } = deps.adoptBrokerPosition({
      symbol: cls.symbol,
      side: cls.side!,
      strike: cls.strike!,
      expiry: cls.expiry!,
      contracts: cls.quantity!,
      entryPremium: cls.entryPremium!,
      currentMark,
      stopFraction: cfg.stopLossFraction,
      trailStartFraction: cfg.trailStartFraction,
      trailGivebackFraction: cfg.trailGivebackFraction,
      breakevenArmFraction: cfg.breakevenArmFraction,
      profitLockArmFraction: cfg.profitLockArmFraction,
      profitLockProfitFraction: cfg.profitLockProfitFraction,
      brokerDateAcquired: bp.dateAcquired,
    });

    if (didAdopt) {
      adopted.push(cls.symbol);
      handledKeys.add(key);
    } else if (reason === "exit-pending" || reason === "closed") {
      // Defense in depth: the ledger said new but state disagreed (e.g. a race).
      pendingBrokerPositions.push(cls.symbol);
    }
  }

  // "Unmanaged broker positions" = the broker holds positions but none were
  // adoptable (all review/skip) AND none are already managed — surfaced as a
  // warning so the operator knows the trail cannot act on them.
  const hasBrokerPositions = broker.positions.length > 0;
  const unmanagedBrokerPositions =
    hasBrokerPositions && !anyManageable && (review.length > 0 || skipped.length > 0);

  return {
    ran: true,
    skippedReason: null,
    adopted,
    review,
    skipped,
    unmanagedBrokerPositions,
    pendingBrokerPositions,
  };
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
