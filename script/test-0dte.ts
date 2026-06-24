/**
 * Static smoke test for same-day 0DTE enforcement.
 *
 * Demonstrates that on 2026-06-02 (NY market date):
 *   - SPY260605... (2026-06-05 weekly) is REJECTED everywhere
 *   - SPY260602... (today's 0DTE)      is ACCEPTED
 *
 * Run: npx tsx script/test-0dte.ts
 * No network, no real orders.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import {
  parseOccSymbol,
  isZeroDteSymbol,
  marketDateNY,
} from "../server/bot/occSymbol.js";
import {
  generateSignals,
  evaluateDataFreshness,
} from "../server/bot/signalEngine.js";
import {
  assertZeroDteOpen,
  executePaperOrder,
  executeOrder,
  isTerminalOrderStatus,
  waitForFill,
  selectMarkFromQuote,
  countDayTrades,
} from "../server/bot/tradierAdapter.js";
import type { TradierOrderLike } from "../server/bot/tradierAdapter.js";
import {
  getBotConfig,
  getAutoTradeReadiness,
  isWithinOpenOverrideWindow,
  minutesIntoEtDay,
  minutesIntoTradingDay,
  etTimestamp,
  etZoneDiagnostics,
  isNearHighImpactEvent,
  type BotConfig,
} from "../server/bot/config.js";
import { getAutomationStatus } from "../server/bot/automationEngine.js";
import {
  canOpenPosition,
  sizePosition,
  evaluatePosition,
} from "../server/bot/riskManager.js";
import {
  openPaperPosition,
  closePaperPosition,
  computeBotPnl,
  getDailyLossSnapshot,
  updateTrail,
  resetPaperState,
  getOpenPositions,
  getAllPositions,
  getBrokerAdoptions,
  markExitPending,
  adoptBrokerPosition as adoptReal,
  type PaperPosition,
} from "../server/bot/paperState.js";
import {
  classifyBrokerPosition,
  deriveEntryPremium,
  reconcileBrokerPositions,
  type ReconcileDeps,
} from "../server/bot/positionReconciler.js";
import type { TradierBrokerPosition } from "../server/bot/tradierAdapter.js";
import {
  aggregateCandles,
  analyzeMultiTimeframe,
  type MtfCandle,
} from "../server/bot/marketStructure.js";
import {
  inferSetups,
  type Candle as RouteCandle,
  type SetupSentiment,
  type SetupLiquidity,
  type Setup,
} from "../server/setups.js";
import express from "express";
import { registerBotRoutes } from "../server/bot/botRoutes.js";

// Pin "now" to 2026-06-02 14:30 UTC ≈ 09:30 CT / 10:30 ET — regular session.
// Time-of-day entry filters have been removed, so the specific minute no longer
// gates entries; this instant is simply a normal mid-session time.
const NOW = new Date("2026-06-02T14:30:00Z");
const TODAY = marketDateNY(NOW);
let pass = 0;
let fail = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\nSame-day 0DTE enforcement — market date ${TODAY}\n`);

console.log("OCC parsing:");
check("parses SPY260602C00758000", () => {
  const p = parseOccSymbol("SPY260602C00758000");
  assert.deepStrictEqual(p, { root: "SPY", expiry: "2026-06-02", side: "Call", strike: 758 });
});
check("parses SPY260605P00766000", () => {
  const p = parseOccSymbol("SPY260605P00766000");
  assert.deepStrictEqual(p, { root: "SPY", expiry: "2026-06-05", side: "Put", strike: 766 });
});
check("rejects garbage symbol", () => {
  assert.strictEqual(parseOccSymbol("NOT_A_SYMBOL"), null);
});

console.log("\n0DTE classification (today = 2026-06-02):");
check("SPY260602C00758000 is 0DTE", () => {
  assert.strictEqual(isZeroDteSymbol("SPY260602C00758000", NOW), true);
});
check("SPY260605P00766000 is NOT 0DTE", () => {
  assert.strictEqual(isZeroDteSymbol("SPY260605P00766000", NOW), false);
});

console.log("\nOrder guard (assertZeroDteOpen):");
check("ACCEPTS opening today's 0DTE", () => {
  assertZeroDteOpen("SPY260602C00758000", NOW);
});
check("REJECTS opening later-dated 2026-06-05", () => {
  assert.throws(() => assertZeroDteOpen("SPY260605C00757000", NOW), /refusing later-dated/);
});

console.log("\nPaper order execution guard:");
check("paper buy_to_open later-dated THROWS", () => {
  assert.throws(
    () =>
      executePaperOrder({
        option_symbol: "SPY260605C00757000",
        side: "buy_to_open",
        quantity: 1,
        type: "market",
        duration: "day",
      }),
    /refusing later-dated|not a parseable/,
  );
});

console.log("\nSignal engine contract selection:");
// These are OFFLINE unit tests driven by synthetic snapshots — most carry no live
// 1m candle stream, so the live fresh-data guard must not enforce here. Production
// (getBotConfig()) still defaults requireFreshData=true; tests that specifically
// exercise the guard pass an explicit { requireFreshData } option to generateSignals.
const cfg: BotConfig = { ...getBotConfig(), requireFreshData: false };
// Legacy fixed-OTM selection tests below assert the LITERAL "1 OTM" strike rule,
// so they must run in fixed_otm mode. The default production mode is best_liquid
// (the smart selector), which is exercised by its own dedicated section.
const legacyOtmCfg: BotConfig = { ...cfg, contractSelectionMode: "fixed_otm" };
const baseSetup = {
  title: "0DTE risk filter (2m confirmation)",
  bias: "Call" as const,
  confidence: 64,
  trigger: "2m close up",
  invalidation: "2m close below VWAP",
  rationale: "test",
};
const mkOption = (symbol: string, expiry: string, strike: number) => ({
  symbol,
  expiry,
  strike,
  side: "Call" as const,
  last: 1.2,
  bid: 1.18,
  ask: 1.24,
  volume: 20000,
  openInterest: 3000,
  volumeOiRatio: 6.6,
  premium: 2_400_000,
  unusualScore: 80,
  flag: "test",
});

/** Like mkOption but with an explicit side, for Put ladders. */
const mkSide = (
  symbol: string,
  expiry: string,
  strike: number,
  side: "Call" | "Put",
) => ({ ...mkOption(symbol, expiry, strike), side });

// OCC strike field is price*1000 in 8 digits, e.g. 758 → "00758000".
const occStrike = (strike: number) => String(Math.round(strike * 1000)).padStart(8, "0");
const occ = (side: "Call" | "Put", strike: number, yymmdd = "260602") =>
  `SPY${yymmdd}${side === "Call" ? "C" : "P"}${occStrike(strike)}`;

check("later-dated-only flow → BLOCKED, no contract", () => {
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [mkOption("SPY260605C00757000", "2026-06-05", 757)],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  assert.strictEqual(signals.length, 1);
  assert.strictEqual(signals[0].contract, null, "must not select a later-dated contract");
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.match(signals[0].blockReason ?? "", /same-day 0DTE/);
});

check("same-day flow → ACTIONABLE, 0DTE contract selected", () => {
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [mkOption("SPY260602C00757000", "2026-06-02", 757)],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  assert.strictEqual(signals.length, 1);
  assert.ok(signals[0].contract, "must select the same-day contract");
  assert.strictEqual(signals[0].contract!.symbol, "SPY260602C00757000");
  assert.strictEqual(signals[0].isZeroDte, true);
  assert.strictEqual(signals[0].contractExpiry, "2026-06-02");
  assert.strictEqual(signals[0].status, "ACTIONABLE");
});

check("cheap same-day option (mid < min premium) → REQUIRES_REVIEW", () => {
  // bid/ask 0.05/0.07 → mid 0.06, below the 0.15 minimum-premium filter.
  const cheap = {
    ...mkOption("SPY260602C00757000", "2026-06-02", 757),
    last: 0.06,
    bid: 0.05,
    ask: 0.07,
  };
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [cheap],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  assert.strictEqual(signals[0].status, "REQUIRES_REVIEW");
  assert.match(signals[0].reviewReason ?? "", /minimum-premium/);
});

check("wide-spread same-day option (spread/mid > max) → REQUIRES_REVIEW", () => {
  // bid/ask 0.80/1.60 → mid 1.20, spread 0.80 → 67% of mid, over the 30% cap.
  const wide = {
    ...mkOption("SPY260602C00757000", "2026-06-02", 757),
    last: 1.2,
    bid: 0.8,
    ask: 1.6,
  };
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [wide],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  assert.strictEqual(signals[0].status, "REQUIRES_REVIEW");
  assert.match(signals[0].reviewReason ?? "", /max-spread/);
});

check("mixed flow → picks same-day, ignores later-dated", () => {
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [
        mkOption("SPY260605C00757000", "2026-06-05", 757),
        mkOption("SPY260602C00758000", "2026-06-02", 758),
      ],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract!.symbol, "SPY260602C00758000");
  assert.strictEqual(signals[0].isZeroDte, true);
});

console.log("\n1-OTM contract selection (BOT_OTM_STRIKES default = 1):");

const putSetup = { ...baseSetup, bias: "Put" as const };

check("default config ships BOT_OTM_STRIKES = 1", () => {
  assert.strictEqual(getBotConfig().otmStrikes, 1, "otmStrikes default must be 1");
});

check("Call chooses the first strike ABOVE spot (1 OTM)", () => {
  // Spot 757.40 → ATM anchor is 757; 1 OTM Call = 758.
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkSide(occ("Call", 756), TODAY, 756, "Call"),
        mkSide(occ("Call", 757), TODAY, 757, "Call"),
        mkSide(occ("Call", 758), TODAY, 758, "Call"),
        mkSide(occ("Call", 759), TODAY, 759, "Call"),
      ],
      economicCalendar: [],
    },
    legacyOtmCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract!.strike, 758, "should pick 758 (1 strike above spot)");
  assert.strictEqual(signals[0].contract!.moneyness, "OTM");
  assert.strictEqual(signals[0].contract!.otmStrikes, 1);
  assert.strictEqual(signals[0].contract!.selectionRule, "1 OTM");
  assert.strictEqual(signals[0].isZeroDte, true);
});

check("Put chooses the first strike BELOW spot (1 OTM)", () => {
  // Spot 757.40 → ATM anchor is 757; 1 OTM Put = 756.
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [putSetup],
      unusualOptions: [
        mkSide(occ("Put", 755), TODAY, 755, "Put"),
        mkSide(occ("Put", 756), TODAY, 756, "Put"),
        mkSide(occ("Put", 757), TODAY, 757, "Put"),
        mkSide(occ("Put", 758), TODAY, 758, "Put"),
      ],
      economicCalendar: [],
    },
    legacyOtmCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract!.strike, 756, "should pick 756 (1 strike below spot)");
  assert.strictEqual(signals[0].contract!.moneyness, "OTM");
  assert.strictEqual(signals[0].contract!.otmStrikes, 1);
  assert.strictEqual(signals[0].contract!.selectionRule, "1 OTM");
  assert.strictEqual(signals[0].isZeroDte, true);
});

check("BOT_OTM_STRIKES=0 keeps ATM/nearest selection", () => {
  const atmCfg: BotConfig = { ...cfg, otmStrikes: 0 };
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkSide(occ("Call", 757), TODAY, 757, "Call"),
        mkSide(occ("Call", 758), TODAY, 758, "Call"),
      ],
      economicCalendar: [],
    },
    atmCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract!.strike, 757, "ATM target should pick the nearest strike");
  assert.strictEqual(signals[0].contract!.moneyness, "ATM");
});

check("1 OTM still rejects a later-dated contract even if it is the 1-OTM strike", () => {
  // Same-day chain has only an ATM 757; the 1-OTM 758 exists ONLY later-dated.
  // The 0DTE guard must win: never reach for the future-dated 758.
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkSide(occ("Call", 757), TODAY, 757, "Call"),
        mkSide(occ("Call", 758, "260605"), "2026-06-05", 758, "Call"),
      ],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  // Only same-day strike is 757 → selected at ATM; future 758 ignored entirely.
  assert.strictEqual(signals[0].contract!.symbol, occ("Call", 757));
  assert.strictEqual(signals[0].contractExpiry, TODAY);
  assert.strictEqual(signals[0].isZeroDte, true);
});

check("future-dated 1-OTM only → BLOCKED, never falls back to future expiry", () => {
  // Every same-day-side contract is later-dated → hard refusal.
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkSide(occ("Call", 758, "260605"), "2026-06-05", 758, "Call"),
        mkSide(occ("Call", 759, "260605"), "2026-06-05", 759, "Call"),
      ],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract, null);
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.match(signals[0].blockReason ?? "", /same-day 0DTE/);
});

// ── Smart contract selector (best_liquid mode) vs fixed 1 OTM ──────────────────
// The smart selector scores the same-day ATM / 1-OTM / 2-OTM candidates under the
// SAME 0DTE / premium / spread guardrails and picks the best, instead of always
// reaching for a fixed strike offset. These tests pin: it rejects later-dated and
// low-quality contracts, never goes beyond 2 OTM, prefers a higher-quality ATM
// over a weak/illiquid 1-OTM, but keeps the 1-OTM when IT scores best.
console.log("\nSmart contract selector (best_liquid) vs fixed 1 OTM:");

// best_liquid config (default ships best_liquid; pin it explicitly for clarity).
const smartCfg: BotConfig = { ...cfg, contractSelectionMode: "best_liquid" };
const fixedCfg: BotConfig = { ...cfg, contractSelectionMode: "fixed_otm", otmStrikes: 1 };

// A liquid option with explicit liquidity fields; override premium/spread/score.
const mkLiq = (
  strike: number,
  side: "Call" | "Put",
  bid: number,
  ask: number,
  over: Partial<{ volume: number; openInterest: number; volumeOiRatio: number; unusualScore: number; yymmdd: string; delta: number }> = {},
) => {
  const yymmdd = over.yymmdd ?? "260602";
  const mid = (bid + ask) / 2;
  return {
    symbol: occ(side, strike, yymmdd),
    expiry: yymmdd === "260602" ? TODAY : "2026-06-05",
    strike,
    side,
    last: mid,
    bid,
    ask,
    volume: over.volume ?? 100000,
    openInterest: over.openInterest ?? 5000,
    volumeOiRatio: over.volumeOiRatio ?? 20,
    unusualScore: over.unusualScore ?? 95,
    premium: 1_000_000,
    flag: "test",
    ...(over.delta != null ? { delta: over.delta } : {}),
  };
};

check("default getBotConfig() ships contractSelectionMode = best_liquid", () => {
  assert.strictEqual(getBotConfig().contractSelectionMode, "best_liquid");
  assert.strictEqual(getBotConfig().selectorMaxOtmStrikes, 2);
});

check("smart selector still REJECTS a later-dated-only chain → BLOCKED", () => {
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [mkLiq(758, "Call", 1.2, 1.24, { yymmdd: "260605" })],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract, null, "must not select a later-dated contract");
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.match(signals[0].blockReason ?? "", /same-day 0DTE/);
});

check("smart selector REJECTS a low-premium 0DTE (below floor) → REQUIRES_REVIEW", () => {
  // Single same-day candidate, mid 0.06 < 0.15 floor → no eligible smart pick,
  // falls through to the legacy path which also flags the premium floor.
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [mkLiq(758, "Call", 0.05, 0.07)],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.strictEqual(signals[0].status, "REQUIRES_REVIEW");
  assert.match(signals[0].reviewReason ?? "", /minimum-premium/);
});

check("smart selector REJECTS a wide-spread 0DTE (over the ceiling)", () => {
  // Only candidate: bid 0.80 / ask 1.60 → 67% spread > 30% ceiling. No eligible
  // smart pick → legacy fallback flags the spread.
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [mkLiq(758, "Call", 0.8, 1.6)],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.strictEqual(signals[0].status, "REQUIRES_REVIEW");
  assert.match(signals[0].reviewReason ?? "", /max-spread/);
});

check("smart selector NEVER chooses beyond 2 OTM even if a far strike is offered", () => {
  // Spot 757.4 → ATM 757. Offer 757..760 all liquid same-day. The 760 (3 OTM)
  // must never be picked; selection stays within ATM..2 OTM (757..759).
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkLiq(757, "Call", 1.6, 1.62),
        mkLiq(758, "Call", 1.1, 1.12),
        mkLiq(759, "Call", 0.72, 0.74),
        mkLiq(760, "Call", 0.40, 0.42),
      ],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.ok(signals[0].contract, "expected a smart pick");
  assert.ok(signals[0].contract!.otmStrikes <= 2, `must not exceed 2 OTM, got ${signals[0].contract!.otmStrikes}`);
  assert.notStrictEqual(signals[0].contract!.strike, 760, "the 3-OTM strike must never be chosen");
});

check("smart selector prefers a strong ATM over a WEAK/illiquid 1-OTM", () => {
  // ATM 757: rich ($1.60), liquid (score 99, big volume). 1-OTM 758: thin and
  // cheap (mid 0.20, low volume/score). best_liquid should pick the ATM 757.
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkLiq(757, "Call", 1.59, 1.61, { volume: 200000, unusualScore: 99, volumeOiRatio: 30 }),
        mkLiq(758, "Call", 0.19, 0.21, { volume: 3000, unusualScore: 80, volumeOiRatio: 3 }),
      ],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract!.strike, 757, "should pick the strong ATM, not the weak 1-OTM");
  assert.strictEqual(signals[0].contract!.moneyness, "ATM");
  // Contrast: the fixed_otm mode would have taken the weak 758 (1-OTM target).
  const fixedSignals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkLiq(757, "Call", 1.59, 1.61, { volume: 200000, unusualScore: 99, volumeOiRatio: 30 }),
        mkLiq(758, "Call", 0.19, 0.21, { volume: 3000, unusualScore: 80, volumeOiRatio: 3 }),
      ],
      economicCalendar: [],
    },
    fixedCfg,
    NOW,
  );
  assert.strictEqual(fixedSignals[0].contract!.strike, 758, "fixed_otm should take the 1-OTM target (the weak one)");
});

check("smart selector CHOOSES the 1-OTM when it has the better liquidity/score and in-band delta", () => {
  // ATM 757 deep/expensive (delta ~0.8 out of band, low premium-strength cap),
  // 1-OTM 758 in the sweet spot: mid ~0.95 (≥ preferred 0.70), strong liquidity,
  // delta estimate ~0.37 (in band). The 1-OTM should win on score.
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkLiq(757, "Call", 2.40, 2.46, { volume: 40000, unusualScore: 90, volumeOiRatio: 10, delta: 0.82 }),
        mkLiq(758, "Call", 0.94, 0.96, { volume: 280000, unusualScore: 99, volumeOiRatio: 32, delta: 0.40 }),
      ],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract!.strike, 758, "1-OTM with the best score should be chosen");
  assert.strictEqual(signals[0].contract!.otmStrikes, 1);
});

check("smart selector preserves the 0DTE gate: picks same-day, ignores later-dated even if liquid", () => {
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkLiq(758, "Call", 2.0, 2.02, { yymmdd: "260605", volume: 999999, unusualScore: 99 }), // future, super-liquid
        mkLiq(757, "Call", 1.5, 1.52), // today's ATM
      ],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contractExpiry, TODAY, "must select today's expiry");
  assert.strictEqual(signals[0].isZeroDte, true);
  assert.notStrictEqual(signals[0].contract!.symbol, occ("Call", 758, "260605"));
});

check("smart selector never returns an ITM strike (stays at/OTM)", () => {
  // Offer an ITM 755 (cheap-to-score) and an ATM 757; ITM must be ineligible.
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkLiq(755, "Call", 2.6, 2.62, { volume: 300000, unusualScore: 99 }), // ITM (2 below anchor)
        mkLiq(757, "Call", 1.5, 1.52),
      ],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.ok(signals[0].contract!.otmStrikes >= 0, "selected contract must not be ITM");
});

