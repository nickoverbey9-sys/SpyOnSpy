/**
 * Risk management module.
 *
 * Evaluates open paper positions against current market data and emits
 * risk actions: stop, trail, flatten-near-close.
 *
 * All actions are PAPER ONLY unless live mode is explicitly enabled and
 * confirmed in the request. See tradierAdapter.ts for live-order guards.
 *
 * NOT FINANCIAL ADVICE. This is software infrastructure.
 */

import type { BotConfig } from "./config.js";
import { isPastCutoff, entryTimeWindowBlock } from "./config.js";
import type { PaperPosition } from "./paperState.js";
import { closePaperPosition, getOpenPositions, updateTrail, partialClosePaperPosition } from "./paperState.js";

export type RiskAction =
  | { kind: "stop"; positionId: string; reason: string; closePremium: number }
  | { kind: "flatten"; positionId: string; reason: string; closePremium: number }
  | { kind: "partial_exit"; positionId: string; reason: string; closePremium: number; contractsToClose: number }
  | { kind: "hold"; positionId: string; reason: string };

/**
 * Given a current option mark price and an open position, determine what
 * risk action to take.
 *
 * The SAME runner-style exit logic applies to every position regardless of
 * size — there is no partial trim ladder. The full position runs together
 * until a stop, the trailing stop, or a flatten/invalidation closes it. There
 * is NO fixed full take-profit: a winner arms a give-back trailing stop at
 * +trailStart (default +25%) and then runs until it drops trailGiveback
 * (default 5%) from its post-arm peak.
 *
 *    1. Past hard-flatten cutoff → flatten (full position)
 *    2. Stop-loss breach (−stopLossFraction premium) → stop (full position)
 *    3. Give-back trailing stop, once armed (peak × (1 − giveback)) → stop
 *       (full position)
 *    4. Otherwise → hold (let the winner run)
 *
 * The trailing stop reads pos.peakPremium / pos.trailArmed, which callers update
 * via updateTrail() before evaluating (runRiskPass / the automation exit loop).
 */
export function evaluatePosition(
  pos: PaperPosition,
  currentPremium: number,
  cfg: BotConfig,
  now = new Date(),
): RiskAction {
  // 1. Hard flatten near close (applies to the full position)
  if (isPastCutoff(cfg, now)) {
    return {
      kind: "flatten",
      positionId: pos.id,
      reason: `Hard flatten: past ${cfg.flattenHourCT}:${String(cfg.flattenMinuteCT).padStart(2, "0")} CT cutoff`,
      closePremium: currentPremium,
    };
  }

  // 2. Stop loss: current premium ≤ stop price (applies to the full position).
  //    The stop price may have been RAISED to entry by the breakeven-protect
  //    rule once the position reached +breakevenArmFraction MFE (see updateTrail);
  //    in that case this is a breakeven/scratch exit, not a -stopLossFraction loss.
  if (currentPremium <= pos.stopPrice) {
    let reason: string;
    if (pos.profitLockArmed) {
      reason = `Profit-lock stop: premium ${currentPremium.toFixed(2)} ≤ locked stop ${pos.stopPrice.toFixed(2)} (raised to +${(cfg.profitLockProfitFraction * 100).toFixed(0)}% profit after reaching +${(cfg.profitLockArmFraction * 100).toFixed(0)}% MFE)`;
    } else if (pos.breakevenArmed) {
      reason = `Breakeven stop: premium ${currentPremium.toFixed(2)} ≤ protected stop ${pos.stopPrice.toFixed(2)} (raised to entry ${pos.entryPremium.toFixed(2)} after reaching +${(cfg.breakevenArmFraction * 100).toFixed(0)}% MFE)`;
    } else {
      reason = `Stop loss: premium ${currentPremium.toFixed(2)} ≤ stop ${pos.stopPrice.toFixed(2)} (${(cfg.stopLossFraction * 100).toFixed(0)}% loss)`;
    }
    return {
      kind: "stop",
      positionId: pos.id,
      reason,
      closePremium: currentPremium,
    };
  }

  // ── Partial exit tier (multi-contract positions only) ──────────────────────
  // When a multi-contract position reaches +35% profit, exit 1 contract to lock
  // in gains and let remaining contracts run on the trail. This improves win rate
  // by protecting partial profits if the move reverses before the full trail arms
  // at +18%. Only triggers once per position.
  if (pos.contracts > 1 && !pos.partialExitDone) {
    const partialExitThreshold = pos.entryPremium * (1 + 0.35);
    if (currentPremium >= partialExitThreshold) {
      return {
        kind: "partial_exit",
        positionId: pos.id,
        reason: `Partial exit: exiting 1 of ${pos.contracts} contracts at +35% profit (premium ${currentPremium.toFixed(2)}, entry ${pos.entryPremium.toFixed(2)}) to lock gains; remaining contracts run trail`,
        closePremium: currentPremium,
        contractsToClose: 1,
      };
    }
  }

  // ── Give-back trailing stop (full position, single OR multi contract) ──────
  // No fixed full take-profit and NO partial trims: +trailStart only ARMS the
  // trail, then the entire position runs until it gives back trailGiveback from
  // its post-arm peak, at which point the full remaining size is closed.
  if (pos.trailArmed) {
    const trailStop = pos.peakPremium * (1 - pos.trailGivebackFraction);
    if (currentPremium <= trailStop) {
      return {
        kind: "stop",
        positionId: pos.id,
        reason: `Trailing stop: premium ${currentPremium.toFixed(2)} ≤ ${(pos.trailGivebackFraction * 100).toFixed(0)}% give-back from peak ${pos.peakPremium.toFixed(2)} (trail ${trailStop.toFixed(2)}; armed at +${(pos.trailStartPrice / pos.entryPremium * 100 - 100).toFixed(0)}%)`,
        closePremium: currentPremium,
      };
    }
  }

  const beNote = pos.breakevenArmed
    ? `, BE-protected @ ${pos.stopPrice.toFixed(2)}`
    : pos.breakevenArmPrice
      ? `, BE arms @ ${pos.breakevenArmPrice.toFixed(2)}`
      : "";
  return {
    kind: "hold",
    positionId: pos.id,
    reason: `Holding (let it run, full position). Current: ${currentPremium.toFixed(2)}, Stop: ${pos.stopPrice.toFixed(2)}${beNote}, Trail ${pos.trailArmed ? `armed @ peak ${pos.peakPremium.toFixed(2)}, exits @ ${(pos.peakPremium * (1 - pos.trailGivebackFraction)).toFixed(2)}` : `arms @ ${pos.trailStartPrice.toFixed(2)}`}`,
  };
}

