/**
 * Signal engine — reads the current market snapshot and produces bot signals.
 *
 * Process:
 *  1. Filter 2m setup cards by bias (Call/Put only, not Wait) and confidence
 *  2. Corroborate with unusual options flow in the same direction
 *  3. Select the same-day 0DTE SPY contract that is BOT_OTM_STRIKES strikes
 *     out-of-the-money for the bias (default 1 OTM — slightly aggressive toward
 *     price targets) from unusualOptions; if none found, produce a
 *     REQUIRES_REVIEW signal rather than fabricating a contract
 *  4. Apply news-blackout and cutoff guards
 *
 * Outputs BotSignal objects — these are trade PLANS, not orders.
 * "signal" language is used throughout, not "trade recommendation."
 *
 * NOT FINANCIAL ADVICE. Paper mode by default. High-risk 0DTE options.
 */

import type { BotConfig } from "./config.js";
import {
  getBotConfig,
  isNearHighImpactEvent,
  isWithinOpenOverrideWindow,
  entryWindowBlock,
} from "./config.js";
import { isZeroDteSymbol, marketDateNY, parseOccSymbol } from "./occSymbol.js";
import {
  selectSmartContract,
  defaultSmartParams,
  type SelectorOption,
  type SmartSelectorParams,
} from "./contractSelector.js";
import {
  aggregateCandles,
  analyzeMultiTimeframe,
  trigger1m,
  type MtfAnalysis,
  type MtfCandle,
  type OpenOverrideInput,
} from "./marketStructure.js";

// ─── Snapshot sub-types (mirrors server/routes.ts) ───────────────────────────

export interface Setup {
  title: string;
  bias: "Call" | "Put" | "Wait";
  confidence: number;
  trigger: string;
  invalidation: string;
  rationale: string;
}

export interface UnusualOption {
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
}

export interface CalendarEvent {
  time: string;
  event: string;
  impact: "High" | "Medium" | "Low";
  status: "Upcoming" | "Released" | "Watched";
}

export interface SnapshotForSignal {
  spy: {
    price: number;
    dailyOpen?: number;
    premarketHigh?: number;
    premarketLow?: number;
    /** 1-minute base series — source of truth for higher-timeframe derivation. */
    candles?: MtfCandle[];
    candles5m?: MtfCandle[];
    candles15m?: MtfCandle[];
    candles30m?: MtfCandle[];
  };
  setups: Setup[];
  unusualOptions: UnusualOption[];
  economicCalendar: CalendarEvent[];
}

// ─── Signal types ─────────────────────────────────────────────────────────────

export type SignalStatus =
  | "ACTIONABLE"      // All data present; can enter paper order
  | "REQUIRES_REVIEW" // Setup present but contract selection uncertain
  | "BLOCKED"         // Entry blocked by risk/time/news guardrail
  | "NO_SETUP";       // No qualifying setup at this time

export interface ContractCandidate {
  symbol: string;
  expiry: string;
  strike: number;
  side: "Call" | "Put";
  last: number;
  bid: number;
  ask: number;
  unusualScore: number;
  selectionReason: string;
  /** Moneyness of the selected strike vs. spot: "OTM", "ATM", or "ITM". */
  moneyness: "OTM" | "ATM" | "ITM";
  /**
   * Number of strikes out-of-the-money the chosen strike sits relative to spot
   * (0 = the strike straddling spot / ATM). Negative = in-the-money.
   */
  otmStrikes: number;
  /** Signed strike − spot distance in dollars (Call: strike−spot, Put: spot−strike). */
  strikeDistance: number;
  /** Human label for the selection rule, e.g. "1 OTM" or "ATM". */
  selectionRule: string;
}

