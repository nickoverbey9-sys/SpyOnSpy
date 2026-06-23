/**
 * Stop-configuration 2×2 sweep for the SPY 0DTE bot.
 *
 * Runs the REAL backtest (script/backtest-bot.ts) four times over the SAME
 * sessions, varying two independent levers, then writes one comparison report:
 *
 *   Lever 1 — protective stops:
 *     • "be+pl"  current config: breakeven @ +10% MFE + profit-lock @ +15% MFE
 *     • "trail"  trailing-only: breakeven AND profit-lock disabled
 *   Lever 2 — A+ proximity entry gate:
 *     • "aplus-off"  current config (gate disabled)
 *     • "aplus-on"   only enter setups whose trigger sits near a structure level
 *
 * The hard −stop and the +trailStart give-back trail are unchanged in every arm.
 *
 * Data source is inherited from the parent environment, so the operator controls
 * real-vs-synthetic ONCE on the outer call:
 *
 *   # Real data (Theta Terminal must be running locally):
 *   BOT_BACKTEST_DATA=thetadata BOT_BACKTEST_SESSIONS=15 \
 *     npx tsx script/backtest-stop-sweep.ts
 *
 *   # Mechanics-only synthetic (no terminal needed; NOT deployable evidence):
 *   npx tsx script/backtest-stop-sweep.ts
 *
 * Output: ./backtest-sweep/<arm>/...  per-arm reports, plus
 *         ./backtest-sweep/COMPARISON.md  the headline + exit-reason table.
 *
 * ⚠ Past performance does not predict future results. Not financial advice.
 */
import "./backtest-env.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(here, "..");
// Relative script path + cwd=PROJECT_ROOT so no spawn arg contains a space
// (the project path "C:\Trading Bot\..." otherwise breaks Windows shell quoting).
const BACKTEST = path.join("script", "backtest-bot.ts");
const ROOT = process.env.BOT_SWEEP_OUT_DIR ?? "./backtest-sweep";

interface Arm {
  id: string;
  label: string;
  env: Record<string, string>;
}

// breakeven OFF = BOT_BREAKEVEN_ARM_FRACTION=0; profit-lock OFF = arm fraction 0.
const STOP_VARIANTS: Array<{ key: string; label: string; env: Record<string, string> }> = [
  {
    key: "be+pl",
    label: "Breakeven@+10% + Profit-lock@+15% (current)",
    env: { BOT_BREAKEVEN_ARM_FRACTION: "0.10", BOT_PROFIT_LOCK_ARM_FRACTION: "0.15", BOT_PROFIT_LOCK_PROFIT_FRACTION: "0.05" },
  },
  {
    key: "trail",
    label: "Trailing-only (breakeven + profit-lock OFF)",
    env: { BOT_BREAKEVEN_ARM_FRACTION: "0", BOT_PROFIT_LOCK_ARM_FRACTION: "0" },
  },
];
const APLUS_VARIANTS: Array<{ key: string; label: string; env: Record<string, string> }> = [
  { key: "aplus-off", label: "A+ gate OFF (current)", env: { BOT_APLUS_ENTRY_ONLY: "false" } },
  { key: "aplus-on", label: "A+ gate ON", env: { BOT_APLUS_ENTRY_ONLY: "true" } },
];

const arms: Arm[] = [];
for (const s of STOP_VARIANTS) {
  for (const a of APLUS_VARIANTS) {
    arms.push({ id: `${s.key}__${a.key}`, label: `${s.label}  ·  ${a.label}`, env: { ...s.env, ...a.env } });
  }
}

interface Summary {
  startBalance: number;
  endBalance: number;
  netPnl: number;
  returnPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  maxDrawdown: number;
  bestTrade: number;
  worstTrade: number;
}
interface Trade { pnl: number; reason: string }
interface Results { summary: Summary; trades: Trade[] }

function exitCat(reason: string): string {
  if (reason.startsWith("Trailing")) return "trail";
  if (reason.startsWith("Profit-lock")) return "profitLock";
  if (reason.startsWith("Breakeven")) return "breakeven";
  if (reason.startsWith("Stop loss")) return "hardStop";
  if (reason.startsWith("Hard flatten") || reason.includes("End-of-session")) return "flatten";
  return "other";
}

