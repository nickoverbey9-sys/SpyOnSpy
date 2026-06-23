/**
 * Bot API routes — /api/bot/*
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE TRADING BOT — SPY 0DTE OPTIONS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Routes:
 *   GET  /api/bot/status         — live-readiness, config, kill-switch state
 *   GET  /api/bot/account        — Tradier balances + bot-managed P&L (read-only)
 *   GET  /api/bot/signals        — current trade signals from snapshot
 *   GET  /api/bot/positions      — open paper/live tracked positions
 *   GET  /api/bot/fills          — recent fills/order log
 *   POST /api/bot/paper-order    — simulate a paper trade (always safe)
 *   POST /api/bot/order          — place a real OR paper order (live requires all guards)
 *   POST /api/bot/close          — close/flatten a tracked position
 *   POST /api/bot/kill-switch    — toggle bot kill switch on/off
 *   POST /api/bot/risk-pass      — run risk evaluation on open positions
 *
 * Live order guard (enforced in /api/bot/order):
 *   1. TRADIER_ENABLE_LIVE_TRADING=true
 *   2. TRADIER_ACCOUNT_ID set
 *   3. TRADIER_TOKEN set
 *   4. { confirmLiveOrder: true } in request body
 *
 * ⚠  NOT FINANCIAL ADVICE. High-risk 0DTE options. Use at your own risk.
 */

import type { Express, Request, Response } from "express";
import {
  getBotConfig,
  getLiveReadiness,
  getAutoTradeReadiness,
  setKillSwitch,
} from "./config.js";
import { isPastCutoff, isNearHighImpactEvent, entryTimeWindowBlock } from "./config.js";
import {
  getAutomationStatus,
  setAutomationRunning,
  getMarkSnapshot,
} from "./automationEngine.js";
import { generateSignals, evaluateDataFreshness } from "./signalEngine.js";
import {
  buildOptionOrderPayload,
  executeOrder,
  executePaperOrder,
  fetchAccountSnapshot,
  fetchBrokerPositions,
  waitForFill,
  cancelOrder,
} from "./tradierAdapter.js";
import {
  canOpenPosition,
  runRiskPass,
  sizePosition,
} from "./riskManager.js";
import {
  openPaperPosition,
  closePaperPosition,
  getOpenPositions,
  getAllPositions,
  getRecentFills,
  getDailyStats,
  getDailyLossSnapshot,
  computeBotPnl,
  computeDailyScorecard,
  computeWeeklyScorecard,
  computeSetupSourceScorecard,
  resetPaperState,
} from "./paperState.js";

// ─── Snapshot accessor (injected from routes.ts) ──────────────────────────────
// We receive a function rather than importing state directly to avoid circular deps.
type Candle = {
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
};

