/**
 * Smart same-day (0DTE) contract selector.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The legacy selector always reached for a FIXED strike offset (BOT_OTM_STRIKES,
 * default 1 OTM). On 2026-06-08 this strike-hopped 744C→745C→746C as SPY climbed
 * and three of four entries topped out at only +16–20% (just short of the +35%
 * trail arm) before round-tripping to the −20% stop. A 1-OTM strike on a $1.00–
 * $1.60 premium is a lower-delta lottery ticket: it needs a larger underlying
 * move to reach the same % gain, so it is more exposed to the "stalled below the
 * trail arm" failure mode.
 *
 * The smart selector instead SCORES the same-day ATM / 1-OTM / 2-OTM candidates
 * for the bias and picks the best one under explicit quality guardrails, so it
 * can prefer a higher-delta ATM contract when the 1-OTM strike is weak/illiquid,
 * while still preferring the 1-OTM strike when IT scores best.
 *
 * GUARDRAILS (hard gates — a candidate failing any of these is never chosen):
 *   • Same-day 0DTE only (expiry parsed from the OCC symbol == today's NY date).
 *   • Side must match the bias (Call/Put).
 *   • Unusual/liquidity score ≥ the configured minimum.
 *   • Mid premium ≥ minOptionPremium (the existing floor).
 *   • Quoted spread (ask−bid)/mid ≤ maxSpreadPct (the existing ceiling).
 *   • Moneyness window: ATM (0) … +maxOtmStrikes OTM only. NEVER beyond
 *     maxOtmStrikes OTM and never ITM (an aggressive 0DTE entry stays at/OTM).
 *
 * SCORE (higher = better) among the surviving candidates, all normalised 0..1:
 *   + premiumStrength   prefer mid ≥ preferredMinPremium (deeper, higher-delta)
 *   + deltaFit          prefer |delta| in [deltaMin, deltaMax] (e.g. 0.35–0.55)
 *   + liquidity         volume / OI / volumeOiRatio / unusualScore
 *   + tightSpread       reward spreads well under the ceiling (esp. < 25–30%)
 *   − farPenalty        penalise distance from spot (further OTM = more fragile)
 *
 * Delta is used when a real per-contract delta is supplied on the option; when
 * absent it is ESTIMATED from moneyness + premium (a monotone proxy, clearly
 * documented). The estimate is only ever used for ranking, never as a gate.
 *
 * The scorer is PURE and deterministic. It performs no network I/O and never
 * relaxes the 0DTE / premium / spread gates. NOT FINANCIAL ADVICE.
 */

import { isZeroDteSymbol, marketDateNY, parseOccSymbol } from "./occSymbol.js";

/** A same-day option candidate as seen by the selector (subset of UnusualOption). */
export interface SelectorOption {
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
  unusualScore: number;
  /** Real per-contract delta if the feed supplies one (absolute or signed). */
  delta?: number | null;
}

/** Selection mode. */
export type ContractSelectionMode = "fixed_otm" | "best_liquid";

/** Tunable knobs for the smart selector (sourced from BotConfig). */
export interface SmartSelectorParams {
  /** Minimum unusual/liquidity score a candidate must clear (hard gate). */
  minScore: number;
  /** Minimum mid premium per share (hard gate — the existing floor). */
  minPremium: number;
  /** Max quoted spread as a fraction of mid (hard gate — the existing ceiling). */
  maxSpreadPct: number;
  /** Furthest OTM (in strikes) the smart selector will consider. Default 2. */
  maxOtmStrikes: number;
  /** Preferred minimum mid premium; candidates at/above score full premium points. */
  preferredMinPremium: number;
  /** Target delta band lower bound (absolute). */
  deltaMin: number;
  /** Target delta band upper bound (absolute). */
  deltaMax: number;
  /** Spread fraction at/under which a candidate earns the full tight-spread bonus. */
  preferredMaxSpreadPct: number;
}

/** Per-candidate scoring breakdown (for diagnostics / tests). */
export interface CandidateScore {
  option: SelectorOption;
  /** Signed OTM distance in strikes (0 = ATM, +n = n OTM, −n = ITM). */
  otmStrikes: number;
  mid: number;
  spreadPct: number;
  /** Delta used for ranking (real when supplied, else estimated). */
  deltaUsed: number;
  deltaEstimated: boolean;
  /** Component sub-scores, each 0..1. */
  components: {
    premiumStrength: number;
    deltaFit: number;
    liquidity: number;
    tightSpread: number;
    farPenalty: number;
  };
  /** Total weighted score (higher = better). */
  score: number;
  /** True when the candidate cleared every hard gate. */
  eligible: boolean;
  /** Why it was rejected (when !eligible). */
  rejectReason?: string;
}

