/**
 * Deterministic modeled example for the 4 → 3 → 2 sizing ladder.
 *
 * Shows, at a small-account buying power, premiums where:
 *   • 4 and 3 contracts cannot be afforded / breach risk, but 2 passes
 *     (so the OLD min-3 rule would have SKIPPED the trade — a missed trade),
 *   • and a premium where even 2 fails (correctly blocked).
 *
 * Offline only — pure arithmetic against sizePosition(). No network, no orders.
 */
import { getBotConfig, type BotConfig } from "../server/bot/config";
import { sizePosition } from "../server/bot/riskManager";

// Recorded option buying power from the live small account (same value the
// selector backtest uses). The 4/3/2 ladder is judged against this BP.
const BUYING_POWER = 368.96;
const cfg: BotConfig = getBotConfig();

// Simulate the OLD behavior (hard min = 3) by running the same sizer with
// minContractsPerTrade forced back to 3.
const oldCfg: BotConfig = { ...cfg, minContractsPerTrade: 3 };

function row(premium: number) {
  const now = sizePosition(premium, cfg, BUYING_POWER);
  const old = sizePosition(premium, oldCfg, BUYING_POWER);
  const cost4 = (premium * 100 * 4).toFixed(0);
  const cost3 = (premium * 100 * 3).toFixed(0);
  const cost2 = (premium * 100 * 2).toFixed(0);
  const verdict =
    old.contracts === 0 && now.contracts > 0
      ? "RESCUED (old=skip, new=trade)"
      : old.contracts === now.contracts
        ? "same"
        : "changed";
  console.log(
    `premium $${premium.toFixed(2).padStart(5)} | 4ctr=$${cost4} 3ctr=$${cost3} 2ctr=$${cost2} ` +
      `| OLD(min3)=${old.contracts} NEW(min2)=${now.contracts} | ${verdict}`,
  );
  console.log(`    new reason: ${now.reason}`);
}

console.log(`Buying power: $${BUYING_POWER}  | max-loss-per-trade: $${cfg.maxLossPerTrade}  | stop ${cfg.stopLossFraction * 100}%`);
console.log(`Ladder: preferred ${cfg.preferredContractsPerTrade} → min ${cfg.minContractsPerTrade}\n`);

// 1) cheap premium — 4 affordable: preferred honored.
row(0.5);
// 2) premium where 4 ($640) and 3 ($480) exceed BP $368.96 but 2 ($320) fits:
//    OLD min-3 would SKIP; NEW lands on 2 → trade NOT missed.
row(1.6);
// 3) the live-recorded T2 premium 1.32: 3 ctr $396 > BP, 2 ctr $264 ≤ BP → rescued.
row(1.32);
// 4) richer premium 1.84: 3 ctr $552 > BP, 2 ctr $368 ≤ BP $368.96 → rescued at the edge.
row(1.84);
// 5) premium where even 2 contracts cannot be afforded → correctly BLOCKED.
row(1.9);
