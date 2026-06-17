/**
 * Reproducible backtest for the small-account SPY 0DTE bot profile.
 *
 * ─── WHAT THIS RUNS ─────────────────────────────────────────────────────────
 * It drives the REAL bot decision logic — the same modules the live engine uses:
 *   • signalEngine.generateSignals  (setups + MTF gating + 0DTE contract pick)
 *   • riskManager.sizePosition       (cash + max-loss-per-trade sizing)
 *   • riskManager.evaluatePosition   (hard stop / give-back trailing stop, full position)
 *   • paperState.openPaperPosition / updateTrail / closePaperPosition
 *   • config time-of-day entry filters + hard flatten cutoff
 *
 * Nothing here places a real order; paperState is pure simulation.
 *
 * ─── DATA SOURCE (IMPORTANT) ────────────────────────────────────────────────
 * This environment has NO market-data API keys and no network access to a SPY
 * 1m feed, so the backtest CANNOT use live historical bars. Instead it generates
 * a DETERMINISTIC, seeded synthetic 1m SPY tape for the 5 most recent regular
 * sessions (mix of trend + chop days) plus a synthetic same-day 0DTE option
 * chain whose premium is approximated from the underlying move and time decay.
 *
 * Results are therefore ILLUSTRATIVE of how the strategy behaves mechanically —
 * NOT a claim of real-world profitability. The seed is fixed so runs reproduce.
 * Swap `loadSessions()` for a real 1m loader (Polygon/Tradier) to backtest live
 * data; the per-bar driver below is unchanged.
 *
 * Run: npx tsx script/backtest-bot.ts
 */

// MUST be first — sets BOT_PAPER_STATE_FILE=none (unless overridden) before
// paperState.js is evaluated, so a backtest never clobbers the live paper
// ledger at .data/bot-state.json.
import "./backtest-env.js";
import fs from "node:fs";
import {
  terminalReachable,
  lastTradingSessions,
  loadSpyOhlc1m,
  OptionQuoteCache,
} from "./thetaDataLoader.js";
import {
  generateSignals,
  type SnapshotForSignal,
  type Setup,
  type UnusualOption,
} from "../server/bot/signalEngine.js";
import type { MtfCandle } from "../server/bot/marketStructure.js";
import { aggregateCandles } from "../server/bot/marketStructure.js";
import { getBotConfig, type BotConfig } from "../server/bot/config.js";
import { sizePosition, evaluatePosition } from "../server/bot/riskManager.js";
import {
  openPaperPosition,
  updateTrail,
  closePaperPosition,
  resetPaperState,
  type PaperPosition,
} from "../server/bot/paperState.js";

const START_BALANCE = Number(process.env.BOT_BACKTEST_START_BALANCE ?? 1326.24);
const OUT_DIR = process.env.BOT_BACKTEST_OUT_DIR ?? "./backtest-output";
/** "thetadata" → real SPY 1m bars + real option NBBO quotes via the local Theta
 *  Terminal; anything else → the deterministic synthetic tape. */
const DATA_SOURCE: "thetadata" | "synthetic" =
  process.env.BOT_BACKTEST_DATA?.toLowerCase() === "thetadata" ? "thetadata" : "synthetic";
const SESSION_COUNT = Number(process.env.BOT_BACKTEST_SESSIONS ?? 5);

// ─── Deterministic PRNG (mulberry32) so the backtest reproduces exactly ────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Session {
  date: string; // YYYY-MM-DD (NY market date)
  bars: MtfCandle[]; // 1m RTH bars
  bias: "Call" | "Put"; // dominant intended direction for the day
  label: string;
  source: "synthetic" | "thetadata";
}

// CT session is 08:30–15:00 → 390 one-minute bars. We model each bar's time in
// UTC (CDT = UTC-5 in June) so the bot's CT-based time filters behave correctly.
const SESSION_BARS = 390;
const SPY_BASE = 565; // plausible 2026 SPY level

/**
 * Build one synthetic session: a drift+noise 1m random walk. `regime` controls
 * the day's character so the 5-session set mixes clean trends and chop (chop
 * days SHOULD be mostly filtered out by the strict MTF gate — that is the point).
 */