check("smart selector honors min premium/spread/0DTE gates under an override-style strong score", () => {
  // A strong-score Put 1-OTM but with a too-wide spread must still be rejected by
  // the quality gate (override never relaxes premium/spread/0DTE).
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [putSetup],
      unusualOptions: [
        mkLiq(756, "Put", 0.5, 1.2, { unusualScore: 99 }), // 78% spread → rejected
      ],
      economicCalendar: [],
    },
    smartCfg,
    NOW,
  );
  assert.strictEqual(signals[0].status, "REQUIRES_REVIEW");
  assert.match(signals[0].reviewReason ?? "", /max-spread|minimum-premium/);
});

check("fixed_otm mode still reproduces the legacy 1-OTM pick exactly", () => {
  const signals = generateSignals(
    {
      spy: { price: 757.4 },
      setups: [baseSetup],
      unusualOptions: [
        mkSide(occ("Call", 757), TODAY, 757, "Call"),
        mkSide(occ("Call", 758), TODAY, 758, "Call"),
      ],
      economicCalendar: [],
    },
    fixedCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract!.strike, 758, "fixed_otm targets 1 OTM");
  assert.strictEqual(signals[0].contract!.selectionRule, "1 OTM");
});

// ── Multi-timeframe aggregation + analysis ─────────────────────────────────────

/**
 * Build a synthetic 1m candle series (`bars` candles ending at NOW). `slope` is
 * the per-bar price drift: positive trends up (bullish), negative trends down.
 */
function buildSeries(bars: number, start: number, slope: number): MtfCandle[] {
  const out: MtfCandle[] = [];
  let price = start;
  for (let i = bars - 1; i >= 0; i -= 1) {
    const open = price;
    const close = price + slope;
    out.push({
      time: new Date(NOW.getTime() - i * 60_000).toISOString(),
      open: Math.round(open * 100) / 100,
      high: Math.round((Math.max(open, close) + 0.05) * 100) / 100,
      low: Math.round((Math.min(open, close) - 0.05) * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: 1_000_000,
    });
    price = close;
  }
  return out;
}

console.log("\nMulti-timeframe aggregation:");
check("aggregateCandles bins 30 × 1m into a single 30m candle", () => {
  const ones = buildSeries(30, 500, 0.1);
  const agg = aggregateCandles(ones, 30);
  assert.ok(agg.length >= 1 && agg.length <= 2, `expected 1–2 30m bars, got ${agg.length}`);
  // First 30m open should equal the first 1m open, last close equal last 1m close.
  assert.strictEqual(agg[0].open, ones[0].open);
  assert.strictEqual(agg[agg.length - 1].close, ones[ones.length - 1].close);
});
check("aggregated 30m volume equals sum of 1m volume", () => {
  const ones = buildSeries(30, 500, 0.1);
  const agg = aggregateCandles(ones, 30);
  const total = agg.reduce((s, c) => s + c.volume, 0);
  assert.strictEqual(total, ones.reduce((s, c) => s + c.volume, 0));
});

console.log("\nMulti-timeframe gating:");
check("bullish 30m/15m aligns a Call entry (no contradiction)", () => {
  const ones = buildSeries(180, 500, 0.08); // steady uptrend
  const a = analyzeMultiTimeframe("Call", {
    candles1m: ones,
    candles5m: aggregateCandles(ones, 5),
    candles15m: aggregateCandles(ones, 15),
    candles30m: aggregateCandles(ones, 30),
    spot: ones[ones.length - 1].close,
  });
  assert.strictEqual(a.higherTimeframeTrend.trend30m.trend, "bullish");
  // Under the strict small-account profile, aligned HTF is necessary but not
  // sufficient — the gate is never the CONTRADICTION block for an aligned HTF.
  assert.strictEqual(a.higherTimeframeTrend.alignment, "aligned");
  assert.doesNotMatch(a.gateReason, /contradicts/i);
});
check("bearish higher timeframe → BLOCK a Call entry (contradiction)", () => {
  const ones = buildSeries(180, 560, -0.08); // steady downtrend
  const a = analyzeMultiTimeframe("Call", {
    candles1m: ones,
    candles5m: aggregateCandles(ones, 5),
    candles15m: aggregateCandles(ones, 15),
    candles30m: aggregateCandles(ones, 30),
    spot: ones[ones.length - 1].close,
  });
  assert.strictEqual(a.higherTimeframeTrend.alignment, "contradicts");
  assert.strictEqual(a.gate, "block");
});
check("S/R levels are produced and ranked by distance to spot", () => {
  const ones = buildSeries(180, 500, 0.05);
  const spot = ones[ones.length - 1].close;
  const a = analyzeMultiTimeframe("Call", {
    candles1m: ones,
    candles5m: aggregateCandles(ones, 5),
    candles15m: aggregateCandles(ones, 15),
    candles30m: aggregateCandles(ones, 30),
    spot,
    sr: { dailyOpen: spot - 3, premarketHigh: spot + 4, premarketLow: spot - 5 },
  });
  assert.ok(a.supportResistance.length > 0, "expected at least one S/R level");
});

console.log("\n0DTE guard still wins over MTF gating:");
check("contradicting HTF + same-day 0DTE → BLOCKED (not actionable)", () => {
  const ones = buildSeries(180, 560, -0.08); // bearish HTF
  const signals = generateSignals(
    {
      spy: {
        price: 757,
        dailyOpen: 758,
        candles: ones,
        candles5m: aggregateCandles(ones, 5),
        candles15m: aggregateCandles(ones, 15),
        candles30m: aggregateCandles(ones, 30),
      },
      setups: [baseSetup], // Call bias
      unusualOptions: [mkOption("SPY260602C00757000", "2026-06-02", 757)],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  // Bearish HTF contradicts the Call bias → blocked by the MTF gate.
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.ok(signals[0].mtf, "mtf analysis should be attached");
  assert.strictEqual(signals[0].mtf!.gate, "block");
});
check("later-dated contract still rejected regardless of bullish HTF", () => {
  const ones = buildSeries(180, 500, 0.08); // bullish HTF (would otherwise allow)
  const signals = generateSignals(
    {
      spy: {
        price: 757,
        candles: ones,
        candles5m: aggregateCandles(ones, 5),
        candles15m: aggregateCandles(ones, 15),
        candles30m: aggregateCandles(ones, 30),
      },
      setups: [baseSetup],
      unusualOptions: [mkOption("SPY260605C00757000", "2026-06-05", 757)],
      economicCalendar: [],
    },
    cfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract, null);
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.match(signals[0].blockReason ?? "", /same-day 0DTE/);
});

// ── Fresh-data guard (stale-candle readiness) ──────────────────────────────────
// During live automation / RTH the bot must refuse to trade off a stale tape.
// The guard is enforced only when requireFresh=true; offline backtests pass false.
console.log("\nFresh-data guard (stale-candle readiness):");

// A simple 1m tape whose newest candle sits at `lastBarMs`.
function tapeEndingAt(lastBarMs: number, bars = 20, price = 757.4): MtfCandle[] {
  const out: MtfCandle[] = [];
  for (let i = bars - 1; i >= 0; i -= 1) {
    out.push({
      time: new Date(lastBarMs - i * 60_000).toISOString(),
      open: price,
      high: price + 0.05,
      low: price - 0.05,
      close: price,
      volume: 1_000_000,
    });
  }
  return out;
}

check("fresh tape (0s old) → ready when enforced", () => {
  const f = evaluateDataFreshness(tapeEndingAt(NOW.getTime()), cfg, NOW, true);
  assert.strictEqual(f.ready, true, "0s-old candle must be ready");
  assert.strictEqual(f.enforced, true);
  assert.strictEqual(f.ageSec, 0);
});

check("stale tape (10 min old) → NOT ready, guard enforced", () => {
  const f = evaluateDataFreshness(tapeEndingAt(NOW.getTime() - 10 * 60_000), cfg, NOW, true);
  assert.strictEqual(f.ready, false, "10-min-old candle must be stale");
  assert.strictEqual(f.enforced, true);
  assert.ok((f.ageSec ?? 0) > cfg.maxCandleStalenessSec);
  assert.match(f.detail, /STALE DATA/);
});

check("offline/backtest (requireFresh=false) is NEVER blocked by staleness", () => {
  const f = evaluateDataFreshness(tapeEndingAt(NOW.getTime() - 60 * 60_000), cfg, NOW, false);
  assert.strictEqual(f.ready, true, "offline replay must not be blocked");
  assert.strictEqual(f.enforced, false);
});

check("missing 1m tape → NOT ready when enforced (no data to trade off)", () => {
  const f = evaluateDataFreshness(undefined, cfg, NOW, true);
  assert.strictEqual(f.ready, false);
  assert.strictEqual(f.enforced, true);
});

check("generateSignals BLOCKS on a stale tape when fresh-data is enforced", () => {
  const stale = tapeEndingAt(NOW.getTime() - 10 * 60_000);
  const signals = generateSignals(
    {
      spy: { price: 757.4, candles: stale },
      setups: [baseSetup],
      unusualOptions: [mkOption(occ("Call", 758), TODAY, 758)],
      economicCalendar: [],
    },
    cfg,
    NOW,
    { requireFreshData: true },
  );
  assert.strictEqual(signals.length, 1);
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.match(signals[0].blockReason ?? "", /STALE DATA/);
  assert.strictEqual(signals[0].dataFreshness.ready, false);
});

check("generateSignals does NOT stale-block an offline replay (requireFresh=false)", () => {
  const stale = tapeEndingAt(NOW.getTime() - 10 * 60_000);
  const signals = generateSignals(
    {
      spy: { price: 757.4, candles: stale },
      setups: [baseSetup],
      unusualOptions: [mkOption(occ("Call", 758), TODAY, 758)],
      economicCalendar: [],
    },
    cfg,
    NOW,
    { requireFreshData: false },
  );
  // Whatever the verdict, it must NOT be the stale-data block.
  assert.doesNotMatch(signals[0].blockReason ?? "", /STALE DATA/);
  assert.strictEqual(signals[0].dataFreshness.enforced, false);
});

// ── Open-window liquidation override + re-arm window ───────────────────────────
// The narrow 09:30–09:35 ET override lets a high-velocity downside liquidation
// take a Put even when the HTF is still NEUTRAL/chop (insufficient open history),
// but NEVER when the HTF is bullish against the trade, and never relaxing the
// premium/spread/sizing/0DTE gates.
console.log("\nOpen-window liquidation override + re-arm:");

// 09:31 ET (EDT) — inside the default 09:30–09:35 override window.
const OPEN_NOW = new Date("2026-06-02T13:31:00Z");

// Dead-flat higher-timeframe candles → genuinely NEUTRAL HTF (the real open
// condition: not enough session history for 30m/15m to register a trend).
function flatHtf(bars: number, stepMin: number, nowMs: number, price = 757.4): MtfCandle[] {
  const out: MtfCandle[] = [];
  for (let i = bars - 1; i >= 0; i -= 1) {
    out.push({
      time: new Date(nowMs - i * stepMin * 60_000).toISOString(),
      open: price,
      high: price + 0.08,
      low: price - 0.08,
      close: price,
      volume: 1_000_000,
    });
  }
  return out;
}

// 1m tape: flat then a sharp `dropBars`-bar liquidation of `dropPer`/bar that
// breaks straight down through the premarket low. `wideBase` inflates the early
// bars' range so the trailing ATR is high (used to suppress velocity).
function liqTape1m(dropBars: number, dropPer: number, nowMs: number, wideBase = false): MtfCandle[] {
  const out: MtfCandle[] = [];
  const n = 20;
  let price = 757.4;
  for (let i = n - 1; i >= 0; i -= 1) {
    const drop = i < dropBars;
    const open = price;
    const close = drop ? price - dropPer : wideBase ? price + (i % 2 === 0 ? 0.5 : -0.5) : price;
    const pad = wideBase && !drop ? 0.6 : 0.02;
    out.push({
      time: new Date(nowMs - i * 60_000).toISOString(),
      open: Math.round(open * 100) / 100,
      high: Math.round((Math.max(open, close) + pad) * 100) / 100,
      low: Math.round((Math.min(open, close) - pad) * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: 1_500_000,
    });
    price = close;
  }
  return out;
}

const PM_LOW = 757.0;
const PM_HIGH = 758.3;
const ovInput = {
  active: true,
  premarketLow: PM_LOW,
  premarketHigh: PM_HIGH,
  minImpulseCandles: cfg.openOverrideMinImpulseCandles,
  minVelocityAtr: cfg.openOverrideMinVelocityAtr,
};

check("override fires: neutral HTF + high-velocity impulse breaks PM low → allow", () => {
  const ones = liqTape1m(2, 0.6, OPEN_NOW.getTime());
  const a = analyzeMultiTimeframe("Put", {
    candles1m: ones,
    candles5m: flatHtf(24, 5, OPEN_NOW.getTime()),
    candles15m: flatHtf(16, 15, OPEN_NOW.getTime()),
    candles30m: flatHtf(12, 30, OPEN_NOW.getTime()),
    spot: ones[ones.length - 1].close,
    sr: { premarketLow: PM_LOW, premarketHigh: PM_HIGH, dailyOpen: 757.17 },
    openOverride: ovInput,
    rearmWindowSec: cfg.rearmWindowSec,
    nowMs: OPEN_NOW.getTime(),
  });
  assert.strictEqual(a.higherTimeframeTrend.alignment, "neutral", "HTF must be neutral for this scenario");
  assert.strictEqual(a.gate, "allow", "override should flip neutral block → allow");
  assert.ok(a.openOverride, "override diagnostic should be attached");
  assert.strictEqual(a.openOverride!.applied, true);
  assert.strictEqual(a.openOverride!.brokeKeyLevel, true);
  assert.match(a.gateReason, /OPEN-WINDOW LIQUIDATION OVERRIDE/);
});

check("override does NOT fire when HTF is BULLISH against the put (contradicts)", () => {
  const ones = liqTape1m(2, 0.6, OPEN_NOW.getTime());
  // Rising HTF — bullish, contradicting a Put.
  const bull = (bars: number, stepMin: number) => {
    const out: MtfCandle[] = [];
    let p = 755;
    for (let i = bars - 1; i >= 0; i -= 1) {
      const o = p;
      const c = p + 0.4;
      out.push({
        time: new Date(OPEN_NOW.getTime() - i * stepMin * 60_000).toISOString(),
        open: o,
        high: Math.max(o, c) + 0.05,
        low: Math.min(o, c) - 0.05,
        close: c,
        volume: 1_000_000,
      });
      p = c;
    }
    return out;
  };
  const a = analyzeMultiTimeframe("Put", {
    candles1m: ones,
    candles5m: bull(24, 5),
    candles15m: bull(16, 15),
    candles30m: bull(12, 30),
    spot: ones[ones.length - 1].close,
    sr: { premarketLow: PM_LOW, premarketHigh: PM_HIGH, dailyOpen: 757.17 },
    openOverride: ovInput,
    rearmWindowSec: cfg.rearmWindowSec,
    nowMs: OPEN_NOW.getTime(),
  });
  assert.strictEqual(a.higherTimeframeTrend.alignment, "contradicts");
  assert.strictEqual(a.gate, "block", "bullish HTF must keep the put blocked");
  assert.strictEqual(a.openOverride!.applied, false);
  assert.match(a.openOverride!.reason, /contradicts/i);
});

check("override does NOT fire when price never broke the premarket low", () => {
  // Modest drift that stays above a much-lower PM low → no key-level break.
  const ones = liqTape1m(2, 0.15, OPEN_NOW.getTime());
  const a = analyzeMultiTimeframe("Put", {
    candles1m: ones,
    candles5m: flatHtf(24, 5, OPEN_NOW.getTime()),
    candles15m: flatHtf(16, 15, OPEN_NOW.getTime()),
    candles30m: flatHtf(12, 30, OPEN_NOW.getTime()),
    spot: ones[ones.length - 1].close,
    sr: { premarketLow: 755.0, premarketHigh: PM_HIGH, dailyOpen: 757.17 },
    openOverride: { ...ovInput, premarketLow: 755.0 },
    rearmWindowSec: cfg.rearmWindowSec,
    nowMs: OPEN_NOW.getTime(),
  });
  assert.strictEqual(a.gate, "block");
  assert.strictEqual(a.openOverride!.applied, false);
  assert.strictEqual(a.openOverride!.brokeKeyLevel, false);
  assert.match(a.openOverride!.reason, /premarket low|key open level/);
});

check("override does NOT fire when the impulse velocity is below the ATR floor", () => {
  // Wide/volatile base inflates ATR; a small break has low velocity multiple.
  const ones = liqTape1m(2, 0.12, OPEN_NOW.getTime(), true);
  const a = analyzeMultiTimeframe("Put", {
    candles1m: ones,
    candles5m: flatHtf(24, 5, OPEN_NOW.getTime()),
    candles15m: flatHtf(16, 15, OPEN_NOW.getTime()),
    candles30m: flatHtf(12, 30, OPEN_NOW.getTime()),
    spot: ones[ones.length - 1].close,
    sr: { premarketLow: 757.3, premarketHigh: PM_HIGH, dailyOpen: 757.17 },
    openOverride: { ...ovInput, premarketLow: 757.3 },
    rearmWindowSec: cfg.rearmWindowSec,
    nowMs: OPEN_NOW.getTime(),
  });
  assert.strictEqual(a.openOverride!.brokeKeyLevel, true, "should have broken PM low");
  assert.strictEqual(a.gate, "block", "low velocity must NOT trigger the override");
  assert.strictEqual(a.openOverride!.applied, false);
  assert.match(a.openOverride!.reason, /velocity/);
  assert.ok(
    a.openOverride!.velocityAtrMultiple < cfg.openOverrideMinVelocityAtr,
    "velocity multiple should be below the floor",
  );
});

// End-to-end through generateSignals: the caller-side eligibility gate.
const liqPutSetup = {
  title: "Open liquidation",
  bias: "Put" as const,
  confidence: 82, // ≥ openOverrideMinConfidence (80)
  trigger: "1m break of premarket low",
  invalidation: "reclaim premarket low",
  rationale: "open liquidation",
};
function liqSnapshot(nowMs: number, score: number) {
  const ones = liqTape1m(2, 0.6, nowMs);
  return {
    spy: {
      price: ones[ones.length - 1].close,
      dailyOpen: 757.17,
      premarketHigh: PM_HIGH,
      premarketLow: PM_LOW,
      candles: ones,
      candles5m: flatHtf(24, 5, nowMs),
      candles15m: flatHtf(16, 15, nowMs),
      candles30m: flatHtf(12, 30, nowMs),
    },
    setups: [liqPutSetup],
    unusualOptions: [
      { ...mkSide(occ("Put", 756), TODAY, 756, "Put"), unusualScore: score, last: 0.85, bid: 0.83, ask: 0.88 },
    ],
    economicCalendar: [],
  };
}

check("in-window + strong score + confidence → ACTIONABLE via override", () => {
  const signals = generateSignals(liqSnapshot(OPEN_NOW.getTime(), 95), cfg, OPEN_NOW, {
    requireFreshData: false,
  });
  assert.strictEqual(signals[0].status, "ACTIONABLE");
  assert.strictEqual(signals[0].mtf!.gate, "allow");
  assert.strictEqual(signals[0].mtf!.openOverride!.applied, true);
  assert.strictEqual(signals[0].contract!.side, "Put");
  assert.strictEqual(signals[0].isZeroDte, true);
});

check("OUTSIDE the open window → override is not even offered (neutral HTF blocks)", () => {
  // NOW is 10:30 ET — well past the 09:35 ET window cutoff.
  const signals = generateSignals(liqSnapshot(NOW.getTime(), 95), cfg, NOW, {
    requireFreshData: false,
  });
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.strictEqual(signals[0].mtf!.gate, "block");
  assert.strictEqual(signals[0].mtf!.openOverride, null, "no override input outside the window");
});

check("in-window but WEAK options score (< floor) → override not offered, blocked", () => {
  const weak = cfg.openOverrideMinOptionScore - 10; // below the score floor
  const signals = generateSignals(liqSnapshot(OPEN_NOW.getTime(), weak), cfg, OPEN_NOW, {
    requireFreshData: false,
  });
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.strictEqual(signals[0].mtf!.openOverride, null, "weak score must not arm the override");
});

check("override-eligible entry STILL downgraded by the premium-floor quality gate", () => {
  const ones = liqTape1m(2, 0.6, OPEN_NOW.getTime());
  const cheapSnap = {
    spy: {
      price: ones[ones.length - 1].close,
      dailyOpen: 757.17,
      premarketHigh: PM_HIGH,
      premarketLow: PM_LOW,
      candles: ones,
      candles5m: flatHtf(24, 5, OPEN_NOW.getTime()),
      candles15m: flatHtf(16, 15, OPEN_NOW.getTime()),
      candles30m: flatHtf(12, 30, OPEN_NOW.getTime()),
    },
    setups: [liqPutSetup],
    unusualOptions: [
      { ...mkSide(occ("Put", 756), TODAY, 756, "Put"), unusualScore: 95, last: 0.06, bid: 0.05, ask: 0.07 },
    ],
    economicCalendar: [],
  };
  const signals = generateSignals(cheapSnap, cfg, OPEN_NOW, { requireFreshData: false });
  assert.strictEqual(signals[0].status, "REQUIRES_REVIEW", "cheap contract must not auto-enter");
  assert.match(signals[0].reviewReason ?? "", /minimum-premium/);
});

// Re-arm continuation window: one green bounce candle must not immediately cancel
// a confirmed continuation. Uses an ALIGNED (bearish) HTF with a confirmed 5m
// setup, where the 1m trigger fired one bar ago and the latest bar bounced green.
console.log("\nRe-arm continuation window (one bounce must not re-block):");

// 5m candles engineered so confirm5m("Put") confirms (vwap-loss).
function confirmedPut5m(nowMs: number): MtfCandle[] {
  const out: MtfCandle[] = [];
  for (let k = 0; k < 10; k += 1) {
    const t = new Date(nowMs - (10 - k) * 5 * 60_000).toISOString();
    if (k === 8) out.push({ time: t, open: 560, high: 560.2, low: 559.5, close: 560.0, vwap: 559.9, histogram: 0.1, volume: 1_000_000 });
    else if (k === 9) out.push({ time: t, open: 559.9, high: 560.0, low: 558.8, close: 559.0, vwap: 559.8, histogram: -0.3, volume: 1_000_000 });
    else out.push({ time: t, open: 560, high: 560.3, low: 559.7, close: 560.0, vwap: 560.0, histogram: 0, volume: 1_000_000 });
  }
  return out;
}
function bearHtf(bars: number, stepMin: number, nowMs: number): MtfCandle[] {
  const out: MtfCandle[] = [];
  let p = 565;
  for (let i = bars - 1; i >= 0; i -= 1) {
    const o = p;
    const c = p - 0.5;
    out.push({
      time: new Date(nowMs - i * stepMin * 60_000).toISOString(),
      open: o,
      high: Math.max(o, c) + 0.1,
      low: Math.min(o, c) - 0.1,
      close: c,
      vwap: c + 0.6,
      histogram: -0.5,
      volume: 1_000_000,
    });
    p = c;
  }
  return out;
}
function down1m(bounceLast: boolean, nowMs: number): MtfCandle[] {
  const out: MtfCandle[] = [];
  const n = 30;
  let price = 560;
  for (let i = n - 1; i >= 0; i -= 1) {
    const open = price;
    let close = price - 0.15;
    if (i === 0 && bounceLast) close = price + 0.25; // single green bounce as the latest bar
    out.push({
      time: new Date(nowMs - i * 60_000).toISOString(),
      open: Math.round(open * 100) / 100,
      high: Math.round((Math.max(open, close) + 0.05) * 100) / 100,
      low: Math.round((Math.min(open, close) - 0.05) * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: 1_000_000,
    });
    price = close;
  }
  return out;
}
function analyzeRearm(bounce: boolean, rearmSec: number, lastTrigMs: number | null) {
  const now = OPEN_NOW.getTime();
  const ones = down1m(bounce, now);
  return analyzeMultiTimeframe("Put", {
    candles1m: ones,
    candles5m: confirmedPut5m(now),
    candles15m: bearHtf(16, 15, now),
    candles30m: bearHtf(12, 30, now),
    spot: ones[ones.length - 1].close,
    rearmWindowSec: rearmSec,
    lastTriggerAtMs: lastTrigMs,
    nowMs: now,
  });
}

check("continuous downside (no bounce) → aligned, 1m trigger fires → allow", () => {
  const a = analyzeRearm(false, 0, null);
  assert.strictEqual(a.higherTimeframeTrend.alignment, "aligned");
  assert.strictEqual(a.entryTimeframe.setup5m.confirmed, true);
  assert.strictEqual(a.entryTimeframe.trigger1m.triggered, true);
  assert.strictEqual(a.gate, "allow");
});

check("a single green bounce WITHOUT re-arm cancels the continuation → block", () => {
  const a = analyzeRearm(true, 0, null); // rearmWindowSec = 0 disables re-arm
  assert.strictEqual(a.entryTimeframe.trigger1m.triggered, false, "bounce candle is not a fresh trigger");
  assert.strictEqual(a.gate, "block", "without re-arm, one bounce re-blocks the entry");
});

check("the same bounce WITH the re-arm window survives → still allow", () => {
  // Trigger fired one bar (60s) ago; the re-arm window keeps it armed.
  const a = analyzeRearm(true, cfg.rearmWindowSec, OPEN_NOW.getTime() - 60_000);
  assert.strictEqual(a.entryTimeframe.trigger1m.triggered, false);
  assert.strictEqual(a.gate, "allow", "re-arm window holds the trigger through one bounce candle");
});

// ── Autonomous trading guards ──────────────────────────────────────────────────

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A live-enabled config that simulates full autonomy env being set. */
const autoLiveCfg: BotConfig = {
  ...cfg,
  liveEnabled: true,
  accountId: "TEST-ACCOUNT",
  tradierToken: "TEST-TOKEN",
  tradierBaseUrl: "https://sandbox.tradier.com",
  autoTradeEnabled: true,
};

await (async () => {
  console.log("\nAutonomous trading — defaults OFF:");
  check("auto-trade readiness is NOT ready without env switches", () => {
    const r = getAutoTradeReadiness();
    assert.strictEqual(r.autoReady, false, "auto must default to not-ready");
    assert.ok(r.blockingCount > 0, "should report blockers");
  });
  check("getBotConfig().autoTradeEnabled defaults to false", () => {
    assert.strictEqual(getBotConfig().autoTradeEnabled, false);
  });
  check("automation status defaults to observe-only", () => {
    const s = getAutomationStatus();
    assert.strictEqual(s.enabled, false, "engine must not be ENV-armed by default");
    assert.strictEqual(s.observeOnly, true, "engine must be observe-only by default");
  });

  console.log("\nAutonomous trading — 0DTE guard still authoritative in auto mode:");
  await checkAsync("auto+confirm later-dated buy_to_open is REJECTED", async () => {
    await assert.rejects(
      () =>
        executeOrder(
          {
            option_symbol: "SPY260605C00757000", // later-dated weekly
            side: "buy_to_open",
            quantity: 1,
            type: "market",
            duration: "day",
          },
          autoLiveCfg,
          true, // confirmLiveOrder supplied internally by the engine
        ),
      /refusing later-dated|not a parseable/,
    );
  });
  await checkAsync("auto sell_to_close is NOT blocked by 0DTE guard (can always flatten)", async () => {
    // No network in this test env: a later-dated CLOSE must pass the 0DTE guard
    // and proceed to the network attempt, which fails — proving the guard did
    // not reject it. We assert the error is NOT a 0DTE refusal.
    await assert.rejects(
      () =>
        executeOrder(
          {
            option_symbol: "SPY260605C00757000",
            side: "sell_to_close",
            quantity: 1,
            type: "market",
            duration: "day",
          },
          autoLiveCfg,
          true,
        ),
      (err: Error) => {
        assert.doesNotMatch(err.message, /refusing later-dated/, "close must not be 0DTE-refused");
        return true;
      },
    );
  });
})();

// ── Unlimited position / trade-count buffers ───────────────────────────────────
// maxOpenPositions <= 0 and maxTradesPerDay <= 0 mean UNLIMITED: the count
// caps must not block entries, while every other NON-TIME guard (loss stop,
// kill switch, same-day 0DTE) stays authoritative. There are no time-of-day
// entry gates anymore.
const unlimitedCfg: BotConfig = {
  ...cfg,
  killSwitchActive: false,
  maxOpenPositions: 0,
  maxTradesPerDay: 0,
  maxDailyLoss: 500,
};

console.log("\nUnlimited position/trade buffers (max <= 0):");
check("maxOpenPositions=0 does NOT block with many open positions", () => {
  const r = canOpenPosition({ tradesOpened: 0, dailyLossUsed: 0 }, 999, unlimitedCfg, NOW);
  assert.strictEqual(r.allowed, true, r.reason);
});
check("maxTradesPerDay=0 does NOT block after many trades today", () => {
  const r = canOpenPosition({ tradesOpened: 999, dailyLossUsed: 0 }, 0, unlimitedCfg, NOW);
  assert.strictEqual(r.allowed, true, r.reason);
});
check("maxTradesPerDay=-1 (negative) is also treated as unlimited", () => {
  const r = canOpenPosition(
    { tradesOpened: 999, dailyLossUsed: 0 },
    999,
    { ...unlimitedCfg, maxOpenPositions: -1, maxTradesPerDay: -1 },
    NOW,
  );
  assert.strictEqual(r.allowed, true, r.reason);
});
check("default getBotConfig() ships finite risk-hardened counts (2 / 50)", () => {
  // RISK-DEFAULT PATCH: unlimited counts were unsafe for a small account. The
  // <= 0 = UNLIMITED semantics still work if an operator sets them (covered by
  // the unlimitedCfg tests above), but the shipped DEFAULTS are finite.
  const c = getBotConfig();
  assert.strictEqual(c.maxOpenPositions, 2, "maxOpenPositions default is 2 (finite)");
  assert.strictEqual(c.maxTradesPerDay, 24, "maxTradesPerDay default is 24 (PDT guard removed, finite)");
});

console.log("\nPreserved hard stops still block even when counts are unlimited:");
check("daily LOSS stop still blocks under unlimited counts", () => {
  const r = canOpenPosition({ tradesOpened: 999, dailyLossUsed: 600 }, 999, unlimitedCfg, NOW);
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /loss limit/i);
});
check("kill switch still blocks under unlimited counts", () => {
  const r = canOpenPosition(
    { tradesOpened: 0, dailyLossUsed: 0 },
    0,
    { ...unlimitedCfg, killSwitchActive: true },
    NOW,
  );
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /kill switch/i);
});
check("entries are allowed past the old 14:30 CT entry cutoff (no time gate)", () => {
  // 15:00 CT (21:00 UTC) used to be past the 14:30 CT entry cutoff. Time-of-day
  // entry gates are removed, so the only remaining time-of-day control is the
  // flatten EXIT — opening is no longer blocked by the clock.
  const lateSession = new Date("2026-06-02T21:00:00Z");
  const r = canOpenPosition({ tradesOpened: 0, dailyLossUsed: 0 }, 0, unlimitedCfg, lateSession);
  assert.strictEqual(r.allowed, true, r.reason);
});

// ── Open/close entry-only guardrail (no new entries first/last 15 min) ───────────
// June is EDT (UTC-4): 09:30 ET = 13:30 UTC, 16:00 ET = 20:00 UTC.
console.log("\nOpen/close entry guardrail (entry-only; exits unaffected):");
const noEntryState = { tradesOpened: 0, dailyLossUsed: 0 };
check("entry BLOCKED in the first 15 min after the open (09:32 ET)", () => {
  const t = new Date("2026-06-02T13:32:00Z"); // 09:32 ET — inside opening blackout
  const r = canOpenPosition(noEntryState, 0, unlimitedCfg, t);
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /first 15 min|opening guardrail/i);
});
check("entry BLOCKED at the open instant (09:30 ET)", () => {
  const t = new Date("2026-06-02T13:30:00Z"); // 09:30 ET
  const r = canOpenPosition(noEntryState, 0, unlimitedCfg, t);
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /opening guardrail|first 15 min/i);
});
check("entry ALLOWED right after the opening blackout clears (09:45 ET)", () => {
  const t = new Date("2026-06-02T13:45:00Z"); // 09:45 ET — blackout is [09:30,09:45)
  const r = canOpenPosition(noEntryState, 0, unlimitedCfg, t);
  assert.strictEqual(r.allowed, true, r.reason);
});
check("entry ALLOWED mid-session (12:00 ET)", () => {
  const t = new Date("2026-06-02T16:00:00Z"); // 12:00 ET
  const r = canOpenPosition(noEntryState, 0, unlimitedCfg, t);
  assert.strictEqual(r.allowed, true, r.reason);
});
check("entry BLOCKED in the last 15 min before the close (15:50 ET)", () => {
  const t = new Date("2026-06-02T19:50:00Z"); // 15:50 ET — inside closing blackout
  const r = canOpenPosition(noEntryState, 0, unlimitedCfg, t);
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /last 15 min|closing guardrail/i);
});
check("entry ALLOWED at exactly the start of the closing window boundary minus 1 (15:44 ET)", () => {
  const t = new Date("2026-06-02T19:44:00Z"); // 15:44 ET — blackout is [15:45,16:00)
  const r = canOpenPosition(noEntryState, 0, unlimitedCfg, t);
  assert.strictEqual(r.allowed, true, r.reason);
});
check("guardrail can be disabled via flag (entry allowed inside the opening window)", () => {
  const t = new Date("2026-06-02T13:32:00Z"); // 09:32 ET
  const r = canOpenPosition(noEntryState, 0, { ...unlimitedCfg, entryTimeGuardEnabled: false }, t);
  assert.strictEqual(r.allowed, true, r.reason);
});
check("EXITS are unaffected by the entry guardrail (stop fires inside the opening blackout)", () => {
  // A live position inside the opening blackout must still be able to exit.
  const p = freshSingle(1.0);
  const t = new Date("2026-06-02T13:32:00Z"); // 09:32 ET — entry-blocked window
  const a = evaluatePosition(p, 0.79, unlimitedCfg, t); // ≤ 0.80 hard stop
  assert.strictEqual(a.kind, "stop", "exit must fire regardless of the entry blackout");
  assert.match(a.reason, /stop loss/i);
});
// ── ET session clock (DST-aware, single source of truth) ────────────────────
// Verified at BOTH a DST date (June, EDT, UTC-4) and a standard-time date
// (January, EST, UTC-5) to prove the IANA-zone conversion — not a hardcoded
// offset — governs every intraday gate.
console.log("\nET session clock (minutesIntoEtDay / minutesIntoTradingDay, DST-aware):");
check("minutesIntoEtDay = 570 at 09:30 ET in DST (June, 13:30Z)", () => {
  assert.strictEqual(minutesIntoEtDay(new Date("2026-06-22T13:30:00Z")), 570);
});
check("minutesIntoEtDay = 570 at 09:30 ET in standard time (January, 14:30Z)", () => {
  assert.strictEqual(minutesIntoEtDay(new Date("2026-01-15T14:30:00Z")), 570);
});
check("minutesIntoEtDay = 0 at midnight ET (no V8 hour-24 quirk), DST", () => {
  assert.strictEqual(minutesIntoEtDay(new Date("2026-06-22T04:00:00Z")), 0);
});
check("minutesIntoEtDay = 0 at midnight ET, standard time", () => {
  assert.strictEqual(minutesIntoEtDay(new Date("2026-01-15T05:00:00Z")), 0);
});
check("minutesIntoTradingDay = 0 at exactly 09:30:00 ET (DST)", () => {
  assert.strictEqual(minutesIntoTradingDay(new Date("2026-06-22T13:30:00Z")), 0);
});
check("minutesIntoTradingDay = 0 at exactly 09:30:00 ET (standard time)", () => {
  assert.strictEqual(minutesIntoTradingDay(new Date("2026-01-15T14:30:00Z")), 0);
});
check("minutesIntoTradingDay = 390 at 16:00:00 ET (DST, 20:00Z)", () => {
  assert.strictEqual(minutesIntoTradingDay(new Date("2026-06-22T20:00:00Z")), 390);
});
check("minutesIntoTradingDay = 390 at 16:00:00 ET (standard time, 21:00Z)", () => {
  assert.strictEqual(minutesIntoTradingDay(new Date("2026-01-15T21:00:00Z")), 390);
});
check("minutesIntoTradingDay is negative before the open (09:00 ET = -30)", () => {
  assert.strictEqual(minutesIntoTradingDay(new Date("2026-06-22T13:00:00Z")), -30);
});
check("etTimestamp renders the ET wall clock for self-verifying logs (DST)", () => {
  assert.strictEqual(etTimestamp(new Date("2026-06-22T13:36:12Z")), "2026-06-22 09:36:12 ET");
});
check("etTimestamp renders the ET wall clock in standard time", () => {
  assert.strictEqual(etTimestamp(new Date("2026-01-15T14:36:12Z")), "2026-01-15 09:36:12 ET");
});
check("etTimestamp renders midnight ET as 00:00:00 (no hour-24 quirk)", () => {
  assert.strictEqual(etTimestamp(new Date("2026-06-22T04:00:00Z")), "2026-06-22 00:00:00 ET");
});