export interface BotSignal {
  id: string;
  generatedAt: string;
  status: SignalStatus;
  bias: "Call" | "Put" | null;
  confidence: number;
  setup: Setup | null;
  contract: ContractCandidate | null;
  /** True only when an actionable same-day 0DTE contract was selected. */
  isZeroDte: boolean;
  /** Expiry of the selected contract (YYYY-MM-DD), or null when none selected. */
  contractExpiry: string | null;
  blockReason: string | null;
  reviewReason: string | null;
  triggerText: string;
  invalidationText: string;
  /** Suggested entry premium (mid of bid/ask) — indicative only */
  suggestedEntryPremium: number | null;
  /** Implied stop price at the hard-stop loss from suggested entry */
  impliedStopPremium: number | null;
  /** Implied premium at which the give-back trailing stop ARMS (+trailStart, e.g. +25%) */
  impliedTrailArmPremium: number | null;
  /** Corroborating unusual options in same direction */
  corroborating: UnusualOption[];
  /**
   * Multi-timeframe market-structure analysis (30m/15m/5m/1m). Present whenever
   * the snapshot carried a candle stream; null for legacy snapshots without one.
   */
  mtf: MtfAnalysis | null;
  /**
   * Fresh-data readiness for this evaluation. `ready` is false when the
   * fresh-data guard is active (live/runtime) and the newest 1m candle is older
   * than the staleness threshold — in that case the signal is forced to BLOCKED
   * and the dashboard/status should surface it as a readiness issue.
   */
  dataFreshness: DataFreshness;
  disclaimer: string;
}

export interface DataFreshness {
  /** False = the newest live 1m candle is stale (guard active). */
  ready: boolean;
  /** Age of the newest 1m candle in seconds (null when no candles present). */
  ageSec: number | null;
  /** Staleness threshold (seconds) applied. */
  thresholdSec: number;
  /** Whether the fresh-data guard was enforced for this evaluation. */
  enforced: boolean;
  /** Human-readable explanation for status/UI. */
  detail: string;
}

/**
 * Evaluate the freshness of the newest live 1m candle relative to `now`. The
 * guard is only ENFORCED when requireFresh is true (live automation / RTH);
 * offline backtests pass requireFresh=false so historical tapes never trip it.
 */
export function evaluateDataFreshness(
  candles1m: MtfCandle[] | undefined,
  cfg: BotConfig,
  now: Date,
  requireFresh: boolean,
): DataFreshness {
  const thresholdSec = cfg.maxCandleStalenessSec;
  if (!candles1m || !candles1m.length) {
    return {
      ready: !requireFresh,
      ageSec: null,
      thresholdSec,
      enforced: requireFresh,
      detail: requireFresh
        ? "No live 1m candles available — data NOT ready for live automation."
        : "No 1m candles (freshness guard not enforced for offline/backtest).",
    };
  }
  const newest = candles1m[candles1m.length - 1];
  const newestMs = new Date(newest.time).getTime();
  const ageSec = Number.isFinite(newestMs)
    ? Math.max(0, Math.round((now.getTime() - newestMs) / 1000))
    : null;

  if (!requireFresh) {
    return {
      ready: true,
      ageSec,
      thresholdSec,
      enforced: false,
      detail: `Freshness guard not enforced (offline/backtest). Newest 1m candle ${ageSec ?? "?"}s old.`,
    };
  }

  const stale = ageSec == null || ageSec > thresholdSec;
  return {
    ready: !stale,
    ageSec,
    thresholdSec,
    enforced: true,
    detail: stale
      ? `STALE DATA: newest live 1m candle is ${ageSec ?? "?"}s old (> ${thresholdSec}s). ` +
        `Automation is NOT working off fresh candles — entries blocked until data refreshes.`
      : `Fresh: newest live 1m candle is ${ageSec}s old (≤ ${thresholdSec}s).`,
  };
}

const DISCLAIMER =
  "⚠ SIGNAL ONLY — NOT A TRADE RECOMMENDATION. 0DTE options carry extreme risk of total loss. " +
  "Paper/simulation mode by default. Live trading requires explicit env var configuration and " +
  "confirmLiveOrder: true on every request. Not financial advice.";

