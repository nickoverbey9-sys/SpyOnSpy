/**
 * Bot configuration — all values sourced from environment variables with
 * conservative defaults. No secrets are hardcoded.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE TRADING BOT — SPY 0DTE OPTIONS VIA TRADIER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This bot is designed for LIVE trading of SPY 0DTE options through Tradier.
 * Paper/simulation mode exists only as a safe fallback for testing.
 *
 * ─── LIVE TRADING GUARD (NON-NEGOTIABLE) ────────────────────────────────────
 * Real orders are BLOCKED until ALL of the following are present:
 *
 *   1. TRADIER_ENABLE_LIVE_TRADING=true     ← explicit opt-in env var
 *   2. TRADIER_ACCOUNT_ID=<your account id> ← real brokerage account
 *   3. TRADIER_TOKEN=<your API token>        ← real Tradier Bearer token
 *   4. { confirmLiveOrder: true }            ← per-request body field
 *
 * Missing any one of these → order is REJECTED before any network call.
 *
 * This design prevents accidental or unauthorized live orders during
 * development, CI, or misconfigured deploys.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Required env vars for live mode:
 *   TRADIER_ENABLE_LIVE_TRADING=true
 *   TRADIER_ACCOUNT_ID=<account id>
 *   TRADIER_TOKEN=<API token>
 *
 * Optional tuning env vars (all have safe defaults):
 *   BOT_PREFERRED_CONTRACTS_PER_TRADE default: 4  (try to buy 4 contracts when
 *                                                 cash/buying power allows it)
 *   BOT_MIN_CONTRACTS_PER_TRADE   default: 1  (hard minimum — sizing steps down
 *                                              from the preferred size toward 1;
 *                                              if even 1 contract is not
 *                                              affordable or breaches the
 *                                              per-trade risk cap, skip)
 *   BOT_MAX_CONTRACTS_PER_TRADE   default: 0  (0 or -1 = NO explicit cap; when
 *                                              finite and >= 1 it caps qty)
 *   BOT_MAX_OPEN_POSITIONS        default: 2  (0 or -1 = unlimited, if set explicitly)
 *   BOT_MAX_TRADES_PER_DAY        default: 6  (0 or -1 = unlimited, if set explicitly)
 *   BOT_MAX_DAILY_LOSS            default: 200 (USD — max NET realized loss per day;
 *                                              broker day P&L is authoritative when live)
 *   BOT_STOP_LOSS_FRACTION        default: 0.20  (20% of premium — hard stop
 *                                                tuned for a small $1.3k account)
 *   BOT_TRIM1_FRACTION            DEPRECATED / unused for exits. The +30% trim
 *                                 was removed because it contradicted the
 *                                 trailing runner. Retained only so the env var
 *                                 still parses. Default: 0.30.
 *   BOT_TRIM2_FRACTION            DEPRECATED / unused for exits. The +60% trim
 *                                 was removed for the same reason. Retained only
 *                                 for back-compat parsing. Default: 0.60.
 *
 * ─── RISK PROFILE: FULL-POSITION RUNNER EXIT (ALL SIZES) ────────────────────
 * Every position — single OR multiple contracts — uses the SAME no-trim exit.
 * There is no partial trim ladder: the full position runs together and exits
 * only on the hard stop, the trailing stop, or a flatten/invalidation. Instead
 * of taking fixed profit, a winner is allowed to RUN: a give-back trailing stop
 * arms at +25% profit and then exits the full remaining size only when the
 * premium drops the configured give-back (default 15%) from its post-arm peak. There is NO fixed full take-profit —
 * +25% only ARMS the trail; the winner can run well beyond it. The hard -20%
 * stop stays in force until the trade first reaches +25% and arms the trail.
 *
 *   BOT_BREAKEVEN_ARM_FRACTION    default: 0.10  (once +10% up, raise the stop to
 *                                                entry/breakeven — shrinks the
 *                                                0 → +25% dead zone; only RAISES
 *                                                the stop, never loosens it; <=0
 *                                                disables breakeven protection)
 *   BOT_TRAIL_START_FRACTION      default: 0.25  (arm the trail once +25% up)
 *   BOT_TRAIL_GIVEBACK_FRACTION   default: 0.15  (exit if it gives back 15% of
 *                                                the peak premium after arming —
 *                                                5% was inside 0DTE quote noise)
 *   BOT_TAKE_PROFIT_FRACTION      DEPRECATED / unused for exits. Retained only
 *                                 for backward-compatible config parsing; the
 *                                 single-contract fixed take-profit was removed
 *                                 in favor of the +25% arm / give-back trail.
 *   BOT_MAX_LOSS_PER_TRADE        default: 100   (USD; ENFORCED as a sizing cap by
 *                                                default — downsizes or skips an
 *                                                entry whose projected stop risk
 *                                                exceeds it. Disable enforcement
 *                                                with BOT_ENFORCE_MAX_LOSS_PER_TRADE=false.)
 *   BOT_ENFORCE_MAX_LOSS_PER_TRADE default: true
 *   BOT_ENTRY_FILL_TIMEOUT_MS     default: 20000 (poll a live entry order this long,
 *                                                then cancel; local position opens
 *                                                only on confirmed executed qty/price)
 *   BOT_EXIT_FILL_TIMEOUT_MS      default: 12000 (poll a live exit limit this long,
 *                                                then cancel and escalate to MARKET)
 *   BOT_MARK_FAILURE_ALERT_COUNT  default: 8     (alert after this many consecutive
 *                                                failed quote fetches on an open position)
 *   BOT_PDT_GUARD_ENABLED         default: true  (block the 4th same-day round trip
 *                                                on a sub-$25k margin account)
 *   BOT_ACCOUNT_START_BALANCE     default: 1326.24 (USD; used for sizing/backtest
 *                                                when no live Tradier balance.)
 *   BOT_MIN_OPTION_PREMIUM        default: 0.15  (skip/review entries whose mid
 *                                                premium is below $0.15/share)
 *   BOT_MAX_SPREAD_PCT            default: 0.30  (skip/review entries whose
 *                                                (ask−bid)/mid exceeds 30%)
 *
 * ─── INTRADAY TIME-OF-DAY GATES ─────────────────────────────────────────────
 * There are NO time-of-day ENTRY blockers. Entries are permitted at any time of
 * the session as long as the non-time safety gates pass (kill switch, daily loss
 * stop, same-day 0DTE guard, live/auto authorization, sizing/risk limits, and
 * the trend/quality filters). The only remaining time-of-day controls are the
 * hard-flatten EXITS below, which close existing positions near the close and
 * never block opening new ones.
 *
 *   BOT_FLATTEN_HOUR_CT           default: 14  (2 PM CT)
 *   BOT_FLATTEN_MINUTE_CT         default: 30  (→ 2:30 PM CT)
 *   BOT_MIN_CONFIDENCE            default: 55
 *   BOT_ALLOW_MEDIUM_CONFIDENCE   default: true
 *   BOT_MIN_UNUSUAL_SCORE         default: 60
 *   BOT_KILL_SWITCH               default: false
 *   BOT_NEWS_BLACKOUT_MINUTES     default: 10
 *   BOT_OTM_STRIKES               default: 1   (prefer contracts this many
 *                                               strikes out-of-the-money; 1 =
 *                                               first strike OTM for the bias.
 *                                               <= 0 = ATM/nearest-to-spot.
 *                                               Used by the fixed_otm mode.)
 *
 * ─── SMART CONTRACT SELECTION ───────────────────────────────────────────────
 * The selector can either target a FIXED strike offset (legacy) or SCORE the
 * same-day ATM / 1-OTM / 2-OTM candidates and pick the best under the same
 * premium/spread/0DTE guardrails. The smart mode prefers a stronger premium
 * (higher delta — less exposed to stalling below the +35% trail arm), an
 * in-band delta, and better liquidity, while penalising distance from spot.
 *
 *   BOT_CONTRACT_SELECTION_MODE   default: best_liquid  (fixed_otm | best_liquid)
 *   BOT_SELECTOR_MAX_OTM_STRIKES  default: 2   (never choose beyond 2 OTM; never ITM)
 *   BOT_SELECTOR_PREFERRED_MIN_PREMIUM default: 0.70 (full premium score at/above)
 *   BOT_SELECTOR_DELTA_MIN        default: 0.35 (target delta band lower bound)
 *   BOT_SELECTOR_DELTA_MAX        default: 0.55 (target delta band upper bound)
 *   BOT_SELECTOR_PREFERRED_MAX_SPREAD_PCT default: 0.25 (full tight-spread bonus ≤ this)
 *
 * ─── AUTONOMOUS TRADING (HANDS-OFF) — DEFAULTS OFF ──────────────────────────
 * Fully autonomous entry/exit is BLOCKED unless TRADIER_AUTO_TRADE=true AND all
 * live guards above are also satisfied. The automation engine supplies the
 * internal confirmLiveOrder=true when calling the guarded adapter; it never
 * bypasses the same-day 0DTE guard or the risk limits.
 *
 *   TRADIER_AUTO_TRADE              default: false  ← master autonomy switch
 *   BOT_AUTOMATION_INTERVAL_MS      default: 15000  (entry evaluation loop)
 *   BOT_EXIT_MANAGEMENT_INTERVAL_MS default: 8000   (exit/management loop)
 *   BOT_AUTO_MIN_CONFIDENCE         default: 70     (min confidence to auto-enter)
 *   BOT_FLATTEN_TIME_CT_HOUR        default: 14     (auto-flatten hour CT)
 *   BOT_FLATTEN_TIME_CT_MINUTE      default: 55     (→ 14:55 CT auto-flatten)
 *   BOT_AUTO_ENTRY_COOLDOWN_MS      default: 300000 (per-contract re-entry cooldown)
 *   BOT_PAPER_STATE_FILE          default: none (in-memory only)
 *   TRADIER_BASE_URL              default: https://api.tradier.com (live)
 *                                          https://sandbox.tradier.com (no live env)
 *
 * ─── FRESH-DATA GUARD (LIVE/RUNTIME ONLY) ───────────────────────────────────
 * During live automation / RTH the engine must act on fresh candles. If the
 * newest live 1m candle is older than the staleness threshold the signal is
 * marked NOT-READY (BLOCKED) so the dashboard/status surfaces it as a readiness
 * issue rather than silently trading a stale tape. Historical/offline backtests
 * pass requireFreshData=false so they are never blocked by this guard.
 *
 *   BOT_REQUIRE_FRESH_DATA          default: true  (enforce during live runtime)
 *   BOT_MAX_CANDLE_STALENESS_SEC    default: 120   (newest 1m candle must be ≤
 *                                                   this many seconds old; >2 min
 *                                                   is treated as stale)
 *
 * ─── OPEN-WINDOW LIQUIDATION OVERRIDE (NARROW, 09:30–09:35 ET) ───────────────
 * A gap-down liquidation that STARTS at the open cannot clear the strict
 * neutral-HTF block on the first bar. A tightly-scoped override allows a PUT
 * entry in the 09:30–09:35 ET window even when the higher timeframe is
 * neutral/chop — but NEVER when the HTF is bullish (opposing the put). It
 * requires ALL of: high-velocity downside impulse, a break below the premarket
 * low / key open support, a strong same-side options/liquidity score, and a
 * confidence floor. It never relaxes the premium/spread/sizing/0DTE gates.
 *
 *   BOT_OPEN_OVERRIDE_ENABLED         default: true
 *   BOT_OPEN_OVERRIDE_START_ET_MIN    default: 570 (09:30 ET, minutes from midnight ET)
 *   BOT_OPEN_OVERRIDE_END_ET_MIN      default: 575 (09:35 ET)
 *   BOT_OPEN_OVERRIDE_MIN_OPTION_SCORE default: 90 (same-side options/liquidity score)
 *   BOT_OPEN_OVERRIDE_MIN_CONFIDENCE  default: 80
 *   BOT_OPEN_OVERRIDE_MIN_IMPULSE_CANDLES default: 2 (consecutive same-dir 1m closes)
 *   BOT_OPEN_OVERRIDE_MIN_VELOCITY_ATR default: 1.5 (impulse range ≥ this × 1m ATR)
 *
 * ─── CONTINUATION RE-ARM WINDOW ─────────────────────────────────────────────
 * After a confirmed (aligned + 5m + 1m) liquidation/continuation setup, the
 * engine stays "armed" for a short window so a single green bounce 1m candle
 * does not immediately cancel a valid continuation. Invalidation and all risk
 * gates still apply.
 *
 *   BOT_REARM_WINDOW_SEC             default: 150 (2.5 min armed after last 1m trigger)
 *
 * ⚠  HIGH-RISK INSTRUMENT: 0DTE options can expire worthless. This software
 *    does not guarantee any trading outcomes. Use at your own risk.
 */