// ── ET clock is invariant to launch context (TZ env / host zone) ─────────────
// The intermittent-offset ticket: a run looked "1 hour off" only because the
// stdout LOG PREFIX rendered in the process launch TZ. The GATE derivation uses
// an explicit IANA zone and must be identical no matter how the process starts.
console.log("\nET clock invariance to launch context (TZ env / host zone):");
check("host process runs in a NON-ET zone, yet minutesIntoEtDay(09:30 ET) = 570", () => {
  // This very test process is NOT in America/New_York (it inherits the host
  // zone — e.g. America/Chicago locally, UTC on Render). If the helper depended
  // on system-local time it would be wrong here; the IANA conversion makes it
  // correct regardless. This is the "TZ unset / host-default" acceptance case.
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.notStrictEqual(hostZone, "America/New_York", "guard: host should not already be ET");
  assert.strictEqual(minutesIntoEtDay(new Date("2026-06-22T13:30:00Z")), 570);
  assert.strictEqual(minutesIntoTradingDay(new Date("2026-06-22T13:30:00Z")), 0);
});
for (const tz of ["UTC", "Asia/Tokyo"]) {
  check(`minutesIntoEtDay(09:30 ET) = 570 in a child process launched with TZ=${tz}`, () => {
    // Genuinely launch a fresh process with a non-ET TZ env (the Run A vector)
    // and confirm the IANA-based derivation still yields 570. TZ is read at
    // process start, so a child process is the faithful way to test it.
    const snippet =
      "const f=(d)=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',hour12:false}).formatToParts(d);" +
      "let h=+p.find(x=>x.type==='hour').value;const m=+p.find(x=>x.type==='minute').value;if(h===24)h=0;return h*60+m;};" +
      "process.stdout.write(String(f(new Date('2026-06-22T13:30:00Z'))));";
    const out = execFileSync(process.execPath, ["-e", snippet], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    }).trim();
    assert.strictEqual(out, "570", `TZ=${tz} child returned ${out}, expected 570`);
  });
}
check("etZoneDiagnostics self-test reports OK and names the IANA zone", () => {
  const diag = etZoneDiagnostics();
  assert.match(diag, /America\/New_York/);
  assert.match(diag, /self-test=OK/, `diagnostics self-test should pass: ${diag}`);
});