type SnapshotFn = () => {
  spy: {
    price: number;
    dailyOpen?: number;
    premarketHigh?: number;
    premarketLow?: number;
    candles?: Candle[];
    candles5m?: Candle[];
    candles15m?: Candle[];
    candles30m?: Candle[];
  };
  setups: Array<{
    title: string;
    bias: "Call" | "Put" | "Wait";
    confidence: number;
    trigger: string;
    invalidation: string;
    rationale: string;
  }>;
  unusualOptions: Array<{
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
  }>;
  economicCalendar: Array<{
    time: string;
    event: string;
    impact: "High" | "Medium" | "Low";
    status: "Upcoming" | "Released" | "Watched";
  }>;
};

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function registerBotRoutes(app: Express, getSnapshot: SnapshotFn): void {
  // ── GET /api/bot/status ────────────────────────────────────────────────────
  app.get("/api/bot/status", (_req: Request, res: Response) => {
    const cfg = getBotConfig();
    const readiness = getLiveReadiness();
    const autoReadiness = getAutoTradeReadiness();
    const openCount = getOpenPositions().length;
    const now = new Date();

    // Daily-loss guard runs on NET realized P&L (de-duplicated), not gross
    // losing-trade dollars. Status does not make a broker network call, so it
    // uses the local net source; the /account endpoint reconciles broker dayPnl.
    const loss = getDailyLossSnapshot();
    const entryAllowed = canOpenPosition(
      { tradesOpened: loss.tradesOpened, dailyLossUsed: loss.dailyLossUsed, netRealizedPnlToday: loss.netRealizedPnlToday },
      openCount,
      cfg,
      now,
    );
    // Open/close entry-only time guardrail status (entries only; exits unaffected).
    const timeGuardBlock = entryTimeWindowBlock(cfg, now);

    // Fresh-data readiness — show stale live candles as a readiness issue so the
    // operator knows the automation is not working off fresh candles.
    const snap = getSnapshot();
    const freshness = evaluateDataFreshness(snap?.spy?.candles, cfg, now, cfg.requireFreshData);

    res.json({
      mode: cfg.liveEnabled ? "LIVE" : "PAPER",
      dataFreshness: freshness,
      liveEnabled: cfg.liveEnabled,
      autoTradeEnabled: cfg.autoTradeEnabled && cfg.liveEnabled,
      killSwitchActive: cfg.killSwitchActive,
      liveReadiness: readiness,
      autoTradeReadiness: autoReadiness,
      entryGuards: {
        allowed: entryAllowed.allowed,
        reason: entryAllowed.reason,
        nearHighImpactNews: false, // evaluated per-signal; shown in signals endpoint
        // Open/close entry-only time guardrail (entries only; exits unaffected).
        timeGuard: {
          enabled: cfg.entryTimeGuardEnabled,
          openBlackoutMin: cfg.entryBlackoutOpenMin,
          closeBlackoutMin: cfg.entryBlackoutCloseMin,
          blocked: timeGuardBlock !== null,
          reason:
            timeGuardBlock ??
            `Entries allowed (outside the first ${cfg.entryBlackoutOpenMin} min after open / last ${cfg.entryBlackoutCloseMin} min before close)`,
        },
      },
      // Hard-flatten EXIT cutoff (closes existing positions near the close). This
      // is NOT an entry blocker — entries are allowed at any time of the session.
      flattenExit: {
        pastFlatten: isPastCutoff(cfg, now),
        flattenCT: `${cfg.flattenHourCT}:${String(cfg.flattenMinuteCT).padStart(2, "0")} CT`,
      },
      riskLimits: {
        maxContractsPerTrade: cfg.maxContractsPerTrade,
        preferredContractsPerTrade: cfg.preferredContractsPerTrade,
        minContractsPerTrade: cfg.minContractsPerTrade,
        maxOpenPositions: cfg.maxOpenPositions,
        maxTradesPerDay: cfg.maxTradesPerDay,
        maxDailyLoss: cfg.maxDailyLoss,
        stopLossFraction: cfg.stopLossFraction,
      },
      smallAccountProfile: {
        accountStartBalance: cfg.accountStartBalance,
        // Reporting only — NOT an entry blocker. The per-trade risk control is
        // the hard stop (stopLossFraction). Sizing is bounded by cash/buying
        // power and the optional explicit contract cap, never by this figure.
        maxLossPerTradeReportingOnly: cfg.maxLossPerTrade,
        hardStopFraction: cfg.stopLossFraction,
        trailStartFraction: cfg.trailStartFraction,
        trailGivebackFraction: cfg.trailGivebackFraction,
        breakevenArmFraction: cfg.breakevenArmFraction,
        profitLockArmFraction: cfg.profitLockArmFraction,
        profitLockProfitFraction: cfg.profitLockProfitFraction,
        minOptionPremium: cfg.minOptionPremium,
        maxSpreadPct: cfg.maxSpreadPct,
        note: `Full position exits together. Hard stop -${(cfg.stopLossFraction * 100).toFixed(0)}%${cfg.breakevenArmFraction > 0 ? `, breakeven-protect at +${(cfg.breakevenArmFraction * 100).toFixed(0)}% (raises stop to entry)` : ""}${cfg.profitLockArmFraction > 0 ? `, profit-lock at +${(cfg.profitLockArmFraction * 100).toFixed(0)}% (raises stop to +${(cfg.profitLockProfitFraction * 100).toFixed(0)}%)` : ""}, trail arms +${(cfg.trailStartFraction * 100).toFixed(0)}%, giveback exit ${(cfg.trailGivebackFraction * 100).toFixed(0)}% from peak, plus flatten/invalidation safety exits. Quality filters: mid ≥ $${cfg.minOptionPremium.toFixed(2)}, spread ≤ ${(cfg.maxSpreadPct * 100).toFixed(0)}% of mid, 30m+15m trend + VWAP/EMA alignment required.`,
      },
      // `daily` reports the day's P&L on a NET realized basis (winners offset
      // losers) — this is what the daily-loss guard uses. `grossLosingTradesToday`
      // is the old gross-loss figure, kept as an informational metric only.
      daily: {
        date: loss.date,
        tradesOpened: loss.tradesOpened,
        netRealizedPnlToday: loss.netRealizedPnlToday,
        dailyLossUsed: loss.dailyLossUsed,
        dailyLossRemaining: round2(Math.max(0, cfg.maxDailyLoss - loss.dailyLossUsed)),
        grossLosingTradesToday: loss.grossLossToday,
        dailyLossSource: loss.source,
        maxDailyLoss: cfg.maxDailyLoss,
      },
      openPositions: openCount,
      tradierBaseUrl: cfg.tradierBaseUrl,
      warnings: [
        "⚠ HIGH RISK: 0DTE options can expire worthless.",
        cfg.liveEnabled
          ? "🔴 LIVE MODE ACTIVE — real orders will be sent to Tradier when confirmLiveOrder=true."
          : "🟡 PAPER MODE — no real orders. Set TRADIER_ENABLE_LIVE_TRADING=true + credentials to enable live.",
        ...(freshness.enforced && !freshness.ready
          ? [`🟠 DATA NOT READY: ${freshness.detail}`]
          : []),
        "This is software infrastructure, not financial advice.",
      ],
    });
  });

  // ── GET /api/bot/account ───────────────────────────────────────────────────
  // Read-only Tradier account balances + bot-managed P&L. Never places an order
  // and never returns secrets. Account values are "unavailable" when
  // TRADIER_TOKEN / TRADIER_ACCOUNT_ID are missing or the API errors.
  app.get("/api/bot/account", async (_req: Request, res: Response) => {
    const cfg = getBotConfig();

    const account = await fetchAccountSnapshot(cfg);

    // Bot-managed P&L from locally tracked positions, valued at the last marks
    // observed by the automation exit loop (best-effort for unrealized).
    const marks = getMarkSnapshot();
    const botPnl = computeBotPnl(marks);

    // Daily-loss guard snapshot, reconciled against the broker's live DAY P&L
    // when that field is present and finite. We pass account.dayPnl ONLY — never
    // account.totalPnl (all-time) and never a null/stale field — so a null
    // broker day figure falls back to the local de-duplicated net realized P&L.
    const brokerDayPnl =
      account.available && typeof account.dayPnl === "number" && Number.isFinite(account.dayPnl)
        ? account.dayPnl
        : null;
    const dailyLoss = getDailyLossSnapshot(brokerDayPnl);

    // Broker positions are best-effort context only (reconciliation), never the
    // source of truth for bot P&L.
    const broker = await fetchBrokerPositions(cfg);

    const warnings: string[] = [];
    if (!account.available) {
      warnings.push(
        `Account balances unavailable: ${account.reason ?? "unknown"}. ` +
          "Set TRADIER_TOKEN and TRADIER_ACCOUNT_ID to track account equity and P&L.",
      );
    }
    if (botPnl.unrealizedPnl === null && botPnl.openPositionCount > 0) {
      warnings.push(
        "Unrealized bot P&L unavailable — no live option marks yet (run the automation engine or enable TRADIER_TOKEN).",
      );
    } else if (botPnl.unrealizedPartial) {
      warnings.push(
        `Unrealized bot P&L is partial — ${botPnl.markedPositionCount}/${botPnl.openPositionCount} open positions had a live mark.`,
      );
    }

    // Surface broker positions the bot already handled (adopted+exited this day)
    // but the broker is still reporting — pending settlement. These are NOT
    // re-adopted or re-exited; their P&L is counted once in botPnl. Flag the
    // divergence so the operator reads Tradier account P&L as the live source of
    // truth and bot P&L as the local exit-management ledger.
    const pending = getAutomationStatus().pendingBrokerPositions;
    if (pending.length) {
      warnings.push(
        `${pending.length} broker position(s) already handled by the bot are still reported by Tradier ` +
          `(pending settlement): ${pending.join(", ")}. These are not re-exited; their realized P&L is ` +
          "counted once. Tradier account P&L is the live source of truth; bot P&L reflects local exit management.",
      );
    }

    res.json({
      fetchedAt: new Date().toISOString(),
      mode: cfg.liveEnabled ? "LIVE" : "PAPER",
      // Tradier live account P&L (source of truth for real money).
      account,
      // Local bot exit-management P&L (de-duplicated per adopted broker identity).
      botPnl,
      // Daily-loss guard view: NET realized P&L basis (not gross losing trades).
      // dailyLossSource shows whether the day figure came from the broker's live
      // day P&L or the local de-duplicated net realized P&L.
      dailyLoss: {
        date: dailyLoss.date,
        tradesOpened: dailyLoss.tradesOpened,
        netRealizedPnlToday: dailyLoss.netRealizedPnlToday,
        dailyLossUsed: dailyLoss.dailyLossUsed,
        dailyLossRemaining: round2(Math.max(0, cfg.maxDailyLoss - dailyLoss.dailyLossUsed)),
        grossLosingTradesToday: dailyLoss.grossLossToday,
        dailyLossSource: dailyLoss.source,
        maxDailyLoss: cfg.maxDailyLoss,
      },
      pendingBrokerPositions: pending,
      brokerPositions: {
        available: broker.available,
        count: broker.positions.length,
        positions: broker.positions,
      },
      warnings,
      note: "Account values (account.*) are read-only LIVE Tradier balances/P&L — the source of truth for real money. botPnl is computed from locally tracked positions (de-duplicated per adopted broker identity) and may differ from real fills. Not financial advice.",
    });
  });

  // ── GET /api/bot/scorecard ─────────────────────────────────────────────────
  // Read-only daily trading scorecard for the current trading day. Aggregates
  // locally tracked positions (realized P&L, win/loss, averages, best/worst,
  // exit-reason breakdown, sizing distribution) and surfaces the live active
  // strategy settings. NEVER places an order or mutates bot state.
  app.get("/api/bot/scorecard", (_req: Request, res: Response) => {
    const cfg = getBotConfig();

    // Unrealized P&L uses the last marks the automation exit loop observed
    // (best-effort; null when no open position has a usable mark).
    const marks = getMarkSnapshot();
    const scorecard = computeDailyScorecard(marks);

    res.json({
      generatedAt: new Date().toISOString(),
      mode: cfg.liveEnabled ? "LIVE" : "PAPER",
      scorecard,
      // Live active strategy settings sourced from config/constants so the
      // operator can verify the running profile matches the intended strategy.
      strategy: {
        preferredContractsPerTrade: cfg.preferredContractsPerTrade,
        minContractsPerTrade: cfg.minContractsPerTrade,
        maxContractsPerTrade: cfg.maxContractsPerTrade,
        stopLossFraction: cfg.stopLossFraction,
        breakevenArmFraction: cfg.breakevenArmFraction,
        trailStartFraction: cfg.trailStartFraction,
        trailGivebackFraction: cfg.trailGivebackFraction,
        contractSelectionMode: cfg.contractSelectionMode,
        maxDailyLoss: cfg.maxDailyLoss,
        maxLossPerTrade: cfg.maxLossPerTrade,
        liveEnabled: cfg.liveEnabled,
        autoTradeEnabled: cfg.autoTradeEnabled && cfg.liveEnabled,
        killSwitchActive: cfg.killSwitchActive,
        autoReady: getAutoTradeReadiness().autoReady,
      },
      note: "Scorecard is computed from locally tracked positions for the current trading day and may differ from real Tradier fills. Read-only. Not financial advice.",
    });
  });

  // ── GET /api/bot/scorecard/weekly ──────────────────────────────────────────
  // Read-only weekly trading scorecard (Mon–Fri of the current NY week).
  // Aggregates the same metrics as the daily scorecard across the week, plus a
  // per-day breakdown so the operator can see each session's contribution.
  // Never places an order or mutates bot state.
  app.get("/api/bot/scorecard/weekly", (_req: Request, res: Response) => {
    const cfg = getBotConfig();
    const scorecard = computeWeeklyScorecard();
    res.json({
      generatedAt: new Date().toISOString(),
      mode: cfg.liveEnabled ? "LIVE" : "PAPER",
      scorecard,
      note: "Weekly scorecard is computed from locally tracked positions for the current NY-local Mon–Fri week and may differ from real Tradier fills. Read-only. Not financial advice.",
    });
  });

  // ── GET /api/bot/scorecard/by-source ───────────────────────────────────────
  // Read-only per-setup-source scorecard for the current trading day. Buckets
  // today's closed trades by the setup that generated them (Pullback / VWAP /
  // Generic continuation / Other-manual) and rolls up trades, win-rate, and net
  // P&L per bucket. Never places an order or mutates bot state.
  app.get("/api/bot/scorecard/by-source", (_req: Request, res: Response) => {
    const cfg = getBotConfig();
    const scorecard = computeSetupSourceScorecard();
    res.json({
      generatedAt: new Date().toISOString(),
      mode: cfg.liveEnabled ? "LIVE" : "PAPER",
      scorecard,
      note: "Per-source scorecard is computed from locally tracked positions for the current trading day. Trades placed before source tagging shipped, and adopted broker positions, bucket as 'Other / manual'. Read-only. Not financial advice.",
    });
  });

  // ── GET /api/bot/signals ───────────────────────────────────────────────────
  app.get("/api/bot/signals", (_req: Request, res: Response) => {
    const snapshot = getSnapshot();
    const cfg = getBotConfig();
    const signals = generateSignals(snapshot, cfg);

    // Attach a position-sizing preview so the UI can show preferred vs. actual
    // (e.g. "fallback to 2 contracts") without placing any order.
    const sized = signals.map((sig) => {
      const premium = sig.suggestedEntryPremium ?? sig.contract?.ask ?? sig.contract?.last ?? null;
      const sizing = premium && premium > 0 ? sizePosition(premium, cfg) : null;
      return { ...sig, sizing };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      count: signals.length,
      signals: sized,
      mode: cfg.liveEnabled ? "LIVE" : "PAPER",
      disclaimer:
        "Signals are trade plans derived from technical setup analysis. " +
        "They are NOT trade recommendations. 0DTE options carry extreme risk. " +
        "Verify all signals manually before acting. Not financial advice.",
    });
  });

  // ── GET /api/bot/positions ─────────────────────────────────────────────────
  app.get("/api/bot/positions", (_req: Request, res: Response) => {
    const cfg = getBotConfig();
    res.json({
      open: getOpenPositions(),
      all: getAllPositions(),
      mode: cfg.liveEnabled ? "LIVE" : "PAPER",
      note: "Positions are tracked locally. For live orders, verify against your Tradier account dashboard.",
    });
  });

  // ── GET /api/bot/fills ─────────────────────────────────────────────────────
  app.get("/api/bot/fills", (_req: Request, res: Response) => {
    const cfg = getBotConfig();
    res.json({
      fills: getRecentFills(),
      daily: getDailyStats(),
      mode: cfg.liveEnabled ? "LIVE" : "PAPER",
    });
  });

  // ── POST /api/bot/paper-order ──────────────────────────────────────────────
  // Always paper — safe for testing at any time.
  app.post("/api/bot/paper-order", (req: Request, res: Response) => {
    const body = req.body ?? {};
    const { optionSymbol, side, contracts, orderType, limitPrice, strike, expiry, entryPremium } = body;

    if (!optionSymbol || !side || !contracts || !orderType) {
      res.status(400).json({
        error: "Missing required fields: optionSymbol, side, contracts, orderType",
      });
      return;
    }

    const cfg = getBotConfig();
    const loss = getDailyLossSnapshot();
    const openCount = getOpenPositions().length;
    const guard = canOpenPosition(
      { tradesOpened: loss.tradesOpened, dailyLossUsed: loss.dailyLossUsed, netRealizedPnlToday: loss.netRealizedPnlToday },
      openCount,
      cfg,
    );

    if (!guard.allowed) {
      res.status(429).json({
        error: "Paper order blocked by risk guardrail",
        reason: guard.reason,
        simulated: true,
      });
      return;
    }

    const payload = buildOptionOrderPayload({
      optionSymbol,
      side,
      contracts: Number(contracts),
      orderType,
      limitPrice: limitPrice ? Number(limitPrice) : undefined,
    });

    let fill;
    try {
      fill = executePaperOrder(payload);
    } catch (err) {
      // Same-day 0DTE guard (or other build error) — refuse, do not track.
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
        simulated: true,
        mode: "PAPER",
      });
      return;
    }

    // Track in paper state
    const premium = Number(entryPremium) || Number(limitPrice) || 0.50;
    const pos = openPaperPosition({
      symbol: optionSymbol,
      side: side.includes("put") || body.bias === "Put" ? "Put" : "Call",
      strike: Number(strike) || 0,
      expiry: expiry ?? new Date().toISOString().slice(0, 10),
      contracts: Number(contracts),
      entryPremium: premium,
      stopFraction: cfg.stopLossFraction,
      takeProfitFraction: cfg.takeProfitFraction,
      trailStartFraction: cfg.trailStartFraction,
      trailGivebackFraction: cfg.trailGivebackFraction,
      breakevenArmFraction: cfg.breakevenArmFraction,
      profitLockArmFraction: cfg.profitLockArmFraction,
      profitLockProfitFraction: cfg.profitLockProfitFraction,
      setupTitle: body.setupTitle,
    });

    res.json({
      simulated: true,
      fill,
      position: pos,
      mode: "PAPER",
      note: "Paper order — no real trade placed. Switch to /api/bot/order with confirmLiveOrder:true and live env vars for real execution.",
    });
  });

  // ── POST /api/bot/order ────────────────────────────────────────────────────
  // Routes to LIVE or PAPER depending on env config + confirmLiveOrder field.
  // Live path enforces all 4 guards in tradierAdapter.ts.
  app.post("/api/bot/order", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const {
      optionSymbol,
      side,
      contracts,
      orderType,
      limitPrice,
      strike,
      expiry,
      entryPremium,
      confirmLiveOrder,
    } = body;

    if (!optionSymbol || !side || !contracts || !orderType) {
      res.status(400).json({
        error: "Missing required fields: optionSymbol, side, contracts, orderType",
      });
      return;
    }

    const cfg = getBotConfig();
    const loss = getDailyLossSnapshot();
    const openCount = getOpenPositions().length;
    const guard = canOpenPosition(
      { tradesOpened: loss.tradesOpened, dailyLossUsed: loss.dailyLossUsed, netRealizedPnlToday: loss.netRealizedPnlToday },
      openCount,
      cfg,
    );

    if (!guard.allowed) {
      res.status(429).json({
        error: "Order blocked by risk guardrail",
        reason: guard.reason,
        mode: cfg.liveEnabled ? "LIVE" : "PAPER",
      });
      return;
    }

    const payload = buildOptionOrderPayload({
      optionSymbol,
      side,
      contracts: Number(contracts),
      orderType,
      limitPrice: limitPrice ? Number(limitPrice) : undefined,
    });

    try {
      const result = await executeOrder(payload, cfg, confirmLiveOrder === true);

      // The requested/synthetic premium is used ONLY to value a PAPER fill. A
      // real live fill must be valued at the broker-reported average price, never
      // this number — recording the requested price as the basis silently
      // mis-states P&L and the stop.
      const requestedPremium = Number(entryPremium) || Number(limitPrice) || 0.50;
      const requestedContracts = Number(contracts);

      let fillPremium = requestedPremium;
      let filledContracts = requestedContracts;
      let partialFill = false;

      // ── FILL-CONFIRMATION (live only) ───────────────────────────────────────
      // A live order is merely ACCEPTED at submission, not filled. Do NOT open a
      // local position until Tradier confirms execution. Poll the order status,
      // record the ACTUAL average fill price and executed quantity, and cancel
      // any unfilled remainder. On rejection/timeout, open NO position and surface
      // the failure to the caller — never assume a synthetic fill. Paper orders
      // (result.simulated) skip this: they have no real broker fill to confirm.
      if (!result.simulated) {
        if (!result.orderId) {
          res.status(502).json({
            error:
              "Live order returned no order id — fill cannot be confirmed; no position opened. " +
              "Verify in your Tradier dashboard.",
            mode: "LIVE",
            tradierResponse: result.tradierResponse,
          });
          return;
        }

        const fill = await waitForFill(result.orderId, cfg, cfg.entryFillTimeoutMs);

        if (fill.outcome === "filled") {
          filledContracts = fill.execQuantity ?? requestedContracts;
          fillPremium = fill.avgFillPrice ?? requestedPremium;
        } else if (fill.outcome === "partial") {
          // Keep what executed, cancel the working remainder, flag for review.
          await cancelOrder(result.orderId, cfg);
          filledContracts = fill.execQuantity ?? 0;
          fillPremium = fill.avgFillPrice ?? requestedPremium;
          if (filledContracts < 1) {
            res.status(502).json({
              error: `Live order ${result.orderId} canceled with no executed contracts — no position opened.`,
              mode: "LIVE",
              orderId: result.orderId,
              status: fill.status,
            });
            return;
          }
          partialFill = true;
        } else if (fill.outcome === "unfilled" || fill.outcome === "rejected") {
          // unfilled: nothing executed before timeout — cancel the working order.
          // rejected/canceled/expired: terminal with zero executed.
          if (fill.outcome === "unfilled") await cancelOrder(result.orderId, cfg);
          res.status(502).json({
            error: `Live order ${result.orderId} ${fill.outcome} (status ${fill.status ?? "?"}) — no position opened.`,
            mode: "LIVE",
            orderId: result.orderId,
            status: fill.status,
          });
          return;
        } else {
          // "unknown": the status endpoint was unreachable. FAIL SAFE — do not
          // assume a fill and do not assume a miss. Best-effort cancel and open NO
          // local position; the automation reconciler adopts the position later if
          // the order actually executed, avoiding a managed phantom either way.
          await cancelOrder(result.orderId, cfg);
          res.status(502).json({
            error:
              `Live order ${result.orderId} status unverifiable (fill-confirmation timeout) — no position opened. ` +
              "The automation reconciler will adopt it if it filled; verify in your Tradier dashboard.",
            mode: "LIVE",
            orderId: result.orderId,
          });
          return;
        }
      }

      // Track locally — PAPER at the requested premium, LIVE at the CONFIRMED
      // fill price/quantity (never the requested/synthetic price).
      const pos = openPaperPosition({
        symbol: optionSymbol,
        side: side.includes("put") || body.bias === "Put" ? "Put" : "Call",
        strike: Number(strike) || 0,
        expiry: expiry ?? new Date().toISOString().slice(0, 10),
        contracts: filledContracts,
        entryPremium: fillPremium,
        stopFraction: cfg.stopLossFraction,
        takeProfitFraction: cfg.takeProfitFraction,
        trailStartFraction: cfg.trailStartFraction,
        trailGivebackFraction: cfg.trailGivebackFraction,
        breakevenArmFraction: cfg.breakevenArmFraction,
        profitLockArmFraction: cfg.profitLockArmFraction,
        profitLockProfitFraction: cfg.profitLockProfitFraction,
        setupTitle: body.setupTitle,
      });

      const goingLive = cfg.liveEnabled && confirmLiveOrder === true;
      const warnings = goingLive
        ? ["🔴 LIVE ORDER FILLED ON TRADIER. Verify in your Tradier dashboard."]
        : ["🟡 Paper/test order — no real trade placed."];
      if (partialFill) {
        warnings.push(
          `⚠ PARTIAL FILL: ${filledContracts}/${requestedContracts} contracts executed @ ${fillPremium.toFixed(2)}; ` +
            "remainder canceled. Position opened for the executed quantity — review.",
        );
      }

      res.json({
        ...result,
        position: pos,
        filledContracts,
        fillPremium,
        partialFill,
        mode: goingLive ? "LIVE" : "PAPER",
        warnings,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({
        error: message,
        mode: cfg.liveEnabled ? "LIVE" : "PAPER",
        hint: cfg.liveEnabled
          ? "Live order rejected. Check confirmLiveOrder field and credentials."
          : "Paper mode active. Set TRADIER_ENABLE_LIVE_TRADING=true to enable live.",
      });
    }
  });

  // ── POST /api/bot/close ────────────────────────────────────────────────────
  app.post("/api/bot/close", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const { positionId, closePremium, reason, confirmLiveOrder, symbol, expectedContracts } = body;

    if (!positionId || closePremium === undefined) {
      res.status(400).json({ error: "Missing required fields: positionId, closePremium" });
      return;
    }

    const premium = Number(closePremium);
    if (!Number.isFinite(premium) || premium < 0) {
      res.status(400).json({ error: "closePremium must be a finite non-negative number" });
      return;
    }

    const cfg = getBotConfig();
    const openPositions = getOpenPositions();
    const pos = openPositions.find((p) => p.id === positionId);

    if (!pos) {
      res.status(404).json({ error: `Position ${positionId} not found or already closed` });
      return;
    }

    // Identity validation: when the caller supplies the symbol/quantity it must
    // match the tracked position, so a stale dashboard row can never close a
    // different live contract than the one the user saw.
    if (symbol !== undefined && symbol !== pos.symbol) {
      res.status(409).json({
        error: `Symbol mismatch: request ${symbol} does not match tracked position ${pos.symbol}`,
      });
      return;
    }
    if (
      expectedContracts !== undefined &&
      Number(expectedContracts) !== pos.contracts
    ) {
      res.status(409).json({
        error: `Quantity mismatch: request ${expectedContracts} does not match tracked ${pos.contracts}`,
      });
      return;
    }

    // For live mode, send a sell-to-close order to Tradier. This live path is
    // reached ONLY here, when the user clicks "Close trade" and confirms, and
    // only when the existing live-trading safety flags are enabled.
    const goingLive = cfg.liveEnabled && confirmLiveOrder === true;
    let liveResult: unknown = null;
    if (goingLive) {
      try {
        const closePayload = buildOptionOrderPayload({
          optionSymbol: pos.symbol,
          side: "sell_to_close",
          contracts: pos.contracts,
          orderType: "market",
        });
        liveResult = await executeOrder(closePayload, cfg, true);
      } catch (err) {
        res.status(400).json({
          error: `Live close order failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    const closed = closePaperPosition(
      positionId,
      premium,
      reason ?? "Manual close via dashboard",
    );

    res.json({
      ok: true,
      closed,
      symbol: pos.symbol,
      contracts: pos.contracts,
      liveOrderResult: liveResult,
      mode: goingLive ? "LIVE" : "PAPER",
      note: goingLive
        ? "Live sell-to-close submitted to Tradier."
        : "Position closed in local tracking (paper). No live order sent.",
    });
  });

  // ── POST /api/bot/kill-switch ──────────────────────────────────────────────
  app.post("/api/bot/kill-switch", (req: Request, res: Response) => {
    const { active } = req.body ?? {};
    if (typeof active !== "boolean") {
      res.status(400).json({ error: "Body must include { active: true|false }" });
      return;
    }
    setKillSwitch(active);
    res.json({
      killSwitchActive: active,
      message: active
        ? "🛑 Kill switch ACTIVATED — bot signals and new orders are suppressed."
        : "✅ Kill switch DEACTIVATED — bot is active.",
    });
  });

  // ── GET /api/bot/automation/status ─────────────────────────────────────────
  // Autonomous engine state: enabled/running, last tick/action, blockers,
  // managed positions, and recent automation events.
  app.get("/api/bot/automation/status", (_req: Request, res: Response) => {
    const cfg = getBotConfig();
    res.json({
      ...getAutomationStatus(),
      autoTradeReadiness: getAutoTradeReadiness(),
      note: cfg.autoTradeEnabled && cfg.liveEnabled
        ? "🔴 AUTONOMOUS LIVE TRADING ARMED — the bot will enter and exit real positions on its own."
        : "🟡 Observe-only. Set TRADIER_AUTO_TRADE=true (plus live env) to arm autonomous execution.",
    });
  });

  // ── POST /api/bot/automation/start-stop ────────────────────────────────────
  // Runtime toggle ONLY. This does NOT enable real orders — TRADIER_AUTO_TRADE
  // and the full live env are still required for any real autonomous order.
  app.post("/api/bot/automation/start-stop", (req: Request, res: Response) => {
    const { running } = req.body ?? {};
    if (typeof running !== "boolean") {
      res.status(400).json({ error: "Body must include { running: true|false }" });
      return;
    }
    setAutomationRunning(running);
    const cfg = getBotConfig();
    res.json({
      running,
      autoTradeEnabled: cfg.autoTradeEnabled && cfg.liveEnabled,
      message: running
        ? "Automation runtime resumed. Real orders still require TRADIER_AUTO_TRADE=true + live env."
        : "Automation runtime paused. No new autonomous entries will be evaluated.",
    });
  });

  // ── POST /api/bot/risk-pass ────────────────────────────────────────────────
  // Run risk evaluation on all open positions using supplied premium prices.
  // Caller provides { premiums: { [positionId]: currentPremium } }
  app.post("/api/bot/risk-pass", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const { premiums, confirmLiveOrder } = body;

    if (!premiums || typeof premiums !== "object") {
      res.status(400).json({ error: "Body must include { premiums: { [positionId]: number } }" });
      return;
    }

    const cfg = getBotConfig();
    const premiumMap = new Map<string, number>(
      Object.entries(premiums).map(([k, v]) => [k, Number(v)]),
    );

    const results = runRiskPass(premiumMap, cfg);

    // For live mode with closes, send actual Tradier orders for stopped positions
    const liveCloses: Array<{ positionId: string; result: unknown }> = [];
    if (cfg.liveEnabled && confirmLiveOrder === true) {
      for (const r of results) {
        if (r.action.kind === "stop" || r.action.kind === "flatten") {
          const openPos = getAllPositions().find((p) => p.id === r.positionId);
          if (openPos && openPos.status === "closed") {
            // Already applied to paper state; now send live close
            try {
              const closePayload = buildOptionOrderPayload({
                optionSymbol: openPos.symbol,
                side: "sell_to_close",
                contracts: openPos.contracts,
                orderType: "market",
              });
              const liveResult = await executeOrder(closePayload, cfg, true);
              liveCloses.push({ positionId: r.positionId, result: liveResult });
            } catch (err) {
              liveCloses.push({
                positionId: r.positionId,
                result: { error: String(err) },
              });
            }
          }
        }
      }
    }

    res.json({
      results,
      liveCloses,
      mode: cfg.liveEnabled && confirmLiveOrder === true ? "LIVE" : "PAPER",
      openAfter: getOpenPositions().length,
    });
  });

  // ── POST /api/bot/reset-paper ──────────────────────────────────────────────
  // Reset paper state — for development/testing only.
  app.post("/api/bot/reset-paper", (_req: Request, res: Response) => {
    resetPaperState();
    res.json({ ok: true, message: "Paper state reset. Open positions cleared." });
  });
}