export interface BotConfig {
  // ── Execution mode ──────────────────────────────────────────────────────────
  /** true only when TRADIER_ENABLE_LIVE_TRADING=true AND account+token present */
  liveEnabled: boolean;
  /** Tradier brokerage account ID — required for live orders */
  accountId: string | null;
  /** Tradier API bearer token */
  tradierToken: string | null;
  /** Tradier base URL: sandbox (default when no live env) or production */
  tradierBaseUrl: string;

  // ── Risk guardrails ──────────────────────────────────────────────────────────
  /**
   * Hard cap on option contracts per single trade. <= 0 means NO explicit cap
   * (sizing is then bounded only by preferred size, cash, and per-trade risk).
   * When finite and >= 1, it caps the desired quantity. Default: 0 (no cap).
   */
  maxContractsPerTrade: number;
  /**
   * Preferred contracts to buy per trade when cash and the per-trade loss cap
   * allow it. Default: 2 (sized for a small account). Steps down the ladder
   * (2 → 1) toward minContractsPerTrade when the preferred size cannot be
   * afforded or would breach the per-trade loss cap.
   */
  preferredContractsPerTrade: number;
  /**
   * Hard minimum contracts per trade. If the largest affordable / risk-safe
   * size is below this, the entry is SKIPPED rather than opened. Default: 1,
   * so the sizing ladder steps 2 (preferred) → 1.
   */
  minContractsPerTrade: number;
  /** Max concurrent open positions. <= 0 means UNLIMITED. Default: 2 (risk-default patch). */
  maxOpenPositions: number;
  /** Max trades initiated per calendar day. <= 0 means UNLIMITED. Default: 50 (risk-default patch). */
  maxTradesPerDay: number;
  /** Max total NET realized loss per day (USD). Default: $600 */
  maxDailyLoss: number;
  /** Hard stop-loss as fraction of entry premium. Default: 0.20 (20%) */
  stopLossFraction: number;
  /**
   * DEPRECATED / unused for exits. The +30% partial trim was removed because it
   * contradicted the trailing runner; the full position now runs together.
   * Retained only so BOT_TRIM1_FRACTION still parses (hidden internal config —
   * never surfaced in /api/bot/status, /api/bot/signals, or the dashboard).
   * Default: 0.30.
   */
  trim1Fraction: number;
  /**
   * DEPRECATED / unused for exits. The +60% partial trim was removed for the
   * same reason. Retained only for back-compat parsing (hidden internal config —
   * never surfaced in any API response or the dashboard). Default: 0.60.
   */
  trim2Fraction: number;