export interface SmartSelectionResult {
  /** Best eligible candidate, or null if none qualified. */
  best: CandidateScore | null;
  /** All scored candidates (eligible + rejected) for diagnostics. */
  scored: CandidateScore[];
  /** Set when flow existed for the side but was ALL later-dated (non-0DTE). */
  laterDatedRejected: boolean;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round(v: number, dp = 4): number {
  return Math.round(v * 10 ** dp) / 10 ** dp;
}

/**
 * Signed OTM distance in whole strikes given the same-day strike ladder for the
 * side. 0 = the strike straddling spot (ATM), +n = n OTM, −n = n ITM. Mirrors
 * signalEngine.otmDistanceInStrikes so both selectors agree on moneyness.
 */
export function otmDistanceInStrikes(
  strike: number,
  spot: number,
  side: "Call" | "Put",
  ladder: number[],
): number {
  let anchor = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ladder.length; i += 1) {
    const d = Math.abs(ladder[i] - spot);
    if (d < bestDist) {
      bestDist = d;
      anchor = i;
    }
  }
  const idx = ladder.indexOf(strike);
  if (idx < 0) return 0;
  const stepsAbove = idx - anchor;
  return side === "Call" ? stepsAbove : -stepsAbove;
}

/**
 * Estimate |delta| for a 0DTE option from moneyness + premium when the feed
 * does not supply a real delta. This is a MONOTONE PROXY for ranking only:
 *   • ATM (otm 0)  → ~0.50
 *   • each strike OTM subtracts ~0.13 (further OTM ⇒ lower delta)
 *   • each strike ITM adds ~0.13
 * A light premium nudge keeps richer same-distance contracts ranked higher.
 * Clamped to [0.02, 0.98]. NEVER used as a gate — only to break ties / rank.
 */
export function estimateDelta(otmStrikes: number, mid: number): number {
  const base = 0.5 - otmStrikes * 0.13;
  const premiumNudge = Math.min(0.08, Math.max(-0.08, (mid - 0.8) * 0.05));
  return clamp01Range(base + premiumNudge, 0.02, 0.98);
}

