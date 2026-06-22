# Strategy / Session Log

Append-only notes on strategy hypotheses and session reviews. Newest entries on top.

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