function runArm(arm: Arm): Results | null {
  const outDir = path.join(ROOT, arm.id);
  const env = { ...process.env, ...arm.env, BOT_BACKTEST_OUT_DIR: outDir };
  console.log(`\n▶ Arm ${arm.id}: ${arm.label}`);
  const res = spawnSync("npx", ["tsx", BACKTEST], {
    env,
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    console.error(`  ✗ arm ${arm.id} failed (exit ${res.status})`);
    return null;
  }
  const file = path.join(outDir, "spy_bot_trail35_giveback5_backtest_results.json");
  if (!fs.existsSync(file)) {
    console.error(`  ✗ arm ${arm.id} produced no results.json`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Results;
}

function fmt(n: number, dp = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  const dataSource = process.env.BOT_BACKTEST_DATA?.toLowerCase() === "thetadata" ? "thetadata" : "synthetic";

  const out: Array<{ arm: Arm; r: Results }> = [];
  for (const arm of arms) {
    const r = runArm(arm);
    if (r) out.push({ arm, r });
  }
  if (!out.length) {
    console.error("No arms succeeded — nothing to compare.");
    process.exit(1);
  }

  const lines: string[] = [];
  lines.push(`# Stop-config 2×2 sweep — data: ${dataSource}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  if (dataSource !== "thetadata") {
    lines.push("> ⚠ **SYNTHETIC data — mechanics only, NOT deployable evidence.** Re-run with");
    lines.push("> `BOT_BACKTEST_DATA=thetadata` and the Theta Terminal running for real-data results.");
  } else {
    lines.push("> ✅ **Real market data (ThetaData).** Past performance does not predict future");
    lines.push("> results. Not financial advice.");
  }
  lines.push("");
  lines.push("## Headline by arm");
  lines.push("");
  lines.push("| Arm | Trades | Win rate | Net P&L | Profit factor | Avg win | Avg loss | Max DD |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const { arm, r } of out) {
    const s = r.summary;
    lines.push(
      `| ${arm.id} | ${s.totalTrades} | ${fmt(s.winRate, 1)}% (${s.wins}W/${s.losses}L) | $${fmt(s.netPnl, 0)} | ${s.profitFactor == null ? "n/a" : fmt(s.profitFactor)} | $${fmt(s.avgWin, 0)} | $${fmt(s.avgLoss, 0)} | $${fmt(s.maxDrawdown, 0)} |`,
    );
  }
  lines.push("");
  lines.push("Arm key: `<stops>__<aplus>` — stops ∈ {be+pl, trail}, aplus ∈ {aplus-off, aplus-on}.");
  for (const a of arms) lines.push(`- \`${a.id}\` — ${a.label}`);
  lines.push("");

  lines.push("## Exit-reason breakdown by arm");
  lines.push("");
  lines.push("Each cell: trades (wins/losses) · net P&L. The trailing stop is the profit engine;");
  lines.push("breakeven exits can never be wins by construction.");
  lines.push("");
  const cats = ["trail", "flatten", "profitLock", "breakeven", "hardStop", "other"] as const;
  lines.push(`| Arm | ${cats.join(" | ")} |`);
  lines.push(`| --- | ${cats.map(() => "---").join(" | ")} |`);
  for (const { arm, r } of out) {
    const agg: Record<string, { n: number; w: number; l: number; pnl: number }> = {};
    for (const c of cats) agg[c] = { n: 0, w: 0, l: 0, pnl: 0 };
    for (const t of r.trades) {
      const c = exitCat(t.reason);
      const a = agg[c] ?? (agg[c] = { n: 0, w: 0, l: 0, pnl: 0 });
      a.n += 1;
      if (t.pnl > 0) a.w += 1;
      else if (t.pnl < 0) a.l += 1;
      a.pnl += t.pnl;
    }
    const cells = cats.map((c) => {
      const a = agg[c];
      return a.n ? `${a.n} (${a.w}/${a.l}) $${fmt(a.pnl, 0)}` : "—";
    });
    lines.push(`| ${arm.id} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("_Generated by script/backtest-stop-sweep.ts. Not financial advice._");

  const compPath = path.join(ROOT, "COMPARISON.md");
  fs.writeFileSync(compPath, lines.join("\n") + "\n");
  console.log(`\n✅ Sweep complete. Comparison written to ${compPath}`);
  console.log(lines.join("\n"));
}

main();