function clamp01Range(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Default smart-selector params derived from existing config values. */
export function defaultSmartParams(
  minScore: number,
  minPremium: number,
  maxSpreadPct: number,
): SmartSelectorParams {
  return {
    minScore,
    minPremium,
    maxSpreadPct,
    maxOtmStrikes: 2,
    preferredMinPremium: 0.7,
    deltaMin: 0.35,
    deltaMax: 0.55,
    preferredMaxSpreadPct: 0.25,
  };
}

/**
 * Score the same-day ATM / 1-OTM / … / maxOTM candidates for `bias` and return
 * the best eligible one. `allowOtmFloor` lets an override (e.g. open-window
 * liquidation/push) keep a 1-OTM strike eligible even if a stricter caller would
 * otherwise prefer ATM — the QUALITY gates always still apply.
 */
export function selectSmartContract(
  options: SelectorOption[],
  bias: "Call" | "Put",
  spot: number,
  params: SmartSelectorParams,
  now: Date = new Date(),
): SmartSelectionResult {
  const today = marketDateNY(now);

  // Side + score gate first (score is a hard gate shared with the legacy path).
  const sideMatch = options.filter(
    (o) => o.side === bias && o.unusualScore >= params.minScore,
  );
  if (!sideMatch.length) {
    return { best: null, scored: [], laterDatedRejected: false };
  }

  // Same-day 0DTE only — never reach for a later-dated expiry.
  const zeroDte = sideMatch.filter((o) => isZeroDteSymbol(o.symbol, now));
  if (!zeroDte.length) {
    return { best: null, scored: [], laterDatedRejected: true };
  }

  const ladder = Array.from(new Set(zeroDte.map((o) => o.strike))).sort(
    (a, b) => a - b,
  );

  const scored: CandidateScore[] = zeroDte.map((o) => {
    const dist = otmDistanceInStrikes(o.strike, spot, bias, ladder);
    const mid = o.ask > 0 && o.bid >= 0 ? round((o.bid + o.ask) / 2, 2) : 0;
    const spreadAbs = o.ask > 0 && o.bid >= 0 ? o.ask - o.bid : Infinity;
    const spreadPct = mid > 0 ? spreadAbs / mid : Infinity;

    const hasReal = o.delta != null && Number.isFinite(o.delta);
    const deltaUsed = hasReal ? Math.abs(o.delta as number) : estimateDelta(dist, mid);

    // ── Hard gates ──────────────────────────────────────────────────────────
    let eligible = true;
    let rejectReason: string | undefined;
    if (dist < 0) {
      eligible = false;
      rejectReason = "ITM (selector stays at/OTM for aggressive 0DTE entries)";
    } else if (dist > params.maxOtmStrikes) {
      eligible = false;
      rejectReason = `beyond ${params.maxOtmStrikes} OTM (too far from spot)`;
    } else if (params.minPremium > 0 && mid < params.minPremium) {
      eligible = false;
      rejectReason = `mid $${mid.toFixed(2)} < min premium $${params.minPremium.toFixed(2)}`;
    } else if (params.maxSpreadPct > 0 && spreadPct > params.maxSpreadPct) {
      eligible = false;
      rejectReason = `spread ${(spreadPct * 100).toFixed(0)}% > max ${(params.maxSpreadPct * 100).toFixed(0)}%`;
    }

    // ── Component sub-scores (0..1) ─────────────────────────────────────────
    const premiumStrength = clamp01(mid / params.preferredMinPremium);
    // deltaFit: 1.0 inside the band, decaying linearly outside it.
    let deltaFit: number;
    if (deltaUsed >= params.deltaMin && deltaUsed <= params.deltaMax) {
      deltaFit = 1;
    } else if (deltaUsed < params.deltaMin) {
      deltaFit = clamp01(1 - (params.deltaMin - deltaUsed) / params.deltaMin);
    } else {
      deltaFit = clamp01(1 - (deltaUsed - params.deltaMax) / (1 - params.deltaMax));
    }
    const liqScore = clamp01(o.unusualScore / 100);
    const volScore = clamp01(Math.log10(Math.max(1, o.volume)) / 6); // 1M vol ≈ 1.0
    const voiScore = clamp01(o.volumeOiRatio / 30);
    const oiScore = clamp01(Math.log10(Math.max(1, o.openInterest)) / 4); // 10k OI ≈ 1.0
    const liquidity = clamp01(0.4 * liqScore + 0.3 * volScore + 0.2 * voiScore + 0.1 * oiScore);
    // tightSpread: 1.0 at/under the preferred ceiling, decaying to 0 at the max.
    const tightSpread = Number.isFinite(spreadPct)
      ? spreadPct <= params.preferredMaxSpreadPct
        ? 1
        : clamp01(1 - (spreadPct - params.preferredMaxSpreadPct) / Math.max(1e-6, params.maxSpreadPct - params.preferredMaxSpreadPct))
      : 0;
    // farPenalty: 0 at ATM, grows with OTM distance (fraction of the max window).
    const farPenalty = params.maxOtmStrikes > 0
      ? clamp01(Math.max(0, dist) / params.maxOtmStrikes)
      : 0;

    const score =
      0.28 * premiumStrength +
      0.26 * deltaFit +
      0.24 * liquidity +
      0.12 * tightSpread -
      0.18 * farPenalty;

    return {
      option: o,
      otmStrikes: dist,
      mid,
      spreadPct: Number.isFinite(spreadPct) ? round(spreadPct, 4) : Infinity,
      deltaUsed: round(deltaUsed, 3),
      deltaEstimated: !hasReal,
      components: {
        premiumStrength: round(premiumStrength),
        deltaFit: round(deltaFit),
        liquidity: round(liquidity),
        tightSpread: round(tightSpread),
        farPenalty: round(farPenalty),
      },
      score: round(score),
      eligible,
      rejectReason,
    };
  });

  const eligible = scored.filter((c) => c.eligible);
  if (!eligible.length) {
    return { best: null, scored, laterDatedRejected: false };
  }

  // Rank by score desc; deterministic tie-breaks: higher delta-fit, higher
  // liquidity, tighter spread, then closer to spot, then lower strike.
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.components.deltaFit !== a.components.deltaFit)
      return b.components.deltaFit - a.components.deltaFit;
    if (b.components.liquidity !== a.components.liquidity)
      return b.components.liquidity - a.components.liquidity;
    if (a.spreadPct !== b.spreadPct) return a.spreadPct - b.spreadPct;
    if (a.otmStrikes !== b.otmStrikes) return a.otmStrikes - b.otmStrikes;
    return a.option.strike - b.option.strike;
  });

  // Mark the today string on result for callers that want to log it.
  void today;
  void parseOccSymbol;

  return { best: eligible[0], scored, laterDatedRejected: false };
}
