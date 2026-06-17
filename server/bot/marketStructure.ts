/**
 * Multi-timeframe market-structure analysis for the SPY 0DTE bot.
 *
 * ─── WHAT THIS DOES ───────────────────────────────────────────────────────────
 * The 1-minute candle stream is the single source of truth. From it we derive
 * higher timeframes server-side and build a layered "stack" the signal engine
 * uses to decide whether an entry is actionable:
 *
 *   30m → higher-timeframe trend / regime (bullish | bearish | neutral/chop)
 *   15m → tactical trend + support/resistance zones (swing H/L, VWAP, EMA,
 *         daily open, premarket H/L)
 *    5m → setup confirmation (continuation/rejection, VWAP reclaim/loss,
 *         pullback hold, break/retest, momentum)
 *    1m → entry trigger / timing (trigger candle, micro pullback, invalidation)
 *
 * The output feeds a gating decision: an entry is only ACTIONABLE when the
 * 15m/30m structure does not contradict the direction. Neutral/chop downgrades
 * confidence; contradiction blocks or flags for review.
 *
 * This module is intentionally self-contained (its own minimal candle shape and
 * indicator math) so it can be imported by both the signal engine and the route
 * layer without creating a circular dependency on server/routes.ts.
 *
 * ⚠ Analysis only — NOT financial advice. Produces trade PLANS, never orders.
 */

// ─── Candle shape (subset of the dashboard candle; only fields we need) ────────

export interface MtfCandle {
  time: string;
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
}

export type Direction = "Call" | "Put";
export type Trend = "bullish" | "bearish" | "neutral";

function round(v: number, dp = 2): number {
  return Math.round(v * 10 ** dp) / 10 ** dp;
}

// ─── Candle aggregation ────────────────────────────────────────────────────────

/**
 * Aggregate 1m candles into N-minute candles by flooring each candle's epoch
 * into fixed N-minute buckets. OHLC is built only from price-domain fields; the
 * derived series then gets indicators recomputed on the higher timeframe.
 */
export function aggregateCandles(candles: MtfCandle[], minutes: number): MtfCandle[] {
  if (!candles.length) return [];
  const bucketMs = minutes * 60_000;
  const buckets = new Map<number, MtfCandle[]>();
  for (const c of candles) {
    const ts = new Date(c.time).getTime();
    if (!Number.isFinite(ts)) continue;
    const key = Math.floor(ts / bucketMs);
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }

  const out: MtfCandle[] = [];
  for (const key of Array.from(buckets.keys()).sort((a, b) => a - b)) {
    const items = buckets.get(key)!;
    items.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const open = items[0].open;
    const close = items[items.length - 1].close;
    const high = Math.max(...items.map((i) => i.high), open, close);
    const low = Math.min(...items.map((i) => i.low), open, close);
    const volume = items.reduce((sum, i) => sum + (i.volume || 0), 0);
    out.push({
      time: new Date(key * bucketMs).toISOString(),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume,
    });
  }

  return addIndicators(out);
}

/** Compute VWAP / EMA200 / MACD on an aggregated series. */
export function addIndicators(candles: MtfCandle[]): MtfCandle[] {
  if (!candles.length) return [];
  let cumPV = 0;
  let cumV = 0;
  let ema12 = candles[0].close;
  let ema26 = candles[0].close;
  let macdSignal = 0;
  let ema200 = candles[0].close;
  const k12 = 2 / 13;
  const k26 = 2 / 27;
  const k9 = 2 / 10;
  const k200 = 2 / 201;

  return candles.map((c) => {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    ema12 = c.close * k12 + ema12 * (1 - k12);
    ema26 = c.close * k26 + ema26 * (1 - k26);
    const macd = ema12 - ema26;
    macdSignal = macd * k9 + macdSignal * (1 - k9);
    ema200 = c.close * k200 + ema200 * (1 - k200);
    return {
      ...c,
      vwap: cumV > 0 ? round(cumPV / cumV) : c.close,
      ema200: round(ema200),
      macd: round(macd, 3),
      signal: round(macdSignal, 3),
      histogram: round(macd - macdSignal, 3),
    };
  });
}

// ─── Swing structure ───────────────────────────────────────────────────────────

interface SwingPoint {
  index: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Pivot-based swing detection: a swing high is a candle whose high is the
 * maximum within `width` bars on each side (and symmetrically for lows).
 */
function findSwings(candles: MtfCandle[], width = 2): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = width; i < candles.length - width; i += 1) {
    const win = candles.slice(i - width, i + width + 1);
    const c = candles[i];
    if (c.high >= Math.max(...win.map((w) => w.high))) {
      points.push({ index: i, price: c.high, kind: "high" });
    }
    if (c.low <= Math.min(...win.map((w) => w.low))) {
      points.push({ index: i, price: c.low, kind: "low" });
    }
  }
  return points;
}