  // ── Trailing-stop profit exit (single contract + multi-contract runner) ───────
  /**
   * DEPRECATED / unused for exits. The single-contract fixed take-profit was
   * removed in favor of the +25% arm / give-back trailing stop so winners
   * can run. Retained only so BOT_TAKE_PROFIT_FRACTION still parses without
   * error. Not read by evaluatePosition. Default: 0.40.
   */
  takeProfitFraction: number;
  /**
   * Gain fraction at which the give-back trailing stop ARMS. Once premium has
   * reached at least entry × (1 + this), the give-back trail becomes active and
   * the winner is allowed to run. Until then the hard -stopLossFraction stop is
   * the only downside exit. Applies to single contracts and to the remaining
   * runner of a multi-contract position. Default: 0.25 (+25%).
   */
  trailStartFraction: number;
  /**
   * Give-back fraction for the trailing stop, measured against the peak premium
   * observed after the trail armed. Exit if premium falls to peak × (1 - this).
   * Default: 0.15 (15% drop from peak) — widened from 5% by the NOISE-FLOOR
   * PATCH (5% fired on routine 0DTE quote jitter); see the runtime default.
   */
  trailGivebackFraction: number;
  /**
   * Breakeven-protect arm fraction. Once a position's premium reaches at least
   * entry × (1 + this) at any point (MFE), the stop is RAISED to the entry
   * premium (breakeven) so a trade that ran up but then reverses no longer gives
   * back a full -stopLossFraction loss. This shrinks the 0 → +trailStart dead
   * zone where only the hard stop protected the position. The breakeven stop
   * NEVER loosens an existing stop — it only raises it — and the profit-lock tier
   * (+profitLockArmFraction) and the +trailStart give-back trail still supersede
   * it once the bigger winner arms (the higher stop always wins).
   * Default: 0.10 (+10%). Set <= 0 via BOT_BREAKEVEN_ARM_FRACTION to disable.
   */
  breakevenArmFraction: number;
  /**
   * Profit-lock arm fraction. Once a position's premium PEAK (MFE) reaches at
   * least entry × (1 + this), the stop is RAISED to lock in a positive profit at
   * entry × (1 + profitLockProfitFraction) — a second protection tier ABOVE the
   * breakeven (entry) stop. Like breakeven it only ever RAISES the stop and is
   * superseded by the +trailStart give-back trail once the bigger winner arms.
   * Default: 0.15 (+15% MFE arms the profit lock). Set <= 0 to disable.
   */
  profitLockArmFraction: number;
  /**
   * Profit fraction locked in once the profit-lock tier arms: the stop is raised
   * to entry × (1 + this) so a winner that reached +profitLockArmFraction can no
   * longer scratch to breakeven. Must be < profitLockArmFraction to be meaningful.
   * Default: 0.05 (lock +5% profit).
   */
  profitLockProfitFraction: number;
  /**
   * Reference dollar figure for one trade's projected stop loss (USD).
   * RESTORED as a SIZING constraint when enforceMaxLossPerTrade is true
   * (the default): sizing downsizes so projected stop risk ≤ this, and skips
   * the entry if even the minimum size would breach it. Default: 100.
   */
  maxLossPerTrade: number;
  /**
   * When true (default), maxLossPerTrade caps position sizing: contracts are
   * reduced until projected stop risk fits, or the entry is skipped. Set
   * BOT_ENFORCE_MAX_LOSS_PER_TRADE=false to restore reporting-only behavior.
   */
  enforceMaxLossPerTrade: boolean;
  /** Ms to wait for a live ENTRY order to fill before canceling. Default 20000. */
  entryFillTimeoutMs: number;
  /** Ms to wait for a live EXIT limit order to fill before escalating. Default 12000. */
  exitFillTimeoutMs: number;
  /**
   * After this many CONSECUTIVE mark-fetch failures for an open position, an
   * error event is emitted so the operator knows exit management is blind on
   * that position. Default 8 (~64s at the 8s exit loop).
   */
  markFailureAlertCount: number;
  /**
   * PDT guard: when true (default) and the live account is a margin account
   * with total equity under $25,000, autonomous entries are blocked after 3
   * day trades have been opened that day (FINRA pattern-day-trader rule).
   * Cash accounts are not blocked (PDT does not apply) but remain subject to
   * settled-funds availability via the cash-based sizing.
   */
  pdtGuardEnabled: boolean;
  /**
   * Assumed account starting/working balance (USD) used for position sizing and
   * backtests when no live Tradier balance is available. Default: 1326.24.
   */
  accountStartBalance: number;

  // ── Contract-quality entry filters ────────────────────────────────────────────
  /**
   * Minimum acceptable option premium (mid of bid/ask, per share) for an entry.
   * Cheap sub-$0.15 0DTE contracts have terrible relative spreads and are
   * effectively lottery tickets, so a candidate below this is downgraded to
   * REQUIRES_REVIEW rather than entered. Default: 0.15 ($0.15/share).
   */
  minOptionPremium: number;
  /**
   * Maximum acceptable quoted bid/ask spread as a fraction of the mid premium.
   * A wide spread means the spread cost dominates the edge, so a candidate whose
   * (ask − bid) / mid exceeds this is downgraded to REQUIRES_REVIEW rather than
   * entered. Default: 0.30 (30% of mid). Set <= 0 to disable the spread check.
   */
  maxSpreadPct: number;

  // ── Intraday time-of-day filters (CT) ─────────────────────────────────────────
  /** Hard-flatten all positions at or after this CT hour (24h). Default: 14 */
  flattenHourCT: number;
  /** Hard-flatten at or after this CT minute. Default: 30 → 14:30 CT */
  flattenMinuteCT: number;
  /** Block new entries for the first N minutes after the 08:30 CT open. Default: 0 (no opening lockout) */
  noEntryFirstMinutes: number;
  /** Block new entries when within N minutes of the 15:00 CT close. Default: 0 (no closing lockout) */
  noEntryLastMinutes: number;
  /** Minimum confidence score (0–100) for a setup to trigger a signal. Default: 55 */
  minConfidence: number;
  /** Whether to include medium-confidence setups (50–69). Default: true */
  allowMediumConfidence: boolean;
  /** Minimum unusual-options score to corroborate a setup. Default: 60 */
  minUnusualScore: number;
  /**
   * How many strikes out-of-the-money to prefer when selecting the same-day
   * 0DTE contract. Default: 1 (first strike OTM for the bias — slightly more
   * aggressive than ATM toward price targets). A value <= 0 selects the strike
   * nearest to spot (ATM-style). Calls count strikes ABOVE spot, Puts BELOW.
   * Used by the fixed_otm selection mode (and as the fallback target).
   */
  otmStrikes: number;