/**
 * Run risk evaluation across all open paper positions given current option
 * mark prices (keyed by position.id → current premium).
 *
 * Applies stops, trailing stops, and flattens to paper state automatically.
 * Returns a log of actions taken.
 */
export function runRiskPass(
  premiumMap: Map<string, number>,
  cfg: BotConfig,
  now = new Date(),
): Array<{ positionId: string; action: RiskAction; applied: boolean; note: string }> {
  const results: Array<{ positionId: string; action: RiskAction; applied: boolean; note: string }> = [];
  const open = getOpenPositions();

  for (const pos of open) {
    const currentPremium = premiumMap.get(pos.id) ?? pos.entryPremium;
    // Keep the trailing-stop peak/armed flags current before evaluating. The
    // trail applies to the full position regardless of size, so update it for
    // every open position.
    updateTrail(pos.id, currentPremium);
    const action = evaluatePosition(pos, currentPremium, cfg, now);

    let applied = false;
    let note = "";

    switch (action.kind) {
      case "stop":
      case "flatten": {
        const closed = closePaperPosition(pos.id, action.closePremium, action.reason);
        applied = !!closed;
        note = applied
          ? `Closed: PnL $${closed?.pnl?.toFixed(2) ?? "?"}`
          : "Position not found or already closed";
        break;
      }
      case "partial_exit": {
        const partial = partialClosePaperPosition(
          pos.id,
          action.contractsToClose,
          action.closePremium,
          action.reason,
        );
        applied = !!partial;
        if (applied && partial) {
          partial.partialExitDone = true;
          const pnlPerContract = (action.closePremium - pos.entryPremium) * 100;
          note = `Partial exit: sold ${action.contractsToClose} contract at +${((action.closePremium / pos.entryPremium - 1) * 100).toFixed(1)}%, ${partial.contracts} remaining`;
        } else {
          note = "Partial exit failed or position not found";
        }
        break;
      }
      case "hold":
        applied = false;
        note = action.reason;
        break;
    }

    results.push({ positionId: pos.id, action, applied, note });
  }

  return results;
}

/**
 * Check if opening a new position is allowed under daily guardrails.
 * Returns { allowed: boolean; reason: string }
 */