/** Classify trend from swing structure: higher-highs/higher-lows etc. */
function swingTrend(candles: MtfCandle[]): Trend {
  const swings = findSwings(candles, 2);
  const highs = swings.filter((s) => s.kind === "high").slice(-2);
  const lows = swings.filter((s) => s.kind === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const higherHighs = highs[1].price > highs[0].price;
  const higherLows = lows[1].price > lows[0].price;
  const lowerHighs = highs[1].price < highs[0].price;
  const lowerLows = lows[1].price < lows[0].price;
  if (higherHighs && higherLows) return "bullish";
  if (lowerHighs && lowerLows) return "bearish";
  return "neutral";
}

// ─── Per-timeframe trend scoring ────────────────────────────────────────────────

export interface TimeframeTrend {
  timeframe: "30m" | "15m" | "5m" | "1m";
  trend: Trend;
  /** -100..100 composite; sign = direction, magnitude = conviction */
  score: number;
  close: number;
  vwap: number | null;
  ema200: number | null;
  histogram: number | null;
  /** Human-readable drivers behind the classification. */
  drivers: string[];
}

/**
 * Score a timeframe's trend from EMA/VWAP position, the slope of close & EMA,
 * MACD histogram, and (for higher TFs) swing structure. Returns a signed
 * composite score; |score| < `neutralBand` is treated as neutral/chop.
 */
function scoreTrend(
  candles: MtfCandle[],
  timeframe: TimeframeTrend["timeframe"],
  opts: { useSwing: boolean; neutralBand: number },
): TimeframeTrend {
  const last = candles[candles.length - 1];
  if (!last) {
    return {
      timeframe,
      trend: "neutral",
      score: 0,
      close: 0,
      vwap: null,
      ema200: null,
      histogram: null,
      drivers: ["No candles available"],
    };
  }

  const prev = candles[Math.max(0, candles.length - 4)] ?? last;
  const vwap = last.vwap ?? last.close;
  const ema = last.ema200 ?? last.close;
  const prevEma = prev.ema200 ?? prev.close;
  const hist = last.histogram ?? 0;
  const drivers: string[] = [];
  let score = 0;

  if (last.close > vwap) {
    score += 22;
    drivers.push(`close ${round(last.close)} above VWAP ${round(vwap)}`);
  } else if (last.close < vwap) {
    score -= 22;
    drivers.push(`close ${round(last.close)} below VWAP ${round(vwap)}`);
  }

  if (last.close > ema) {
    score += 16;
    drivers.push(`close above ${timeframe} EMA`);
  } else if (last.close < ema) {
    score -= 16;
    drivers.push(`close below ${timeframe} EMA`);
  }

  // EMA slope (regime)
  if (ema > prevEma) {
    score += 12;
    drivers.push("EMA sloping up");
  } else if (ema < prevEma) {
    score -= 12;
    drivers.push("EMA sloping down");
  }

  // Close slope (momentum of price itself)
  if (last.close > prev.close) score += 10;
  else if (last.close < prev.close) score -= 10;

  // MACD histogram
  if (hist > 0) {
    score += 16;
    drivers.push(`MACD histogram positive (${hist.toFixed(2)})`);
  } else if (hist < 0) {
    score -= 16;
    drivers.push(`MACD histogram negative (${hist.toFixed(2)})`);
  }

  if (opts.useSwing) {
    const st = swingTrend(candles);
    if (st === "bullish") {
      score += 18;
      drivers.push("swing structure: higher highs / higher lows");
    } else if (st === "bearish") {
      score -= 18;
      drivers.push("swing structure: lower highs / lower lows");
    } else {
      drivers.push("swing structure: mixed / ranging");
    }
  }

  const bounded = Math.max(-100, Math.min(100, score));
  const trend: Trend =
    bounded > opts.neutralBand ? "bullish" : bounded < -opts.neutralBand ? "bearish" : "neutral";

  return {
    timeframe,
    trend,
    score: Math.round(bounded),
    close: round(last.close),
    vwap: round(vwap),
    ema200: round(ema),
    histogram: round(hist, 3),
    drivers: drivers.slice(0, 4),
  };
}

// ─── Support / Resistance ───────────────────────────────────────────────────────

export interface SrLevel {
  price: number;
  type: "support" | "resistance";
  source: string;
  timeframe: "30m" | "15m" | "daily" | "premarket";
  /** 1..100 — how strongly this level is corroborated. */
  strength: number;
}

export interface SrContext {
  dailyOpen?: number | null;
  premarketHigh?: number | null;
  premarketLow?: number | null;
}

/**
 * Build S/R zones from 15m/30m swing highs/lows plus VWAP/EMA and, when
 * available, daily open and premarket high/low. Levels near the same price are
 * merged and their strength increased (more corroboration = stronger zone).
 */
export function buildSupportResistance(
  candles15m: MtfCandle[],
  candles30m: MtfCandle[],
  spot: number,
  ctx: SrContext = {},
): SrLevel[] {
  const raw: SrLevel[] = [];

  const addSwings = (candles: MtfCandle[], tf: "15m" | "30m") => {
    for (const s of findSwings(candles, 2)) {
      raw.push({
        price: round(s.price),
        type: s.price >= spot ? "resistance" : "support",
        source: `${tf} swing ${s.kind}`,
        timeframe: tf,
        strength: tf === "30m" ? 55 : 45,
      });
    }
  };
  addSwings(candles15m, "15m");
  addSwings(candles30m, "30m");

  const last15 = candles15m[candles15m.length - 1];
  if (last15?.vwap != null) {
    raw.push({
      price: round(last15.vwap),
      type: last15.vwap >= spot ? "resistance" : "support",
      source: "15m VWAP",
      timeframe: "15m",
      strength: 50,
    });
  }
  const last30 = candles30m[candles30m.length - 1];
  if (last30?.ema200 != null) {
    raw.push({
      price: round(last30.ema200),
      type: last30.ema200 >= spot ? "resistance" : "support",
      source: "30m EMA200",
      timeframe: "30m",
      strength: 48,
    });
  }
  if (ctx.dailyOpen != null) {
    raw.push({
      price: round(ctx.dailyOpen),
      type: ctx.dailyOpen >= spot ? "resistance" : "support",
      source: "daily open",
      timeframe: "daily",
      strength: 52,
    });
  }
  if (ctx.premarketHigh != null) {
    raw.push({
      price: round(ctx.premarketHigh),
      type: "resistance",
      source: "premarket high",
      timeframe: "premarket",
      strength: 50,
    });
  }
  if (ctx.premarketLow != null) {
    raw.push({
      price: round(ctx.premarketLow),
      type: "support",
      source: "premarket low",
      timeframe: "premarket",
      strength: 50,
    });
  }

  // Merge levels within a tight band (0.1% of spot) — corroboration stacks.
  const band = Math.max(0.15, spot * 0.001);
  const merged: SrLevel[] = [];
  for (const lvl of raw.sort((a, b) => a.price - b.price)) {
    const near = merged.find((m) => Math.abs(m.price - lvl.price) <= band && m.type === lvl.type);
    if (near) {
      near.strength = Math.min(100, near.strength + Math.round(lvl.strength * 0.35));
      near.source = near.source.includes(lvl.source) ? near.source : `${near.source} + ${lvl.source}`;
    } else {
      merged.push({ ...lvl });
    }
  }

  return merged.sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot));
}