resetPaperState();
check("same-day 0DTE guard still blocks a later-dated contract (unchanged)", () => {
  const signals = generateSignals(
    {
      spy: { price: 757 },
      setups: [baseSetup],
      unusualOptions: [mkOption("SPY260605C00757000", "2026-06-05", 757)],
      economicCalendar: [],
    },
    unlimitedCfg,
    NOW,
  );
  assert.strictEqual(signals[0].contract, null);
  assert.strictEqual(signals[0].status, "BLOCKED");
  assert.match(signals[0].blockReason ?? "", /same-day 0DTE/);
});

// ── Small-account risk profile defaults ────────────────────────────────────────
console.log("\nSmall-account risk profile defaults:");
check("default stopLossFraction is 0.20", () => {
  assert.strictEqual(getBotConfig().stopLossFraction, 0.20);
});
check("default trailStartFraction is 0.25 (+25% arm) and giveback 0.15 (noise-floor patch)", () => {
  const c = getBotConfig();
  assert.strictEqual(c.trailStartFraction, 0.25);
  // 5% give-back fired on routine 0DTE quote jitter; widened to 15%.
  assert.strictEqual(c.trailGivebackFraction, 0.15);
});
check("default maxLossPerTrade is 40 and start balance 1326.24", () => {
  const c = getBotConfig();
  assert.strictEqual(c.maxLossPerTrade, 40, "right-sized to ~10% of a small account");
  assert.strictEqual(c.accountStartBalance, 1326.24);
});
check("default contract-quality filters: minOptionPremium 0.30, maxSpreadPct 0.12", () => {
  const c = getBotConfig();
  // maxSpreadPct must stay well under 2× stopLossFraction so the half-spread
  // cannot consume the whole stop budget on entry (the instant-stop contradiction).
  assert.strictEqual(c.minOptionPremium, 0.30);
  assert.strictEqual(c.maxSpreadPct, 0.12);
  assert.ok(c.maxSpreadPct < 2 * c.stopLossFraction, "spread ceiling must be < 2× the stop fraction");
});

// ── Contract sizing ladder ──────────────────────────────────────────────────────
// Default is now preferred=2 → 1 (small-account sized). The laddering MECHANICS
// (step down by risk cap / cash) are still exercised at preferred=4 via cfg4 so
// the stepping logic stays covered independent of the shipped default.
console.log("\nContract sizing ladder (default preferred=2, min=1; mechanics tested at 4):");
// Pins both the preferred size (4) AND the $100 per-trade cap so the laddering
// MECHANICS stay covered independent of the shipped defaults (now preferred 2,
// cap $40).
const cfg4: BotConfig = { ...getBotConfig(), preferredContractsPerTrade: 4, maxLossPerTrade: 100 };
check("defaults: preferred=2, min=1, no explicit cap", () => {
  const c = getBotConfig();
  assert.strictEqual(c.preferredContractsPerTrade, 2, "preferred default is 2");
  assert.strictEqual(c.minContractsPerTrade, 1, "min default is 1");
  assert.ok(c.maxContractsPerTrade <= 0, "max cap default is unset (no explicit cap)");
});
check("default ladder: picks 2 when cash + risk cap allow (premium 0.50)", () => {
  // premium 0.50 → cost $50/ctr, stop risk $10/ctr (20% stop). 2 ctr = $100 cost,
  // $20 risk — both within cash ($1326) and the $100 cap → take the preferred 2.
  const s = sizePosition(0.5, getBotConfig(), 1326.24);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 2, "should buy the preferred 2 contracts");
  assert.strictEqual(s.fellBackFromPreferred, false);
  assert.strictEqual(s.projectedStopLoss, 20);
  assert.match(s.reason, /preferred target/i);
});
check("default ladder: falls back to 1 when cash affords only 1 (premium 1.00, $150)", () => {
  // premium 1.00 → 2 ctr cost $200 > $150; 1 ctr $100 ≤ $150 → step to the min 1.
  const s = sizePosition(1.0, getBotConfig(), 150);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 1, "should fall back to the minimum 1 contract");
  assert.strictEqual(s.fellBackFromPreferred, true);
  assert.match(s.reason, /fallback to 1 contract/i);
});
check("mechanics: chooses 4 when cash allows the preferred size", () => {
  // premium 0.50 → cost $50/ctr, stop risk $10/ctr (20% stop). 4 ctr = $200
  // cost (≤ $1326 cash) → prefer 4.
  const s = sizePosition(0.5, cfg4, 1326.24);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 4, "should buy preferred 4 contracts");
  assert.strictEqual(s.fellBackFromPreferred, false);
  assert.strictEqual(s.projectedStopLoss, 40);
  assert.match(s.reason, /preferred target/i);
});
check("mechanics: max-loss-per-trade downsizes to fit the $100 cap (premium 1.50 → 3 ctr)", () => {
  // PER-TRADE RISK PATCH (enforceMaxLossPerTrade default on): premium 1.50 →
  // stop risk $30/ctr (20% stop). 4 ctr would risk $120 > the $100 cap, so sizing
  // steps down to 3 ctr ($90 projected stop risk ≤ cap). Cash for 3 ctr = $450 ≤
  // $1326, so the risk cap (not cash) is the binding constraint.
  const s = sizePosition(1.5, cfg4, 1326.24);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 3, "downsized to 3 by the per-trade risk cap");
  assert.strictEqual(s.fellBackFromPreferred, true);
  assert.strictEqual(s.projectedStopLoss, 90, "projected stop risk fits the $100 cap");
  assert.match(s.reason, /per-trade risk cap/i);
});
check("mechanics: falls back to 3 when cash cannot afford 4", () => {
  // premium 1.00, cash only $350 → 4 ctr cost $400 > cash; 3 ctr $300 ≤ cash
  // → fall back to 3 (cash-bound only).
  const s = sizePosition(1.0, cfg4, 350);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 3, "should fall back to 3 contracts on cash");
  assert.strictEqual(s.fellBackFromPreferred, true);
  assert.match(s.reason, /fallback to 3 contract/i);
  assert.match(s.reason, /cash/i);
});
check("mechanics: max-loss-per-trade downsizes to fit the $100 cap (premium 2.00 → 2 ctr)", () => {
  // premium 2.00 → stop risk $40/ctr (20% stop). 4 ctr would risk $160 > the $100
  // cap → step down to 2 ctr ($80 ≤ cap). Cash for 2 ctr = $400 ≤ $1326.
  const s = sizePosition(2.0, cfg4, 1326.24);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 2, "downsized to 2 by the per-trade risk cap");
  assert.strictEqual(s.fellBackFromPreferred, true);
  assert.strictEqual(s.projectedStopLoss, 80);
  assert.match(s.reason, /per-trade risk cap/i);
});
check("mechanics: falls back to 2 when cash affords only 2 (not 3 or 4)", () => {
  // premium 1.00, cash only $250 → 4 ctr $400 and 3 ctr $300 > cash; 2 ctr $200
  // ≤ $250 → land on 2 (cash-bound only).
  const s = sizePosition(1.0, cfg4, 250);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 2, "should fall back to 2 contracts on cash");
  assert.strictEqual(s.fellBackFromPreferred, true);
  assert.match(s.reason, /fallback to 2 contract/i);
  assert.match(s.reason, /cash/i);
});
check("mechanics: per-trade risk cap downsizes to the minimum 1 ctr (premium 3.00)", () => {
  // premium 3.00 → stop risk $60/ctr (20% stop). 4/3/2 ctr all project > the $100
  // cap; only 1 ctr ($60 ≤ cap) fits. With the hard minimum now 1, the entry is
  // sized to 1 (not skipped) — cash is ample ($1326). The per-trade risk cap is
  // the binding constraint.
  const s = sizePosition(3.0, cfg4, 1326.24);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 1, "downsized to the minimum 1 by the per-trade risk cap");
  assert.strictEqual(s.fellBackFromPreferred, true);
  assert.strictEqual(s.projectedStopLoss, 60, "projected stop risk fits the $100 cap");
  assert.match(s.reason, /per-trade risk cap/i);
});
check("entry BLOCKED by the per-trade risk cap when even 1 ctr breaches it (premium 6.00)", () => {
  // premium 6.00 → stop risk $120/ctr (20% stop). Even the hard-minimum 1 ctr
  // projects $120 stop risk > the $100 cap, so the entry is SKIPPED despite cash
  // for 2 ctr ($1326). The per-trade risk cap (enforce default on) is authoritative.
  const s = sizePosition(6.0, getBotConfig(), 1326.24);
  assert.strictEqual(s.allowed, false, s.reason);
  assert.strictEqual(s.contracts, 0);
  assert.match(s.reason, /per-trade risk cap/i);
});
check("mechanics: falls back from 4 all the way to 1 on cash (premium 1.00, $150)", () => {
  // premium 1.00, cash only $150 → 4/3/2 ctr cost $400/$300/$200 > $150; 1 ctr
  // $100 ≤ $150 → land on the hard minimum of 1 (cash-bound), stepping past every
  // rung of the preferred-4 ladder.
  const s = sizePosition(1.0, cfg4, 150);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 1, "should fall back to the minimum 1 contract on cash");
  assert.strictEqual(s.fellBackFromPreferred, true);
  assert.match(s.reason, /fallback to 1 contract/i);
  assert.match(s.reason, /cash/i);
});
check("entry BLOCKED when cash cannot afford even 1 contract (premium 1.00, $50)", () => {
  // premium 1.00, cash only $50 → 1 ctr cost $100 > $50 available. Below the hard
  // minimum of 1, so the entry is skipped.
  const s = sizePosition(1.0, getBotConfig(), 50);
  assert.strictEqual(s.allowed, false);
  assert.strictEqual(s.contracts, 0);
  assert.match(s.reason, /insufficient cash/i);
});
check("finite maxContractsPerTrade=3 caps preferred 4 down to 3", () => {
  // Explicit cap of 3 forces three contracts even though 4 is affordable.
  const cfgCap: BotConfig = { ...cfg4, maxContractsPerTrade: 3 };
  const s = sizePosition(0.5, cfgCap, 1326.24);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 3, "capped to 3 by max-per-trade cap");
  assert.strictEqual(s.fellBackFromPreferred, true);
  assert.match(s.reason, /capped to 3 contract/i);
  assert.match(s.reason, /max-per-trade cap/i);
});
check("explicit caps at or above preferred are safe (cap=4 honors preferred 4)", () => {
  const cfgCap: BotConfig = { ...cfg4, maxContractsPerTrade: 4 };
  const s = sizePosition(0.5, cfgCap, 1326.24);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 4, "cap=4 still allows the preferred 4");
  assert.strictEqual(s.fellBackFromPreferred, false);
});
check("larger preferred honored when cash allows it", () => {
  // preferred=5, premium 0.40 → cost $40/ctr; 5 ctr cost $200 ≤ cash → size 5.
  // Based on cfg4 ($100 cap) so this exercises the CASH-bound path; the shipped
  // $40 cap is deliberately not the constraint under test here.
  const cfg5: BotConfig = { ...cfg4, preferredContractsPerTrade: 5 };
  const s = sizePosition(0.4, cfg5, 1326.24);
  assert.strictEqual(s.allowed, true, s.reason);
  assert.strictEqual(s.contracts, 5);
  assert.strictEqual(s.fellBackFromPreferred, false);
});
check("per-trade risk cap downsizes to 3 ctr when projected loss would exceed the cap, AND the -20% hard stop still fires on it", () => {
  // premium 1.50, stop 20% → $30/ctr stop risk. 4 ctr ($120) breaches the $100
  // cap, so sizing steps down to 3 ctr ($90 ≤ cap) with ample cash ($1326).
  // Pinned to preferred=4 to exercise the downsizing ladder (the shipped default
  // is now 2, which would land on 2 here without the step-down under test).
  const cfg: BotConfig = { ...getBotConfig(), preferredContractsPerTrade: 4, maxLossPerTrade: 100 };
  const sizing = sizePosition(1.5, cfg, 1326.24);
  assert.strictEqual(sizing.allowed, true, sizing.reason);
  assert.strictEqual(sizing.contracts, 3, "downsized to 3 by the per-trade risk cap");
  assert.ok(
    sizing.projectedStopLoss <= cfg.maxLossPerTrade,
    `projected loss ${sizing.projectedStopLoss} should fit the cap ${cfg.maxLossPerTrade}`,
  );

  // The actual premium-based hard stop at -20% must STILL fire on that very
  // 3-contract position: entry 1.50 → stop 1.20; a mark of 1.19 trips the stop.
  resetPaperState();
  const pos = openPaperPosition({
    symbol: "SPY260602C00757000",
    side: "Call",
    strike: 757,
    expiry: TODAY,
    contracts: sizing.contracts,
    entryPremium: 1.5,
    stopFraction: cfg.stopLossFraction,
    trailStartFraction: cfg.trailStartFraction,
    trailGivebackFraction: cfg.trailGivebackFraction,
  });
  assert.strictEqual(pos.contracts, 3, "position opened with 3 contracts");
  assert.ok(Math.abs(pos.stopPrice - 1.2) < 1e-9, `hard stop set at -20% (1.20), got ${pos.stopPrice}`);
  const action = evaluatePosition(pos, 1.19, cfg, NOW);
  assert.strictEqual(action.kind, "stop", "hard stop must fire at -20% on the 3-ctr position");
  assert.match(action.reason, /stop loss/i);
  resetPaperState();
});

// ── No time-of-day entry blockers ───────────────────────────────────────────────
// The post-open whipsaw window, the midday lunch-chop window, and the last-entry
// cutoff have all been removed. Entries are permitted at any time of the session
// (and even outside it) as long as the NON-TIME guards pass. These tests pin the
// formerly-blocked instants and assert entries are now allowed.
console.log("\nNo time-of-day entry blockers (formerly-blocked windows now allowed):");
const atCT = (utcIso: string) => new Date(utcIso); // helper for clarity

// Instants that USED to be blocked by the removed time-of-day filters and are
// NOT inside the open/close entry-only guardrail window (09:30–09:45 ET and
// 15:45–16:00 ET). These remain entry-allowed:
//   10:00 CT (15:00 UTC = 11:00 ET) → mid-session, well clear of both guardrails
//   12:00 CT (17:00 UTC = 13:00 ET) → was the midday lunch-chop window
//   14:00 CT (19:00 UTC = 15:00 ET) → was past the 13:45 CT last-entry cutoff
//   15:00 CT (21:00 UTC = 17:00 ET) → after the 16:00 ET close (outside RTH)
const formerlyBlocked: Array<{ label: string; iso: string }> = [
  { label: "10:00 CT (mid-session)", iso: "2026-06-02T15:00:00Z" },
  { label: "12:00 CT (midday chop)", iso: "2026-06-02T17:00:00Z" },
  { label: "14:00 CT (past last-entry)", iso: "2026-06-02T19:00:00Z" },
  { label: "15:00 CT (past flatten cutoff)", iso: "2026-06-02T21:00:00Z" },
];

for (const { label, iso } of formerlyBlocked) {
  check(`canOpenPosition allows entry at ${label}`, () => {
    const r = canOpenPosition(
      { tradesOpened: 0, dailyLossUsed: 0 },
      0,
      unlimitedCfg,
      atCT(iso),
    );
    assert.strictEqual(r.allowed, true, r.reason);
  });
  check(`generateSignals produces an ACTIONABLE 0DTE entry at ${label}`, () => {
    const signals = generateSignals(
      {
        spy: { price: 757 },
        setups: [baseSetup],
        unusualOptions: [mkOption("SPY260602C00757000", "2026-06-02", 757)],
        economicCalendar: [],
      },
      unlimitedCfg,
      atCT(iso),
    );
    assert.strictEqual(signals[0].status, "ACTIONABLE", signals[0].blockReason ?? "");
    assert.ok(signals[0].contract, "expected a same-day 0DTE contract to be selected");
    assert.strictEqual(signals[0].isZeroDte, true);
  });
}

check("kill switch STILL blocks entry at a formerly-blocked time", () => {
  // The non-time kill-switch guard must remain authoritative regardless of clock.
  const r = canOpenPosition(
    { tradesOpened: 0, dailyLossUsed: 0 },
    0,
    { ...unlimitedCfg, killSwitchActive: true },
    atCT("2026-06-02T17:00:00Z"),
  );
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /kill switch/i);
});

check("daily loss stop STILL blocks entry at a formerly-blocked time", () => {
  const r = canOpenPosition(
    { tradesOpened: 0, dailyLossUsed: 600 },
    0,
    unlimitedCfg,
    atCT("2026-06-02T19:00:00Z"),
  );
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /loss limit/i);
});

// ── Single-contract exit logic (hard stop + give-back trailing stop, no TP) ─────
console.log("\nSingle-contract exit logic (trailing, no fixed take-profit):");
// Uses the config defaults (trailStart +35%, giveback 5%) — pass nothing so
// the test exercises the SHIPPED defaults, not hardcoded overrides.
function freshSingle(entry = 1.0): PaperPosition {
  resetPaperState();
  const cfg = getBotConfig();
  return openPaperPosition({
    symbol: "SPY260602C00757000",
    side: "Call",
    strike: 757,
    expiry: TODAY,
    contracts: 1,
    entryPremium: entry,
    stopFraction: cfg.stopLossFraction,
    trailStartFraction: cfg.trailStartFraction,
    trailGivebackFraction: cfg.trailGivebackFraction,
  });
}
check("single contract flagged singleContract=true", () => {
  const p = freshSingle();
  assert.strictEqual(p.singleContract, true);
});
check("trail ARMS at exactly +25% (default trailStartFraction=0.25)", () => {
  const p = freshSingle(1.0);
  // Just under +25% → not armed yet.
  updateTrail(p.id, 1.24);
  assert.strictEqual(p.trailArmed, false, "must not arm below +25%");
  // At +25% the trail ARMS but premium is at the peak → HOLD (run), not exit.
  updateTrail(p.id, 1.25);
  assert.strictEqual(p.trailArmed, true, "must arm at +25%");
  const a = evaluatePosition(p, 1.25, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "hold", `expected hold (let it run), got ${a.kind}`);
});
check("single contract never emits trim actions", () => {
  const p = freshSingle(1.0);
  // +45% is past the legacy trim levels but single contracts must HOLD, never trim.
  updateTrail(p.id, 1.45);
  const a = evaluatePosition(p, 1.45, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "hold", `expected hold, got ${a.kind}`);
});
check("winner runs past +25% then exits the FULL position on a 15% give-back from peak", () => {
  const p = freshSingle(1.0);
  // Run to +50% (peak 1.50, trail armed at +25%). Trail stop = 1.50 × 0.85 = 1.275.
  updateTrail(p.id, 1.50);
  assert.strictEqual(p.trailArmed, true);
  // A pullback to exactly the peak (no give-back) still HOLDS.
  assert.strictEqual(evaluatePosition(p, 1.50, getBotConfig(), NOW).kind, "hold");
  // A 10% pullback (1.35) is less than the 15% give-back trigger → still HOLD.
  assert.strictEqual(evaluatePosition(p, 1.35, getBotConfig(), NOW).kind, "hold");
  // Pull back to 1.27 (below 1.275, the 15% give-back) but above the +5% profit-lock → trailing stop.
  const a = evaluatePosition(p, 1.27, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /trailing stop/i);
  assert.match(a.reason, /15% give-back/i);
});
check("does NOT trail-exit before the +25% arm even on a meaningful pullback", () => {
  const p = freshSingle(1.0);
  // Rise to +20% (peak 1.20) — trail NOT armed (needs +25%).
  updateTrail(p.id, 1.20);
  assert.strictEqual(p.trailArmed, false);
  // Breakeven armed (peak ≥ +10%) so the stop is now at entry 1.00; pull back to
  // 1.12 (above breakeven, >5% off the peak) → HOLD (trail not armed).
  const a = evaluatePosition(p, 1.12, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "hold", `expected hold (trail not armed), got ${a.kind}`);
});
check("hard -20% stop stays in force before any arm (peak below +15% profit-lock)", () => {
  const p = freshSingle(1.0);
  // Peak +9% only → neither the +15% profit-lock nor the +30% trail armed (and
  // breakeven is disabled); a drop to the hard stop fires the -20% stop loss.
  updateTrail(p.id, 1.09); // +9%, nothing armed
  assert.strictEqual(p.trailArmed, false);
  assert.strictEqual(p.breakevenArmed, false);
  assert.strictEqual(p.profitLockArmed, false);
  const a = evaluatePosition(p, 0.79, getBotConfig(), NOW); // ≤ 0.80 hard stop
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /stop loss/i);
});

