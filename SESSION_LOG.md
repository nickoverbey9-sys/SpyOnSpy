# Strategy / Session Log

Append-only notes on strategy hypotheses and session reviews. Newest entries on top.

---

## 2026-06-22 — REJECTED: post-hard-stop same-direction entry cooldown

Ported the parallel build's `BOT_HARD_STOP_DIRECTION_COOLDOWN_SEC` idea (after a −20%
hard stop, pause same-side new entries for N sec) and backtested it on the same 15 real
sessions ($400 start). **It does not help — neutral-to-negative:**

| Cooldown | Trades | Win rate | Net P&L | PF | Hard stops | CD blocks |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| off (current) | 133 | 64.7% | $10,123 | 5.86 | 15 (−$1,431) | 0 |
| 300s | 133 | 63.9% | $9,895 | 5.54 | 16 (−$1,527) | 4 |
| 600s | 129 | 63.6% | $8,777 | 5.21 | 15 (−$1,431) | 19 |

**Why it failed:** (1) the pattern is rare — at 300s the cooldown fired only 4× in 15
sessions; same-side hard stops almost never cluster within minutes. (2) When it did block
(600s), it removed *profitable* re-entries — after a hard stop the MTF gate re-qualifies the
setup and those continuations mostly run. The existing 30m+15m alignment gate already vets
re-entries, so a blunt time cooldown only sits out winners. Hard-stop count never even
dropped (path-dependency relocates them).

**Decision: do NOT deploy. Code reverted** (kept repo clean); default would have been 0/off
anyway. NOT ruled out: the CHOP-GATED variant (`BOT_HARD_STOP_CHOP_COOLDOWN_SEC` — cool down
only in choppy regime) is a different mechanism and untested. Lesson: a plausible idea from
the friend's higher-win-rate playbook was net-negative on THIS architecture — backtest every
ported mechanism on real data before believing it.

---

## 2026-06-22 — RESOLVED: stop-calibration 2×2 backtest (real ThetaData, 15 sessions)

The breakeven/profit-lock hypothesis (logged below) is now tested on REAL data. Ran a
2×2 sweep — {breakeven+profit-lock ON vs trailing-only} × {A+ gate OFF vs ON} — over
the same 15 sessions (2026-05-29 → 06-18, $400 start) via `script/backtest-stop-sweep.ts`.
Output: `backtest-sweep-real/COMPARISON.md`.

| Arm | Trades | Win rate | Net P&L | PF | Avg loss | Max DD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| be+pl, A+ off (CURRENT) | 133 | 64.7% | $10,123 | 5.86 | $45 | $184 |
| be+pl, A+ on | 95 | 64.2% | $7,084 | 6.19 | $40 | $224 |
| trail-only, A+ off | 89 | 70.8% | $8,603 | 5.24 | $81 | $336 |
| trail-only, A+ on | 68 | 69.1% | $4,143 | 3.54 | $78 | $294 |

**Confirmed:** the breakeven stop is 0W/13L by construction (−$284) and profit-lock is a
net-negative coin flip (19W/15L, −$109). Removing both RAISES win rate 64.7%→70.8% (+6.1pts)
— the hypothesis below was directionally correct.

**But it is NOT a free lunch:** trailing-only makes ~$1,500 LESS net profit (the protective
stops were scratching trades that otherwise run to the full −20% hard stop: hard-stops 15→20,
avg loss $45→$81) and nearly DOUBLES max drawdown ($184→$336). The protective stops trade a
little win-rate/profit for materially smaller drawdown — worth it on a small account.

**The A+ proximity gate is NOT a win-rate lever** and is net-negative here: it barely moves
win rate (slightly down) while cutting net profit 30–52%. In this sample the mid-range chases
it filters were net profitable. Do NOT enable `BOT_APLUS_ENTRY_ONLY`.

**DECISION (operator, 2026-06-22): KEEP CURRENT CONFIG.** Highest net profit + smallest
drawdown win over the +6pt win-rate gain. No live config changed. `trail-only` (set
`BOT_BREAKEVEN_ARM_FRACTION=0` + `BOT_PROFIT_LOCK_ARM_FRACTION=0`) remains the documented
win-rate-max alternative if priorities change. Untested middle ground worth a future arm:
drop breakeven only (the pure 0/13 loss bucket), keep profit-lock.

**Harness note:** fixed a real bug — `backtest-bot.ts` was not threading the profit-lock
fractions into `openPaperPosition`, so `BOT_PROFIT_LOCK_ARM_FRACTION` had no effect on any
prior backtest (it always ran at the hardcoded 0.15/0.05). Now config-authoritative. Also:
Theta Terminal v3 is now v3-API-only; the loader (`thetaDataLoader.ts`) was already v3-native,
so no migration was needed — the earlier "v3 migration blocker" was really just terminal setup.

---

## 2026-06-22 — Stop-calibration hypothesis: breakeven/profit-lock stops suspected net-negative

**Observation (2 OBSERVE sessions, paper):** Across morning (≈−$127) and afternoon (≈+$192), the same pattern held in both:

- The +30%-armed trailing stop (15% give-back from peak) produced every large winner: +$148, +$116, +$64, +$28, +$24. **This is the profit engine.**
- The +10% MFE breakeven stop and +15% MFE profit-lock stop repeatedly converted marginal winners into scratches or small losers: +$8, $0, $0, −$16, −$18, −$2, −$10. The protective stop sits **inside the 0DTE premium noise floor** and gets tapped on normal wiggle before the move develops.

**Hypothesis to test:** Loosen or remove the breakeven (+10% MFE) and profit-lock (+15% MFE) stops; let the +30%-armed trailing stop be the primary/only profit-side exit, with the −15% hard stop unchanged for genuinely wrong entries.

**Why this is NOT a live tweak:** Two sessions cannot distinguish "the breakeven stop is structurally net-negative" from "we happened to catch two trends this afternoon." Removing a protective stop on a 2-day sample is exactly the overfit trap. Needs many-session validation.

**Decision:** This is now the #1 concrete reason the ThetaData v3 real-data backtest is **blocking, not optional**. The backtest must compare, on the same historical sessions:

- **(A) current config:** hard −15% + breakeven@10% MFE + profit-lock@15% MFE + trailing@30%
- **(B) trailing-only config:** hard −15% + trailing@30%, breakeven and profit-lock removed

Carry these two configs into the v3 backtest as the first thing tested once the loader migration is done.

**Status:** Logged. Blocked on ThetaData v3 migration + clean 15-session real-data backtest. No code change until then.