/** Nearest support below spot and nearest resistance above spot. */
export function nearestLevels(levels: SrLevel[], spot: number): {
  support: SrLevel | null;
  resistance: SrLevel | null;
} {
  const supports = levels.filter((l) => l.type === "support" && l.price <= spot);
  const resistances = levels.filter((l) => l.type === "resistance" && l.price >= spot);
  const support = supports.sort((a, b) => b.price - a.price)[0] ?? null;
  const resistance = resistances.sort((a, b) => a.price - b.price)[0] ?? null;
  return { support, resistance };
}

// ─── A+ entry proximity (supply/demand · S/R · buyer/seller step-in) ───────────

export interface AplusProximity {
  /** True when the trigger price is near a relevant structure level for the side. */
  qualifies: boolean;
  /** The level the entry is anchored to (nearest qualifying), or null. */
  level: SrLevel | null;
  /** Signed distance trigger→level in dollars (absolute used for the band check). */
  distance: number;
  /** Distance as a fraction of spot. */
  distancePct: number;
  /** Human-readable explanation for status/diagnostics. */
  reason: string;
}

/**
 * A+ entry proximity check. An A+ entry is one whose trigger price sits NEAR a
 * relevant structure level rather than mid-range. The S/R levels built by
 * buildSupportResistance encode the same information a trader reads as
 * supply/demand zones and buyer/seller step-in levels: swing highs/lows
 * (where price previously stepped in), VWAP, EMA, daily open, and premarket
 * high/low.
 *
 *   • Call (long): qualifies when the trigger price is within the proximity
 *     band of a SUPPORT/DEMAND level (buyers step in) at or below price, OR of a
 *     RESISTANCE level it is reclaiming (within band from below/at) — i.e. a
 *     break/retest of broken supply. A chase far above support is rejected.
 *   • Put (short): qualifies when the trigger price is within the band of a
 *     RESISTANCE/SUPPLY level (sellers step in) at or above price, OR of a
 *     SUPPORT level it is losing — a break/retest of lost demand. A chase far
 *     below resistance is rejected.
 *
 * Pure function. `triggerPrice` is the price the entry triggers at (the latest
 * 1m close); `spot` anchors the proximity band width.
 */