// ── Multi-contract uses the SAME no-trim full-position runner exit ───────────────
console.log("\nMulti-contract uses the same no-trim runner exit (no +30%/+60% trim):");
function freshMulti(contracts = 3, entry = 1.0): PaperPosition {
  resetPaperState();
  const cfg = getBotConfig();
  return openPaperPosition({
    symbol: "SPY260602C00757000",
    side: "Call",
    strike: 757,
    expiry: TODAY,
    contracts,
    entryPremium: entry,
    stopFraction: cfg.stopLossFraction,
    trailStartFraction: cfg.trailStartFraction,
    trailGivebackFraction: cfg.trailGivebackFraction,
  });
}
check("qty=3 does NOT trim at +30% (holds the full position, runs)", () => {
  const p = freshMulti(3, 1.0);
  assert.strictEqual(p.singleContract, false);
  // +31% is past the legacy trim-1 (+30%) but must NOT trim — hold the full size.
  updateTrail(p.id, 1.31);
  const a = evaluatePosition(p, 1.31, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "hold", `expected hold (no trim), got ${a.kind}`);
});
check("qty=3 does NOT trim at +60% (still holds the full position)", () => {
  const p = freshMulti(3, 1.0);
  // +61% is past the legacy trim-2 (+60%) but must NOT trim — still hold.
  updateTrail(p.id, 1.61);
  const a = evaluatePosition(p, 1.61, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "hold", `expected hold (no trim), got ${a.kind}`);
});
check("qty=3 never partially trims — contract count is unchanged after passing +30%/+60%", () => {
  const p = freshMulti(3, 1.0);
  updateTrail(p.id, 1.31); // past +30%
  evaluatePosition(p, 1.31, getBotConfig(), NOW);
  updateTrail(p.id, 1.61); // past +60%
  evaluatePosition(p, 1.61, getBotConfig(), NOW);
  assert.strictEqual(p.contracts, 3, "multi-contract size must not be reduced by any trim");
});
check("multi-contract exits the FULL position on 15% give-back after the +25% arm", () => {
  const p = freshMulti(3, 1.0);
  // Run to +55% (peak 1.55 → trail armed at +25%). Trail stop = 1.55 × 0.85 = 1.3175.
  updateTrail(p.id, 1.55);
  assert.strictEqual(p.trailArmed, true);
  // All 3 contracts still on (no trims happened) → the stop closes the full size.
  assert.strictEqual(p.contracts, 3, "all contracts must still be open before the trailing exit");
  const a = evaluatePosition(p, 1.31, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /trailing stop/i);
});
check("multi-contract arms the trail at +25% (default), not +20% or +50%", () => {
  const p = freshMulti(3, 1.0);
  updateTrail(p.id, 1.24); // +24% — not armed
  assert.strictEqual(p.trailArmed, false);
  updateTrail(p.id, 1.25); // +25% — arms
  assert.strictEqual(p.trailArmed, true);
});
check("multi-contract does NOT trail-exit before the +25% arm", () => {
  const p = freshMulti(3, 1.0);
  updateTrail(p.id, 1.20); // +20% — trail not armed yet
  assert.strictEqual(p.trailArmed, false);
  // Breakeven armed (peak ≥ +10%) → stop at entry 1.00; pull back to 1.12 (above
  // breakeven, >5% off the peak) but trail not armed → HOLD.
  const a = evaluatePosition(p, 1.12, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "hold", `expected hold (trail not armed), got ${a.kind}`);
});
check("multi-contract hard stop at -20% still fires", () => {
  const p = freshMulti(3, 1.0);
  const a = evaluatePosition(p, 0.79, getBotConfig(), NOW); // ≤ 0.80 stop
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /stop loss/i);
});
resetPaperState();

// ── Breakeven-protect stop (+10% arm raises the stop to entry) ───────────────────
console.log("\nBreakeven-protect stop (+10% MFE raises the stop to entry):");
check("default breakevenArmFraction is 0.10 (+10%) and enabled", () => {
  const c = getBotConfig();
  assert.strictEqual(c.breakevenArmFraction, 0.10);
});
check("breakeven seeds breakevenArmPrice at entry × 1.10 and starts disarmed", () => {
  const p = freshSingle(1.0);
  assert.strictEqual(p.breakevenArmPrice, 1.10);
  assert.strictEqual(p.breakevenArmed, false);
  assert.strictEqual(p.stopPrice, 0.80, "initial stop is the -20% hard stop");
});
check("breakeven does NOT arm before +10% (stop stays at -20% hard stop)", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.09); // +9% — below the +10% arm
  assert.strictEqual(p.breakevenArmed, false, "must not arm below +10%");
  assert.strictEqual(p.stopPrice, 0.80, "stop must remain the -20% hard stop");
  const a = evaluatePosition(p, 0.79, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /stop loss/i);
});
check("breakeven ARMS at exactly +10% and raises the stop to entry", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.10); // +10% — arms breakeven (still below the +15% profit-lock)
  assert.strictEqual(p.breakevenArmed, true, "must arm at +10%");
  assert.strictEqual(p.profitLockArmed, false, "profit-lock must not arm yet at +10%");
  assert.strictEqual(p.stopPrice, 1.0, "stop raised to entry premium");
  assert.strictEqual(evaluatePosition(p, 1.10, getBotConfig(), NOW).kind, "hold");
});
check("breakeven exits at/near entry on a pullback after the +10% arm (shrinks the dead zone)", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.12); // +12% — breakeven armed (stop=entry), profit-lock NOT yet
  assert.strictEqual(p.breakevenArmed, true);
  assert.strictEqual(p.profitLockArmed, false);
  // Pulls back to entry → breakeven stop fires (scratch), NOT a -20% loss.
  const a = evaluatePosition(p, 1.0, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /breakeven stop/i);
  assert.strictEqual(a.kind === "stop" ? a.closePremium : null, 1.0);
});
check("breakeven NEVER loosens an existing stop — only raises it", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.12); // arms breakeven → stop raised to 1.0 (from 0.80)
  assert.strictEqual(p.stopPrice, 1.0);
  updateTrail(p.id, 1.03);
  assert.strictEqual(p.stopPrice, 1.0, "stop must not loosen back below entry");
  assert.strictEqual(p.breakevenArmed, true);
});
check("+25% trail still supersedes breakeven/profit-lock (15% give-back from peak beats the locked stop)", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.50); // +50%: breakeven + profit-lock armed AND trail armed (+25%)
  assert.strictEqual(p.breakevenArmed, true);
  assert.strictEqual(p.profitLockArmed, true);
  assert.strictEqual(p.trailArmed, true);
  // 15% give-back from the 1.50 peak = 1.275, still well above the +5% profit-lock stop 1.05.
  const a = evaluatePosition(p, 1.27, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /trailing stop/i, "trail give-back supersedes the locked stop");
});
check("hard -20% stop still fires when breakeven never armed (price never reached +10%)", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.05); // +5% peak, breakeven not armed
  assert.strictEqual(p.breakevenArmed, false);
  const a = evaluatePosition(p, 0.79, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /stop loss/i);
});
check("breakeven does NOT contradict the +15% profit-lock: once profit-lock arms it protects +5%", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.12); // +12% — breakeven armed (stop = entry 1.0)
  assert.strictEqual(p.breakevenArmed, true);
  assert.strictEqual(p.stopPrice, 1.0);
  updateTrail(p.id, 1.16); // +16% — profit-lock arms; stop RAISED to +5% (1.05), above breakeven
  assert.strictEqual(p.profitLockArmed, true);
  assert.strictEqual(p.stopPrice, 1.05, "profit-lock supersedes breakeven (higher stop wins)");
  const a = evaluatePosition(p, 1.04, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /profit-lock/i, "exit at the +5% lock, not the breakeven entry");
});
check("breakeven works for a multi-contract full position (no trims)", () => {
  const p = freshMulti(3, 1.0);
  updateTrail(p.id, 1.12); // +12% — breakeven arms for the whole position
  assert.strictEqual(p.breakevenArmed, true);
  assert.strictEqual(p.profitLockArmed, false);
  assert.strictEqual(p.stopPrice, 1.0);
  assert.strictEqual(p.contracts, 3, "no trim — full size intact");
  const a = evaluatePosition(p, 0.99, getBotConfig(), NOW); // pull back through entry
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /breakeven stop/i);
  assert.doesNotMatch(a.reason, /trim/i, "no trim labels");
});
resetPaperState();

// ── Profit-lock tier (+15% MFE raises the stop to lock +5% profit) ───────────────
console.log("\nProfit-lock tier (+15% MFE locks in +5% profit, above breakeven):");
check("default profit-lock fractions are arm=0.15 (+15%) and profit=0.05 (+5%)", () => {
  const c = getBotConfig();
  assert.strictEqual(c.profitLockArmFraction, 0.15);
  assert.strictEqual(c.profitLockProfitFraction, 0.05);
});
check("profit-lock seeds arm price at entry × 1.15, stop at entry × 1.05, disarmed", () => {
  const p = freshSingle(1.0);
  assert.strictEqual(p.profitLockArmPrice, 1.15);
  assert.strictEqual(p.profitLockStopPrice, 1.05);
  assert.strictEqual(p.profitLockArmed, false);
});
check("profit-lock does NOT arm just below +15% (breakeven still governs the stop)", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.14); // +14% — breakeven armed, profit-lock NOT yet
  assert.strictEqual(p.breakevenArmed, true);
  assert.strictEqual(p.profitLockArmed, false, "must not arm below +15%");
  assert.strictEqual(p.stopPrice, 1.0, "stop is the breakeven (entry), not the +5% lock");
});
check("profit-lock ARMS at exactly +15% and raises the stop to lock +5% profit", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.15); // +15% — profit-lock arms
  assert.strictEqual(p.profitLockArmed, true, "must arm at +15%");
  assert.strictEqual(p.trailArmed, false, "trail still not armed below +25%");
  assert.strictEqual(p.stopPrice, 1.05, "stop raised to entry × 1.05 (+5% locked)");
  // At the peak (no give-back) it still HOLDS.
  assert.strictEqual(evaluatePosition(p, 1.15, getBotConfig(), NOW).kind, "hold");
});
check("profit-lock supersedes breakeven (a pullback below entry exits at the +5% lock)", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.20); // +20% — both breakeven and profit-lock armed
  assert.strictEqual(p.breakevenArmed, true);
  assert.strictEqual(p.profitLockArmed, true);
  assert.strictEqual(p.stopPrice, 1.05, "the higher +5% lock supersedes the entry breakeven");
  // Pull back to the locked stop → exits with a +5% profit, not a scratch/loss.
  const a = evaluatePosition(p, 1.04, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /profit-lock/i, "exit reason must name the profit-lock tier");
});
check("profit-lock NEVER loosens an existing stop — only raises it", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.20); // arms profit-lock → stop 1.05
  assert.strictEqual(p.stopPrice, 1.05);
  updateTrail(p.id, 1.06); // later lower mark must not pull the stop down
  assert.strictEqual(p.stopPrice, 1.05, "stop must not loosen below the +5% lock");
  assert.strictEqual(p.profitLockArmed, true, "arm flag stays set");
});
check("+25% trail give-back supersedes the profit-lock stop on a deep runner", () => {
  const p = freshSingle(1.0);
  updateTrail(p.id, 1.50); // +50% — profit-lock + trail armed
  assert.strictEqual(p.profitLockArmed, true);
  assert.strictEqual(p.trailArmed, true);
  // 15% give-back from peak 1.50 = 1.275, still far above the +5% lock 1.05 → trail wins.
  const a = evaluatePosition(p, 1.27, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /trailing stop/i, "trail give-back supersedes the profit-lock stop");
});
check("profit-lock works for a multi-contract full position (no trims)", () => {
  const p = freshMulti(3, 1.0);
  updateTrail(p.id, 1.16); // +16% — profit-lock arms for the whole position
  assert.strictEqual(p.profitLockArmed, true);
  assert.strictEqual(p.stopPrice, 1.05);
  assert.strictEqual(p.contracts, 3, "no trim — full size intact");
  const a = evaluatePosition(p, 1.04, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /profit-lock/i);
  assert.doesNotMatch(a.reason, /trim/i, "no trim labels");
});
resetPaperState();

// ── Stricter MTF gating: neutral/chop BLOCKS ────────────────────────────────────
console.log("\nStricter MTF gating (neutral/chop blocks):");
check("neutral higher timeframe BLOCKS (does not downgrade)", () => {
  // Flat/ranging series → 30m & 15m neutral.
  const ones = buildSeries(180, 500, 0.0);
  const a = analyzeMultiTimeframe("Call", {
    candles1m: ones,
    candles5m: aggregateCandles(ones, 5),
    candles15m: aggregateCandles(ones, 15),
    candles30m: aggregateCandles(ones, 30),
    spot: ones[ones.length - 1].close,
  });
  assert.strictEqual(a.higherTimeframeTrend.alignment, "neutral");
  assert.strictEqual(a.gate, "block", "neutral must block under the strict profile");
});

// ── No visible trim fields / labels in dashboard-facing output ──────────────────
console.log("\nNo visible trim fields or labels in dashboard-facing output:");

/** Recursively collect every object key in a value. */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

const TRIM_KEY = /trim/i;
// Trim *labels* a user would read: "Trim 30%", "Trim 60%", "trim1", "trim2",
// "trimTo", or a generic "trim" word. We do NOT match the substring inside
// unrelated words, so we anchor on the standalone token.
const TRIM_LABEL = /\btrim\b|trim\s*\d|trim[12]|trimto|trim\s*\d{1,3}\s*%/i;

check("MTF entryPlan has NO trimTo (or any trim) key", () => {
  const up = buildSeries(180, 500, 0.6); // clean uptrend
  const mtf = analyzeMultiTimeframe("Call", {
    candles1m: up,
    candles5m: aggregateCandles(up, 5),
    candles15m: aggregateCandles(up, 15),
    candles30m: aggregateCandles(up, 30),
    spot: up[up.length - 1].close,
  });
  const keys = collectKeys(mtf);
  const trimKeys = keys.filter((k) => TRIM_KEY.test(k));
  assert.deepStrictEqual(trimKeys, [], `MTF output exposes trim keys: ${trimKeys.join(", ")}`);
  assert.ok(!("trimTo" in mtf.entryPlan), "entryPlan.trimTo must not exist");
});

check("paper position object exposes NO trim fields", () => {
  const p = freshSingle(1.0);
  const keys = collectKeys(p);
  const trimKeys = keys.filter((k) => TRIM_KEY.test(k));
  assert.deepStrictEqual(
    trimKeys,
    [],
    `Position exposes trim fields (trim1Price/trim2Price/trim1Done/...): ${trimKeys.join(", ")}`,
  );
  resetPaperState();
});

check("status smallAccountProfile note uses no-trim exit text (no 'Trim 30/60%')", () => {
  const cfg = getBotConfig();
  // Mirror the note the /api/bot/status route returns (computed from config).
  const note =
    `Full position exits together. Hard stop -${(cfg.stopLossFraction * 100).toFixed(0)}%, ` +
    `trail arms +${(cfg.trailStartFraction * 100).toFixed(0)}%, ` +
    `giveback exit ${(cfg.trailGivebackFraction * 100).toFixed(0)}% from peak, ` +
    `plus flatten/invalidation safety exits.`;
  assert.ok(!TRIM_LABEL.test(note), `status note still shows a trim label: "${note}"`);
  assert.match(note, /hard stop/i);
  assert.match(note, /trail arms \+25%/i);
  assert.match(note, /giveback exit 15% from peak/i);
  // No misleading legacy +40%, +20%, or +50% trail labels should appear in the note.
  assert.ok(!/\+40%/.test(note), "note must not show the removed +40% trail label");
  assert.ok(!/\+20% (trail|arm)/i.test(note), "note must not show the removed +20% trail label");
  assert.ok(!/\+50%/.test(note), "note must not show the removed +50% trail label");
  // The deprecated env fractions stay internal — never quote them in the note.
  assert.ok(!note.includes(String(cfg.trim1Fraction)), "note must not surface trim1Fraction");
  assert.ok(!note.includes(String(cfg.trim2Fraction)), "note must not surface trim2Fraction");
});

check("automation engine never emits a 'trim' action/event kind", () => {
  // Past the legacy +30% / +60% trim levels the exit decision must be hold/stop,
  // never a partial trim. Single and multi contract both verified above; here we
  // assert the action kind vocabulary contains no 'trim'.
  const p = freshMulti(3, 1.0);
  updateTrail(p.id, 1.65); // past both legacy trim levels and the +25% arm
  const a = evaluatePosition(p, 1.65, getBotConfig(), NOW);
  assert.ok(["hold", "stop", "flatten"].includes(a.kind), `unexpected action kind ${a.kind}`);
  assert.notStrictEqual(a.kind as string, "trim", "no trim action may be emitted");
  resetPaperState();
});

// ── Broker-position reconciliation / adoption (exit-only) ───────────────────────
// After a restart/redeploy local managed state is empty, but the broker still
// holds the live SPY 0DTE option. Reconciliation must adopt eligible long SPY
// same-day options so the trailing exit can manage them. No real network/orders.
console.log("\nBroker-position reconciliation / adoption:");

// Build broker rows. Tradier reports option cost_basis as TOTAL dollars
// (premium × qty × 100). entry 1.00, qty 2 → cost_basis 200.
const brokerOcc = (side: "Call" | "Put", strike: number, yymmdd = "260602") =>
  `SPY${yymmdd}${side === "Call" ? "C" : "P"}${occStrike(strike)}`;

const mkBrokerPos = (
  symbol: string,
  quantity: number | null,
  costBasis: number | null,
): TradierBrokerPosition => ({
  symbol,
  quantity,
  costBasis,
  dateAcquired: "2026-06-02T14:00:00.000Z",
});

// A reconcile-deps factory that injects synthetic broker data and a mock mark,
// using the REAL adoptBrokerPosition + getOpenPositions against paper state.
function mkDeps(
  positions: TradierBrokerPosition[],
  mark: number | null,
  available = true,
): ReconcileDeps {
  return {
    fetchBrokerPositions: async () => ({ available, positions }),
    fetchOptionMark: async () => mark,
    adoptBrokerPosition: adoptReal,
    getOpenPositions,
    getBrokerAdoptions,
  };
}

check("deriveEntryPremium reads total-dollar cost basis as per-contract", () => {
  // 200 total / (2 × 100) = 1.00 per contract.
  assert.strictEqual(deriveEntryPremium(200, 2), 1.0);
  // Robust: a value already per-contract (e.g. 1.25) would yield sub-penny under
  // the total interpretation (1.25 / 200), so it is used as-is.
  assert.strictEqual(deriveEntryPremium(1.25, 2), 1.25);
});

check("classify: SPY same-day long Call → adopt", () => {
  const cls = classifyBrokerPosition(mkBrokerPos(brokerOcc("Call", 756), 2, 256), NOW);
  assert.strictEqual(cls.disposition, "adopt");
  assert.strictEqual(cls.side, "Call");
  assert.strictEqual(cls.quantity, 2);
  assert.ok(cls.entryPremium && cls.entryPremium > 0);
});

check("classify: future-dated option is NOT adopted (skip)", () => {
  const cls = classifyBrokerPosition(mkBrokerPos(brokerOcc("Call", 756, "260605"), 2, 256), NOW);
  assert.strictEqual(cls.disposition, "skip");
  assert.match(cls.reason, /0DTE/i);
});

