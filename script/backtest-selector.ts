/**
 * OFFLINE backtest/replay of the 2026-06-08 SPY 0DTE trades across contract-
 * selection policies. No orders, no live endpoints, no tokens, no push.
 *
 * ── METHOD ────────────────────────────────────────────────────────────────────
 * The bot recorded only 3 premium points per trade (entry / peak / close) plus
 * the underlying spyAtEntry and the trade's MFE. There is no minute-by-minute
 * option path, so we MODEL alternative-strike outcomes from the recorded
 * underlying move using a per-strike delta derived from the live snapshot chain
 * (adjacent-strike premium differences ≈ delta). For each trade:
 *
 *   underlyingMoveAtPeak  = (actualPeakPrem − actualEntryPrem) / actualDelta
 *   altPeakPrem           = altEntryPrem + altDelta × underlyingMoveAtPeak
 *   altMfePct             = altPeakPrem / altEntryPrem − 1
 *
 * Exit model = the SHIPPING engine rules (−20% hard stop, +35% trail arm, 5%
 * giveback). All four real trades followed an up-then-down path (peak then
 * round-trip), so:
 *   • altMfePct ≥ +35%  → trail arms, exit ≈ peak − 5% giveback (locks a gain)
 *   • altMfePct <  +35% → round-trips through entry to the −20% hard stop
 * This mirrors EXACTLY what happened live (T3 armed at +42%→+34% kept; T1/T2/T4
 * stalled < +35% and lost −20%+). P&L = pct × altEntryPrem × 100 × contracts.
 *
 * Contract count respects the engine's 4-preferred / 2-min sizing ladder with the
 * recorded buyingPower so a richer (ATM/ITM) premium can reduce the lot count.
 *
 * Selection per policy uses the REAL selectSmartContract() scorer from the repo
 * where applicable, so the backtest exercises shipping code, not a re-impl.
 * NOT FINANCIAL ADVICE.
 */

import fs from "node:fs";
import path from "node:path";
import {
  selectSmartContract,
  defaultSmartParams,
  type SelectorOption,
} from "../server/bot/contractSelector.js";

const WORKSPACE = "/home/user/workspace";
const snap = JSON.parse(
  fs.readFileSync(path.join(WORKSPACE, "snapshot_today.json"), "utf8"),
);
const diag = JSON.parse(
  fs.readFileSync(
    path.join(WORKSPACE, "spy_today_trade_diagnostic_2026-06-08.json"),
    "utf8",
  ),
);

const SPOT = snap.spy.price as number; // 743.97
const NOW = new Date("2026-06-08T15:00:00Z");

// Engine baseline (from the diagnostic + bot config defaults).
const STOP = 0.2; // -20% hard stop
const TRAIL_ARM = 0.35; // +35% arm
const GIVEBACK = 0.05; // 5% giveback after arm
const PREFERRED = 4;
const MIN_CONTRACTS = 2;
const MAX_LOSS_PER_TRADE = 100; // small-account guard
const BUYING_POWER = 368.96; // recorded option buying power

// Live Call chain (uniform score 99, ~1¢ spreads).
const callChain: SelectorOption[] = snap.unusualOptions
  .filter((o: any) => o.side === "Call")
  .map((o: any) => ({
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
  }))
  .sort((a: SelectorOption, b: SelectorOption) => a.strike - b.strike);

const mid = (o: SelectorOption) => (o.bid + o.ask) / 2;

// Per-strike delta derived from adjacent-strike premiums (chain-implied).
// delta(K) ≈ mid(K) − mid(K+1)  (strike step = $1). ITM strikes get the higher
// delta, ATM ≈ 0.59, 1-OTM ≈ 0.48, 2-OTM ≈ 0.37 on this chain.
function chainDelta(strike: number): number {
  const i = callChain.findIndex((o) => o.strike === strike);
  if (i < 0) return 0.5;
  if (i < callChain.length - 1) return mid(callChain[i]) - mid(callChain[i + 1]);
  // last strike: reuse the step below it
  return i > 0 ? mid(callChain[i - 1]) - mid(callChain[i]) : 0.4;
}

// Strike ladder anchored at spot: ATM = nearest strike, +n = n OTM (Calls).
const atmStrike = callChain
  .map((o) => o.strike)
  .reduce((best, k) => (Math.abs(k - SPOT) < Math.abs(best - SPOT) ? k : best), callChain[0].strike);

function strikeForOffset(offset: number): number {
  return atmStrike + offset; // Calls: +offset strikes OTM
}