export function aplusProximity(
  levels: SrLevel[],
  direction: Direction,
  triggerPrice: number,
  spot: number,
  proximityPct: number,
  minStrength: number,
): AplusProximity {
  const band = proximityPct > 0 ? Math.max(0.01, spot * proximityPct) : Infinity;
  const wantBull = direction === "Call";

  // Relevant level types for the side: a Call leans on support/demand (and a
  // reclaimed resistance); a Put leans on resistance/supply (and a lost support).
  // We accept BOTH types within the band so a break/retest of the opposite
  // level (the classic step-in) also qualifies, while a mid-range chase — far
  // from every level — does not.
  const candidates = levels
    .filter((l) => minStrength <= 0 || l.strength >= minStrength)
    .map((l) => ({ level: l, distance: Math.abs(l.price - triggerPrice) }))
    .sort((a, b) => a.distance - b.distance);

  const near = candidates.find((c) => c.distance <= band);

  if (!near) {
    const nearest = candidates[0];
    return {
      qualifies: false,
      level: nearest?.level ?? null,
      distance: nearest?.distance ?? Infinity,
      distancePct: nearest ? round(nearest.distance / spot, 4) : Infinity,
      reason: nearest
        ? `Mid-range chase: trigger ${round(triggerPrice)} is ${round(nearest.distance)} ` +
          `(${round((nearest.distance / spot) * 100, 2)}%) from the nearest qualifying ` +
          `${nearest.level.type} ${round(nearest.level.price)} (${nearest.level.source}); ` +
          `outside the ${round(proximityPct * 100, 2)}% A+ proximity band.`
        : `No structure level (≥ strength ${minStrength}) found to anchor an A+ ${direction} entry.`,
    };
  }

  const lvl = near.level;
  // Confirm the level makes directional sense (supply/demand & step-in logic):
  //   Call → support at/below price (demand) OR resistance being reclaimed.
  //   Put  → resistance at/above price (supply) OR support being lost.
  const directionalOk = wantBull
    ? lvl.type === "support" || triggerPrice >= lvl.price - band
    : lvl.type === "resistance" || triggerPrice <= lvl.price + band;

  if (!directionalOk) {
    return {
      qualifies: false,
      level: lvl,
      distance: near.distance,
      distancePct: round(near.distance / spot, 4),
      reason:
        `Nearby ${lvl.type} ${round(lvl.price)} (${lvl.source}) does not support an A+ ` +
        `${direction} step-in at trigger ${round(triggerPrice)}.`,
    };
  }

  const role = wantBull
    ? lvl.type === "support"
      ? "demand/support (buyers step in)"
      : "reclaimed supply/resistance (break-retest)"
    : lvl.type === "resistance"
      ? "supply/resistance (sellers step in)"
      : "lost demand/support (break-retest)";

  return {
    qualifies: true,
    level: lvl,
    distance: near.distance,
    distancePct: round(near.distance / spot, 4),
    reason:
      `A+ ${direction}: trigger ${round(triggerPrice)} is within ${round(near.distance)} ` +
      `($, ${round((near.distance / spot) * 100, 2)}%) of ${role} ` +
      `${round(lvl.price)} [${lvl.source}, strength ${lvl.strength}].`,
  };
}

// ─── Setup confirmation (5m) & entry trigger (1m) ──────────────────────────────

export interface SetupConfirmation {
  confirmed: boolean;
  kind: "continuation" | "rejection" | "vwap-reclaim" | "vwap-loss" | "pullback-hold" | "none";
  detail: string;
}

/** 5m setup confirmation for a given direction. */
export function confirm5m(candles5m: MtfCandle[], direction: Direction): SetupConfirmation {
  const last = candles5m[candles5m.length - 1];
  const prev = candles5m[candles5m.length - 2] ?? last;
  if (!last) return { confirmed: false, kind: "none", detail: "No 5m data" };
  const vwap = last.vwap ?? last.close;
  const hist = last.histogram ?? 0;
  const priorHist = prev.histogram ?? 0;

  if (direction === "Call") {
    if (last.close > vwap && prev.close <= (prev.vwap ?? prev.close)) {
      return { confirmed: true, kind: "vwap-reclaim", detail: `5m reclaimed VWAP ${round(vwap)}` };
    }
    if (last.close > vwap && hist > 0 && hist >= priorHist) {
      return { confirmed: true, kind: "continuation", detail: `5m holding above VWAP with rising MACD` };
    }
    if (last.close > vwap && last.low <= vwap) {
      return { confirmed: true, kind: "pullback-hold", detail: `5m pullback to VWAP held and closed above` };
    }
    return { confirmed: false, kind: "none", detail: "5m has not confirmed bullish continuation" };
  }

  if (last.close < vwap && prev.close >= (prev.vwap ?? prev.close)) {
    return { confirmed: true, kind: "vwap-loss", detail: `5m lost VWAP ${round(vwap)}` };
  }
  if (last.close < vwap && hist < 0 && hist <= priorHist) {
    return { confirmed: true, kind: "continuation", detail: `5m holding below VWAP with falling MACD` };
  }
  if (last.close < vwap && last.high >= vwap) {
    return { confirmed: true, kind: "rejection", detail: `5m rejected VWAP and closed below` };
  }
  return { confirmed: false, kind: "none", detail: "5m has not confirmed bearish continuation" };
}