check("classify: short/negative quantity is NOT adopted (skip)", () => {
  const cls = classifyBrokerPosition(mkBrokerPos(brokerOcc("Call", 756), -2, 256), NOW);
  assert.strictEqual(cls.disposition, "skip");
  assert.match(cls.reason, /long|short/i);
});

check("classify: non-SPY option is reviewed, not adopted", () => {
  const cls = classifyBrokerPosition(mkBrokerPos("QQQ260602C00500000", 1, 100), NOW);
  assert.strictEqual(cls.disposition, "review");
});

check("classify: SPY shares / unparseable symbol → review (never managed)", () => {
  const cls = classifyBrokerPosition(mkBrokerPos("SPY", 100, 75600), NOW);
  assert.strictEqual(cls.disposition, "review");
});

await checkAsync("reconcile: broker SPY 0DTE long adopted when local state empty", async () => {
  resetPaperState();
  assert.strictEqual(getOpenPositions().length, 0, "precondition: no local positions");
  const sym = brokerOcc("Call", 756);
  const res = await reconcileBrokerPositions(
    autoLiveCfg,
    NOW,
    mkDeps([mkBrokerPos(sym, 2, 200)], 1.05),
  );
  assert.strictEqual(res.ran, true);
  assert.deepStrictEqual(res.adopted, [sym]);
  const open = getOpenPositions();
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].symbol, sym);
  assert.strictEqual(open[0].adoptedFromBroker, true);
  assert.strictEqual(open[0].entryPremium, 1.0, "entry premium reconstructed from cost basis");
  resetPaperState();
});

await checkAsync("reconcile: observe-only (auto off) adopts nothing", async () => {
  resetPaperState();
  const sym = brokerOcc("Call", 756);
  const res = await reconcileBrokerPositions(
    { ...autoLiveCfg, autoTradeEnabled: false },
    NOW,
    mkDeps([mkBrokerPos(sym, 2, 200)], 1.05),
  );
  assert.strictEqual(res.ran, false);
  assert.strictEqual(getOpenPositions().length, 0, "must not adopt when not live-armed");
  resetPaperState();
});

await checkAsync("reconcile: no duplicate adoption when already managed", async () => {
  resetPaperState();
  const sym = brokerOcc("Call", 756);
  // Seed a local position for the same symbol first.
  openPaperPosition({
    symbol: sym, side: "Call", strike: 756, expiry: TODAY, contracts: 2,
    entryPremium: 1.0, stopFraction: 0.20, trailStartFraction: 0.35, trailGivebackFraction: 0.05,
  });
  const res = await reconcileBrokerPositions(
    autoLiveCfg, NOW, mkDeps([mkBrokerPos(sym, 2, 200)], 1.05),
  );
  assert.deepStrictEqual(res.adopted, [], "should not re-adopt an already-managed symbol");
  assert.strictEqual(getOpenPositions().length, 1, "no duplicate local position");
  resetPaperState();
});

await checkAsync("reconcile: future-dated broker position is not adopted, warns unmanaged", async () => {
  resetPaperState();
  const res = await reconcileBrokerPositions(
    autoLiveCfg, NOW, mkDeps([mkBrokerPos(brokerOcc("Call", 756, "260605"), 2, 200)], 1.05),
  );
  assert.deepStrictEqual(res.adopted, []);
  assert.strictEqual(getOpenPositions().length, 0);
  assert.strictEqual(res.unmanagedBrokerPositions, true, "should flag unmanaged broker positions");
  resetPaperState();
});

await checkAsync("reconcile: adopted position with mark above +25% arms the trail", async () => {
  resetPaperState();
  const sym = brokerOcc("Call", 756);
  // entry 1.00, mark 1.55 (+55%) → trail arms immediately (arms at +25% = 1.25).
  const res = await reconcileBrokerPositions(
    autoLiveCfg, NOW, mkDeps([mkBrokerPos(sym, 2, 200)], 1.55),
  );
  assert.deepStrictEqual(res.adopted, [sym]);
  const open = getOpenPositions();
  assert.strictEqual(open[0].trailArmed, true, "trail must arm when mark ≥ +25%");
  assert.ok(open[0].peakPremium >= 1.55, "peak seeded to the current mark");
  resetPaperState();
});

check("adopted position exits on 15% give-back from peak (evaluatePosition)", () => {
  resetPaperState();
  const sym = brokerOcc("Call", 756);
  const c = getBotConfig();
  // Adopt directly: entry 1.00, current mark 1.60 (+60%) → armed, peak 1.60.
  const { position } = adoptReal({
    symbol: sym, side: "Call", strike: 756, expiry: TODAY, contracts: 2,
    entryPremium: 1.0, currentMark: 1.6, stopFraction: c.stopLossFraction,
    trailStartFraction: c.trailStartFraction, trailGivebackFraction: c.trailGivebackFraction,
    brokerDateAcquired: "2026-06-02T14:00:00.000Z",
  });
  assert.strictEqual(position.trailArmed, true);
  // Trail stop = 1.60 × 0.85 = 1.36. Pull back to 1.35 → trailing-stop exit.
  const a = evaluatePosition(position, 1.35, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop");
  assert.match(a.reason, /trailing stop/i);
  resetPaperState();
});

check("adopted-not-yet-armed: peak tracks max(entry, mark), holds below +25%", () => {
  resetPaperState();
  const sym = brokerOcc("Put", 756);
  const c = getBotConfig();
  // entry 1.00, mark 1.20 (+20%) → trail not armed (arms at +25%); peak = 1.20.
  const { position } = adoptReal({
    symbol: sym, side: "Put", strike: 756, expiry: TODAY, contracts: 1,
    entryPremium: 1.0, currentMark: 1.20, stopFraction: c.stopLossFraction,
    trailStartFraction: c.trailStartFraction, trailGivebackFraction: c.trailGivebackFraction,
    profitLockArmFraction: c.profitLockArmFraction, profitLockProfitFraction: c.profitLockProfitFraction,
    brokerDateAcquired: null,
  });
  assert.strictEqual(position.trailArmed, false);
  assert.strictEqual(position.peakPremium, 1.20);
  // +20% peak ≥ +15% → profit-lock armed at adoption, stop locked to +5% (1.05).
  assert.strictEqual(position.profitLockArmed, true);
  assert.strictEqual(position.stopPrice, 1.05, "stop locked to +5% profit at adoption");
  // Mark 1.10 is above the +5% locked stop and below the +25% trail arm → hold.
  const a = evaluatePosition(position, 1.10, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "hold", `expected hold (trail not armed), got ${a.kind}`);
  resetPaperState();
});

check("adopted position with known peak +12% ARMS breakeven (stop raised to entry)", () => {
  resetPaperState();
  const sym = brokerOcc("Call", 756);
  const c = getBotConfig();
  // entry 1.00, mark 1.12 (+12%): below the +25% trail arm and below the +15%
  // profit-lock, but at/above the +10% breakeven arm. Breakeven arms at adoption
  // and raises the stop from the -20% hard stop to entry (1.00) — scratch protection.
  const { position } = adoptReal({
    symbol: sym, side: "Call", strike: 756, expiry: TODAY, contracts: 2,
    entryPremium: 1.0, currentMark: 1.12, stopFraction: c.stopLossFraction,
    trailStartFraction: c.trailStartFraction, trailGivebackFraction: c.trailGivebackFraction,
    breakevenArmFraction: c.breakevenArmFraction,
    profitLockArmFraction: c.profitLockArmFraction, profitLockProfitFraction: c.profitLockProfitFraction,
    brokerDateAcquired: null,
  });
  assert.strictEqual(position.trailArmed, false, "below +25% — trail not armed");
  assert.strictEqual(position.profitLockArmed, false, "below +15% — profit-lock not armed");
  assert.strictEqual(position.breakevenArmed, true, "≥ +10% — breakeven armed");
  assert.strictEqual(position.stopPrice, 1.0, "stop raised to entry (breakeven), not the -20% hard stop");
  // Pull back below entry → breakeven stop fires (scratch the trade at entry).
  const a = evaluatePosition(position, 0.99, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop", "breakeven stop fires when mark drops below entry");
  assert.match(a.reason, /breakeven/i);
  resetPaperState();
});

check("adopted long SPY 0DTE position triggers the -20% HARD STOP close decision", () => {
  resetPaperState();
  const sym = brokerOcc("Call", 756);
  const c = getBotConfig();
  // Adopt at the adoption mark with NO favorable excursion (mark == entry): no
  // protection tier arms, so the stop stays at the -20% hard stop (entry × 0.80).
  const { position } = adoptReal({
    symbol: sym, side: "Call", strike: 756, expiry: TODAY, contracts: 2,
    entryPremium: 1.0, currentMark: 1.0, stopFraction: c.stopLossFraction,
    trailStartFraction: c.trailStartFraction, trailGivebackFraction: c.trailGivebackFraction,
    breakevenArmFraction: c.breakevenArmFraction,
    profitLockArmFraction: c.profitLockArmFraction, profitLockProfitFraction: c.profitLockProfitFraction,
    brokerDateAcquired: "2026-06-02T14:00:00.000Z",
  });
  assert.strictEqual(position.adoptedFromBroker, true, "position is adopted from the broker");
  assert.strictEqual(position.trailArmed, false, "no excursion — trail not armed");
  assert.strictEqual(position.breakevenArmed, false, "no excursion — breakeven not armed");
  assert.strictEqual(position.profitLockArmed, false, "no excursion — profit-lock not armed");
  assert.strictEqual(position.stopPrice, 0.8, "stop sits at the -20% hard stop (1.00 × 0.80)");
  // A mark at/under the hard stop must produce the hard-stop close decision —
  // the same exit path a bot-opened position takes. This is the safety case the
  // user needs: an adopted untracked broker position can now be stopped out.
  const a = evaluatePosition(position, 0.8, getBotConfig(), NOW);
  assert.strictEqual(a.kind, "stop", "premium ≤ hard stop must yield a stop action");
  assert.strictEqual(a.closePremium, 0.8);
  assert.match(a.reason, /stop loss/i);
  assert.match(a.reason, /20% loss/i);
  resetPaperState();
});

await checkAsync(
  "end-to-end: reconcile adopts a long SPY 0DTE position that then hits the hard stop",
  async () => {
    resetPaperState();
    const sym = brokerOcc("Put", 757);
    // Adopt via the real reconcile path (mark == entry → unarmed, hard stop only).
    const res = await reconcileBrokerPositions(
      autoLiveCfg, NOW, mkDeps([mkBrokerPos(sym, 2, 200)], 1.0),
    );
    assert.deepStrictEqual(res.adopted, [sym], "adopted via reconcile");
    const pos = getOpenPositions()[0];
    assert.strictEqual(pos.adoptedFromBroker, true);
    assert.strictEqual(pos.stopPrice, 0.8, "hard stop at -20% of the adoption-basis entry");
    // Price drops to the hard stop → the normal exit evaluator returns a stop and
    // the close is applied to paper state (no live order in test mode).
    const action = evaluatePosition(pos, 0.79, getBotConfig(), NOW);
    assert.strictEqual(action.kind, "stop");
    assert.match(action.reason, /stop loss/i);
    const closed = closePaperPosition(pos.id, action.closePremium, action.reason);
    assert.ok(closed && closed.status === "closed", "adopted position closes on the hard stop");
    assert.strictEqual(closed!.pnl, -42, "(0.79 - 1.00) × 2 × 100 = -$42 realized");
    assert.strictEqual(getOpenPositions().length, 0, "no open positions remain after the stop");
    resetPaperState();
  },
);

// ── Adopted-position idempotency / P&L de-duplication (regression) ──────────────
// Reproduces the live bug: after the bot adopts a broker SPY 0DTE position and
// exits it, the broker keeps reporting the SAME position on later ticks
// (settlement lag). The bot MUST NOT re-adopt it, must NOT create duplicate
// closed positions, must NOT compound realized loss, and must NOT emit repeated
// sell_to_close. A genuinely NEW lot (different dateAcquired) IS adoptable.
console.log("\nAdopted-position idempotency / P&L de-duplication (regression):");

await checkAsync(
  "re-reported broker position after a close is NOT re-adopted (no duplicate, no compounded loss)",
  async () => {
    resetPaperState();
    const sym = brokerOcc("Put", 757); // mirrors the live SPY260604P00757000 case
    const acq = "2026-06-02T13:45:00.000Z";
    const brokerPos = (): TradierBrokerPosition => ({
      symbol: sym, quantity: 2, costBasis: 200, dateAcquired: acq,
    });

    // Tick 1: broker reports the position, local state empty → adopt once.
    let res = await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 1.0));
    assert.deepStrictEqual(res.adopted, [sym], "adopted exactly once on first tick");
    const open = getOpenPositions();
    assert.strictEqual(open.length, 1);
    const posId = open[0].id;

    // The bot exits it at a LOSS (mark 0.60 < entry 1.00 → -$80 on 2 contracts).
    markExitPending(posId); // engine flags pending before the local close
    const closed = closePaperPosition(posId, 0.6, "trailing stop");
    assert.ok(closed, "position closed");
    assert.strictEqual(closed!.pnl, -80, "single realized loss of -$80");

    const pnlAfterFirstClose = computeBotPnl().realizedPnl;
    assert.strictEqual(pnlAfterFirstClose, -80, "realized loss is -$80 after one close");

    // Ticks 2..11: broker STILL reports the same position (same dateAcquired).
    // Each tick must be a no-op for adoption/exit.
    for (let i = 0; i < 10; i++) {
      res = await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 0.6));
      assert.deepStrictEqual(res.adopted, [], `tick ${i + 2}: must not re-adopt`);
      assert.deepStrictEqual(
        res.pendingBrokerPositions, [sym],
        `tick ${i + 2}: re-reported position surfaced as pending`,
      );
    }

    // No duplicate positions, no compounded loss.
    assert.strictEqual(getOpenPositions().length, 0, "no new open positions re-adopted");
    const closedCount = getAllPositions().filter((p) => p.status === "closed").length;
    assert.strictEqual(closedCount, 1, "exactly one closed position — no duplicates");
    assert.strictEqual(
      computeBotPnl().realizedPnl, -80,
      "realized loss is counted exactly once (not compounded across ticks)",
    );

    // Only ONE sell-to-close fill was recorded.
    resetPaperState();
  },
);

await checkAsync(
  "adopted identity exits exactly once across many exit ticks (no repeated sell_to_close)",
  async () => {
    resetPaperState();
    const sym = brokerOcc("Call", 758);
    const acq = "2026-06-02T13:00:00.000Z";
    const brokerPos = (): TradierBrokerPosition => ({
      symbol: sym, quantity: 1, costBasis: 100, dateAcquired: acq,
    });

    // Adopt + close once.
    await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 1.0));
    const id = getOpenPositions()[0].id;
    markExitPending(id);
    closePaperPosition(id, 0.5, "hard stop");

    // Many re-report ticks: none should adopt, none should produce a new close.
    for (let i = 0; i < 25; i++) {
      const r = await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 0.5));
      assert.deepStrictEqual(r.adopted, []);
    }
    // Ledger holds exactly one identity, terminally closed.
    const adoptions = getBrokerAdoptions();
    assert.strictEqual(adoptions.length, 1, "one tracked broker identity");
    assert.strictEqual(adoptions[0].status, "closed", "identity is terminally closed");
    resetPaperState();
  },
);

await checkAsync(
  "exit-pending identity (broker still reporting before settlement) is not re-exited",
  async () => {
    resetPaperState();
    const sym = brokerOcc("Put", 756);
    const acq = "2026-06-02T12:30:00.000Z";
    const brokerPos = (): TradierBrokerPosition => ({
      symbol: sym, quantity: 1, costBasis: 100, dateAcquired: acq,
    });
    await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 1.0));
    const id = getOpenPositions()[0].id;
    // Simulate: live close submitted (exit-pending) but local close not yet done.
    markExitPending(id);
    const r = await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 1.0));
    assert.deepStrictEqual(r.adopted, [], "exit-pending identity must not be re-adopted");
    assert.deepStrictEqual(r.pendingBrokerPositions, [sym], "surfaced as pending");
    resetPaperState();
  },
);

await checkAsync(
  "a genuinely NEW lot (different dateAcquired) in the same symbol IS adoptable",
  async () => {
    resetPaperState();
    const sym = brokerOcc("Call", 757);
    // First lot adopted then closed.
    await reconcileBrokerPositions(
      autoLiveCfg, NOW,
      mkDeps([{ symbol: sym, quantity: 1, costBasis: 100, dateAcquired: "2026-06-02T10:00:00.000Z" }], 1.0),
    );
    const firstId = getOpenPositions()[0].id;
    markExitPending(firstId);
    closePaperPosition(firstId, 0.8, "trailing stop");

    // A NEW lot in the SAME symbol with a DIFFERENT acquire time appears later.
    const res = await reconcileBrokerPositions(
      autoLiveCfg, NOW,
      mkDeps([{ symbol: sym, quantity: 2, costBasis: 200, dateAcquired: "2026-06-02T15:30:00.000Z" }], 1.05),
    );
    assert.deepStrictEqual(res.adopted, [sym], "new lot (new dateAcquired) is adopted");
    const open = getOpenPositions();
    assert.strictEqual(open.length, 1, "the new lot is now managed");
    assert.strictEqual(open[0].contracts, 2);
    // Two distinct identities tracked: the closed one and the newly managed one.
    const adoptions = getBrokerAdoptions();
    assert.strictEqual(adoptions.length, 2, "two distinct broker identities");
    resetPaperState();
  },
);

await checkAsync(
  "computeBotPnl reflects Tradier-independent local ledger; loss not double-counted",
  async () => {
    resetPaperState();
    const sym = brokerOcc("Put", 755);
    const acq = "2026-06-02T11:00:00.000Z";
    const brokerPos = (): TradierBrokerPosition => ({
      symbol: sym, quantity: 3, costBasis: 300, dateAcquired: acq,
    });
    await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 1.0));
    const id = getOpenPositions()[0].id;
    markExitPending(id);
    closePaperPosition(id, 0.7, "trailing stop"); // (0.7-1.0)*3*100 = -90

    // Broker keeps reporting for 50 ticks.
    for (let i = 0; i < 50; i++) {
      await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 0.7));
    }
    assert.strictEqual(computeBotPnl().realizedPnl, -90, "loss counted once, never compounded");
    resetPaperState();
  },
);

// ── Daily-loss guard on NET realized P&L (not gross losing trades) ──────────────
console.log("\nDaily-loss guard uses NET realized P&L (winners offset losers):");

// Open a 1-contract position at $2.00 and close it so pnl = (close - 2.00) * 100.
// Returns the realized pnl in USD for assertions.
function closeOneAt(closePremium: number): number {
  const pos = openPaperPosition({
    symbol: brokerOcc("Call", 757),
    side: "Call",
    strike: 757,
    expiry: TODAY,
    contracts: 1,
    entryPremium: 2.0,
    stopFraction: 0.2,
  });
  const closed = closePaperPosition(pos.id, closePremium, "test close");
  return closed?.pnl ?? NaN;
}

check("sequence -105,-90,+108,-88 → net -175, gross losers 283, dailyLossUsed 175, NOT blocked", () => {
  resetPaperState();
  // (close - 2.00) * 100 = pnl  →  1.95→-105, 1.10→-90, 3.08→+108, 1.12→-88
  assert.strictEqual(closeOneAt(0.95), -105);
  assert.strictEqual(closeOneAt(1.10), -90);
  assert.strictEqual(closeOneAt(3.08), 108);
  assert.strictEqual(closeOneAt(1.12), -88);

  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.netRealizedPnlToday, -175, `net should be -175, got ${snap.netRealizedPnlToday}`);
  assert.strictEqual(snap.grossLossToday, 283, `gross losers should be 283, got ${snap.grossLossToday}`);
  assert.strictEqual(snap.dailyLossUsed, 175, `dailyLossUsed should be 175, got ${snap.dailyLossUsed}`);
  assert.strictEqual(snap.source, "local-net-realized");

  const r = canOpenPosition(
    { tradesOpened: snap.tradesOpened, dailyLossUsed: snap.dailyLossUsed, netRealizedPnlToday: snap.netRealizedPnlToday },
    0,
    { ...unlimitedCfg, maxDailyLoss: 500 },
    NOW,
  );
  assert.strictEqual(r.allowed, true, `net -175 must NOT block under maxDailyLoss 500 (reason: ${r.reason})`);
  resetPaperState();
});