function sizeContracts(entryPrem: number): number {
  // Mirror engine intent: ladder 4 → 3 → 2 (min 2), capped by max-loss-per-trade and BP.
  const perContractCost = entryPrem * 100;
  const maxLossCost = MAX_LOSS_PER_TRADE / (STOP * entryPrem * 100); // contracts s.t. 20% loss ≤ $100
  const byBp = Math.floor(BUYING_POWER / perContractCost);
  let qty = PREFERRED;
  qty = Math.min(qty, Math.floor(maxLossCost));
  qty = Math.min(qty, byBp);
  if (qty < MIN_CONTRACTS) {
    // Allow min 2 only if BP still covers it; else whatever BP allows (≥1).
    qty = Math.min(MIN_CONTRACTS, byBp);
  }
  return Math.max(1, qty);
}

/** Model an alternative strike's outcome for one recorded trade. */
function modelTrade(
  trade: any,
  altStrike: number,
): {
  strike: number;
  entryPrem: number;
  delta: number;
  mfePct: number;
  armed: boolean;
  exitPct: number;
  contracts: number;
  pnl: number;
} {
  const actualDelta = chainDelta(trade.actualStrike);
  const altDelta = chainDelta(altStrike);
  // Underlying move ($) implied by the actual contract's peak gain.
  const actualPeakGain = trade.peak - trade.entry; // premium $
  const underlyingMove = actualDelta > 0 ? actualPeakGain / actualDelta : 0;

  // Alt entry premium from the chain mid, scaled to the trade's actual entry
  // timing: the snapshot is a single late-session frame, so we anchor the alt
  // premium to the actual entry by preserving the chain's RELATIVE pricing.
  // altEntry = actualEntry × (chainMid(alt) / chainMid(actualStrike)).
  const chainMidAlt = mid(callChain.find((o) => o.strike === altStrike)!);
  const chainMidActual = mid(callChain.find((o) => o.strike === trade.actualStrike)!);
  const altEntry = +(trade.entry * (chainMidAlt / chainMidActual)).toFixed(2);

  const altPeak = altEntry + altDelta * underlyingMove;
  const mfePct = altEntry > 0 ? altPeak / altEntry - 1 : 0;

  const armed = mfePct >= TRAIL_ARM;
  // Armed → lock peak minus 5% giveback. Not armed → round-trip to −20% stop.
  const exitPct = armed ? mfePct - GIVEBACK : -STOP;

  const contracts = sizeContracts(altEntry);
  const pnl = Math.round(exitPct * altEntry * 100 * contracts);

  return { strike: altStrike, entryPrem: altEntry, delta: +altDelta.toFixed(3), mfePct: +(mfePct * 100).toFixed(1), armed, exitPct: +(exitPct * 100).toFixed(1), contracts, pnl };
}

// Map diagnostic trades → backtest input (actual strike parsed from contract).
const trades = diag.trades.map((t: any) => ({
  id: t.id,
  actualStrike: Number(t.contract.slice(-8)) / 1000,
  entry: t.entry,
  peak: t.peak,
  close: t.close,
  actualMfePct: t.mfePct,
  actualPnl: t.pnl,
  actualQty: t.qty,
  spyAtEntry: t.spyAtEntry,
}));

// ── Policies ────────────────────────────────────────────────────────────────
// Each policy picks an alternative strike per trade. fixed_1otm reproduces the
// actual selection (the bot's current behavior). The smart policies use the REAL
// scorer to choose among ATM..maxOTM on the live chain (uniform score/spread, so
// the differentiator here is premium-strength / delta = moneyness).
type Policy = {
  key: string;
  label: string;
  pick: (trade: any) => number; // returns chosen strike
};

const smartParams = (maxOtm: number) => ({
  ...defaultSmartParams(60, 0.15, 0.3),
  maxOtmStrikes: maxOtm,
});

function smartPick(maxOtm: number): number {
  const res = selectSmartContract(callChain, "Call", SPOT, smartParams(maxOtm), NOW);
  return res.best ? res.best.option.strike : atmStrike;
}