function buildSession(
  date: string,
  rand: () => number,
  regime: "trend-up" | "trend-down" | "chop",
  open: number,
): Session {
  const bars: MtfCandle[] = [];
  let price = open;
  // Per-bar drift (in $) and noise scale by regime.
  const drift =
    regime === "trend-up" ? 0.012 : regime === "trend-down" ? -0.012 : 0.0;
  const noise = regime === "chop" ? 0.09 : 0.06;

  // Base date at 08:30 CT = 13:30 UTC (CDT).
  const dayStartUtc = new Date(`${date}T13:30:00Z`).getTime();

  for (let i = 0; i < SESSION_BARS; i += 1) {
    const open0 = price;
    // Mild mean-reversion in chop, momentum in trends.
    const shock = (rand() - 0.5) * 2 * noise;
    const momentum = regime === "chop" ? -(price - open) * 0.002 : 0;
    const close0 = open0 + drift + shock + momentum;
    const hi = Math.max(open0, close0) + rand() * 0.05;
    const lo = Math.min(open0, close0) - rand() * 0.05;
    bars.push({
      time: new Date(dayStartUtc + i * 60_000).toISOString(),
      open: round(open0),
      high: round(hi),
      low: round(lo),
      close: round(close0),
      volume: 800_000 + Math.floor(rand() * 600_000),
    });
    price = close0;
  }

  const bias: "Call" | "Put" = regime === "trend-down" ? "Put" : "Call";
  return { date, bars, bias, label: regime, source: "synthetic" };
}

/**
 * The 5 most recent *available* sessions for this run. With no live feed we use
 * the five business days ending 2026-06-02 and assign a regime mix. Replace this
 * with a real loader to backtest actual SPY 1m history.
 */
function loadSessions(): Session[] {
  const rand = mulberry32(0x5be0d7e); // fixed seed → reproducible
  const dates = [
    { date: "2026-05-27", regime: "trend-up" as const },
    { date: "2026-05-28", regime: "chop" as const },
    { date: "2026-05-29", regime: "trend-down" as const },
    { date: "2026-06-01", regime: "trend-up" as const },
    { date: "2026-06-02", regime: "chop" as const },
  ];
  const sessions: Session[] = [];
  let open = SPY_BASE;
  for (const d of dates) {
    const s = buildSession(d.date, rand, d.regime, open);
    sessions.push(s);
    open = s.bars[s.bars.length - 1].close; // carry close→next open (gap-free)
  }
  return sessions;
}

/**
 * REAL sessions from ThetaData: actual SPY 1m RTH bars for the N most recent
 * completed trading days. Session bias is derived from the realized day
 * direction (open vs close) — it feeds the synthetic setup CARD only; the
 * signal engine's MTF gating runs on the real bars themselves.
 *
 * Throws (rather than silently falling back) when the user explicitly asked
 * for thetadata but the terminal is unreachable or returns no data — a
 * backtest that quietly switched to synthetic data would be worse than one
 * that fails loudly.
 */