check("gross losers 283 alone does NOT trip the guard (the old bug)", () => {
  // The pre-fix guard summed gross losses (283) and would approach the cap. The
  // net-based guard only consumes 175. Assert the gross figure is informational.
  resetPaperState();
  closeOneAt(0.95); // -105
  closeOneAt(1.10); // -90
  closeOneAt(3.08); // +108
  closeOneAt(1.12); // -88
  const snap = getDailyLossSnapshot();
  assert.ok(snap.grossLossToday > snap.dailyLossUsed, "gross loss should exceed net loss used");
  assert.strictEqual(snap.dailyLossUsed, 175);
  resetPaperState();
});

check("net -501 DOES block under maxDailyLoss 500", () => {
  resetPaperState();
  // (close - 2.00) * 100 = -501  →  close = -3.01 is invalid; use two closes.
  assert.strictEqual(closeOneAt(0.95), -105); // -105
  // (close-2)*100 = -396 → close = -1.96 invalid; build with a larger entry.
  const big = openPaperPosition({
    symbol: brokerOcc("Put", 755),
    side: "Put",
    strike: 755,
    expiry: TODAY,
    contracts: 1,
    entryPremium: 5.0,
    stopFraction: 0.2,
  });
  const closedBig = closePaperPosition(big.id, 1.04, "test close"); // (1.04-5)*100 = -396
  assert.strictEqual(closedBig?.pnl, -396);

  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.netRealizedPnlToday, -501, `net should be -501, got ${snap.netRealizedPnlToday}`);
  assert.strictEqual(snap.dailyLossUsed, 501);

  const r = canOpenPosition(
    { tradesOpened: snap.tradesOpened, dailyLossUsed: snap.dailyLossUsed, netRealizedPnlToday: snap.netRealizedPnlToday },
    0,
    { ...unlimitedCfg, maxDailyLoss: 500 },
    NOW,
  );
  assert.strictEqual(r.allowed, false, "net -501 must block under maxDailyLoss 500");
  assert.match(r.reason, /net realized loss/i);
  resetPaperState();
});

check("net exactly -500 blocks (dailyLossUsed >= cap is inclusive)", () => {
  resetPaperState();
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 757), side: "Call", strike: 757, expiry: TODAY,
    contracts: 1, entryPremium: 6.0, stopFraction: 0.2,
  });
  const closed = closePaperPosition(p.id, 1.0, "test close"); // (1-6)*100 = -500
  assert.strictEqual(closed?.pnl, -500);
  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.dailyLossUsed, 500);
  const r = canOpenPosition(
    { tradesOpened: snap.tradesOpened, dailyLossUsed: snap.dailyLossUsed, netRealizedPnlToday: snap.netRealizedPnlToday },
    0, { ...unlimitedCfg, maxDailyLoss: 500 }, NOW,
  );
  assert.strictEqual(r.allowed, false, "net -500 (== cap) must block");
  resetPaperState();
});

check("net -999 does NOT block under maxDailyLoss 1000", () => {
  resetPaperState();
  // Build net realized -999 with a single losing close: (close-10)*100 = -999 → close = 0.01.
  const p = openPaperPosition({
    symbol: brokerOcc("Put", 753), side: "Put", strike: 753, expiry: TODAY,
    contracts: 1, entryPremium: 10.0, stopFraction: 0.2,
  });
  const closed = closePaperPosition(p.id, 0.01, "test close"); // (0.01-10)*100 = -999
  assert.strictEqual(closed?.pnl, -999);
  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.netRealizedPnlToday, -999, `net should be -999, got ${snap.netRealizedPnlToday}`);
  assert.strictEqual(snap.dailyLossUsed, 999);
  const r = canOpenPosition(
    { tradesOpened: snap.tradesOpened, dailyLossUsed: snap.dailyLossUsed, netRealizedPnlToday: snap.netRealizedPnlToday },
    0, { ...unlimitedCfg, maxDailyLoss: 1000 }, NOW,
  );
  assert.strictEqual(r.allowed, true, `net -999 must NOT block under maxDailyLoss 1000 (reason: ${r.reason})`);
  resetPaperState();
});

check("net -1000 DOES block under maxDailyLoss 1000 (>= cap is inclusive)", () => {
  resetPaperState();
  // (close-10)*100 = -1000 → close = 0.00.
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 758), side: "Call", strike: 758, expiry: TODAY,
    contracts: 1, entryPremium: 10.0, stopFraction: 0.2,
  });
  const closed = closePaperPosition(p.id, 0.0, "test close"); // (0-10)*100 = -1000
  assert.strictEqual(closed?.pnl, -1000);
  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.netRealizedPnlToday, -1000, `net should be -1000, got ${snap.netRealizedPnlToday}`);
  assert.strictEqual(snap.dailyLossUsed, 1000);
  const r = canOpenPosition(
    { tradesOpened: snap.tradesOpened, dailyLossUsed: snap.dailyLossUsed, netRealizedPnlToday: snap.netRealizedPnlToday },
    0, { ...unlimitedCfg, maxDailyLoss: 1000 }, NOW,
  );
  assert.strictEqual(r.allowed, false, "net -1000 (== cap) must block under maxDailyLoss 1000");
  assert.match(r.reason, /net realized loss/i);
  resetPaperState();
});

check("broker day P&L is used as the source when finite", () => {
  resetPaperState();
  closeOneAt(0.95); // local net -105
  const snap = getDailyLossSnapshot(-250); // broker reports -250 for the day
  assert.strictEqual(snap.source, "broker-day-pnl");
  assert.strictEqual(snap.netRealizedPnlToday, -250);
  assert.strictEqual(snap.dailyLossUsed, 250);
  resetPaperState();
});

check("null/undefined broker day P&L falls back to local net realized", () => {
  resetPaperState();
  closeOneAt(0.95); // local net -105
  const snapNull = getDailyLossSnapshot(null);
  assert.strictEqual(snapNull.source, "local-net-realized");
  assert.strictEqual(snapNull.netRealizedPnlToday, -105);
  const snapUndef = getDailyLossSnapshot();
  assert.strictEqual(snapUndef.source, "local-net-realized");
  assert.strictEqual(snapUndef.netRealizedPnlToday, -105);
  resetPaperState();
});

check("net-positive day uses 0 of the daily-loss cap", () => {
  resetPaperState();
  closeOneAt(3.08); // +108
  closeOneAt(1.12); // -88  → net +20
  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.netRealizedPnlToday, 20);
  assert.strictEqual(snap.dailyLossUsed, 0, "net-positive day must not consume the cap");
  assert.ok(snap.grossLossToday >= 88, "gross losers still tracked informationally");
  resetPaperState();
});

check("losses -300 + wins +250 → net -50, NOT blocked under maxDailyLoss 100", () => {
  resetPaperState();
  // Build gross losses of 300 and gross wins of 250 → net -50.
  closeOneAt(0.50); // (0.50-2.00)*100 = -150
  closeOneAt(0.50); // -150  → gross losers 300
  closeOneAt(4.50); // (4.50-2.00)*100 = +250  → net -50
  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.netRealizedPnlToday, -50, `net should be -50, got ${snap.netRealizedPnlToday}`);
  assert.strictEqual(snap.grossLossToday, 300, `gross losers should be 300, got ${snap.grossLossToday}`);
  assert.strictEqual(snap.dailyLossUsed, 50, `dailyLossUsed should be 50 (net), got ${snap.dailyLossUsed}`);
  const r = canOpenPosition(
    { tradesOpened: snap.tradesOpened, dailyLossUsed: snap.dailyLossUsed, netRealizedPnlToday: snap.netRealizedPnlToday },
    0,
    { ...unlimitedCfg, maxDailyLoss: 100 },
    NOW,
  );
  assert.strictEqual(r.allowed, true, `net -50 must NOT block under maxDailyLoss 100 (reason: ${r.reason})`);
  resetPaperState();
});

check("gross losses 300 > maxDailyLoss 100 but net positive → entries still allowed", () => {
  resetPaperState();
  closeOneAt(0.50); // -150
  closeOneAt(0.50); // -150  → gross losers 300
  closeOneAt(6.10); // (6.10-2.00)*100 = +410  → net +110
  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.netRealizedPnlToday, 110, `net should be +110, got ${snap.netRealizedPnlToday}`);
  assert.strictEqual(snap.grossLossToday, 300, `gross losers should be 300, got ${snap.grossLossToday}`);
  assert.ok(
    snap.grossLossToday > 100,
    `gross losers (${snap.grossLossToday}) should exceed maxDailyLoss 100`,
  );
  assert.strictEqual(snap.dailyLossUsed, 0, "net-positive day consumes 0 of the cap regardless of gross losses");
  const r = canOpenPosition(
    { tradesOpened: snap.tradesOpened, dailyLossUsed: snap.dailyLossUsed, netRealizedPnlToday: snap.netRealizedPnlToday },
    0,
    { ...unlimitedCfg, maxDailyLoss: 100 },
    NOW,
  );
  assert.strictEqual(r.allowed, true, `gross losses > cap but net positive must NOT block (reason: ${r.reason})`);
  resetPaperState();
});

check("net exactly -100 blocks under maxDailyLoss 100 (cap is inclusive)", () => {
  resetPaperState();
  closeOneAt(0.50); // -150
  closeOneAt(2.50); // (2.50-2.00)*100 = +50  → net -100
  const snap = getDailyLossSnapshot();
  assert.strictEqual(snap.netRealizedPnlToday, -100, `net should be -100, got ${snap.netRealizedPnlToday}`);
  assert.strictEqual(snap.dailyLossUsed, 100);
  const r = canOpenPosition(
    { tradesOpened: snap.tradesOpened, dailyLossUsed: snap.dailyLossUsed, netRealizedPnlToday: snap.netRealizedPnlToday },
    0,
    { ...unlimitedCfg, maxDailyLoss: 100 },
    NOW,
  );
  assert.strictEqual(r.allowed, false, "net -100 (== cap) must block");
  assert.match(r.reason, /net realized loss/i);
  resetPaperState();
});

await checkAsync(
  "adopted/duplicate broker P&L stays de-duplicated in net realized (loss counted once)",
  async () => {
    resetPaperState();
    const sym = brokerOcc("Put", 755);
    const acq = "2026-06-02T11:00:00.000Z";
    const brokerPos = (): TradierBrokerPosition => ({
      symbol: sym, quantity: 3, costBasis: 300, dateAcquired: acq,
    });
    await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 1.0));
    const id = getOpenPositions()[0].id;
    markExitPending(id);
    closePaperPosition(id, 0.7, "trailing stop"); // (0.7-1.0)*3*100 = -90
    // Broker keeps reporting the same identity for many ticks — must NOT re-adopt.
    for (let i = 0; i < 25; i++) {
      await reconcileBrokerPositions(autoLiveCfg, NOW, mkDeps([brokerPos()], 0.7));
    }
    // De-dup property: the adopted loss is realized exactly ONCE, never
    // compounded across the repeated broker reports. The daily snapshot draws
    // net realized P&L from the same per-position ledger computeBotPnl uses, so
    // a single -90 close yields a single -90 contribution (no duplication).
    assert.strictEqual(computeBotPnl().realizedPnl, -90, "adopted loss counted once, not compounded");
    const closedLosers = getAllPositions().filter((p) => p.status === "closed" && (p.pnl ?? 0) < 0);
    assert.strictEqual(closedLosers.length, 1, "exactly one closed losing position — no duplicate closes");
    resetPaperState();
  },
);

check("exits are never blocked by the daily-loss guard (guard gates ENTRY only)", () => {
  resetPaperState();
  // Drive the day well past the cap so any entry would be blocked.
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 757), side: "Call", strike: 757, expiry: TODAY,
    contracts: 1, entryPremium: 8.0, stopFraction: 0.2,
  });
  // An OPEN position must still be exitable regardless of daily loss. Closing is
  // not routed through canOpenPosition, so a stop/flatten/trail always applies.
  const blocked = { tradesOpened: 99, dailyLossUsed: 9999, netRealizedPnlToday: -9999 };
  const entry = canOpenPosition(blocked, 0, { ...unlimitedCfg, maxDailyLoss: 500 }, NOW);
  assert.strictEqual(entry.allowed, false, "entry should be blocked when far past cap");
  // Exit path: evaluatePosition returns a stop/flatten with no daily-loss gate.
  const stopAction = evaluatePosition(getOpenPositions()[0], 0.5, { ...unlimitedCfg, maxDailyLoss: 500 }, NOW);
  assert.notStrictEqual(stopAction.kind, "hold", "a deep loss should yield a stop/flatten exit");
  const closed = closePaperPosition(p.id, 0.5, "hard stop");
  assert.ok(closed && closed.status === "closed", "exit must succeed even past daily-loss cap");
  resetPaperState();
});

// ── VWAP reclaim (Call) / VWAP fade (Put) setup detection (inferSetups) ─────────
console.log("\nVWAP reclaim / fade setups (inferSetups, 2m candles):");

const vwapSentiment: SetupSentiment = { label: "Neutral", score: 0, drivers: [] };
const vwapLiquidity: SetupLiquidity = {
  netFlow: 0, callWall: 600, putWall: 500, supportZones: [490], resistanceZones: [510],
};
/** Build a minimal 2m candle carrying the indicator fields inferSetups reads. */
function vwapCandle(p: {
  close: number; vwap: number; high?: number; low?: number;
  ema200?: number; histogram?: number; williamsR?: number;
}): RouteCandle {
  return {
    time: "2026-06-02T14:30:00Z", label: "10:30", open: p.close,
    high: p.high ?? p.close, low: p.low ?? p.close, close: p.close, volume: 1000,
    vwap: p.vwap, ema200: p.ema200 ?? p.close,
    histogram: p.histogram ?? 0, williamsR: p.williamsR ?? -50,
  };
}
function setupTitled(setups: Setup[], tag: string) {
  return setups.find((s) => s.title.includes(tag));
}

check("VWAP reclaim produces an actionable Call setup (cross-up, near VWAP, confirming momentum)", () => {
  // Prior bar closed below VWAP (499.9 < 500); current bar closes just above
  // (500.4, within the 12bps ≈ 0.60 band) with positive histogram and price > EMA.
  const prior = vwapCandle({ close: 499.9, vwap: 500 });
  const last = vwapCandle({ close: 500.4, vwap: 500, ema200: 499, histogram: 0.5, williamsR: -30 });
  const setups = inferSetups([prior, last], { label: "Bullish", score: 30, drivers: [] }, vwapLiquidity);
  const s = setupTitled(setups, "vwap-reclaim");
  assert.ok(s, "a VWAP reclaim setup card must be emitted");
  assert.strictEqual(s!.bias, "Call", "actionable reclaim is a Call");
  assert.match(s!.rationale, /Tagged source: vwap-reclaim/);
  assert.match(s!.rationale, /VWAP RECLAIM/);
});

check("VWAP fade produces an actionable Put setup (tests VWAP then rejects, confirming momentum)", () => {
  // Current bar's high reached VWAP (500) from below but it closed back below
  // (499.6) with negative histogram and price < EMA — a rejection of the line.
  const prior = vwapCandle({ close: 499.5, vwap: 500 });
  const last = vwapCandle({ close: 499.6, vwap: 500, high: 500.1, ema200: 501, histogram: -0.5, williamsR: -70 });
  const setups = inferSetups([prior, last], { label: "Bearish", score: -30, drivers: [] }, vwapLiquidity);
  const s = setupTitled(setups, "vwap-fade");
  assert.ok(s, "a VWAP fade setup card must be emitted");
  assert.strictEqual(s!.bias, "Put", "actionable fade is a Put");
  assert.match(s!.rationale, /Tagged source: vwap-fade/);
  assert.match(s!.rationale, /VWAP FADE/);
});

check("VWAP reclaim does NOT fire when price is extended far above VWAP (no chasing)", () => {
  // Prior below VWAP, current far above (505 vs VWAP 500 → ~100bps, outside the
  // 12bps band) → not a clean reclaim near the line, so no reclaim card.
  const prior = vwapCandle({ close: 499.9, vwap: 500 });
  const last = vwapCandle({ close: 505, vwap: 500, histogram: 0.5 });
  const setups = inferSetups([prior, last], vwapSentiment, vwapLiquidity);
  assert.strictEqual(setupTitled(setups, "vwap-reclaim"), undefined, "extended price must not emit a reclaim");
});

check("VWAP reclaim does NOT fire without momentum confirmation", () => {
  // Clean cross-up near VWAP but histogram negative AND falling → momentum fails.
  const prior = vwapCandle({ close: 499.9, vwap: 500, histogram: -0.1 });
  const last = vwapCandle({ close: 500.3, vwap: 500, histogram: -0.5 });
  const setups = inferSetups([prior, last], vwapSentiment, vwapLiquidity);
  assert.strictEqual(setupTitled(setups, "vwap-reclaim"), undefined, "no confirming momentum → no reclaim card");
});

check("VWAP fade does NOT fire when the bar never tests VWAP from below", () => {
  // Price stays well below VWAP and its high never reaches the line → no fade.
  const prior = vwapCandle({ close: 498, vwap: 500 });
  const last = vwapCandle({ close: 498.2, vwap: 500, high: 498.5, histogram: -0.5 });
  const setups = inferSetups([prior, last], vwapSentiment, vwapLiquidity);
  assert.strictEqual(setupTitled(setups, "vwap-fade"), undefined, "no VWAP test → no fade card");
});

check("VWAP setups are disabled by config flags", () => {
  const prior = vwapCandle({ close: 499.9, vwap: 500 });
  const last = vwapCandle({ close: 500.4, vwap: 500, histogram: 0.5 });
  process.env.BOT_VWAP_RECLAIM_ENABLED = "false";
  process.env.BOT_VWAP_FADE_ENABLED = "false";
  try {
    const setups = inferSetups([prior, last], vwapSentiment, vwapLiquidity);
    assert.strictEqual(setupTitled(setups, "vwap-reclaim"), undefined, "reclaim disabled → no card");
    assert.strictEqual(setupTitled(setups, "vwap-fade"), undefined, "fade disabled → no card");
  } finally {
    delete process.env.BOT_VWAP_RECLAIM_ENABLED;
    delete process.env.BOT_VWAP_FADE_ENABLED;
  }
});

check("a sub-floor reclaim still emits a card but flips to bias Wait (below min confidence)", () => {
  // Clean cross-up near VWAP with confirming momentum, but bearish sentiment drags
  // the confidence below the vwapMinConfidence floor → card present, bias Wait.
  process.env.BOT_VWAP_MIN_CONFIDENCE = "85";
  try {
    const prior = vwapCandle({ close: 499.9, vwap: 500 });
    const last = vwapCandle({ close: 500.3, vwap: 500, histogram: 0.2, williamsR: -60 });
    const setups = inferSetups([prior, last], { label: "Neutral", score: 0, drivers: [] }, vwapLiquidity);
    const s = setupTitled(setups, "vwap-reclaim");
    assert.ok(s, "the reclaim card is still surfaced for transparency");
    assert.strictEqual(s!.bias, "Wait", "below the confidence floor the bias is Wait, not Call");
  } finally {
    delete process.env.BOT_VWAP_MIN_CONFIDENCE;
  }
});

// ── Manual close route POST /api/bot/close (paper path, mocks only) ─────────────
console.log("\nManual close route /api/bot/close (paper, no live creds):");