export function canOpenPosition(
  daily: {
    tradesOpened: number;
    /**
     * NET realized loss consumed today (USD, positive): max(0, -net P&L). This
     * is what gates the daily-loss cap — NOT the gross sum of losing trades.
     * Winners offset losers, so a profitable-net day uses little or none of the
     * cap even after large gross losses.
     */
    dailyLossUsed: number;
    /** NET realized P&L today (signed) — used only for the block message. */
    netRealizedPnlToday?: number;
  },
  openCount: number,
  cfg: BotConfig,
  now = new Date(),
): { allowed: boolean; reason: string } {
  if (cfg.killSwitchActive) {
    return { allowed: false, reason: "Kill switch is active — bot is paused" };
  }
  // Open/close ENTRY-ONLY guardrail: no new entries in the first 15 min after
  // the regular open or the last 15 min before the regular close (ET). Exits are
  // never routed through canOpenPosition, so this blocks opening only — stops,
  // trailing stops, breakeven/profit-lock, and the hard flatten still apply.
  const timeBlock = entryTimeWindowBlock(cfg, now);
  if (timeBlock) {
    return { allowed: false, reason: timeBlock };
  }
  // The hard-flatten cutoff (isPastCutoff) only closes existing positions in
  // evaluatePosition — it never blocks opening a new one.
  // maxTradesPerDay <= 0 means unlimited — skip the daily trade-count cap.
  if (cfg.maxTradesPerDay > 0 && daily.tradesOpened >= cfg.maxTradesPerDay) {
    return { allowed: false, reason: `Daily trade limit reached (${daily.tradesOpened}/${cfg.maxTradesPerDay})` };
  }
  // Daily-loss cap is on NET realized P&L (winners net against losers), so it
  // tracks actual account drawdown rather than gross losing-trade dollars.
  if (daily.dailyLossUsed >= cfg.maxDailyLoss) {
    const net = daily.netRealizedPnlToday;
    const netStr = typeof net === "number" ? ` (net realized P&L $${net.toFixed(2)})` : "";
    return {
      allowed: false,
      reason: `Daily loss limit reached: net realized loss $${daily.dailyLossUsed.toFixed(2)} / $${cfg.maxDailyLoss}${netStr}`,
    };
  }
  // maxOpenPositions <= 0 means unlimited — skip the concurrent-position cap.
  if (cfg.maxOpenPositions > 0 && openCount >= cfg.maxOpenPositions) {
    return { allowed: false, reason: `Max open positions reached (${openCount}/${cfg.maxOpenPositions})` };
  }
  return { allowed: true, reason: "Within all risk limits" };
}

export interface SizingDecision {
  /** Number of contracts to buy. 0 means the entry must be SKIPPED. */
  contracts: number;
  /** Whether opening at this size is permitted under cash + explicit cap. */
  allowed: boolean;
  /**
   * Projected dollar loss if the hard stop is hit on the sized position.
   * Informational only — it does NOT downsize or block the entry. The actual
   * risk control is the premium-based hard stop in evaluatePosition.
   */
  projectedStopLoss: number;
  /** Total cost of the sized position in USD. */
  cost: number;
  /** Preferred target size (cfg.preferredContractsPerTrade) for this trade. */
  preferred: number;
  /** Hard minimum size (cfg.minContractsPerTrade, default 1) below which the entry is skipped. */
  minimum: number;
  /**
   * True when the sized quantity is below the preferred target because cash or
   * an explicit maxContractsPerTrade forced a smaller size. The reason string
   * describes which constraint bound it.
   */
  fellBackFromPreferred: boolean;
  reason: string;
}

/**
 * Size a new position for the given entry premium under the operator's sizing
 * preference plus the cash + explicit-cap constraints:
 *
 *   • Preference: aim for cfg.preferredContractsPerTrade (default 2, small-account
 *     sized). Step down the ladder (2 → 1) toward cfg.minContractsPerTrade
 *     (default 1, the hard minimum) when the preferred size cannot be afforded.
 *   • Cash: the position cost (premium × 100 × qty) must fit the working balance
 *     (default cfg.accountStartBalance when no live balance supplied).
 *   • Explicit cap: when cfg.maxContractsPerTrade is finite (> 0) it caps the
 *     desired quantity even below the preferred size.
 *
 * cfg.maxLossPerTrade is NO LONGER a pre-entry sizing blocker. The projected
 * dollar stop loss is still computed and reported (projectedStopLoss) for
 * visibility, but it never downsizes or blocks an entry — it was preventing
 * 4-contract entries even when cash/buying power was sufficient. The risk it
 * was approximating is now enforced purely by the actual premium-based hard
 * stop (cfg.stopLossFraction, default -20%) in evaluatePosition.
 *
 * desired = min(preferred, maxByCash, maxContractsPerTrade-if-finite).
 * If desired >= minimum the entry is allowed at that size; otherwise it is
 * SKIPPED (contracts=0). With defaults (preferred 2, min 1, no explicit cap) the
 * result is 2 when affordable, then 1 on fallback, or 0 when even 1 cannot be
 * afforded.
 *
 * Size does not change exit behavior: every position (1 or 2+ contracts) uses
 * the same no-trim runner exit — hard stop, +35% arm / 5% give-back trailing
 * stop, and flatten/invalidation (see evaluatePosition).
 */