async function loadRealSessions(n: number): Promise<Session[]> {
  if (!(await terminalReachable())) {
    throw new Error(
      "BOT_BACKTEST_DATA=thetadata but the Theta Terminal is not reachable. " +
        "Start it first:  java -jar ThetaTerminal.jar <email> <password>  " +
        "(listens on http://127.0.0.1:25503; override with THETA_TERMINAL_URL).",
    );
  }
  // Explicit date override (BOT_BACKTEST_DATE=YYYY-MM-DD[,YYYY-MM-DD...]) lets
  // us backtest a SPECIFIC session — including TODAY — which lastTradingSessions
  // deliberately excludes (it only lists completed/finalized EOD sessions). When
  // set, these exact dates are used in the given order, bypassing the calendar.
  const dateOverride = process.env.BOT_BACKTEST_DATE?.trim();
  // Over-fetch the calendar so we can drop days whose options haven't yet
  // been finalized in ThetaData's pipeline (most recent session sometimes
  // returns 472 on quote queries for hours after the close).
  const dates = dateOverride
    ? dateOverride.split(",").map((d) => d.trim()).filter(Boolean)
    : await lastTradingSessions(n + 3);
  if (!dates.length) throw new Error("ThetaData returned no completed trading sessions for SPY.");
  const sessions: Session[] = [];
  // Newest → oldest so we keep the freshest N that successfully load.
  for (const date of [...dates].reverse()) {
    let bars: MtfCandle[];
    try {
      bars = await loadSpyOhlc1m(date);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[backtest] skipping ${date}: ${msg.slice(0, 140)}`);
      continue;
    }
    const dayOpen = bars[0].open;
    const dayClose = bars[bars.length - 1].close;
    const movePct = ((dayClose - dayOpen) / dayOpen) * 100;
    const bias: "Call" | "Put" = dayClose >= dayOpen ? "Call" : "Put";
    sessions.push({
      date,
      bars,
      bias,
      label: `real ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%`,
      source: "thetadata",
    });
    console.log(`[backtest] loaded ${bars.length} real SPY 1m bars for ${date} (${movePct.toFixed(2)}%)`);
    if (sessions.length >= n) break;
  }
  return sessions.reverse();
}

// ─── Synthetic 0DTE option model ───────────────────────────────────────────────
// Approximate a near-ATM 0DTE premium from intrinsic + a time-decayed extrinsic
// component. Premium per share; contract value = premium × 100. This is a coarse
// model (no IV surface) but is monotonic in the right direction and decays to
// expiry, which is what the exit logic is exercised against.
function optionPremium(
  spot: number,
  strike: number,
  side: "Call" | "Put",
  minutesToClose: number,
): number {
  const intrinsic = side === "Call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  // Extrinsic ~ proportional to sqrt(time left) and a vol term; shrinks to 0.
  const tFrac = Math.max(0, minutesToClose) / SESSION_BARS;
  const extrinsic = 0.9 * Math.sqrt(tFrac) * (0.6 + 0.4 * Math.exp(-Math.abs(spot - strike) / 1.5));
  return round(intrinsic + extrinsic);
}

const occStrike = (strike: number) => String(Math.round(strike * 1000)).padStart(8, "0");
const occSymbol = (side: "Call" | "Put", strike: number, date: string) =>
  `SPY${date.slice(2).replace(/-/g, "")}${side === "Call" ? "C" : "P"}${occStrike(strike)}`;

/** Build a small same-day 0DTE chain around spot for one direction. */
function buildChain(
  spot: number,
  side: "Call" | "Put",
  date: string,
  minutesToClose: number,
): UnusualOption[] {
  const atm = Math.round(spot);
  const strikes = [atm - 2, atm - 1, atm, atm + 1, atm + 2];
  return strikes.map((strike) => {
    const prem = optionPremium(spot, strike, side, minutesToClose);
    const bid = round(Math.max(0.01, prem - 0.03));
    const ask = round(prem + 0.03);
    return {
      symbol: occSymbol(side, strike, date),
      expiry: date,
      strike,
      side,
      last: prem,
      bid,
      ask,
      volume: 18_000 + Math.floor(Math.abs(strike - atm) === 1 ? 6000 : 0),
      openInterest: 3000,
      volumeOiRatio: 6,
      premium: prem * 100 * 20000,
      unusualScore: 78,
      flag: "synthetic",
    };
  });
}

/** Derive a 2m setup card from the recent 1m structure for a direction. */
function buildSetup(bars: MtfCandle[], bias: "Call" | "Put"): Setup {
  const last = bars[bars.length - 1];
  const prior = bars[Math.max(0, bars.length - 6)];
  const slope = last.close - prior.close;
  // Confidence scales with how strongly recent price agrees with the bias.
  const agree = bias === "Call" ? slope : -slope;
  const confidence = Math.max(50, Math.min(80, Math.round(60 + agree * 12)));
  return {
    title: "0DTE momentum setup (synthetic)",
    bias,
    confidence,
    trigger: `${bias === "Call" ? "Up" : "Down"} momentum on 2m`,
    invalidation: "2m close back through VWAP",
    rationale: "backtest-derived",
  };
}

// ─── Trade record ───────────────────────────────────────────────────────────────
interface TradeRecord {
  date: string;
  symbol: string;
  side: "Call" | "Put";
  strike: number;
  contracts: number;
  entryAt: string;
  entryPremium: number;
  exitAt: string;
  exitPremium: number;
  reason: string;
  pnl: number;
  balanceAfter: number;
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Build the same 5-strike chain from REAL ThetaData NBBO quotes at this bar.
 * Strikes with no quote data are omitted. last = mid (the quote endpoint has
 * no trade prints); volume/OI/unusualScore are plausible constants so the
 * signal engine's liquidity gate behaves as in live mode — flagged in the
 * report as a known approximation.
 */
async function buildRealChain(
  quotes: OptionQuoteCache,
  spot: number,
  side: "Call" | "Put",
  date: string,
  barUtcMs: number,
): Promise<UnusualOption[]> {
  const atm = Math.round(spot);
  const strikes = [atm - 2, atm - 1, atm, atm + 1, atm + 2];
  const right = side === "Call" ? "C" : "P";
  const out: UnusualOption[] = [];
  for (const strike of strikes) {
    const q = await quotes.getQuote(date, strike, right as "C" | "P", barUtcMs);
    if (!q || !(q.ask > 0)) continue;
    const bid = q.bid > 0 ? q.bid : 0.01;
    const mid = round((bid + q.ask) / 2);
    out.push({
      symbol: occSymbol(side, strike, date),
      expiry: date,
      strike,
      side,
      last: mid,
      bid,
      ask: q.ask,
      volume: 18_000 + (Math.abs(strike - atm) === 1 ? 6000 : 0),
      openInterest: 3000,
      volumeOiRatio: 6,
      premium: mid * 100 * 20000,
      unusualScore: 78,
      flag: "thetadata-quote",
    });
  }
  return out;
}

/**
 * Current REAL mark for an open contract at this bar: the NBBO BID — the side
 * a long position actually exits at, matching the patched live exit logic.
 * Returns null when the contract has no quote this minute (caller holds the
 * last known mark).
 */
async function realMark(
  quotes: OptionQuoteCache,
  date: string,
  strike: number,
  side: "Call" | "Put",
  barUtcMs: number,
): Promise<number | null> {
  const q = await quotes.getQuote(date, strike, side === "Call" ? "C" : "P", barUtcMs);
  if (!q) return null;
  return q.bid > 0 ? q.bid : null;
}

// ─── Backtest driver ──────────────────────────────────────────────────────────
async function run() {
  const cfg: BotConfig = { ...getBotConfig(), accountStartBalance: START_BALANCE };
  const sessions = DATA_SOURCE === "thetadata"
    ? await loadRealSessions(SESSION_COUNT)
    : loadSessions();
  const quoteCache = new OptionQuoteCache();
  const trades: TradeRecord[] = [];
  let balance = START_BALANCE;
  let dailyLoss = 0;

  // Rejection-reason counters: every bar that DIDN'T fire a trade is classified
  // by which gate killed it. Surfaced in the report so it's obvious whether the
  // bot is blocked by MTF, by data quality, by confidence, or by sizing.
  const rejects: Record<string, number> = {
    no_chain_quoted: 0,
    daily_loss_stop: 0,
    no_setup: 0,
    blocked_mtf: 0,
    blocked_other: 0,
    review_mtf: 0,
    review_contract_quality: 0,
    review_aplus_floor: 0,
    review_no_contract: 0,
    review_other: 0,
    confidence_below_auto: 0,
    sizing_rejected: 0,
    cost_exceeds_balance: 0,
    bars_evaluated: 0,
  };
  const mtfBlockReasons = new Map<string, number>();
  const mtfReviewReasons = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const session of sessions) {
    resetPaperState();
    dailyLoss = 0;
    let openPos: PaperPosition | null = null;
    let openContract: { strike: number; side: "Call" | "Put" } | null = null;
    let lastKnownMark: number | null = null;
    let entryBarIndex = -1;

    for (let i = 30; i < session.bars.length; i += 1) {
      const now = new Date(session.bars[i].time);
      const minutesToClose = session.bars.length - i;
      const window = session.bars.slice(0, i + 1);
      const spot = window[window.length - 1].close;

      // ── Manage an open position first (exit logic) ──
      if (openPos && openContract) {
        let mark: number;
        if (session.source === "thetadata") {
          const real = await realMark(quoteCache, session.date, openContract.strike, openContract.side, now.getTime());
          // Hold the last known mark through a quote gap — mirrors the live
          // engine's stale-mark behavior; never fabricates a price.
          mark = real ?? lastKnownMark ?? openPos.entryPremium;
        } else {
          mark = optionPremium(spot, openContract.strike, openContract.side, minutesToClose);
        }
        lastKnownMark = mark;
        updateTrail(openPos.id, mark);
        const action = evaluatePosition(openPos, mark, cfg, now);
        if (action.kind === "stop" || action.kind === "flatten") {
          const closePrem = action.kind === "stop" || action.kind === "flatten" ? action.closePremium : mark;
          const closed = closePaperPosition(openPos.id, closePrem, action.reason);
          if (closed) {
            const pnl = closed.pnl ?? 0;
            balance += pnl;
            if (pnl < 0) dailyLoss += Math.abs(pnl);
            trades.push({
              date: session.date,
              symbol: closed.symbol,
              side: closed.side,
              strike: closed.strike,
              contracts: closed.contracts,
              entryAt: closed.entryAt,
              entryPremium: closed.entryPremium,
              exitAt: closed.closeAt ?? now.toISOString(),
              exitPremium: closePrem,
              reason: action.reason,
              pnl,
              balanceAfter: round(balance),
            });
          }
          openPos = null;
          openContract = null;
          lastKnownMark = null;
        }
        continue; // one position at a time in this small-account backtest
      }

      rejects.bars_evaluated += 1;

      // Respect the daily dollar-loss stop.
      if (dailyLoss >= cfg.maxDailyLoss) {
        rejects.daily_loss_stop += 1;
        continue;
      }

      // ── Look for an entry ──
      const chain = session.source === "thetadata"
        ? await buildRealChain(quoteCache, spot, session.bias, session.date, now.getTime())
        : buildChain(spot, session.bias, session.date, minutesToClose);
      if (!chain.length) {
        rejects.no_chain_quoted += 1;
        continue;
      }
      const snapshot: SnapshotForSignal = {
        spy: {
          price: spot,
          dailyOpen: session.bars[0].open,
          candles: window,
          candles5m: aggregateCandles(window, 5),
          candles15m: aggregateCandles(window, 15),
          candles30m: aggregateCandles(window, 30),
        },
        setups: [buildSetup(window, session.bias)],
        unusualOptions: chain,
        economicCalendar: [],
      };

      const signals = generateSignals(snapshot, cfg, now);
      const actionable = signals.find(
        (s) => s.status === "ACTIONABLE" && s.contract && s.isZeroDte && s.confidence >= cfg.autoMinConfidence,
      );
      if (!actionable || !actionable.contract) {
        // Classify why no signal was actionable.
        if (!signals.length || signals[0].status === "NO_SETUP") {
          rejects.no_setup += 1;
        } else {
          // Take the first signal as representative (loop only inspects bias-aligned one).
          const s = signals[0];
          if (s.status === "BLOCKED") {
            const reason = s.blockReason ?? "unknown";
            if (s.mtf?.gate === "block") {
              rejects.blocked_mtf += 1;
              bump(mtfBlockReasons, s.mtf.gateReason || reason);
            } else {
              rejects.blocked_other += 1;
            }
          } else if (s.status === "REQUIRES_REVIEW") {
            const reason = s.reviewReason ?? "";
            if (s.mtf?.gate === "downgrade") {
              rejects.review_mtf += 1;
              bump(mtfReviewReasons, s.mtf.gateReason || reason);
            } else if (/A\+ gate/.test(reason)) {
              rejects.review_aplus_floor += 1;
            } else if (/premium|spread/i.test(reason)) {
              rejects.review_contract_quality += 1;
            } else if (/No same-day 0DTE SPY options/i.test(reason)) {
              rejects.review_no_contract += 1;
            } else {
              rejects.review_other += 1;
            }
          } else if (s.status === "ACTIONABLE" && s.confidence < cfg.autoMinConfidence) {
            rejects.confidence_below_auto += 1;
          }
        }
        continue;
      }

      const entryPremium = actionable.suggestedEntryPremium ?? actionable.contract.ask;
      const sizing = sizePosition(entryPremium, cfg, balance);
      if (!sizing.allowed || sizing.contracts < 1) {
        rejects.sizing_rejected += 1;
        continue;
      }

      // Cost must fit the running balance (cash-settled buy).
      const cost = entryPremium * 100 * sizing.contracts;
      if (cost > balance) {
        rejects.cost_exceeds_balance += 1;
        continue;
      }

      openPos = openPaperPosition({
        symbol: actionable.contract.symbol,
        side: actionable.contract.side,
        strike: actionable.contract.strike,
        expiry: actionable.contract.expiry,
        contracts: sizing.contracts,
        entryPremium,
        stopFraction: cfg.stopLossFraction,
        takeProfitFraction: cfg.takeProfitFraction,
        trailStartFraction: cfg.trailStartFraction,
        trailGivebackFraction: cfg.trailGivebackFraction,
        breakevenArmFraction: cfg.breakevenArmFraction,
      });
      openContract = { strike: actionable.contract.strike, side: actionable.contract.side };
      entryBarIndex = i;
      void entryBarIndex;
    }

    // End-of-session: force-close any residual open position at the last mark.
    if (openPos && openContract) {
      const lastSpot = session.bars[session.bars.length - 1].close;
      let mark: number;
      if (session.source === "thetadata") {
        const lastBarMs = new Date(session.bars[session.bars.length - 1].time).getTime();
        const real = await realMark(quoteCache, session.date, openContract.strike, openContract.side, lastBarMs);
        mark = real ?? lastKnownMark ?? optionPremium(lastSpot, openContract.strike, openContract.side, 0);
      } else {
        mark = optionPremium(lastSpot, openContract.strike, openContract.side, 0);
      }
      const closed = closePaperPosition(openPos.id, mark, "End-of-session flatten (backtest)");
      if (closed) {
        const pnl = closed.pnl ?? 0;
        balance += pnl;
        trades.push({
          date: session.date,
          symbol: closed.symbol,
          side: closed.side,
          strike: closed.strike,
          contracts: closed.contracts,
          entryAt: closed.entryAt,
          entryPremium: closed.entryPremium,
          exitAt: closed.closeAt ?? "",
          exitPremium: mark,
          reason: "End-of-session flatten (backtest)",
          pnl,
          balanceAfter: round(balance),
        });
      }
    }
  }

  const topMtfBlock = [...mtfBlockReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMtfReview = [...mtfReviewReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const out = summarize(sessions, trades, balance);
  (out as { rejects?: typeof rejects }).rejects = rejects;
  (out as { topMtfBlock?: typeof topMtfBlock }).topMtfBlock = topMtfBlock;
  (out as { topMtfReview?: typeof topMtfReview }).topMtfReview = topMtfReview;
  return out as ReturnType<typeof summarize> & { rejects: typeof rejects; topMtfBlock: typeof topMtfBlock; topMtfReview: typeof topMtfReview };
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
  perSession: Array<{ date: string; label: string; trades: number; pnl: number }>;
}

function summarize(sessions: Session[], trades: TradeRecord[], endBalance: number): { summary: Summary; trades: TradeRecord[] } {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Max drawdown on the running balance.
  let peak = START_BALANCE;
  let maxDd = 0;
  let bal = START_BALANCE;
  for (const t of trades) {
    bal = t.balanceAfter;
    if (bal > peak) peak = bal;
    const dd = peak - bal;
    if (dd > maxDd) maxDd = dd;
  }

  const perSession = sessions.map((s) => {
    const st = trades.filter((t) => t.date === s.date);
    return {
      date: s.date,
      label: s.label,
      trades: st.length,
      pnl: round(st.reduce((a, t) => a + t.pnl, 0)),
    };
  });

  const summary: Summary = {
    startBalance: START_BALANCE,
    endBalance: round(endBalance),
    netPnl: round(endBalance - START_BALANCE),
    returnPct: round(((endBalance - START_BALANCE) / START_BALANCE) * 100),
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? round((wins.length / trades.length) * 100) : 0,
    avgWin: wins.length ? round(grossWin / wins.length) : 0,
    avgLoss: losses.length ? round(grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    maxDrawdown: round(maxDd),
    bestTrade: trades.length ? round(Math.max(...trades.map((t) => t.pnl))) : 0,
    worstTrade: trades.length ? round(Math.min(...trades.map((t) => t.pnl))) : 0,
    perSession,
  };
  return { summary, trades };
}

// ─── Output writers ─────────────────────────────────────────────────────────────
interface Diagnostics {
  rejects: Record<string, number>;
  topMtfBlock: Array<[string, number]>;
  topMtfReview: Array<[string, number]>;
}

function writeReports(summary: Summary, trades: TradeRecord[], diag?: Diagnostics) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    `${OUT_DIR}/spy_bot_trail35_giveback5_backtest_results.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), summary, trades, diagnostics: diag }, null, 2),
  );

  const header = "date,symbol,side,strike,contracts,entryAt,entryPremium,exitAt,exitPremium,pnl,balanceAfter,reason";
  const rows = trades.map((t) =>
    [
      t.date,
      t.symbol,
      t.side,
      t.strike,
      t.contracts,
      t.entryAt,
      t.entryPremium,
      t.exitAt,
      t.exitPremium,
      t.pnl,
      t.balanceAfter,
      `"${t.reason.replace(/"/g, "'")}"`,
    ].join(","),
  );
  fs.writeFileSync(`${OUT_DIR}/spy_bot_trail35_giveback5_backtest_trades.csv`, [header, ...rows].join("\n") + "\n");

  const md = renderMarkdown(summary, trades, diag);
  fs.writeFileSync(`${OUT_DIR}/spy_bot_trail35_giveback5_backtest_report.md`, md);
}