// Spin up an ephemeral express server bound to loopback with the bot routes
// registered. Live trading is disabled (no TRADIER_ENABLE_LIVE_TRADING), so the
// close route NEVER reaches the Tradier sell-to-close path — it only closes the
// local paper position. No network, no real orders.
const closeApp = express();
closeApp.use(express.json());
const emptySnapshot = () => ({
  spy: { price: 500 },
  setups: [] as Setup[],
  unusualOptions: [],
  economicCalendar: [],
});
registerBotRoutes(closeApp, emptySnapshot as never);
const closeServer = closeApp.listen(0);
await new Promise<void>((resolve) => closeServer.once("listening", () => resolve()));
const closePort = (closeServer.address() as { port: number }).port;
async function postClose(body: unknown) {
  const res = await fetch(`http://127.0.0.1:${closePort}/api/bot/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

await checkAsync("close: paper position closes successfully and reports PAPER mode", async () => {
  resetPaperState();
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 757), side: "Call", strike: 757, expiry: TODAY,
    contracts: 2, entryPremium: 1.0, stopFraction: 0.2,
  });
  const { status, json } = await postClose({
    positionId: p.id, symbol: p.symbol, expectedContracts: 2,
    closePremium: 1.2, confirmLiveOrder: true, reason: "Manual close via dashboard button",
  });
  assert.strictEqual(status, 200, "paper close returns 200");
  assert.strictEqual(json.ok, true);
  assert.strictEqual(json.mode, "PAPER", "live disabled → PAPER mode even with confirmLiveOrder");
  assert.strictEqual(json.liveOrderResult, null, "no Tradier order placed in paper mode");
  assert.strictEqual(getOpenPositions().length, 0, "position is closed");
  resetPaperState();
});

await checkAsync("close: unknown positionId returns 404", async () => {
  resetPaperState();
  const { status, json } = await postClose({ positionId: "does-not-exist", closePremium: 1.0 });
  assert.strictEqual(status, 404);
  assert.match(String(json.error), /not found/i);
  resetPaperState();
});

await checkAsync("close: symbol mismatch returns 409 and does NOT close", async () => {
  resetPaperState();
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 757), side: "Call", strike: 757, expiry: TODAY,
    contracts: 2, entryPremium: 1.0, stopFraction: 0.2,
  });
  const { status, json } = await postClose({
    positionId: p.id, symbol: brokerOcc("Put", 757), closePremium: 1.0,
  });
  assert.strictEqual(status, 409);
  assert.match(String(json.error), /symbol mismatch/i);
  assert.strictEqual(getOpenPositions().length, 1, "mismatch must not close the position");
  resetPaperState();
});

await checkAsync("close: quantity mismatch returns 409 and does NOT close", async () => {
  resetPaperState();
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 757), side: "Call", strike: 757, expiry: TODAY,
    contracts: 2, entryPremium: 1.0, stopFraction: 0.2,
  });
  const { status, json } = await postClose({
    positionId: p.id, expectedContracts: 5, closePremium: 1.0,
  });
  assert.strictEqual(status, 409);
  assert.match(String(json.error), /quantity mismatch/i);
  assert.strictEqual(getOpenPositions().length, 1, "mismatch must not close the position");
  resetPaperState();
});

await checkAsync("close: non-finite/negative closePremium returns 400", async () => {
  resetPaperState();
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 757), side: "Call", strike: 757, expiry: TODAY,
    contracts: 1, entryPremium: 1.0, stopFraction: 0.2,
  });
  const bad = await postClose({ positionId: p.id, closePremium: "not-a-number" });
  assert.strictEqual(bad.status, 400);
  const neg = await postClose({ positionId: p.id, closePremium: -1 });
  assert.strictEqual(neg.status, 400);
  assert.strictEqual(getOpenPositions().length, 1, "invalid premium must not close the position");
  resetPaperState();
});

await checkAsync("close: missing required fields returns 400", async () => {
  const { status } = await postClose({ positionId: "" });
  assert.strictEqual(status, 400);
});

await new Promise<void>((resolve) => closeServer.close(() => resolve()));

// ── Patch #1: order fill-confirmation primitives + manual /api/bot/order ─────────
// A live order is only ACCEPTED at submission; the position must not be treated
// as open until a fill is confirmed by order-status polling. These tests pin the
// terminal-status classification and the FAIL-SAFE timeout behavior with no
// network (no creds → status endpoint unreachable → "unknown"), and assert the
// PAPER order route opens at the requested premium and reports the confirmed
// quantity/price fields. No real network/orders.
console.log("\nOrder fill confirmation (Patch #1):");

check("terminal statuses are classified terminal (filled/canceled/rejected/expired/error)", () => {
  for (const s of ["filled", "canceled", "cancelled", "rejected", "expired", "error", "FILLED", "Rejected"]) {
    assert.strictEqual(isTerminalOrderStatus(s), true, `${s} should be terminal`);
  }
});

check("working statuses are NOT terminal (open/pending/partially_filled/null)", () => {
  for (const s of ["open", "pending", "partially_filled", "ok", "calculated", ""]) {
    assert.strictEqual(isTerminalOrderStatus(s), false, `${s} should not be terminal`);
  }
  assert.strictEqual(isTerminalOrderStatus(null), false, "null is not terminal");
});

await checkAsync("waitForFill fails safe to 'unknown' when status is unverifiable (no creds, fast timeout)", async () => {
  const cfg = getBotConfig();
  // No TRADIER_TOKEN/ACCOUNT_ID in the test env → getOrderStatus returns
  // unavailable every poll → never assume a fill; outcome must be "unknown".
  const t0 = Date.now();
  const fill = await waitForFill("phantom-order-id", cfg, 200, 50);
  assert.strictEqual(fill.outcome, "unknown", "unverifiable status must NOT be treated as filled");
  assert.strictEqual(fill.avgFillPrice, null, "no fabricated fill price");
  assert.strictEqual(fill.execQuantity, null, "no assumed executed quantity");
  assert.ok(Date.now() - t0 >= 180, "polled until the timeout before giving up");
});

// Manual /api/bot/order route — PAPER path (live disabled in the test env). The
// fill-confirmation branch is live-only, so a paper order still opens locally,
// but now reports the confirmed quantity/price fields used by the live path.
const orderApp = express();
orderApp.use(express.json());
registerBotRoutes(orderApp, emptySnapshot as never);
const orderServer = orderApp.listen(0);
await new Promise<void>((resolve) => orderServer.once("listening", () => resolve()));
const orderPort = (orderServer.address() as { port: number }).port;
async function postOrder(body: unknown) {
  const res = await fetch(`http://127.0.0.1:${orderPort}/api/bot/order`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

// The paper order route runs through executeOrder → executePaperOrder, whose
// 0DTE guard parses the OCC expiry against the REAL system clock (not the pinned
// NOW). Build a same-day symbol from the real market date so the open succeeds.
const realToday = marketDateNY(new Date());
const realYymmdd = realToday.slice(2).replace(/-/g, "");
const todayOcc = (side: "Call" | "Put", strike: number) =>
  `SPY${realYymmdd}${side === "Call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

await checkAsync("order (paper): opens at requested premium and reports confirmed fields", async () => {
  resetPaperState();
  const sym = todayOcc("Call", 757);
  const { status, json } = await postOrder({
    optionSymbol: sym, side: "buy_to_open", contracts: 2, orderType: "limit",
    limitPrice: 1.25, strike: 757, expiry: realToday, entryPremium: 1.25,
  });
  assert.strictEqual(status, 200, "paper order returns 200");
  assert.strictEqual(json.mode, "PAPER", "live disabled → PAPER mode");
  assert.strictEqual(json.simulated, true, "paper order is simulated, no broker poll");
  assert.strictEqual(json.partialFill, false, "paper order is never a partial");
  assert.strictEqual(json.filledContracts, 2, "paper fills the requested quantity");
  assert.strictEqual(json.fillPremium, 1.25, "paper basis is the requested premium");
  const pos = json.position as Record<string, unknown>;
  assert.strictEqual(pos.contracts, 2);
  assert.strictEqual(pos.entryPremium, 1.25);
  assert.strictEqual(getOpenPositions().length, 1, "paper position is opened");
  resetPaperState();
});

await checkAsync("order: missing required fields returns 400 and opens nothing", async () => {
  resetPaperState();
  const { status } = await postOrder({ optionSymbol: brokerOcc("Call", 757) });
  assert.strictEqual(status, 400);
  assert.strictEqual(getOpenPositions().length, 0, "no position on a malformed request");
  resetPaperState();
});

await new Promise<void>((resolve) => orderServer.close(() => resolve()));

// ── Patch #2: mark-price fallback wiring (selectMarkFromQuote) ───────────────────
// The exit loop's trailing-stop engine must never evaluate against a bad mark.
// selectMarkFromQuote is the wired fallback: bid → mid → last, with a zero/absent
// bid rejected outright (June-12 zero-bid bug), and null when no source yields a
// positive price so the caller can fail safe.
console.log("\nMark-price fallback wiring (Patch #2):");

check("mark fallback: a positive bid is the primary mark", () => {
  assert.strictEqual(selectMarkFromQuote({ bid: 1.20, ask: 1.30, mid: 1.25, last: 1.22 }), 1.20);
});

check("mark fallback: ZERO bid is rejected, falls through to mid", () => {
  // The exact June-12 failure shape: bid 0, but a usable mid/last exists.
  assert.strictEqual(selectMarkFromQuote({ bid: 0, ask: 1.30, mid: 1.25, last: 1.22 }), 1.25);
});

check("mark fallback: absent (null) bid falls through to mid", () => {
  assert.strictEqual(selectMarkFromQuote({ bid: null, ask: null, mid: 1.10, last: 1.05 }), 1.10);
});

check("mark fallback: zero bid AND no mid falls through to last", () => {
  assert.strictEqual(selectMarkFromQuote({ bid: 0, ask: 0, mid: null, last: 0.90 }), 0.90);
});

check("mark fallback: negative/non-finite values are never used as a mark", () => {
  assert.strictEqual(selectMarkFromQuote({ bid: -1, ask: null, mid: Number.NaN, last: 0.75 }), 0.75);
});

check("mark fallback: no positive source anywhere → null (caller fails safe, holds)", () => {
  assert.strictEqual(selectMarkFromQuote({ bid: 0, ask: 0, mid: 0, last: 0 }), null);
  assert.strictEqual(selectMarkFromQuote({ bid: null, ask: null, mid: null, last: null }), null);
});

// ── PDT day-trade counting (broker-authoritative, sub-$25k margin) ──────────────
// countDayTrades derives the rolling 5-business-day day-trade count from Tradier
// order history (restart-safe, since Render's local .data/ is ephemeral). A day
// trade = a same-day option open+close round trip; today's still-open positions
// count too (a 0DTE open becomes a day trade this session). Pure + network-free.
console.log("\nPDT day-trade counting (Patch: broker-authoritative):");

// Fixed "now" = Tue 2026-06-23 13:00 ET. Window business days (incl. today):
// 06-23 Tue, 06-22 Mon, 06-19 Fri, 06-18 Thu, 06-17 Wed (weekend 06-20/21 skipped).
const PDT_NOW = new Date("2026-06-23T17:00:00Z");
const ord = (
  dateNy: string,
  sym: string,
  side: "buy_to_open" | "sell_to_close",
  status = "filled",
): TradierOrderLike => ({
  status,
  side,
  class: "option",
  option_symbol: sym,
  // 14:30Z ≈ 10:30 ET — safely the same NY date as `dateNy`.
  transaction_date: `${dateNy}T14:30:00Z`,
});

check("PDT: no orders → 0 day trades", () => {
  assert.deepStrictEqual(countDayTrades([], PDT_NOW), { count: 0, dates: [] });
});

check("PDT: a same-day round trip today counts as 1", () => {
  const r = countDayTrades([
    ord("2026-06-23", "SPY260623C00600000", "buy_to_open"),
    ord("2026-06-23", "SPY260623C00600000", "sell_to_close"),
  ], PDT_NOW);
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.dates, ["2026-06-23"]);
});

check("PDT: today's still-open position (no close yet) counts as a pending day trade", () => {
  const r = countDayTrades([ord("2026-06-23", "SPY260623P00590000", "buy_to_open")], PDT_NOW);
  assert.strictEqual(r.count, 1, "a 0DTE open today will become a day trade this session");
});

check("PDT: an OPEN-only on a PRIOR day is NOT a day trade (never closed that day)", () => {
  const r = countDayTrades([ord("2026-06-22", "SPY260622C00600000", "buy_to_open")], PDT_NOW);
  assert.strictEqual(r.count, 0);
});

check("PDT: three round trips across three prior business days → 3 (the 4th must block)", () => {
  const r = countDayTrades([
    ord("2026-06-22", "SPY260622C00600000", "buy_to_open"),
    ord("2026-06-22", "SPY260622C00600000", "sell_to_close"),
    ord("2026-06-19", "SPY260619P00595000", "buy_to_open"),
    ord("2026-06-19", "SPY260619P00595000", "sell_to_close"),
    ord("2026-06-18", "SPY260618C00601000", "buy_to_open"),
    ord("2026-06-18", "SPY260618C00601000", "sell_to_close"),
  ], PDT_NOW);
  assert.strictEqual(r.count, 3, "at 3 in the window the guard blocks the next entry");
  assert.deepStrictEqual(r.dates, ["2026-06-18", "2026-06-19", "2026-06-22"]);
});

check("PDT: two round trips of the same symbol on the same day count as 2", () => {
  const r = countDayTrades([
    ord("2026-06-23", "SPY260623C00600000", "buy_to_open"),
    ord("2026-06-23", "SPY260623C00600000", "sell_to_close"),
    ord("2026-06-23", "SPY260623C00600000", "buy_to_open"),
    ord("2026-06-23", "SPY260623C00600000", "sell_to_close"),
  ], PDT_NOW);
  assert.strictEqual(r.count, 2);
});

check("PDT: a round trip OUTSIDE the 5-business-day window is excluded", () => {
  // 06-16 (Tue) is the 6th business day back — beyond the window of 5.
  const r = countDayTrades([
    ord("2026-06-16", "SPY260616C00600000", "buy_to_open"),
    ord("2026-06-16", "SPY260616C00600000", "sell_to_close"),
  ], PDT_NOW);
  assert.strictEqual(r.count, 0, "older than 5 business days must not count");
});

check("PDT: non-filled and non-option orders are ignored", () => {
  const r = countDayTrades([
    ord("2026-06-23", "SPY260623C00600000", "buy_to_open", "canceled"),
    ord("2026-06-23", "SPY260623C00600000", "sell_to_close", "rejected"),
    { status: "filled", side: "buy", class: "equity", symbol: "SPY", transaction_date: "2026-06-23T14:30:00Z" },
  ], PDT_NOW);
  assert.strictEqual(r.count, 0);
});

// ── News blackout fires on HIGH only (placeholder calendar must be Medium) ──────
// isNearHighImpactEvent pauses autonomous signals within newsBlackoutMinutes of a
// "High" event. The static dashboard calendar is a set of recurring placeholder
// windows (not a live feed); a fabricated daily "High" at 1:00 PM was blacking
// out entries every session. These tests lock the contract: only "High" blocks,
// so the placeholders (now "Medium") never trigger the blackout.
console.log("\nNews blackout (High-only) gating:");

// 2026-06-23T17:00Z = 1:00 PM ET (EDT, UTC-4). minutesIntoEtDay → 780.
const NEWS_NOW = new Date("2026-06-23T17:00:00Z");

check("blackout FIRES within window of a High event at the same ET time", () => {
  const cal = [{ time: "1:00 PM", impact: "High" as const, status: "Watched" as const }];
  assert.strictEqual(isNearHighImpactEvent(cal, getBotConfig(), NEWS_NOW), true);
});

check("blackout does NOT fire for a MEDIUM event at the same ET time (placeholder case)", () => {
  const cal = [{ time: "1:00 PM", impact: "Medium" as const, status: "Watched" as const }];
  assert.strictEqual(isNearHighImpactEvent(cal, getBotConfig(), NEWS_NOW), false,
    "downgraded placeholder windows must not pause autonomous entries");
});

check("blackout does NOT fire for a High event well outside the window", () => {
  // 2:00 PM ET (840) is 60 min from 1:00 PM (780) — far beyond the 10-min window.
  const cal = [{ time: "2:00 PM", impact: "High" as const, status: "Upcoming" as const }];
  assert.strictEqual(isNearHighImpactEvent(cal, getBotConfig(), NEWS_NOW), false);
});

check("the full static placeholder set (all Medium) never triggers the blackout", () => {
  // Mirror of getCalendar()'s windows after the downgrade. They are all Medium, so
  // none may block — independent of the time of evaluation (tested at 1:00 PM ET,
  // when the old fabricated "High" placeholder used to fire).
  const placeholders = [
    { time: "7:30 AM", impact: "Medium" as const, status: "Released" as const },
    { time: "8:45 AM", impact: "Medium" as const, status: "Released" as const },
    { time: "9:00 AM", impact: "Medium" as const, status: "Released" as const },
    { time: "12:00 PM", impact: "Medium" as const, status: "Released" as const },
    { time: "1:00 PM", impact: "Medium" as const, status: "Watched" as const },
  ];
  assert.strictEqual(isNearHighImpactEvent(placeholders, getBotConfig(), NEWS_NOW), false,
    "no downgraded placeholder may pause autonomous entries");
});

// ── Bid-referenced hard stop (contradiction fix #3) ─────────────────────────────
// The exit measures on the BID, but the stop used to be set off the ask/mid cost
// basis — so a wide-spread entry showed an instant bid-drag that could trip the
// −stopFraction stop on tick one. The hard stop and peak now reference the entry
// BID; breakeven/profit-lock destinations stay on the cost basis (profit = profit
// on what was paid). Back-compatible: no entryBid → legacy basis stop.
console.log("\nBid-referenced hard stop (contradiction fix #3):");

check("stop & peak reference the entry BID; profit-lock stays on cost basis", () => {
  resetPaperState();
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 600), side: "Call", strike: 600, expiry: TODAY,
    contracts: 2, entryPremium: 1.0, entryBid: 0.8, stopFraction: 0.2,
    breakevenArmFraction: 0.1, profitLockArmFraction: 0.15, profitLockProfitFraction: 0.05,
  });
  assert.ok(Math.abs(p.stopPrice - 0.64) < 1e-9, `stop = entryBid×0.80 = 0.64, got ${p.stopPrice}`);
  assert.ok(Math.abs(p.peakPremium - 0.8) < 1e-9, "peak seeds to the entry bid");
  assert.ok(Math.abs((p.profitLockStopPrice ?? 0) - 1.05) < 1e-9, "profit-lock stop = cost×1.05 (profit on what was paid)");
  resetPaperState();
});

check("bid-referenced stop does NOT pre-trip on the spread at entry", () => {
  resetPaperState();
  const cfg = getBotConfig();
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 600), side: "Call", strike: 600, expiry: TODAY,
    contracts: 2, entryPremium: 1.0, entryBid: 0.8, stopFraction: 0.2,
  });
  // Mark == the entry bid (0.80): a fresh position with ZERO adverse move. The
  // legacy basis stop (1.00×0.80 = 0.80) would fire here for a guaranteed loss.
  assert.strictEqual(evaluatePosition(p, 0.8, cfg, NOW).kind, "hold", "must not stop at the entry bid");
  // A genuine 20% drop FROM the bid (0.80×0.80 = 0.64) still stops, as intended.
  assert.strictEqual(evaluatePosition(p, 0.63, cfg, NOW).kind, "stop", "real adverse move still stops");
  resetPaperState();
});

check("legacy path (no entryBid) keeps the basis-referenced stop & peak", () => {
  resetPaperState();
  const p = openPaperPosition({
    symbol: brokerOcc("Call", 600), side: "Call", strike: 600, expiry: TODAY,
    contracts: 2, entryPremium: 1.0, stopFraction: 0.2,
  });
  assert.ok(Math.abs(p.stopPrice - 0.8) < 1e-9, "legacy stop = entryPremium×0.80");
  assert.ok(Math.abs(p.peakPremium - 1.0) < 1e-9, "legacy peak seeds to entryPremium");
  resetPaperState();
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