function generateId() {
  return `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function round(v: number, dp = 2) {
  return Math.round(v * 10 ** dp) / 10 ** dp;
}

function clampConfidence(v: number) {
  return Math.max(0, Math.min(99, Math.round(v)));
}

/** Today's SPY market date (New York) in YYYY-MM-DD */
function todayStr(now: Date = new Date()) {
  return marketDateNY(now);
}

export interface ContractSelection {
  /** A same-day 0DTE contract, or null if none qualified. */
  contract: ContractCandidate | null;
  /**
   * Set when contracts matched the side/score filter but ALL of them were
   * later-dated (non-0DTE). Used to produce a clear refusal reason instead of a
   * generic "no contract" message, so the operator knows the bot saw flow but
   * deliberately refused the future expiry.
   */
  laterDatedRejected: boolean;
}

/**
 * Signed out-of-the-money distance in strikes for one contract, given the full
 * ordered ladder of same-day strikes for its side. Returns:
 *   0  → the strike that straddles spot (nearest, ATM-ish)
 *   +n → n strikes out-of-the-money (Call above spot / Put below spot)
 *   −n → n strikes in-the-money
 *
 * `ladder` must be the sorted unique strike list for this side (ascending).
 */
function otmDistanceInStrikes(
  strike: number,
  spot: number,
  side: "Call" | "Put",
  ladder: number[],
): number {
  // Index of the ATM anchor — the strike closest to spot on this ladder.
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
  // Steps above the anchor are OTM for Calls; steps below are OTM for Puts.
  const stepsAbove = idx - anchor;
  return side === "Call" ? stepsAbove : -stepsAbove;
}

/**
 * Select the best SAME-DAY (0DTE) contract candidate for a given bias.
 *
 * Hard rule: only contracts whose expiration — parsed from the OCC symbol —
 * equals today's NY market date are eligible. There is NO fallback to weekly /
 * future expiries; a later-dated contract is never returned as a candidate.
 *
 *  1. Filter to matching side + minimum unusual score
 *  2. Keep only same-day 0DTE (expiry parsed from the symbol == today)
 *  3. Build the same-day strike ladder and target `otmTarget` strikes OTM
 *     (Call → above spot, Put → below spot). otmTarget <= 0 keeps ATM/nearest.
 *  4. Rank candidates by: proximity to the OTM target, then high-probability
 *     factors (unusualScore, volume-to-OI, tighter spread, raw volume).
 *
 * Returns { contract: null, laterDatedRejected: true } when flow existed but
 * was all later-dated, so the caller can surface a precise refusal reason.
 */
function selectContract(
  unusualOptions: UnusualOption[],
  bias: "Call" | "Put",
  spyPrice: number,
  minScore: number,
  otmTarget: number,
  now: Date = new Date(),
  smart?: { params: SmartSelectorParams } | null,
): ContractSelection {
  const today = todayStr(now);

  // ── Smart selector path (best_liquid mode) ─────────────────────────────────
  // Scores the same-day ATM / 1-OTM / 2-OTM candidates under the SAME 0DTE,
  // premium, and spread guardrails and picks the best. When it yields no
  // eligible candidate we fall through to the legacy fixed-OTM path so the
  // failure surfaces identically (REQUIRES_REVIEW / later-dated BLOCK).
  if (smart) {
    const selOpts: SelectorOption[] = unusualOptions.map((o) => ({
      symbol: o.symbol,
      expiry: o.expiry,
      strike: o.strike,
      side: o.side,
      last: o.last,
      bid: o.bid,
      ask: o.ask,
      volume: o.volume,
      openInterest: o.openInterest,
      volumeOiRatio: o.volumeOiRatio,
      unusualScore: o.unusualScore,
      delta: (o as { delta?: number | null }).delta ?? null,
    }));
    const res = selectSmartContract(selOpts, bias, spyPrice, smart.params, now);
    if (res.laterDatedRejected) {
      return { contract: null, laterDatedRejected: true };
    }
    if (res.best) {
      const c = res.best;
      const best = c.option;
      const parsed = parseOccSymbol(best.symbol);
      const strike = parsed?.strike ?? best.strike;
      const dist = c.otmStrikes;
      const moneyness: "OTM" | "ATM" | "ITM" =
        dist > 0 ? "OTM" : dist < 0 ? "ITM" : "ATM";
      const selectionRule =
        dist > 0 ? `${dist} OTM` : dist < 0 ? `${Math.abs(dist)} ITM` : "ATM";
      const strikeDistance = round(
        bias === "Call" ? strike - spyPrice : spyPrice - strike,
        2,
      );
      const deltaLabel = c.deltaEstimated
        ? `~${c.deltaUsed.toFixed(2)}Δ est`
        : `${c.deltaUsed.toFixed(2)}Δ`;
      return {
        contract: {
          symbol: best.symbol,
          expiry: parsed?.expiry ?? best.expiry,
          strike,
          side: best.side,
          last: best.last,
          bid: best.bid,
          ask: best.ask,
          unusualScore: best.unusualScore,
          moneyness,
          otmStrikes: dist,
          strikeDistance,
          selectionRule,
          selectionReason: `Smart-selected same-day 0DTE ${bias} — ${selectionRule} (best_liquid), strike ${strike} vs spot ${round(spyPrice, 2)}, mid $${c.mid.toFixed(2)}, ${deltaLabel}, spread ${(c.spreadPct * 100).toFixed(0)}%, score ${best.unusualScore}, selectorScore ${c.score.toFixed(3)}, expiry ${today} (verified from OCC symbol)`,
        },
        laterDatedRejected: false,
      };
    }
    // No eligible smart candidate → fall through to the legacy fixed path so the
    // caller still gets a precise REQUIRES_REVIEW / no-contract verdict.
  }

  // Filter to matching side and minimum unusual score
  const matching = unusualOptions.filter(
    (o) => o.side === bias && o.unusualScore >= minScore,
  );

  if (!matching.length) {
    return { contract: null, laterDatedRejected: false };
  }

  // Same-day 0DTE only — expiry derived from the OCC symbol (source of truth).
  const zeroDte = matching.filter((o) => isZeroDteSymbol(o.symbol, now));

  if (!zeroDte.length) {
    // Flow exists but every contract is later-dated → refuse, do not fall back.
    return { contract: null, laterDatedRejected: true };
  }

  // Build the ascending, de-duplicated strike ladder for this side so we can
  // measure each contract's distance OTM in whole strikes (not dollars).
  const ladder = Array.from(new Set(zeroDte.map((o) => o.strike))).sort(
    (a, b) => a - b,
  );

  // Desired moneyness: clamp to the available ladder so a sparse same-day chain
  // still yields the furthest-OTM contract it has rather than nothing.
  const target = Math.max(0, Math.floor(otmTarget));

  const scored = zeroDte.map((o) => {
    const dist = otmDistanceInStrikes(o.strike, spyPrice, bias, ladder);
    const spread = o.ask > 0 && o.bid > 0 ? o.ask - o.bid : Infinity;
    return { o, dist, spread };
  });

  // Primary key: closeness to the OTM target (prefer at-or-just-past target,
  // never an ITM strike when an OTM one is available for an aggressive entry).
  // Secondary keys rank high-probability factors among equally-positioned
  // strikes: unusualScore ↓, volume/OI ↓, tighter spread ↑, raw volume ↓.
  const sorted = scored.sort((a, b) => {
    const aGap = Math.abs(a.dist - target);
    const bGap = Math.abs(b.dist - target);
    if (aGap !== bGap) return aGap - bGap;
    // Tie on distance to target → prefer the OTM side over the ITM side.
    if (a.dist !== b.dist) return b.dist - a.dist;
    if (b.o.unusualScore !== a.o.unusualScore)
      return b.o.unusualScore - a.o.unusualScore;
    if (b.o.volumeOiRatio !== a.o.volumeOiRatio)
      return b.o.volumeOiRatio - a.o.volumeOiRatio;
    if (a.spread !== b.spread) return a.spread - b.spread;
    return b.o.volume - a.o.volume;
  });

  const pick = sorted[0];
  const best = pick.o;
  const parsed = parseOccSymbol(best.symbol);
  const strike = parsed?.strike ?? best.strike;
  const dist = pick.dist;

  const moneyness: "OTM" | "ATM" | "ITM" =
    dist > 0 ? "OTM" : dist < 0 ? "ITM" : "ATM";
  const selectionRule =
    dist > 0 ? `${dist} OTM` : dist < 0 ? `${Math.abs(dist)} ITM` : "ATM";
  const strikeDistance = round(bias === "Call" ? strike - spyPrice : spyPrice - strike, 2);

  const targetLabel = target > 0 ? `${target} strike(s) OTM target` : "ATM/nearest target";

  return {
    contract: {
      symbol: best.symbol,
      expiry: parsed?.expiry ?? best.expiry,
      strike,
      side: best.side,
      last: best.last,
      bid: best.bid,
      ask: best.ask,
      unusualScore: best.unusualScore,
      moneyness,
      otmStrikes: dist,
      strikeDistance,
      selectionRule,
      selectionReason: `Selected same-day 0DTE ${bias} — ${selectionRule} (${targetLabel}), strike ${strike} vs spot ${round(spyPrice, 2)}, score ${best.unusualScore}, expiry ${today} (verified from OCC symbol)`,
    },
    laterDatedRejected: false,
  };
}

/**
 * Build the multi-timeframe analysis for a direction from the snapshot's candle
 * stream. Derives 15m/30m from the 1m base when those series are absent, so the
 * analysis works even if only 1m candles are supplied. Returns null when no 1m
 * stream is present (legacy/unit-test snapshots).
 */
function buildMtf(
  snapshot: SnapshotForSignal,
  bias: "Call" | "Put",
  cfg: BotConfig,
  now: Date,
  openOverride?: OpenOverrideInput,
): MtfAnalysis | null {
  const ones = snapshot.spy.candles;
  if (!ones || !ones.length) return null;

  const fives = snapshot.spy.candles5m?.length ? snapshot.spy.candles5m : ones;
  const fifteens = snapshot.spy.candles15m;
  const thirties = snapshot.spy.candles30m;

  // Derive lastTriggerAtMs from the tape so the re-arm window survives across
  // stateless ticks: scan recent 1m bars for the most recent confirmed trigger.
  const lastTriggerAtMs = mostRecentTriggerMs(ones, bias);

  return analyzeMultiTimeframe(bias, {
    candles1m: ones,
    candles5m: fives,
    // analyzeMultiTimeframe needs 15m/30m; if the snapshot omitted them we
    // derive them here so callers can pass just the 1m stream.
    candles15m: fifteens?.length ? fifteens : aggregateCandles(ones, 15),
    candles30m: thirties?.length ? thirties : aggregateCandles(ones, 30),
    spot: snapshot.spy.price,
    sr: {
      dailyOpen: snapshot.spy.dailyOpen ?? null,
      premarketHigh: snapshot.spy.premarketHigh ?? null,
      premarketLow: snapshot.spy.premarketLow ?? null,
    },
    openOverride,
    rearmWindowSec: cfg.rearmWindowSec,
    lastTriggerAtMs,
    nowMs: now.getTime(),
    aplus: cfg.aplusEntryOnly
      ? {
          enabled: true,
          proximityPct: cfg.aplusProximityPct,
          minLevelStrength: cfg.aplusMinLevelStrength,
        }
      : undefined,
  });
}

/**
 * Epoch ms of the most recent 1m candle that confirmed an entry trigger for the
 * given direction, scanning the trailing few bars. Lets the re-arm window
 * survive across stateless evaluations (each tick is a fresh snapshot).
 */
function mostRecentTriggerMs(candles1m: MtfCandle[], bias: "Call" | "Put"): number | null {
  const scan = Math.min(candles1m.length, 6);
  for (let i = candles1m.length; i >= candles1m.length - scan + 1 && i >= 2; i -= 1) {
    const window = candles1m.slice(0, i);
    const t = trigger1m(window, bias);
    if (t.triggered) {
      const ms = new Date(window[window.length - 1].time).getTime();
      return Number.isFinite(ms) ? ms : null;
    }
  }
  return null;
}

/** Generate bot signals from the current snapshot.
 *
 * Returns up to 2 signals (one per qualifying setup). Typically 0–2 signals
 * at any given time depending on market conditions.
 */
export interface GenerateSignalsOptions {
  /**
   * Whether the fresh-data guard is ENFORCED. Defaults to cfg.requireFreshData
   * (true for live/runtime). Offline backtests/replays pass false so historical
   * tapes are never blocked as "stale".
   */
  requireFreshData?: boolean;
}

export function generateSignals(
  snapshot: SnapshotForSignal,
  cfg: BotConfig = getBotConfig(),
  now = new Date(),
  options: GenerateSignalsOptions = {},
): BotSignal[] {
  const requireFresh = options.requireFreshData ?? cfg.requireFreshData;
  const freshness = evaluateDataFreshness(snapshot.spy.candles, cfg, now, requireFresh);

  // ── Global guards ─────────────────────────────────────────────────────────
  if (cfg.killSwitchActive) {
    return [withFreshness(blockedSignal("Kill switch is active — all signals suppressed"), freshness)];
  }

  // Fresh-data guard: during live automation / RTH, refuse to trade off a stale
  // tape. Surfaced as a readiness issue (BLOCKED) so the operator sees that the
  // automation is not working off fresh candles.
  if (freshness.enforced && !freshness.ready) {
    return [withFreshness(blockedSignal(freshness.detail), freshness)];
  }

  const nearNews = isNearHighImpactEvent(snapshot.economicCalendar, cfg, now);
  if (nearNews) {
    return [withFreshness(blockedSignal(`Within ${cfg.newsBlackoutMinutes} min of high-impact calendar event — signals paused`), freshness)];
  }

  const entryBlock = entryWindowBlock(cfg, now);
  if (entryBlock) {
    return [withFreshness(blockedSignal(entryBlock), freshness)];
  }

  // ── Filter qualifying setups ───────────────────────────────────────────────
  const qualifying = snapshot.setups.filter((s) => {
    if (s.bias === "Wait") return false;
    if (cfg.allowMediumConfidence) {
      return s.confidence >= cfg.minConfidence;
    }
    // High confidence only
    return s.confidence >= 70;
  });

  if (!qualifying.length) {
    return [withFreshness(noSetupSignal(), freshness)];
  }

  const signals: BotSignal[] = [];

  for (const setup of qualifying.slice(0, 2)) {
    const bias = setup.bias as "Call" | "Put";

    // Corroborating unusual options in the same direction
    const corroborating = snapshot.unusualOptions.filter(
      (o) => o.side === bias && o.unusualScore >= cfg.minUnusualScore,
    );

    // Contract selection — same-day 0DTE only. In best_liquid mode the smart
    // selector scores ATM / 1-OTM / 2-OTM candidates under the same guardrails;
    // in fixed_otm mode the legacy fixed-target path is used.
    const smart =
      cfg.contractSelectionMode === "best_liquid"
        ? {
            params: {
              ...defaultSmartParams(
                cfg.minUnusualScore,
                cfg.minOptionPremium,
                cfg.maxSpreadPct,
              ),
              maxOtmStrikes: cfg.selectorMaxOtmStrikes,
              preferredMinPremium: cfg.selectorPreferredMinPremium,
              deltaMin: cfg.selectorDeltaMin,
              deltaMax: cfg.selectorDeltaMax,
              preferredMaxSpreadPct: cfg.selectorPreferredMaxSpreadPct,
            },
          }
        : null;
    const selection = selectContract(
      snapshot.unusualOptions,
      bias,
      snapshot.spy.price,
      cfg.minUnusualScore,
      cfg.otmStrikes,
      now,
      smart,
    );
    const contract = selection.contract;

    const mid = contract ? round((contract.bid + contract.ask) / 2, 2) : null;
    const stopFrac = cfg.stopLossFraction;
    const trailArmFrac = cfg.trailStartFraction;

    // ── Open-window liquidation override eligibility (caller-side strict gate) ─
    // The override is offered to the MTF stack ONLY when ALL of the following
    // hold: it is enabled, `now` is inside the narrow 09:30–09:35 ET window, the
    // bias is Put (downside liquidation), the same-side options/liquidity score
    // is strong (≥ openOverrideMinOptionScore), and the setup confidence meets
    // the elevated floor. The MTF stack then additionally requires a genuine
    // high-velocity impulse + premarket-low break and never relaxes a bullish
    // (contradicting) HTF. This converts the un-tradable first bar of a real
    // open liquidation from BLOCK to ACTIONABLE without touching chop-day drift.
    const bestSameSideScore = snapshot.unusualOptions
      .filter((o) => o.side === bias)
      .reduce((m, o) => Math.max(m, o.unusualScore), 0);
    const overrideEligible =
      cfg.openOverrideEnabled &&
      bias === "Put" &&
      isWithinOpenOverrideWindow(cfg, now) &&
      bestSameSideScore >= cfg.openOverrideMinOptionScore &&
      setup.confidence >= cfg.openOverrideMinConfidence;
    const openOverride: OpenOverrideInput | undefined = overrideEligible
      ? {
          active: true,
          premarketLow: snapshot.spy.premarketLow ?? null,
          premarketHigh: snapshot.spy.premarketHigh ?? null,
          minImpulseCandles: cfg.openOverrideMinImpulseCandles,
          minVelocityAtr: cfg.openOverrideMinVelocityAtr,
        }
      : undefined;

    // Multi-timeframe market-structure analysis for this direction.
    const mtf = buildMtf(snapshot, bias, cfg, now, openOverride);

    let status: SignalStatus;
    let blockReason: string | null = null;
    let reviewReason: string | null = null;
    let confidence = setup.confidence;

    if (selection.laterDatedRejected) {
      // Flow existed but all later-dated → hard block, never offer future expiry.
      // (Same-day 0DTE guard is authoritative and runs before MTF gating.)
      status = "BLOCKED";
      blockReason =
        "No same-day 0DTE SPY contract found; refusing later-dated expiry. " +
        `Only ${todayStr(now)} expirations are eligible for 0DTE entry.`;
    } else if (!contract) {
      status = "REQUIRES_REVIEW";
      reviewReason =
        `No same-day 0DTE SPY options with score ≥ ${cfg.minUnusualScore} found for ${bias} side. ` +
        "Manual same-day contract selection required before entry.";
    } else if (!isZeroDteSymbol(contract.symbol, now)) {
      // Defensive: should be unreachable, selectContract only returns 0DTE.
      status = "BLOCKED";
      blockReason =
        `Selected contract ${contract.symbol} is not a same-day 0DTE; refusing later-dated expiry.`;
    } else {
      // Same-day 0DTE contract is valid. Now apply higher-timeframe gating:
      //   block      → higher timeframe contradicts → BLOCKED
      //   downgrade  → higher timeframe neutral/chop → REQUIRES_REVIEW or reduced confidence
      //   allow      → higher timeframe aligned → ACTIONABLE (confidence boosted)
      if (mtf) {
        confidence = clampConfidence(confidence + mtf.confidenceDelta);
        if (mtf.gate === "block") {
          status = "BLOCKED";
          blockReason = mtf.gateReason;
        } else if (mtf.gate === "downgrade") {
          status = "REQUIRES_REVIEW";
          reviewReason = mtf.gateReason;
        } else {
          status = "ACTIONABLE";
        }
      } else {
        // No candle stream available — preserve prior behavior.
        status = "ACTIONABLE";
      }

      // ── Contract-quality filters (premium floor + spread ceiling) ───────────
      // Only gate an otherwise-actionable entry: a too-cheap or too-wide 0DTE
      // contract is a lottery fill whose spread cost dominates the edge, so we
      // downgrade it to REQUIRES_REVIEW rather than auto-entering. These run
      // AFTER MTF gating so a BLOCKED/REVIEW verdict is never relaxed.
      if (status === "ACTIONABLE" && contract && mid != null) {
        if (cfg.minOptionPremium > 0 && mid < cfg.minOptionPremium) {
          status = "REQUIRES_REVIEW";
          reviewReason =
            `Mid premium $${mid.toFixed(2)} is below the $${cfg.minOptionPremium.toFixed(2)} ` +
            `minimum-premium filter — too cheap/illiquid for an auto-entry.`;
        } else if (cfg.maxSpreadPct > 0 && contract.ask > 0 && contract.bid >= 0) {
          const spreadPct = mid > 0 ? (contract.ask - contract.bid) / mid : Infinity;
          if (spreadPct > cfg.maxSpreadPct) {
            status = "REQUIRES_REVIEW";
            reviewReason =
              `Bid/ask spread ${(spreadPct * 100).toFixed(0)}% of mid exceeds the ` +
              `${(cfg.maxSpreadPct * 100).toFixed(0)}% max-spread filter — execution cost too high.`;
          }
        }
      }

      // ── A+ confidence floor ("only enter A+ setups") ────────────────────────
      // When the A+ gate is on, an actionable entry must also clear the elevated
      // A+ confidence floor (above the base minConfidence). Anything weaker is a
      // B/C setup and is downgraded to REQUIRES_REVIEW rather than auto-entered.
      // The proximity component of "A+" is enforced inside the MTF gate (it turns
      // a mid-range chase from allow→downgrade); this is the quality component.
      if (cfg.aplusEntryOnly && status === "ACTIONABLE" && confidence < cfg.aplusMinConfidence) {
        status = "REQUIRES_REVIEW";
        reviewReason =
          `A+ gate: confidence ${confidence} is below the A+ floor ${cfg.aplusMinConfidence} ` +
          `— only A+ (highest-quality) setups are auto-entered.`;
      }
    }

    signals.push({
      id: generateId(),
      generatedAt: now.toISOString(),
      status,
      bias,
      confidence,
      setup,
      contract,
      isZeroDte: !!contract && isZeroDteSymbol(contract.symbol, now),
      contractExpiry: contract?.expiry ?? null,
      blockReason,
      reviewReason,
      triggerText: mtf ? `${setup.trigger} · 1m: ${mtf.entryPlan.trigger}` : setup.trigger,
      invalidationText: mtf ? `${setup.invalidation} · ${mtf.entryPlan.invalidation}` : setup.invalidation,
      suggestedEntryPremium: mid,
      impliedStopPremium: mid ? round(mid * (1 - stopFrac)) : null,
      impliedTrailArmPremium: mid ? round(mid * (1 + trailArmFrac)) : null,
      corroborating,
      mtf,
      dataFreshness: freshness,
      disclaimer: DISCLAIMER,
    });
  }

  return signals;
}

/** Attach a freshness verdict to a signal (for the global-guard early returns). */
function withFreshness(sig: BotSignal, freshness: DataFreshness): BotSignal {
  return { ...sig, dataFreshness: freshness };
}

const DEFAULT_FRESHNESS: DataFreshness = {
  ready: true,
  ageSec: null,
  thresholdSec: 120,
  enforced: false,
  detail: "Freshness not evaluated.",
};

function blockedSignal(reason: string): BotSignal {
  return {
    id: generateId(),
    generatedAt: new Date().toISOString(),
    status: "BLOCKED",
    bias: null,
    confidence: 0,
    setup: null,
    contract: null,
    isZeroDte: false,
    contractExpiry: null,
    blockReason: reason,
    reviewReason: null,
    triggerText: "n/a",
    invalidationText: "n/a",
    suggestedEntryPremium: null,
    impliedStopPremium: null,
    impliedTrailArmPremium: null,
    corroborating: [],
    mtf: null,
    dataFreshness: DEFAULT_FRESHNESS,
    disclaimer: DISCLAIMER,
  };
}

function noSetupSignal(): BotSignal {
  return {
    id: generateId(),
    generatedAt: new Date().toISOString(),
    status: "NO_SETUP",
    bias: null,
    confidence: 0,
    setup: null,
    contract: null,
    isZeroDte: false,
    contractExpiry: null,
    blockReason: "No qualifying Call or Put setups at current confidence threshold",
    reviewReason: null,
    triggerText: "Wait for a clear 2m directional close with momentum",
    invalidationText: "n/a",
    suggestedEntryPremium: null,
    impliedStopPremium: null,
    impliedTrailArmPremium: null,
    corroborating: [],
    mtf: null,
    dataFreshness: DEFAULT_FRESHNESS,
    disclaimer: DISCLAIMER,
  };
}