export interface EntryTrigger {
  triggered: boolean;
  detail: string;
  /** Suggested price-level invalidation derived from the last 1m candle. */
  invalidationPrice: number | null;
}

/** 1m entry trigger / timing for a given direction. */
export function trigger1m(candles1m: MtfCandle[], direction: Direction): EntryTrigger {
  const last = candles1m[candles1m.length - 1];
  const prev = candles1m[candles1m.length - 2] ?? last;
  if (!last) return { triggered: false, detail: "No 1m data", invalidationPrice: null };

  if (direction === "Call") {
    const triggered = last.close > last.open && last.close >= prev.high;
    return {
      triggered,
      detail: triggered
        ? `1m trigger candle closed up through prior high ${round(prev.high)}`
        : `Awaiting 1m close above prior high ${round(prev.high)}`,
      invalidationPrice: round(Math.min(last.low, prev.low)),
    };
  }
  const triggered = last.close < last.open && last.close <= prev.low;
  return {
    triggered,
    detail: triggered
      ? `1m trigger candle closed down through prior low ${round(prev.low)}`
      : `Awaiting 1m close below prior low ${round(prev.low)}`,
    invalidationPrice: round(Math.max(last.high, prev.high)),
  };
}

// ─── Top-level multi-timeframe analysis ─────────────────────────────────────────

export type AlignmentStatus = "aligned" | "neutral" | "contradicts";

export interface HigherTimeframeTrend {
  trend30m: TimeframeTrend;
  trend15m: TimeframeTrend;
  trend5m: TimeframeTrend;
  alignment: AlignmentStatus;
  alignmentReason: string;
}

export interface EntryTimeframe {
  setup5m: SetupConfirmation;
  trigger1m: EntryTrigger;
}

export interface EntryPlan {
  trigger: string;
  invalidation: string;
  /** Target = nearest opposing S/R level aligned to direction. */
  target: number | null;
  runnerTarget: number | null;
}

export interface MtfAnalysis {
  direction: Direction;
  higherTimeframeTrend: HigherTimeframeTrend;
  supportResistance: SrLevel[];
  nearestSupport: SrLevel | null;
  nearestResistance: SrLevel | null;
  entryTimeframe: EntryTimeframe;
  entryPlan: EntryPlan;
  /**
   * Gating verdict for the signal engine:
   *   allow      — HTF aligned, may proceed at full confidence
   *   downgrade  — HTF neutral/chop, proceed only with extra confirmation
   *   block      — HTF contradicts the direction; do not enter
   */
  gate: "allow" | "downgrade" | "block";
  gateReason: string;
  /** Confidence adjustment to apply to the base setup confidence (additive). */
  confidenceDelta: number;
  /** Open-window liquidation override diagnostics (null when not evaluated). */
  openOverride: OpenOverrideResult | null;
  /**
   * A+ entry proximity diagnostics (supply/demand · S/R · step-in). Present only
   * when the caller supplied aplus params; null otherwise. When the A+ gate is
   * enforced and this does not qualify, the gate is downgraded from "allow" so
   * mid-range chases are not auto-entered.
   */
  aplus: AplusProximity | null;
  /**
   * Epoch ms of the most recent confirmed 1m trigger observed this evaluation
   * (carries forward the caller's lastTriggerAtMs when this bar did not retrigger
   * but is still inside the re-arm window). Callers persist this so the re-arm
   * survives across evaluations. Null when no trigger has been seen.
   */
  lastTriggerAtMs: number | null;
}

/**
 * Optional inputs that enable the narrow open-window liquidation override. When
 * provided AND `active` is true (caller already confirmed the 09:30–09:35 ET
 * window + same-side options score + confidence floor), the gate may flip a
 * NEUTRAL-HTF block to "allow" for a genuine high-velocity downside liquidation.
 * The override NEVER fires when the HTF CONTRADICTS the direction (e.g. bullish
 * HTF against a Put). All other (non-time) safety gates are unaffected.
 */