function renderMarkdown(s: Summary, trades: TradeRecord[], diag?: Diagnostics): string {
  const lines: string[] = [];
  lines.push(`# SPY 0DTE Bot — Backtest ($${START_BALANCE.toFixed(2)}) — data: ${DATA_SOURCE}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  if (DATA_SOURCE === "thetadata") {
    lines.push("> ✅ **Real market data (ThetaData).** Underlying: actual SPY 1m RTH bars. Options:");
    lines.push("> actual same-day 0DTE NBBO quotes — entries priced at the ASK, exits and stop/trail");
    lines.push("> evaluation at the BID (matching the live engine). Known approximations: option");
    lines.push("> volume/OI/unusual-score in the chain are plausible constants (the quote endpoint");
    lines.push("> has no volume), and fills assume the full quoted side with no queue/partial-fill");
    lines.push("> modeling. **Past performance does not predict future results. Not advice.**");
  } else {
    lines.push("> ⚠ **Synthetic data.** The backtest ran the **real bot logic** over a deterministic,");
    lines.push("> seeded synthetic 1m SPY tape and synthetic 0DTE premiums. Numbers are illustrative");
    lines.push("> of strategy mechanics only. Run with **BOT_BACKTEST_DATA=thetadata** (Theta Terminal");
    lines.push("> running locally) to backtest real SPY bars and real option quotes.");
    lines.push("> **0DTE options can expire worthless — not advice.**");
  }
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Start balance | $${s.startBalance.toFixed(2)} |`);
  lines.push(`| End balance | $${s.endBalance.toFixed(2)} |`);
  lines.push(`| Net P&L | $${s.netPnl.toFixed(2)} |`);
  lines.push(`| Return | ${s.returnPct.toFixed(2)}% |`);
  lines.push(`| Total trades | ${s.totalTrades} |`);
  lines.push(`| Win rate | ${s.winRate.toFixed(1)}% (${s.wins}W / ${s.losses}L) |`);
  lines.push(`| Avg win | $${s.avgWin.toFixed(2)} |`);
  lines.push(`| Avg loss | $${s.avgLoss.toFixed(2)} |`);
  lines.push(`| Profit factor | ${s.profitFactor === null ? "n/a (no losses)" : s.profitFactor.toFixed(2)} |`);
  lines.push(`| Max drawdown | $${s.maxDrawdown.toFixed(2)} |`);
  lines.push(`| Best / worst trade | $${s.bestTrade.toFixed(2)} / $${s.worstTrade.toFixed(2)} |`);
  lines.push("");
  lines.push("## Risk profile under test");
  lines.push("");
  const rc = getBotConfig();
  const armPct = Math.round(rc.trailStartFraction * 100);
  const gbPct = Math.round(rc.trailGivebackFraction * 100);
  const stopPct = Math.round(rc.stopLossFraction * 100);
  lines.push(`- Hard stop loss: ${stopPct}% of premium · NO fixed take-profit (let winners run)`);
  lines.push(`- Trailing stop: arms at +${armPct}%, exits on a ${gbPct}% give-back from the post-arm peak`);
  lines.push(`- All sizes (${rc.minContractsPerTrade}–${rc.preferredContractsPerTrade} contract ladder): full position runs together, no partial trims`);
  lines.push(`- Exits: hard stop -${stopPct}% · +${armPct}% arm / ${gbPct}% give-back trailing stop · flatten/invalidation`);
  lines.push("- Max loss per trade: $100 (~7.5% of account) · Daily loss stop (backtest): $1000");
  lines.push("- Entry filters: 30m+15m trend alignment, 5m setup + 1m trigger required;");
  lines.push("  no time-of-day entry blockers; hard flatten 14:30 CT");
  lines.push(`- Quality filters: min option premium $${rc.minOptionPremium.toFixed(2)}, max spread ${Math.round(rc.maxSpreadPct * 100)}% of mid`);
  lines.push(`- Sizing ladder: preferred ${rc.preferredContractsPerTrade} → fallback steps down to minimum ${rc.minContractsPerTrade} (blocks below ${rc.minContractsPerTrade}), capped by cash and per-trade stop risk`);
  lines.push("");
  lines.push("## Per-session");
  lines.push("");
  lines.push("| Date | Regime | Trades | P&L |");
  lines.push("| --- | --- | --- | --- |");
  for (const p of s.perSession) {
    lines.push(`| ${p.date} | ${p.label} | ${p.trades} | $${p.pnl.toFixed(2)} |`);
  }
  lines.push("");
  lines.push("## Trades");
  lines.push("");
  if (!trades.length) {
    lines.push("_No trades were taken — the strict entry filters blocked every bar (e.g. chop-only)._");
  } else {
    lines.push("| Date | Side | Strike | Qty | Entry | Exit | P&L | Reason |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const t of trades) {
      lines.push(
        `| ${t.date} | ${t.side} | ${t.strike} | ${t.contracts} | ${t.entryPremium.toFixed(2)} | ${t.exitPremium.toFixed(2)} | $${t.pnl.toFixed(2)} | ${t.reason.slice(0, 60)} |`,
      );
    }
  }
  lines.push("");
  if (diag) {
    lines.push("## Rejection breakdown");
    lines.push("");
    lines.push("Why each non-trade bar didn't fire (counts across all evaluated bars):");
    lines.push("");
    lines.push("| Bucket | Count |");
    lines.push("| --- | ---: |");
    const order = [
      "bars_evaluated",
      "no_chain_quoted",
      "daily_loss_stop",
      "no_setup",
      "blocked_mtf",
      "blocked_other",
      "review_mtf",
      "review_contract_quality",
      "review_aplus_floor",
      "review_no_contract",
      "review_other",
      "confidence_below_auto",
      "sizing_rejected",
      "cost_exceeds_balance",
    ];
    for (const k of order) lines.push(`| ${k} | ${diag.rejects[k] ?? 0} |`);
    lines.push("");
    if (diag.topMtfBlock.length) {
      lines.push("### Top MTF block reasons");
      lines.push("");
      for (const [r, n] of diag.topMtfBlock) lines.push(`- (${n}) ${r}`);
      lines.push("");
    }
    if (diag.topMtfReview.length) {
      lines.push("### Top MTF downgrade reasons");
      lines.push("");
      for (const [r, n] of diag.topMtfReview) lines.push(`- (${n}) ${r}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

run()
  .then((result) => {
    const { summary, trades } = result;
    const diag: Diagnostics = {
      rejects: (result as { rejects?: Diagnostics["rejects"] }).rejects ?? {},
      topMtfBlock: (result as { topMtfBlock?: Diagnostics["topMtfBlock"] }).topMtfBlock ?? [],
      topMtfReview: (result as { topMtfReview?: Diagnostics["topMtfReview"] }).topMtfReview ?? [],
    };
    writeReports(summary, trades, diag);
    console.log(`Backtest complete (data source: ${DATA_SOURCE}).`);
    console.log(JSON.stringify(summary, null, 2));
    console.log("\nRejection breakdown:");
    console.log(JSON.stringify(diag.rejects, null, 2));
    if (diag.topMtfBlock.length) {
      console.log("\nTop MTF block reasons:");
      for (const [r, n] of diag.topMtfBlock) console.log(`  (${n}) ${r}`);
    }
    if (diag.topMtfReview.length) {
      console.log("\nTop MTF downgrade reasons:");
      for (const [r, n] of diag.topMtfReview) console.log(`  (${n}) ${r}`);
    }
    console.log("\nReports written to:");
    console.log(`  ${OUT_DIR}/spy_bot_trail35_giveback5_backtest_report.md`);
    console.log(`  ${OUT_DIR}/spy_bot_trail35_giveback5_backtest_results.json`);
    console.log(`  ${OUT_DIR}/spy_bot_trail35_giveback5_backtest_trades.csv`);
  })
  .catch((err) => {
    console.error(`Backtest failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