export function sizePosition(
  entryPremium: number,
  cfg: BotConfig,
  availableCash?: number,
): SizingDecision {
  const cash = Number.isFinite(availableCash) && (availableCash as number) > 0
    ? (availableCash as number)
    : cfg.accountStartBalance;

  const perContractCost = entryPremium * 100;
  const perContractStopLoss = entryPremium * cfg.stopLossFraction * 100;

  const minimum = Math.max(1, cfg.minContractsPerTrade);
  const preferred = Math.max(minimum, cfg.preferredContractsPerTrade);

  if (!(perContractCost > 0)) {
    return {
      contracts: 0,
      allowed: false,
      projectedStopLoss: 0,
      cost: 0,
      preferred,
      minimum,
      fellBackFromPreferred: false,
      reason: "Invalid entry premium",
    };
  }

  const maxByCash = Math.floor(cash / perContractCost);
  // PER-TRADE RISK PATCH: maxLossPerTrade is RESTORED as a sizing constraint
  // (default on). Contracts are downsized so projected stop risk fits the cap;
  // if even the minimum size breaches it, the entry is skipped. Set
  // BOT_ENFORCE_MAX_LOSS_PER_TRADE=false to make it reporting-only again.
  const maxByRisk =
    cfg.enforceMaxLossPerTrade && perContractStopLoss > 0 && cfg.maxLossPerTrade > 0
      ? Math.floor(cfg.maxLossPerTrade / perContractStopLoss)
      : Infinity;
  // Explicit per-trade cap only applies when finite (> 0); <= 0 means no cap.
  const hasExplicitCap = cfg.maxContractsPerTrade > 0;
  const explicitCap = hasExplicitCap ? cfg.maxContractsPerTrade : Infinity;

  const allowed = Math.min(maxByCash, maxByRisk);
  const contracts = Math.min(preferred, allowed, explicitCap);

  // Even the hard minimum cannot be satisfied → skip the entry (insufficient
  // cash for the minimum size, or the minimum size would breach the per-trade
  // risk cap).
  if (!Number.isFinite(contracts) || contracts < minimum) {
    const riskBound = maxByRisk < maxByCash;
    return {
      contracts: 0,
      allowed: false,
      projectedStopLoss: round(perContractStopLoss * minimum),
      cost: round(perContractCost * minimum),
      preferred,
      minimum,
      fellBackFromPreferred: false,
      reason: riskBound
        ? `Per-trade risk cap: ${minimum} contract(s) project $${(perContractStopLoss * minimum).toFixed(0)} stop risk but cap is $${cfg.maxLossPerTrade.toFixed(0)}`
        : `Insufficient cash: ${minimum} contract(s) cost $${(perContractCost * minimum).toFixed(0)} but only $${cash.toFixed(2)} available`,
    };
  }

  const fellBackFromPreferred = contracts < preferred;
  let reason: string;
  if (!fellBackFromPreferred) {
    reason = `Sized ${contracts} contract(s) at preferred target: cost $${(perContractCost * contracts).toFixed(0)}, projected stop risk $${(perContractStopLoss * contracts).toFixed(0)} (hard stop -${(cfg.stopLossFraction * 100).toFixed(0)}%)`;
  } else if (hasExplicitCap && explicitCap <= allowed && explicitCap < preferred) {
    reason = `Capped to ${contracts} contract(s) by max-per-trade cap (preferred ${preferred}): cost $${(perContractCost * contracts).toFixed(0)}, projected stop risk $${(perContractStopLoss * contracts).toFixed(0)}`;
  } else if (maxByRisk < maxByCash && contracts === Math.min(preferred, maxByRisk)) {
    reason = `Downsized to ${contracts} contract(s) by per-trade risk cap $${cfg.maxLossPerTrade.toFixed(0)} (preferred ${preferred}): cost $${(perContractCost * contracts).toFixed(0)}, projected stop risk $${(perContractStopLoss * contracts).toFixed(0)} (hard stop -${(cfg.stopLossFraction * 100).toFixed(0)}%)`;
  } else {
    reason = `Fallback to ${contracts} contract(s) due to cash cap (preferred ${preferred}): cost $${(perContractCost * contracts).toFixed(0)}, projected stop risk $${(perContractStopLoss * contracts).toFixed(0)} (hard stop -${(cfg.stopLossFraction * 100).toFixed(0)}%)`;
  }

  return {
    contracts,
    allowed: true,
    projectedStopLoss: round(perContractStopLoss * contracts),
    cost: round(perContractCost * contracts),
    preferred,
    minimum,
    fellBackFromPreferred,
    reason,
  };
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