export interface OpenOverrideInput {
  /** Caller already verified time-window + options score + confidence. */
  active: boolean;
  /** Premarket low (for a Put liquidation) / high (for a Call) break check. */
  premarketLow?: number | null;
  premarketHigh?: number | null;
  /** Min consecutive same-direction 1m closes required for an impulse. */
  minImpulseCandles: number;
  /** Min impulse range as a multiple of the trailing 1m ATR. */
  minVelocityAtr: number;
}

/** Diagnostic detail about why the open-window override did/didn't apply. */
export interface OpenOverrideResult {
  applied: boolean;
  reason: string;
  impulseCandles: number;
  velocityAtrMultiple: number;
  brokeKeyLevel: boolean;
}

export interface MtfInput {
  candles1m: MtfCandle[];
  candles5m: MtfCandle[];
  candles15m: MtfCandle[];
  candles30m: MtfCandle[];
  spot: number;
  sr?: SrContext;
  /** When present, enables the narrow open-window liquidation override. */
  openOverride?: OpenOverrideInput;
  /**
   * Seconds to remain "armed" after a confirmed 1m trigger so a single bounce
   * candle does not immediately re-block a valid continuation. The caller may
   * also report the timestamp of the most recent confirmed trigger via
   * `lastTriggerAtMs` so the re-arm survives across evaluations.
   */
  rearmWindowSec?: number;
  /** Epoch ms of the most recent confirmed 1m trigger (for the re-arm window). */
  lastTriggerAtMs?: number | null;
  /** Current evaluation time (epoch ms) — defaults to Date.now() at call site. */
  nowMs?: number;
  /**
   * When present, enables the A+ entry proximity gate (supply/demand · S/R ·
   * step-in). The gate only ever TIGHTENS: it can downgrade an otherwise-allow
   * verdict to "downgrade" (mid-range chase), never relax a block.
   */
  aplus?: {
    enabled: boolean;
    proximityPct: number;
    minLevelStrength: number;
  };
}

/**
 * Measure a downside (Put) or upside (Call) liquidation impulse on the 1m tape:
 * count of trailing consecutive same-direction closes and the impulse range as a
 * multiple of the trailing 1m ATR. Used only by the open-window override.
 */