  // ── Smart contract selection ─────────────────────────────────────────────────
  /**
   * Contract-selection mode:
   *   "fixed_otm"   — legacy behavior: always target BOT_OTM_STRIKES OTM.
   *   "best_liquid" — SCORE the same-day ATM / 1-OTM / 2-OTM candidates and pick
   *                   the best one under the same premium/spread/0DTE guardrails,
   *                   preferring stronger premium, in-band delta, and liquidity.
   * Default: "best_liquid". Set BOT_CONTRACT_SELECTION_MODE=fixed_otm to restore
   * the strict fixed-1-OTM behavior. Both modes obey every existing hard gate.
   */
  contractSelectionMode: "fixed_otm" | "best_liquid";
  /**
   * Furthest OTM (in strikes) the smart selector will consider. The selector
   * NEVER chooses beyond this many strikes OTM and never an ITM strike.
   * Default: 2 (ATM, 1 OTM, 2 OTM).
   */
  selectorMaxOtmStrikes: number;
  /**
   * Preferred minimum mid premium for the smart selector. Candidates at/above
   * this earn the full premium-strength score (deeper = higher delta = less
   * exposed to the sub-arm "stall" failure mode). NOT a hard gate — the hard
   * floor is still minOptionPremium. Default: 0.70.
   */
  selectorPreferredMinPremium: number;
  /** Smart-selector target delta band lower bound (absolute). Default: 0.35. */
  selectorDeltaMin: number;
  /** Smart-selector target delta band upper bound (absolute). Default: 0.55. */
  selectorDeltaMax: number;
  /**
   * Spread fraction at/under which a smart-selector candidate earns the full
   * tight-spread bonus (scores degrade between this and maxSpreadPct).
   * Default: 0.25 (25% of mid).
   */
  selectorPreferredMaxSpreadPct: number;
  /** Whether bot signal generation is globally paused. Default: false */
  killSwitchActive: boolean;
  /** Block entries within this many minutes of a high-impact calendar event. Default: 10 */
  newsBlackoutMinutes: number;

  // ── Open/close entry-only time guardrail ──────────────────────────────────────
  /**
   * Master switch for the open/close entry-only time guardrail. When true, NEW
   * entries are blocked during the first entryBlackoutOpenMin minutes after the
   * regular open (09:30 ET) and the last entryBlackoutCloseMin minutes before the
   * regular close (16:00 ET). This gates ENTRIES ONLY — exits (stops, trailing
   * stops, breakeven/profit-lock, hard flatten) are never affected. Default: true.
   */
  entryTimeGuardEnabled: boolean;
  /** No new entries for this many minutes after the 09:30 ET regular open. Default: 15 */
  entryBlackoutOpenMin: number;
  /** No new entries for this many minutes before the 16:00 ET regular close. Default: 15 */
  entryBlackoutCloseMin: number;

  // ── Autonomous trading ───────────────────────────────────────────────────────
  /**
   * Master switch for fully autonomous entry/exit. Real autonomous orders are
   * BLOCKED unless this is true AND liveEnabled is true. Default: false (OFF).
   * Set via TRADIER_AUTO_TRADE=true. This is in addition to every existing
   * live guard — it never replaces them.
   */
  autoTradeEnabled: boolean;
  /** Entry-evaluation loop interval (ms). Default: 15000 */
  automationIntervalMs: number;
  /** Exit/position-management loop interval (ms). Default: 8000 */
  exitManagementIntervalMs: number;
  /** Minimum signal confidence for an autonomous entry. Default: 70 */
  autoMinConfidence: number;
  /** Hard-flatten all bot-managed positions at/after this CT hour. Default: 14 */
  autoFlattenHourCT: number;
  /** Hard-flatten at/after this CT minute. Default: 55 → 14:55 CT */
  autoFlattenMinuteCT: number;
  /** Cooldown (ms) before the same contract symbol may be re-entered. Default: 300000 (5 min) */
  autoEntryCooldownMs: number;

  // ── Fresh-data guard (live/runtime only) ──────────────────────────────────────
  /**
   * Enforce the fresh-data guard during live automation / RTH. When true and the
   * newest live 1m candle is older than maxCandleStalenessSec, signals are marked
   * NOT-READY (BLOCKED) and surfaced in status. Offline backtests pass
   * requireFreshData=false to generateSignals to bypass this. Default: true.
   */
  requireFreshData: boolean;
  /** Max allowed age (seconds) of the newest live 1m candle before it is stale. Default: 120 */
  maxCandleStalenessSec: number;

  // ── Open-window liquidation override (narrow 09:30–09:35 ET) ──────────────────
  /** Master switch for the open-window liquidation override. Default: true */
  openOverrideEnabled: boolean;
  /** Override window start, minutes-from-midnight ET. Default: 570 (09:30 ET) */
  openOverrideStartEtMin: number;
  /** Override window end (exclusive-ish), minutes-from-midnight ET. Default: 575 (09:35 ET) */
  openOverrideEndEtMin: number;
  /** Min same-side options/liquidity (unusual) score required for the override. Default: 90 */
  openOverrideMinOptionScore: number;
  /** Min setup confidence required for the override. Default: 80 */
  openOverrideMinConfidence: number;
  /** Min consecutive same-direction 1m closes for a valid impulse. Default: 2 */
  openOverrideMinImpulseCandles: number;
  /** Min impulse range as a multiple of the trailing 1m ATR. Default: 1.5 */
  openOverrideMinVelocityAtr: number;

  // ── Continuation re-arm window ────────────────────────────────────────────────
  /**
   * Seconds to stay "armed" after a confirmed 1m trigger so a single bounce
   * candle does not immediately re-block a valid continuation. Default: 150.
   */
  rearmWindowSec: number;