const policies: Policy[] = [
  {
    key: "fixed_1otm_actual",
    label: "Fixed 1-OTM (current / actual)",
    pick: () => strikeForOffset(1),
  },
  { key: "atm_only", label: "ATM only", pick: () => strikeForOffset(0) },
  {
    key: "smart_atm_1otm",
    label: "Smart best of ATM+1OTM",
    pick: () => smartPick(1),
  },
  {
    key: "smart_atm_1otm_2otm",
    label: "Smart best of ATM+1OTM+2OTM",
    pick: () => smartPick(2),
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────
const rows: any[] = [];
const policyTotals: Record<string, number> = {};

for (const p of policies) {
  let total = 0;
  for (const t of trades) {
    const strike = p.pick(t);
    const m = modelTrade(t, strike);
    total += m.pnl;
    rows.push({
      policy: p.key,
      policyLabel: p.label,
      trade: t.id,
      actualStrike: t.actualStrike,
      actualPnl: t.actualPnl,
      altStrike: m.strike,
      altOffset: m.strike - atmStrike,
      altEntryPrem: m.entryPrem,
      altDelta: m.delta,
      altMfePct: m.mfePct,
      armed: m.armed,
      altExitPct: m.exitPct,
      contracts: m.contracts,
      modeledPnl: m.pnl,
    });
  }
  policyTotals[p.key] = total;
}

// ── Output ──────────────────────────────────────────────────────────────────
console.log("\n=== SPY 0DTE Contract-Selector Backtest (2026-06-08) ===");
console.log(`Spot ${SPOT}  ATM strike ${atmStrike}  | actual day P&L: ${diag.counterfactuals.actual.dayTotal}\n`);
console.log("Chain-implied deltas (Call):");
for (const k of [741, 742, 743, 744, 745, 746]) {
  console.log(`  ${k} (${k - atmStrike >= 0 ? "+" : ""}${k - atmStrike} off ATM)  mid $${mid(callChain.find((o) => o.strike === k)!).toFixed(3)}  delta~${chainDelta(k).toFixed(3)}`);
}

for (const p of policies) {
  console.log(`\n--- ${p.label} [${p.key}] ---`);
  const prs = rows.filter((r) => r.policy === p.key);
  for (const r of prs) {
    console.log(
      `  ${r.trade}: K${r.altStrike}(${r.altOffset >= 0 ? "+" : ""}${r.altOffset}) Δ${r.altDelta} entry$${r.altEntryPrem} x${r.contracts}  MFE ${r.altMfePct}%  ${r.armed ? "ARMED✓" : "stall"}  exit ${r.altExitPct}%  → $${r.modeledPnl}`,
    );
  }
  console.log(`  DAY TOTAL: $${policyTotals[p.key]}`);
}

console.log("\n=== Summary (modeled day P&L) ===");
const ranked = policies
  .map((p) => ({ key: p.key, label: p.label, total: policyTotals[p.key] }))
  .sort((a, b) => b.total - a.total);
ranked.forEach((r, i) => console.log(`  ${i + 1}. ${r.label}: $${r.total}`));
console.log(`  (actual fixed-OTM live result: $${diag.counterfactuals.actual.dayTotal})`);

// Write CSV + JSON artifacts.
const header = [
  "policy", "policyLabel", "trade", "actualStrike", "actualPnl", "altStrike",
  "altOffset", "altEntryPrem", "altDelta", "altMfePct", "armed", "altExitPct",
  "contracts", "modeledPnl",
];
const csv = [
  header.join(","),
  ...rows.map((r) => header.map((h) => r[h]).join(",")),
  "",
  "policy,dayTotal",
  ...policies.map((p) => `${p.key},${policyTotals[p.key]}`),
].join("\n");

fs.writeFileSync(path.join(WORKSPACE, "spy_smart_contract_selector_backtest.csv"), csv);
fs.writeFileSync(
  path.join(WORKSPACE, "spy_smart_contract_selector_backtest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode: "OFFLINE_ANALYSIS_ONLY",
      disclaimer:
        "No orders, no live endpoints, no tokens, no push. Modeled from 3-point premium path + chain-implied deltas. Not financial advice.",
      spot: SPOT,
      atmStrike,
      chainImpliedDelta: Object.fromEntries(
        [741, 742, 743, 744, 745, 746].map((k) => [k, +chainDelta(k).toFixed(3)]),
      ),
      engine: { STOP, TRAIL_ARM, GIVEBACK, PREFERRED, MIN_CONTRACTS, MAX_LOSS_PER_TRADE, BUYING_POWER },
      actualDayTotal: diag.counterfactuals.actual.dayTotal,
      rows,
      policyTotals,
      method:
        "altEntry = actualEntry × chainMid(alt)/chainMid(actual); underlyingMove = (actualPeak−actualEntry)/actualDelta; altPeak = altEntry + altDelta×underlyingMove; +35% arm → lock peak−5%, else −20% stop.",
      limitations: [
        "Only entry/peak/close recorded; alternative premium path modeled not observed.",
        "Chain is a single late-session snapshot; alt entry premiums scaled by relative chain pricing.",
        "Uniform snapshot score(99)/spread(~1¢) ⇒ selector differentiator on this data is delta/premium (moneyness), not liquidity.",
        "Up-then-down path assumed (matches all four recorded trades).",
      ],
    },
    null,
    2,
  ),
);

console.log("\nWrote spy_smart_contract_selector_backtest.csv / .json to workspace.");