function measureImpulse(
  candles1m: MtfCandle[],
  direction: Direction,
): { consecutive: number; velocityAtr: number } {
  if (candles1m.length < 3) return { consecutive: 0, velocityAtr: 0 };
  const want = direction === "Put" ? -1 : 1;

  // Trailing consecutive same-direction closes (close vs prior close).
  let consecutive = 0;
  for (let i = candles1m.length - 1; i > 0; i -= 1) {
    const dir = Math.sign(candles1m[i].close - candles1m[i - 1].close);
    if (dir === want) consecutive += 1;
    else break;
  }

  // Trailing 1m ATR over the last ~14 bars (true range).
  const lookback = Math.min(14, candles1m.length - 1);
  let trSum = 0;
  for (let i = candles1m.length - lookback; i < candles1m.length; i += 1) {
    const c = candles1m[i];
    const prevClose = candles1m[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trSum += tr;
  }
  const atr = lookback > 0 ? trSum / lookback : 0;

  // Impulse range = move over the trailing consecutive run (at least 1 bar).
  const span = Math.max(1, consecutive);
  const startIdx = Math.max(0, candles1m.length - 1 - span);
  const impulseRange = Math.abs(
    candles1m[candles1m.length - 1].close - candles1m[startIdx].close,
  );
  const velocityAtr = atr > 0 ? impulseRange / atr : 0;

  return { consecutive, velocityAtr: round(velocityAtr, 2) };
}

/**
 * Run the full multi-timeframe stack for a candidate direction and return the
 * structured analysis plus a gating verdict. Pure function — no side effects.
 */
export function analyzeMultiTimeframe(direction: Direction, input: MtfInput): MtfAnalysis {
  const { candles1m, candles5m, candles15m, candles30m, spot } = input;

  const trend30m = scoreTrend(candles30m, "30m", { useSwing: true, neutralBand: 22 });
  const trend15m = scoreTrend(candles15m, "15m", { useSwing: true, neutralBand: 18 });
  const trend5m = scoreTrend(candles5m, "5m", { useSwing: false, neutralBand: 14 });

  const wantBull = direction === "Call";
  const wantTrend: Trend = wantBull ? "bullish" : "bearish";
  const oppTrend: Trend = wantBull ? "bearish" : "bullish";

  // Alignment across the two higher timeframes (15m + 30m).
  let alignment: AlignmentStatus;
  let alignmentReason: string;
  const htf = [trend30m, trend15m];
  const contradicts = htf.some((t) => t.trend === oppTrend);
  const supports = htf.filter((t) => t.trend === wantTrend).length;

  if (contradicts) {
    alignment = "contradicts";
    const bad = htf.find((t) => t.trend === oppTrend)!;
    alignmentReason = `${bad.timeframe} trend is ${bad.trend}, opposing a ${direction} entry`;
  } else if (supports === htf.length) {
    alignment = "aligned";
    alignmentReason = `30m and 15m both ${wantTrend} — higher timeframe supports ${direction}`;
  } else {
    alignment = "neutral";
    alignmentReason = `Higher timeframe is mixed/neutral (30m ${trend30m.trend}, 15m ${trend15m.trend})`;
  }

  const sr = buildSupportResistance(candles15m, candles30m, spot, input.sr);
  const { support, resistance } = nearestLevels(sr, spot);

  const setup5m = confirm5m(candles5m, direction);
  const entryTrigger = trigger1m(candles1m, direction);

  // ── Continuation re-arm window ──────────────────────────────────────────────
  // Once a 1m trigger has fired, stay "armed" for rearmWindowSec so that a single
  // green bounce 1m candle does not immediately cancel a valid continuation. We
  // treat the 1m as effectively triggered while inside the window, even if THIS
  // bar's raw trigger is pending. Invalidation/risk gates still apply elsewhere.
  const nowMs = input.nowMs ?? Date.now();
  const lastBar1m = candles1m[candles1m.length - 1];
  const lastBarMs = lastBar1m ? new Date(lastBar1m.time).getTime() : nowMs;
  const rearmWindowSec = input.rearmWindowSec ?? 0;
  let lastTriggerAtMs: number | null = input.lastTriggerAtMs ?? null;
  if (entryTrigger.triggered) {
    lastTriggerAtMs = Number.isFinite(lastBarMs) ? lastBarMs : nowMs;
  }
  const withinRearm =
    rearmWindowSec > 0 &&
    lastTriggerAtMs != null &&
    nowMs - lastTriggerAtMs <= rearmWindowSec * 1000;
  // Effective trigger: a fresh trigger OR still inside the re-arm window.
  const triggerEffective = entryTrigger.triggered || withinRearm;

  // Gate decision.
  let gate: MtfAnalysis["gate"];
  let gateReason: string;
  let confidenceDelta = 0;

  // Small-account profile: be strict. An entry is only ACTIONABLE when BOTH
  // higher timeframes (30m + 15m) align with the direction AND the 5m setup and
  // 1m trigger have both confirmed. Anything weaker blocks rather than merely
  // downgrading — neutral/chop is treated as a hard no-trade, not a softer flag.
  if (alignment === "contradicts") {
    gate = "block";
    gateReason = `Higher timeframe contradicts ${direction}: ${alignmentReason}. Entry blocked.`;
    confidenceDelta = -40;
  } else if (alignment === "neutral") {
    // Neutral/chop now BLOCKS (previously downgraded). Require clean trend.
    gate = "block";
    confidenceDelta = -20;
    gateReason =
      `Higher timeframe is neutral/choppy: ${alignmentReason}. ` +
      `Entry blocked — small-account profile requires 30m + 15m trend alignment.`;
  } else {
    // 30m + 15m aligned. Now demand BOTH lower-timeframe confirmations (with the
    // re-arm window applied to the 1m so bounce candles do not re-block).
    if (!setup5m.confirmed || !triggerEffective) {
      gate = "block";
      confidenceDelta = -8;
      gateReason =
        `Higher timeframe aligned with ${direction}, but lower-timeframe confirmation ` +
        `incomplete (5m ${setup5m.confirmed ? "ok" : "pending"}, 1m ${triggerEffective ? "ok" : "pending"}). ` +
        `Entry blocked until 5m setup + 1m trigger both confirm.`;
    } else {
      gate = "allow";
      confidenceDelta = 8 + Math.round(Math.abs(trend30m.score) / 20);
      const rearmNote =
        !entryTrigger.triggered && withinRearm
          ? ` (1m held via ${rearmWindowSec}s re-arm continuation window)`
          : "";
      gateReason =
        `Higher timeframe aligned with ${direction}: ${alignmentReason}. ` +
        `5m setup (${setup5m.kind}) and 1m trigger both confirmed${rearmNote}.`;
    }
  }

  // ── Open-window liquidation override (narrow, neutral-HTF only) ─────────────
  // ONLY when the caller activated it (already verified 09:30–09:35 ET window +
  // same-side options score + confidence floor) and the HTF is NEUTRAL (never
  // when it CONTRADICTS). Requires a genuine high-velocity impulse that broke the
  // key open level (premarket low for a Put). Flips the neutral block to "allow".
  let openOverride: OpenOverrideResult | null = null;
  const ov = input.openOverride;
  if (ov && ov.active) {
    const { consecutive, velocityAtr } = measureImpulse(candles1m, direction);
    const keyLevel = direction === "Put" ? ov.premarketLow : ov.premarketHigh;
    const brokeKeyLevel =
      keyLevel != null && Number.isFinite(keyLevel)
        ? direction === "Put"
          ? spot < keyLevel
          : spot > keyLevel
        : false;
    const enoughImpulse = consecutive >= ov.minImpulseCandles;
    const enoughVelocity = velocityAtr >= ov.minVelocityAtr;
    const directionOk = direction === "Put"; // override is liquidation-down only
    const htfNotAgainst = alignment !== "contradicts";

    const qualifies =
      directionOk &&
      htfNotAgainst &&
      alignment === "neutral" &&
      enoughImpulse &&
      enoughVelocity &&
      brokeKeyLevel;

    if (qualifies && gate !== "allow") {
      gate = "allow";
      // Modest positive bump; the strict caller floor already gated confidence.
      confidenceDelta = Math.max(confidenceDelta, 4);
      gateReason =
        `OPEN-WINDOW LIQUIDATION OVERRIDE: ${direction} allowed despite neutral HTF — ` +
        `high-velocity impulse (${consecutive} consec 1m closes, ${velocityAtr}× ATR) ` +
        `broke key open level ${round(keyLevel as number)}. HTF not contradicting. ` +
        `All non-time safety gates remain in force.`;
    }
    openOverride = {
      applied: qualifies && gate === "allow",
      reason: qualifies
        ? "Override conditions met"
        : `Override not applied: ${
            !directionOk
              ? "direction not a downside liquidation"
              : alignment === "contradicts"
                ? "HTF contradicts the trade (bullish against a put)"
                : alignment !== "neutral"
                  ? `HTF is ${alignment}, override only relaxes neutral`
                  : !enoughImpulse
                    ? `impulse ${consecutive} < ${ov.minImpulseCandles} candles`
                    : !enoughVelocity
                      ? `velocity ${velocityAtr} < ${ov.minVelocityAtr}× ATR`
                      : !brokeKeyLevel
                        ? "did not break premarket low / key open level"
                        : "unknown"
          }`,
      impulseCandles: consecutive,
      velocityAtrMultiple: velocityAtr,
      brokeKeyLevel,
    };
  }

  // ── A+ entry proximity gate (supply/demand · S/R · buyer/seller step-in) ────
  // An A+ entry must trigger NEAR a relevant structure level, not mid-range. The
  // gate only ever TIGHTENS: it can turn an "allow" into a "downgrade" when the
  // trigger price is a mid-range chase, but it never relaxes a block. The trigger
  // price is the latest 1m close (where the entry fires).
  let aplus: AplusProximity | null = null;
  if (input.aplus?.enabled) {
    const triggerPrice = lastBar1m?.close ?? spot;
    aplus = aplusProximity(
      sr,
      direction,
      triggerPrice,
      spot,
      input.aplus.proximityPct,
      input.aplus.minLevelStrength,
    );
    if (gate === "allow" && !aplus.qualifies) {
      gate = "downgrade";
      confidenceDelta = Math.min(confidenceDelta, 0) - 6;
      gateReason =
        `A+ gate: not an A+ entry — ${aplus.reason} ` +
        `Higher/lower timeframes aligned, but the entry is not near a supply/demand · ` +
        `support/resistance · step-in level, so it is downgraded from auto-entry.`;
    } else if (gate === "allow" && aplus.qualifies) {
      gateReason = `${gateReason} ${aplus.reason}`;
    }
  }

  // Entry plan anchored to S/R levels.
  const target = wantBull ? resistance?.price ?? null : support?.price ?? null;
  const stopLevel = wantBull ? support?.price ?? null : resistance?.price ?? null;
  const entryPlan: EntryPlan = {
    trigger: entryTrigger.detail,
    invalidation:
      entryTrigger.invalidationPrice != null
        ? `${direction === "Call" ? "Below" : "Above"} ${entryTrigger.invalidationPrice}` +
          (stopLevel != null ? ` (structure ${wantBull ? "support" : "resistance"} ${stopLevel})` : "")
        : `${setup5m.detail}`,
    target,
    runnerTarget: target,
  };

  return {
    direction,
    higherTimeframeTrend: {
      trend30m,
      trend15m,
      trend5m,
      alignment,
      alignmentReason,
    },
    supportResistance: sr.slice(0, 8),
    nearestSupport: support,
    nearestResistance: resistance,
    entryTimeframe: { setup5m, trigger1m: entryTrigger },
    entryPlan,
    gate,
    gateReason,
    confidenceDelta,
    openOverride,
    aplus,
    lastTriggerAtMs: withinRearm || entryTrigger.triggered ? lastTriggerAtMs : null,
  };
}