  // ── A+ entry gate (supply/demand · support/resistance · step-in proximity) ────
  /**
   * Master switch for the A+ entry quality gate. When true, an otherwise
   * ACTIONABLE entry is additionally required to be a HIGH-QUALITY setup whose
   * trigger price is NEAR a relevant structure level — a supply/demand zone,
   * a support/resistance level, or a buyer/seller step-in level — rather than a
   * mid-range chase. Calls must be near demand/support (or a reclaimed
   * resistance); Puts near supply/resistance (or a lost support). Mid-range
   * entries with no nearby level are downgraded to REQUIRES_REVIEW. Default: false
   * (opt-in via BOT_APLUS_ENTRY_ONLY=true) so existing behavior is preserved.
   */
  aplusEntryOnly: boolean;
  /**
   * Proximity threshold for the A+ gate, as a fraction of spot. The trigger
   * price must sit within this band of a relevant structure level to qualify.
   * Default: 0.0015 (0.15% of spot — ~$1.09 at SPY 725). Tunable for the
   * backtest only. Set <= 0 to disable the distance check (quality-only A+).
   */
  aplusProximityPct: number;
  /**
   * Minimum corroboration strength (1..100) of the nearby structure level for an
   * A+ entry. Levels below this are treated as too weak to anchor an A+ entry.
   * Default: 50. Set <= 0 to accept any level regardless of strength.
   */
  aplusMinLevelStrength: number;
  /**
   * Minimum (MTF-adjusted) confidence for an A+ entry. "Only enter A+ setups"
   * means the strongest setups: this floor sits above the base minConfidence.
   * Default: 70. Only applied when aplusEntryOnly is true.
   */
  aplusMinConfidence: number;
  /**
   * Enable the VWAP RECLAIM bullish/call setup: a prior 2m bar that closed BELOW
   * VWAP followed by a current 2m bar that CLOSES BACK ABOVE VWAP, confirmed by
   * non-negative/rising MACD momentum and a close within vwapProximityBps of VWAP
   * (so it reclaims AT the line, not a chase well above it). Produces a tagged
   * "VWAP reclaim (2m)" Call setup. Default: true.
   */
  vwapReclaimEnabled: boolean;
  /**
   * Enable the VWAP FADE/REJECTION bearish/put setup: price TESTS VWAP from below
   * (the 2m bar's high reaches at/above VWAP within vwapProximityBps) but FAILS to
   * hold it, CLOSING BACK BELOW VWAP with non-positive/falling MACD momentum.
   * Produces a tagged "VWAP fade (2m)" Put setup. Default: true.
   */
  vwapFadeEnabled: boolean;
  /**
   * Proximity band around VWAP, in BASIS POINTS of spot, for the reclaim/fade
   * confirmation. The reclaim close must be within this band above VWAP, and the
   * fade test must reach within this band of VWAP, so neither chases a move that
   * has already extended far from the line. Default: 12 (0.12% of spot, ~$0.87 at
   * SPY 725). Set <= 0 to disable the proximity check (confirmation-only).
   */
  vwapProximityBps: number;
  /**
   * Minimum confidence (1..100) a VWAP reclaim/fade setup must reach to be emitted
   * as a directional (Call/Put) card; below this it is surfaced as "Wait". Keeps
   * weak, unconfirmed VWAP crosses from producing actionable signals. Default: 58.
   */
  vwapMinConfidence: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

/**
 * Runtime-mutable kill switch. Toggle via POST /api/bot/kill-switch.
 *
 * PERSISTENCE PATCH: the kill switch now persists to a small JSON file so a
 * restart/redeploy cannot silently re-arm a bot the operator killed. File path
 * via BOT_KILL_SWITCH_FILE (default .data/kill-switch.json next to the paper
 * state). The env var BOT_KILL_SWITCH still forces it ON at boot.
 */
import fs from "node:fs";
import path from "node:path";

const KILL_SWITCH_FILE =
  process.env.BOT_KILL_SWITCH_FILE ?? path.join(".data", "kill-switch.json");

function loadKillSwitch(): boolean {
  // Env var forces ON regardless of file.
  if (envBool("BOT_KILL_SWITCH", false)) return true;
  try {
    const raw = fs.readFileSync(KILL_SWITCH_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { active?: boolean };
    return parsed.active === true;
  } catch {
    return false;
  }
}

let _killSwitchActive = loadKillSwitch();

export function setKillSwitch(value: boolean): void {
  _killSwitchActive = value;
  try {
    fs.mkdirSync(path.dirname(KILL_SWITCH_FILE), { recursive: true });
    fs.writeFileSync(
      KILL_SWITCH_FILE,
      JSON.stringify({ active: value, updatedAt: new Date().toISOString() }),
      "utf-8",
    );
  } catch {
    console.warn("[bot] Could not persist kill switch to", KILL_SWITCH_FILE);
  }
}

export function getKillSwitchState(): boolean {
  return _killSwitchActive;
}

export function getBotConfig(): BotConfig {
  const token = process.env.TRADIER_TOKEN ?? null;
  const accountId = process.env.TRADIER_ACCOUNT_ID ?? null;
  const wantsLive = process.env.TRADIER_ENABLE_LIVE_TRADING?.toLowerCase() === "true";
  const liveEnabled = wantsLive && !!token && !!accountId;

  // Default to production Tradier when live is enabled, sandbox otherwise.
  const defaultBase = liveEnabled
    ? "https://api.tradier.com"
    : "https://sandbox.tradier.com";
  const tradierBaseUrl = process.env.TRADIER_BASE_URL ?? defaultBase;

  return {
    liveEnabled,
    accountId,
    tradierToken: token,
    tradierBaseUrl,

    // 0 (or any value <= 0) means NO explicit per-trade cap — sizing is bounded
    // by preferred size, cash, and per-trade risk instead. Default 0 so the
    // preferred (4) can apply unless an operator sets an explicit cap.
    maxContractsPerTrade: envInt("BOT_MAX_CONTRACTS_PER_TRADE", 0),
    preferredContractsPerTrade: envInt("BOT_PREFERRED_CONTRACTS_PER_TRADE", 2),
    minContractsPerTrade: envInt("BOT_MIN_CONTRACTS_PER_TRADE", 1),
    // RISK-DEFAULT PATCH: unlimited concurrent positions / trades-per-day were
    // unsafe defaults for a small account. <= 0 still means UNLIMITED if an
    // operator explicitly sets it, but the DEFAULTS are now finite.
    maxOpenPositions: envInt("BOT_MAX_OPEN_POSITIONS", 2),
    // PDT guard removed; pattern-day-trader compliance is now operator's
    // responsibility. 24 is a reasonable daily ceiling for small-account strategy.
    maxTradesPerDay: envInt("BOT_MAX_TRADES_PER_DAY", 24),
    // SMALL-ACCOUNT CONSISTENCY PATCH: $200 was ~50% of a $400 account in one
    // day. Lowered to $100 (~25%) so the daily circuit-breaker is sized to the
    // real account, not a $1.3k one.
    maxDailyLoss: envFloat("BOT_MAX_DAILY_LOSS", 100),
    stopLossFraction: envFloat("BOT_STOP_LOSS_FRACTION", 0.20),
    trim1Fraction: envFloat("BOT_TRIM1_FRACTION", 0.30),
    trim2Fraction: envFloat("BOT_TRIM2_FRACTION", 0.60),

    takeProfitFraction: envFloat("BOT_TAKE_PROFIT_FRACTION", 0.40),
    // THETA-DECAY PATCH: 0DTE options lose 1-5% daily from theta alone. A +25%
    // spike often happens on momentum/gamma, not structural setup. Lowered to +18%
    // to reduce false arms and timeout from natural premium decay.
    trailStartFraction: envFloat("BOT_TRAIL_START_FRACTION", 0.18),
    // NOISE-FLOOR PATCH (REVISED): 15% give-back was too tight for 0DTE theta bleed.
    // At +18% arm, a position decays naturally back toward peak from time decay alone.
    // Widened to 20% to distinguish theta-bleed exits from real reversals.
    trailGivebackFraction: envFloat("BOT_TRAIL_GIVEBACK_FRACTION", 0.20),
    // DEAD-ZONE PATCH: 0-10% window is wide for fast-moving 0DTE. Lowered to 7%
    // to shrink the unprotected commitment zone and arm breakeven sooner.
    breakevenArmFraction: envFloat("BOT_BREAKEVEN_ARM_FRACTION", 0.07),
    profitLockArmFraction: envFloat("BOT_PROFIT_LOCK_ARM_FRACTION", 0.15),
    profitLockProfitFraction: envFloat("BOT_PROFIT_LOCK_PROFIT_FRACTION", 0.05),
    // SMALL-ACCOUNT CONSISTENCY PATCH: $100 was 25% of a $400 account on ONE
    // trade (50% across two concurrent positions). Lowered to $40 so a single
    // stop-out risks ~10% of the account and two concurrent positions ~20%.
    maxLossPerTrade: envFloat("BOT_MAX_LOSS_PER_TRADE", 40),
    enforceMaxLossPerTrade: envBool("BOT_ENFORCE_MAX_LOSS_PER_TRADE", true),
    entryFillTimeoutMs: envInt("BOT_ENTRY_FILL_TIMEOUT_MS", 20_000),
    exitFillTimeoutMs: envInt("BOT_EXIT_FILL_TIMEOUT_MS", 12_000),
    markFailureAlertCount: envInt("BOT_MARK_FAILURE_ALERT_COUNT", 8),
    pdtGuardEnabled: envBool("BOT_PDT_GUARD_ENABLED", true),
    accountStartBalance: envFloat("BOT_ACCOUNT_START_BALANCE", 1326.24),
    // CONTRADICTION FIX: a $0.15 floor sits inside the guaranteed-loss zone — one
    // tick is ~7% and a near-max spread is ~27%, so the -stop lands at/below the
    // entry bid. Raised to $0.30 so a tick and the spread are a smaller fraction.
    minOptionPremium: envFloat("BOT_MIN_OPTION_PREMIUM", 0.30),
    // CONTRADICTION FIX (the big one): the spread is measured at exit on the BID
    // while entry is on the ask/mid, so an allowed 30% spread = a 15% instant
    // bid-drag = the ENTIRE -15% stop budget → fresh positions could stop out on
    // tick one. Tightened to 8% per trading logic review to remove bid-drag ambiguity
    // and ensure stops have room to breathe. Pairs with the bid-referenced stop in
    // paperState (defense in depth).
    maxSpreadPct: envFloat("BOT_MAX_SPREAD_PCT", 0.08),

    flattenHourCT: envInt("BOT_FLATTEN_HOUR_CT", 14),
    flattenMinuteCT: envInt("BOT_FLATTEN_MINUTE_CT", 30),
    noEntryFirstMinutes: envInt("BOT_NO_ENTRY_FIRST_MINUTES", 0),
    noEntryLastMinutes: envInt("BOT_NO_ENTRY_LAST_MINUTES", 0),
    minConfidence: envInt("BOT_MIN_CONFIDENCE", 55),
    allowMediumConfidence: envBool("BOT_ALLOW_MEDIUM_CONFIDENCE", true),
    minUnusualScore: envInt("BOT_MIN_UNUSUAL_SCORE", 60),
    otmStrikes: envInt("BOT_OTM_STRIKES", 1),
    contractSelectionMode:
      process.env.BOT_CONTRACT_SELECTION_MODE?.toLowerCase() === "fixed_otm"
        ? "fixed_otm"
        : "best_liquid",
    selectorMaxOtmStrikes: envInt("BOT_SELECTOR_MAX_OTM_STRIKES", 2),
    selectorPreferredMinPremium: envFloat("BOT_SELECTOR_PREFERRED_MIN_PREMIUM", 0.70),
    selectorDeltaMin: envFloat("BOT_SELECTOR_DELTA_MIN", 0.35),
    selectorDeltaMax: envFloat("BOT_SELECTOR_DELTA_MAX", 0.55),
    selectorPreferredMaxSpreadPct: envFloat("BOT_SELECTOR_PREFERRED_MAX_SPREAD_PCT", 0.25),
    killSwitchActive: _killSwitchActive,
    newsBlackoutMinutes: envInt("BOT_NEWS_BLACKOUT_MINUTES", 10),

    entryTimeGuardEnabled: envBool("BOT_ENTRY_TIME_GUARD_ENABLED", true),
    entryBlackoutOpenMin: envInt("BOT_ENTRY_BLACKOUT_OPEN_MIN", 15),
    entryBlackoutCloseMin: envInt("BOT_ENTRY_BLACKOUT_CLOSE_MIN", 15),

    autoTradeEnabled: envBool("TRADIER_AUTO_TRADE", false),
    automationIntervalMs: envInt("BOT_AUTOMATION_INTERVAL_MS", 15_000),
    exitManagementIntervalMs: envInt("BOT_EXIT_MANAGEMENT_INTERVAL_MS", 8_000),
    autoMinConfidence: envInt("BOT_AUTO_MIN_CONFIDENCE", 70),
    autoFlattenHourCT: envInt("BOT_FLATTEN_TIME_CT_HOUR", 14),
    autoFlattenMinuteCT: envInt("BOT_FLATTEN_TIME_CT_MINUTE", 55),
    autoEntryCooldownMs: envInt("BOT_AUTO_ENTRY_COOLDOWN_MS", 300_000),

    requireFreshData: envBool("BOT_REQUIRE_FRESH_DATA", true),
    maxCandleStalenessSec: envInt("BOT_MAX_CANDLE_STALENESS_SEC", 120),

    openOverrideEnabled: envBool("BOT_OPEN_OVERRIDE_ENABLED", true),
    openOverrideStartEtMin: envInt("BOT_OPEN_OVERRIDE_START_ET_MIN", 570),
    openOverrideEndEtMin: envInt("BOT_OPEN_OVERRIDE_END_ET_MIN", 575),
    openOverrideMinOptionScore: envInt("BOT_OPEN_OVERRIDE_MIN_OPTION_SCORE", 90),
    openOverrideMinConfidence: envInt("BOT_OPEN_OVERRIDE_MIN_CONFIDENCE", 80),
    openOverrideMinImpulseCandles: envInt("BOT_OPEN_OVERRIDE_MIN_IMPULSE_CANDLES", 2),
    openOverrideMinVelocityAtr: envFloat("BOT_OPEN_OVERRIDE_MIN_VELOCITY_ATR", 1.5),

    rearmWindowSec: envInt("BOT_REARM_WINDOW_SEC", 150),

    aplusEntryOnly: envBool("BOT_APLUS_ENTRY_ONLY", false),
    aplusProximityPct: envFloat("BOT_APLUS_PROXIMITY_PCT", 0.0015),
    aplusMinLevelStrength: envInt("BOT_APLUS_MIN_LEVEL_STRENGTH", 50),
    aplusMinConfidence: envInt("BOT_APLUS_MIN_CONFIDENCE", 70),
    vwapReclaimEnabled: envBool("BOT_VWAP_RECLAIM_ENABLED", true),
    vwapFadeEnabled: envBool("BOT_VWAP_FADE_ENABLED", true),
    vwapProximityBps: envFloat("BOT_VWAP_PROXIMITY_BPS", 12),
    vwapMinConfidence: envInt("BOT_VWAP_MIN_CONFIDENCE", 58),
  };
}

/**
 * SINGLE DST-aware primitive that every intraday time gate derives from. Returns
 * the wall-clock hour/minute for an instant in the given IANA timezone, so the
 * opening guardrail, flatten, pre-market block, and news blackout can never
 * drift onto different clocks or a brittle fixed UTC offset.
 *
 * Handles the V8 quirk where `hour12:false` formats midnight as "24:MM" instead
 * of "00:MM" — without this, minutesIntoEtDay returned 1440 at 00:00 ET.
 */
function zonedHourMinute(now: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  let hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  if (hour === 24) hour = 0; // V8 formats midnight as "24:MM" under hour12:false
  return { hour, minute };
}

/** Minutes-from-midnight in `timeZone` for an instant, via {@link zonedHourMinute}. */
function zonedMinutesOfDay(now: Date, timeZone: string): number {
  const { hour, minute } = zonedHourMinute(now, timeZone);
  return hour * 60 + minute;
}

/**
 * Minutes-from-midnight in America/New_York for a given instant. Used by the
 * open-window liquidation override and the entry guardrail to decide whether
 * `now` falls inside an ET window regardless of the server's own timezone.
 * DST-aware (IANA zone, not a hardcoded offset): 09:30 ET = 570 in both EDT and
 * EST.
 */
export function minutesIntoEtDay(now = new Date()): number {
  return zonedMinutesOfDay(now, "America/New_York");
}

/** True if `now` is inside the configured open-window override window (ET). */
export function isWithinOpenOverrideWindow(cfg: BotConfig, now = new Date()): boolean {
  const m = minutesIntoEtDay(now);
  return m >= cfg.openOverrideStartEtMin && m <= cfg.openOverrideEndEtMin;
}

/** Regular trading hours boundaries in minutes-from-midnight ET. */
const RTH_OPEN_ET_MIN = 9 * 60 + 30; // 09:30 ET = 570
const RTH_CLOSE_ET_MIN = 16 * 60;    // 16:00 ET = 960

/**
 * Minutes since the 09:30 ET regular-session open ("minutes into the trading
 * day"). Returns 0 at exactly 09:30:00 ET, 390 at 16:00:00 ET, and a negative
 * value before the open. DST-aware via {@link minutesIntoEtDay}. This is the
 * single trading-day clock the opening guardrail, flatten, and pre-market block
 * should reason in so they cannot drift apart.
 */
export function minutesIntoTradingDay(now = new Date()): number {
  return minutesIntoEtDay(now) - RTH_OPEN_ET_MIN;
}

/**
 * Human-readable Eastern-time stamp for an instant, e.g.
 * "2026-06-22 09:36:12 ET". Logged alongside the UTC ISO timestamp on each event
 * so logs are self-verifying — a reader can confirm an ET-gated action (opening
 * guardrail, flatten) fired at the ET time its message claims, without mentally
 * converting from UTC or the viewer's local timezone.
 */
export function etTimestamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hh = get("hour");
  if (hh === "24") hh = "00"; // V8 midnight quirk under hour12:false
  return `${get("year")}-${get("month")}-${get("day")} ${hh}:${get("minute")}:${get("second")} ET`;
}

/**
 * One-line, self-verifying snapshot of the ET clock derivation, logged once at
 * engine/server start so a mis-zoned run is visible in the first log line.
 *
 * Every intraday gate derives ET via an explicit IANA America/New_York
 * conversion that does NOT depend on the host's `TZ` env or system-local time —
 * but a host built without full ICU (or a fixed-offset shim) could silently fall
 * back to UTC. The embedded self-test maps a fixed instant (09:30:00 EDT) and
 * asserts it yields 570 minutes; an "ICU/zone FAIL" here means the gates would
 * mis-fire and must be investigated before trusting the session clock.
 *
 * `systemZone`/`tzEnv` are reported for context only — they must NOT change gate
 * behavior, and the self-test proves they don't.
 */
export function etZoneDiagnostics(now = new Date()): string {
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown";
  const tzEnv = typeof process !== "undefined" ? process.env.TZ ?? "<unset>" : "<n/a>";
  const probe = new Date("2026-06-22T13:30:00Z"); // 09:30:00 EDT (DST)
  const probeMin = minutesIntoEtDay(probe);
  const selfTest = probeMin === RTH_OPEN_ET_MIN
    ? "OK"
    : `FAIL(09:30 ET => ${probeMin} min, expected ${RTH_OPEN_ET_MIN} — ICU/zone data missing, gates will mis-fire)`;
  return (
    `ET clock: IANA America/New_York via Intl (DST-aware, TZ-env independent) | ` +
    `host systemZone=${systemZone} TZ=${tzEnv} | self-test=${selfTest} | now=${etTimestamp(now)}`
  );
}

/**
 * Open/close ENTRY-ONLY time guardrail. Returns a human-readable block reason
 * when `now` falls inside the first entryBlackoutOpenMin minutes after the
 * regular open or the last entryBlackoutCloseMin minutes before the regular
 * close (both in ET); returns null when entries are permitted. Disabled (always
 * null) when entryTimeGuardEnabled is false.
 *
 * This gates ENTRIES ONLY. It is consulted by canOpenPosition (the single entry
 * chokepoint) and never by the exit path, so stops, trailing stops, breakeven /
 * profit-lock, and the hard flatten are completely unaffected.
 */
export function entryTimeWindowBlock(cfg: BotConfig, now = new Date()): string | null {
  if (!cfg.entryTimeGuardEnabled) return null;
  const m = minutesIntoEtDay(now);

  const openMin = Math.max(0, cfg.entryBlackoutOpenMin);
  const closeMin = Math.max(0, cfg.entryBlackoutCloseMin);

  // First N minutes after the regular open (09:30 → 09:30+N ET).
  if (openMin > 0 && m >= RTH_OPEN_ET_MIN && m < RTH_OPEN_ET_MIN + openMin) {
    return `No new entries in the first ${openMin} min after the 09:30 ET open (opening guardrail)`;
  }
  // Last N minutes before the regular close (16:00−N → 16:00 ET).
  if (closeMin > 0 && m >= RTH_CLOSE_ET_MIN - closeMin && m < RTH_CLOSE_ET_MIN) {
    return `No new entries in the last ${closeMin} min before the 16:00 ET close (closing guardrail)`;
  }
  return null;
}

/**
 * Returns true if it is at or past the AUTONOMOUS hard-flatten cutoff
 * (default 14:55 CT). This is intentionally distinct from isPastCutoff:
 * the autonomous engine flattens slightly earlier than the entry cutoff so
 * positions are closed before the session-end illiquidity window.
 */
export function isPastAutoFlatten(cfg: BotConfig, now = new Date()): boolean {
  const { hour, minute } = zonedHourMinute(now, "America/Chicago");
  return (
    hour > cfg.autoFlattenHourCT ||
    (hour === cfg.autoFlattenHourCT && minute >= cfg.autoFlattenMinuteCT)
  );
}

/**
 * Returns a reason string when `now` falls inside a no-entry window
 * (post-open lockout or pre-close lockout), or null when entries are allowed.
 * SPY RTH is 08:30–15:00 CT.
 */
export function entryWindowBlock(cfg: BotConfig, now = new Date()): string | null {
  if (cfg.noEntryFirstMinutes <= 0 && cfg.noEntryLastMinutes <= 0) return null;
  const minOfDay = zonedMinutesOfDay(now, "America/Chicago");
  const openMin = 8 * 60 + 30;       // 08:30 CT
  const closeMin = 15 * 60;          // 15:00 CT
  if (cfg.noEntryFirstMinutes > 0 && minOfDay >= openMin && minOfDay < openMin + cfg.noEntryFirstMinutes) {
    return `No-entry window: first ${cfg.noEntryFirstMinutes} min after the open (08:30–${String(Math.floor((openMin + cfg.noEntryFirstMinutes) / 60)).padStart(2, "0")}:${String((openMin + cfg.noEntryFirstMinutes) % 60).padStart(2, "0")} CT).`;
  }
  if (cfg.noEntryLastMinutes > 0 && minOfDay >= closeMin - cfg.noEntryLastMinutes && minOfDay < closeMin) {
    return `No-entry window: last ${cfg.noEntryLastMinutes} min before the close (${String(Math.floor((closeMin - cfg.noEntryLastMinutes) / 60)).padStart(2, "0")}:${String((closeMin - cfg.noEntryLastMinutes) % 60).padStart(2, "0")}–15:00 CT).`;
  }
  return null;
}

/** Returns true if it is at or past the hard-flatten cutoff (default 14:30 CT) */
export function isPastCutoff(cfg: BotConfig, now = new Date()): boolean {
  const { hour, minute } = zonedHourMinute(now, "America/Chicago");
  return hour > cfg.flattenHourCT || (hour === cfg.flattenHourCT && minute >= cfg.flattenMinuteCT);
}

/**
 * Parse a calendar event time string (e.g. "8:30 AM", "08:30", "2:00 PM ET")
 * into minutes-from-midnight. Returns null when unparseable. The time is
 * interpreted as EASTERN TIME (the convention for US economic releases).
 */
function parseEventTimeToEtMinutes(time: string): number | null {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(time ?? "");
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * Returns true if now is within blackoutMinutes of any high-impact event.
 *
 * TIMEZONE PATCH: the previous implementation parsed the event time with
 * `new Date(dateString + " " + event.time)`, i.e. in the SERVER's local
 * timezone — on a UTC host an 8:30 AM ET release parsed as 8:30 UTC and the
 * blackout silently never engaged. Event times are now compared as ET
 * minutes-from-midnight against minutesIntoEtDay(now), which is host-TZ-safe.
 */
export function isNearHighImpactEvent(
  calendar: Array<{
    time: string;
    impact: "High" | "Medium" | "Low";
    status: "Upcoming" | "Released" | "Watched";
  }>,
  cfg: BotConfig,
  now = new Date(),
): boolean {
  const nowEtMin = minutesIntoEtDay(now);
  for (const event of calendar) {
    if (event.impact !== "High") continue;
    const evtEtMin = parseEventTimeToEtMinutes(event.time);
    if (evtEtMin === null) continue;
    if (Math.abs(nowEtMin - evtEtMin) < cfg.newsBlackoutMinutes) return true;
  }
  return false;
}

/**
 * Returns a structured readiness checklist for the UI.
 * Shows exactly what is blocking live mode.
 */
export function getLiveReadiness(): {
  liveEnabled: boolean;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  blockingCount: number;
} {
  const hasToken = !!process.env.TRADIER_TOKEN;
  const hasAccount = !!process.env.TRADIER_ACCOUNT_ID;
  const hasEnvFlag = process.env.TRADIER_ENABLE_LIVE_TRADING?.toLowerCase() === "true";
  const liveEnabled = hasToken && hasAccount && hasEnvFlag;

  const checks = [
    {
      label: "TRADIER_TOKEN",
      ok: hasToken,
      detail: hasToken ? "API token present" : "Set TRADIER_TOKEN=<your Tradier bearer token>",
    },
    {
      label: "TRADIER_ACCOUNT_ID",
      ok: hasAccount,
      detail: hasAccount ? "Account ID present" : "Set TRADIER_ACCOUNT_ID=<your brokerage account id>",
    },
    {
      label: "TRADIER_ENABLE_LIVE_TRADING",
      ok: hasEnvFlag,
      detail: hasEnvFlag
        ? "Live trading enabled via env"
        : "Set TRADIER_ENABLE_LIVE_TRADING=true to enable real order submission",
    },
    {
      label: "confirmLiveOrder (per-request)",
      ok: false, // always shown as manual — evaluated per request
      detail: "Each live order request body must include { confirmLiveOrder: true }",
    },
  ];

  return {
    liveEnabled,
    checks,
    blockingCount: checks.filter((c) => !c.ok).length,
  };
}

/**
 * Returns a readiness checklist specific to AUTONOMOUS execution.
 *
 * Autonomous live orders require EVERYTHING live mode requires PLUS the
 * explicit TRADIER_AUTO_TRADE=true switch and the kill switch being off.
 * The per-request confirmLiveOrder field is supplied internally by the
 * automation engine (the user explicitly asked for hands-off entry/exit), so
 * it is NOT a manual blocker here — but the engine still passes it through the
 * same guarded adapter, so the live safety design is unchanged.
 */
export function getAutoTradeReadiness(): {
  autoReady: boolean;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  blockingCount: number;
} {
  const hasToken = !!process.env.TRADIER_TOKEN;
  const hasAccount = !!process.env.TRADIER_ACCOUNT_ID;
  const hasLiveFlag = process.env.TRADIER_ENABLE_LIVE_TRADING?.toLowerCase() === "true";
  const hasAutoFlag = process.env.TRADIER_AUTO_TRADE?.toLowerCase() === "true";
  const killOff = !_killSwitchActive;

  const checks = [
    {
      label: "TRADIER_ENABLE_LIVE_TRADING",
      ok: hasLiveFlag,
      detail: hasLiveFlag ? "Live trading enabled" : "Set TRADIER_ENABLE_LIVE_TRADING=true",
    },
    {
      label: "TRADIER_ACCOUNT_ID",
      ok: hasAccount,
      detail: hasAccount ? "Account ID present" : "Set TRADIER_ACCOUNT_ID",
    },
    {
      label: "TRADIER_TOKEN",
      ok: hasToken,
      detail: hasToken ? "API token present" : "Set TRADIER_TOKEN",
    },
    {
      label: "TRADIER_AUTO_TRADE",
      ok: hasAutoFlag,
      detail: hasAutoFlag
        ? "Autonomous entry/exit ENABLED — bot will place real orders without confirmation"
        : "Set TRADIER_AUTO_TRADE=true to allow the bot to enter/exit on its own (HIGH RISK)",
    },
    {
      label: "Kill switch OFF",
      ok: killOff,
      detail: killOff ? "Kill switch is off" : "Kill switch is ON — autonomous execution suppressed",
    },
  ];

  const autoReady = hasToken && hasAccount && hasLiveFlag && hasAutoFlag && killOff;

  return {
    autoReady,
    checks,
    blockingCount: checks.filter((c) => !c.ok).length,
  };
}
