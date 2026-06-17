import { getBotConfig } from "./bot/config.js";

export type Candle = {
  time: string;
  label: string;
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
  williamsR?: number;
  liquidityIn?: number;
  liquidityOut?: number;
};

export type SetupSentiment = {
  label: "Bullish" | "Bearish" | "Neutral";
  score: number;
  drivers: string[];
};

export type SetupLiquidity = {
  netFlow: number;
  callWall: number;
  putWall: number;
  supportZones: number[];
  resistanceZones: number[];
};

export type Setup = {
  title: string;
  bias: "Call" | "Put" | "Wait";
  confidence: number;
  trigger: string;
  invalidation: string;
  rationale: string;
};

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function inferSetups(
  candles2m: Candle[],
  sentiment: SetupSentiment,
  liquidity: SetupLiquidity,
): Setup[] {
  const last = candles2m[candles2m.length - 1];
  const prior = candles2m[candles2m.length - 2] ?? last;
  const vwap = last.vwap ?? last.close;
  const ema200 = last.ema200 ?? last.close;
  const histogram = last.histogram ?? 0;
  const priorHistogram = prior.histogram ?? 0;
  const williams = last.williamsR ?? -50;
  const support = liquidity.supportZones[0] ?? last.close - 1;
  const resistance = liquidity.resistanceZones[0] ?? last.close + 1;

  const closeAboveVwap = last.close > vwap;
  const closeBelowVwap = last.close < vwap;
  const histogramRising = histogram > priorHistogram;
  const histogramFalling = histogram < priorHistogram;
  const aboveEma = last.close > ema200;
  const belowEma = last.close < ema200;

  // ── VWAP reclaim (Call) / VWAP fade (Put) detection ───────────────────────────
  // Reclaim: a prior 2m bar closed BELOW VWAP and the current bar closes BACK
  //   ABOVE VWAP near the line (within the proximity band) with confirming
  //   momentum — a genuine cross-up, not a mid-range chase already extended above.
  // Fade:   the current 2m bar TESTED VWAP from below (its high reached at/above
  //   VWAP, within the band) but FAILED to hold, closing back BELOW VWAP with
  //   confirming downside momentum — a rejection of the line.
  const cfg = getBotConfig();
  const priorClose = prior.close;
  const proximityBand = (cfg.vwapProximityBps / 10_000) * last.close;
  const distanceAboveVwap = last.close - vwap;
  const reclaimMomentumOk = histogram >= 0 || histogramRising;
  const fadeMomentumOk = histogram <= 0 || histogramFalling;
  // Proximity passes when disabled (<= 0) or the close sits within the band of VWAP.
  const reclaimNearVwap = proximityBand <= 0 || distanceAboveVwap <= proximityBand;
  const fadeTestedVwap = proximityBand <= 0 || last.high >= vwap - proximityBand;
  const vwapReclaim =
    cfg.vwapReclaimEnabled &&
    priorClose < vwap &&
    last.close > vwap &&
    reclaimNearVwap &&
    reclaimMomentumOk;
  const vwapFade =
    cfg.vwapFadeEnabled &&
    last.high >= vwap &&
    fadeTestedVwap &&
    last.close < vwap &&
    fadeMomentumOk;
  const vwapReclaimConfidence = clamp(
    60 + sentiment.score / 5 + (aboveEma ? 6 : 0) + (histogram > 0 ? 5 : 0) + (williams > -50 ? 4 : 0),
    50,
    90,
  );
  const vwapFadeConfidence = clamp(
    60 - sentiment.score / 5 + (belowEma ? 6 : 0) + (histogram < 0 ? 5 : 0) + (williams < -50 ? 4 : 0),
    50,
    90,
  );
  const reclaimActionable = vwapReclaim && vwapReclaimConfidence >= cfg.vwapMinConfidence;
  const fadeActionable = vwapFade && vwapFadeConfidence >= cfg.vwapMinConfidence;

  const longSetup = closeAboveVwap && histogram > 0 && histogramRising;
  const longConfirming = closeAboveVwap && histogram > 0;
  const putSetup = closeBelowVwap && histogram < 0 && histogramFalling;
  const putConfirming = closeBelowVwap && histogram < 0;

  const longConfidence = longSetup
    ? clamp(
        62 +
          sentiment.score / 4 +
          (aboveEma ? 6 : 0) +
          (williams > -35 ? 5 : 0),
        52,
        90,
      )
    : longConfirming
      ? clamp(54 + sentiment.score / 6, 45, 70)
      : clamp(40 + sentiment.score / 8, 18, 55);

  const putConfidence = putSetup
    ? clamp(
        62 -
          sentiment.score / 4 +
          (belowEma ? 6 : 0) +
          (williams < -65 ? 5 : 0),
        52,
        90,
      )
    : putConfirming
      ? clamp(54 - sentiment.score / 6, 45, 70)
      : clamp(40 - sentiment.score / 8, 18, 55);

  const setups: Setup[] = [];

  if (cfg.vwapReclaimEnabled && vwapReclaim) {
    setups.push({
      title: "VWAP reclaim (2m) [vwap-reclaim]",
      bias: reclaimActionable ? "Call" : "Wait",
      confidence: vwapReclaimConfidence,
      trigger: `2m closes back above VWAP ${round(vwap)} from below (prior close ${round(priorClose)}) within ${cfg.vwapProximityBps}bps, momentum confirming`,
      invalidation: `2m close back below VWAP ${round(vwap)} or MACD histogram turns negative`,
      rationale: reclaimActionable
        ? `VWAP RECLAIM: price reclaimed VWAP ${round(vwap)} from below with confirming momentum (hist ${histogram.toFixed(2)}).${aboveEma ? " Above the 2m 200 EMA." : ""} Tagged source: vwap-reclaim.`
        : `VWAP reclaim crossed above VWAP ${round(vwap)} but confidence is below the ${cfg.vwapMinConfidence} floor; wait for a stronger confirmation.`,
    });
  }

  if (cfg.vwapFadeEnabled && vwapFade) {
    setups.push({
      title: "VWAP fade (2m) [vwap-fade]",
      bias: fadeActionable ? "Put" : "Wait",
      confidence: vwapFadeConfidence,
      trigger: `2m tests VWAP ${round(vwap)} from below and closes back below (close ${round(last.close)}) within ${cfg.vwapProximityBps}bps, momentum confirming`,
      invalidation: `2m close reclaims and holds above VWAP ${round(vwap)} or MACD histogram turns positive`,
      rationale: fadeActionable
        ? `VWAP FADE: price tested VWAP ${round(vwap)} from below and was rejected, closing back below with confirming downside momentum (hist ${histogram.toFixed(2)}).${belowEma ? " Below the 2m 200 EMA." : ""} Tagged source: vwap-fade.`
        : `VWAP fade rejected the line at ${round(vwap)} but confidence is below the ${cfg.vwapMinConfidence} floor; wait for a stronger confirmation.`,
    });
  }

  setups.push(
    {
      title: "VWAP reclaim continuation (2m)",
      bias: longSetup ? "Call" : "Wait",
      confidence: longConfidence,
      trigger: `2m close above VWAP ${round(vwap)} with rising MACD histogram, break of ${round(resistance)}`,
      invalidation: `2m close back below VWAP ${round(vwap)} or MACD histogram flips negative`,
      rationale: longSetup
        ? `2m candle is holding above VWAP with momentum building (hist ${histogram.toFixed(2)}).${
            aboveEma ? " Price is above the 200 EMA on the 2m series." : ""
          }`
        : longConfirming
          ? "2m price is above VWAP but momentum has not yet expanded; wait for an impulse 2m close."
          : "Wait for a 2m close back above VWAP with positive momentum before chasing upside.",
    },
    {
      title: "Liquidity rejection fade (2m)",
      bias: putSetup ? "Put" : "Wait",
      confidence: putConfidence,
      trigger: `2m rejection of ${round(resistance)} or close below ${round(support)} with falling MACD`,
      invalidation: `2m close reclaims VWAP ${round(vwap)} or MACD histogram turns positive`,
      rationale: putSetup
        ? `2m candle is rejecting from VWAP with negative momentum (hist ${histogram.toFixed(2)}).${
            belowEma ? " Price is below the 200 EMA on the 2m series." : ""
          }`
        : putConfirming
          ? "2m price is below VWAP but downside momentum has not extended; wait for an impulse 2m close."
          : "No clean downside trigger until a 2m close fails VWAP and a liquidity shelf gives way.",
    },
    {
      title: "0DTE risk filter (2m confirmation)",
      bias: Math.abs(sentiment.score) < 18 ? "Wait" : sentiment.score > 0 ? "Call" : "Put",
      confidence: clamp(50 + Math.abs(sentiment.score) / 3, 45, 80),
      trigger: "Only take the first pullback after a confirmed 2m trend candle",
      invalidation: "Skip if a 2m candle closes back inside the prior 2m range or spreads widen",
      rationale:
        "0DTE contracts decay quickly, so the dashboard requires a 2m close in trend direction before counting a signal as live.",
    },
  );

  return setups.map((setup) => ({
    ...setup,
    confidence: Math.round(setup.confidence),
  }));
}
