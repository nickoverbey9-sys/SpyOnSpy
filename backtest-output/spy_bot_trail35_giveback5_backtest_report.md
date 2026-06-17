# SPY 0DTE Bot — Backtest ($1326.24) — data: thetadata

Generated: 2026-06-17T06:54:01.979Z

> ✅ **Real market data (ThetaData).** Underlying: actual SPY 1m RTH bars. Options:
> actual same-day 0DTE NBBO quotes — entries priced at the ASK, exits and stop/trail
> evaluation at the BID (matching the live engine). Known approximations: option
> volume/OI/unusual-score in the chain are plausible constants (the quote endpoint
> has no volume), and fills assume the full quoted side with no queue/partial-fill
> modeling. **Past performance does not predict future results. Not advice.**

## Headline

| Metric | Value |
| --- | --- |
| Start balance | $1326.24 |
| End balance | $2539.24 |
| Net P&L | $1213.00 |
| Return | 91.46% |
| Total trades | 23 |
| Win rate | 60.9% (14W / 9L) |
| Avg win | $104.64 |
| Avg loss | $28.00 |
| Profit factor | 5.81 |
| Max drawdown | $88.00 |
| Best / worst trade | $567.00 / $-88.00 |

## Risk profile under test

- Hard stop loss: 20% of premium · NO fixed take-profit (let winners run)
- Trailing stop: arms at +25%, exits on a 15% give-back from the post-arm peak
- All sizes (1–4 contract ladder): full position runs together, no partial trims
- Exits: hard stop -20% · +25% arm / 15% give-back trailing stop · flatten/invalidation
- Max loss per trade: $100 (~7.5% of account) · Daily loss stop (backtest): $1000
- Entry filters: 30m+15m trend alignment, 5m setup + 1m trigger required;
  no time-of-day entry blockers; hard flatten 14:30 CT
- Quality filters: min option premium $0.15, max spread 30% of mid
- Sizing ladder: preferred 4 → fallback steps down to minimum 1 (blocks below 1), capped by cash and per-trade stop risk

## Per-session

| Date | Regime | Trades | P&L |
| --- | --- | --- | --- |
| 2026-06-15 | real +0.37% | 4 | $625.00 |
| 2026-06-16 | real -0.56% | 19 | $588.00 |

## Trades

| Date | Side | Strike | Qty | Entry | Exit | P&L | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-15 | Call | 754 | 4 | 1.12 | 1.07 | $-20.00 | Breakeven stop: premium 1.07 ≤ protected stop 1.12 (raised t |
| 2026-06-15 | Call | 753 | 3 | 1.38 | 1.44 | $18.00 | Profit-lock stop: premium 1.44 ≤ locked stop 1.45 (raised to |
| 2026-06-15 | Call | 753 | 3 | 1.35 | 3.24 | $567.00 | Trailing stop: premium 3.24 ≤ 15% give-back from peak 3.83 ( |
| 2026-06-15 | Call | 755 | 4 | 0.50 | 0.65 | $60.00 | Trailing stop: premium 0.65 ≤ 15% give-back from peak 0.77 ( |
| 2026-06-16 | Put | 754 | 4 | 1.00 | 1.80 | $320.00 | Trailing stop: premium 1.80 ≤ 15% give-back from peak 2.26 ( |
| 2026-06-16 | Put | 753 | 4 | 1.17 | 1.23 | $24.00 | Profit-lock stop: premium 1.23 ≤ locked stop 1.23 (raised to |
| 2026-06-16 | Put | 753 | 4 | 1.00 | 1.09 | $36.00 | Trailing stop: premium 1.09 ≤ 15% give-back from peak 1.29 ( |
| 2026-06-16 | Put | 752 | 4 | 0.95 | 0.73 | $-88.00 | Stop loss: premium 0.73 ≤ stop 0.76 (20% loss) |
| 2026-06-16 | Put | 752 | 4 | 0.79 | 1.00 | $84.00 | Trailing stop: premium 1.00 ≤ 15% give-back from peak 1.20 ( |
| 2026-06-16 | Put | 753 | 4 | 0.71 | 0.69 | $-8.00 | Breakeven stop: premium 0.69 ≤ protected stop 0.71 (raised t |
| 2026-06-16 | Put | 753 | 4 | 0.71 | 0.69 | $-8.00 | Profit-lock stop: premium 0.69 ≤ locked stop 0.75 (raised to |
| 2026-06-16 | Put | 753 | 4 | 1.07 | 1.11 | $16.00 | Profit-lock stop: premium 1.11 ≤ locked stop 1.12 (raised to |
| 2026-06-16 | Put | 752 | 4 | 0.66 | 0.63 | $-12.00 | Breakeven stop: premium 0.63 ≤ protected stop 0.66 (raised t |
| 2026-06-16 | Put | 752 | 4 | 0.66 | 0.50 | $-64.00 | Stop loss: premium 0.50 ≤ stop 0.53 (20% loss) |
| 2026-06-16 | Put | 752 | 4 | 0.56 | 0.69 | $52.00 | Trailing stop: premium 0.69 ≤ 15% give-back from peak 0.84 ( |
| 2026-06-16 | Put | 752 | 4 | 0.67 | 0.65 | $-8.00 | Breakeven stop: premium 0.65 ≤ protected stop 0.67 (raised t |
| 2026-06-16 | Put | 752 | 4 | 0.69 | 0.84 | $60.00 | Trailing stop: premium 0.84 ≤ 15% give-back from peak 1.04 ( |
| 2026-06-16 | Put | 752 | 4 | 0.74 | 0.72 | $-8.00 | Profit-lock stop: premium 0.72 ≤ locked stop 0.78 (raised to |
| 2026-06-16 | Put | 751 | 4 | 0.29 | 0.32 | $12.00 | Trailing stop: premium 0.32 ≤ 15% give-back from peak 0.42 ( |
| 2026-06-16 | Put | 751 | 4 | 0.30 | 0.31 | $4.00 | Profit-lock stop: premium 0.31 ≤ locked stop 0.32 (raised to |
| 2026-06-16 | Put | 751 | 4 | 0.39 | 0.86 | $188.00 | Trailing stop: premium 0.86 ≤ 15% give-back from peak 1.07 ( |
| 2026-06-16 | Put | 751 | 4 | 0.49 | 0.55 | $24.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-16 | Put | 751 | 4 | 0.71 | 0.62 | $-36.00 | Hard flatten: past 14:30 CT cutoff |

## Rejection breakdown

Why each non-trade bar didn't fire (counts across all evaluated bars):

| Bucket | Count |
| --- | ---: |
| bars_evaluated | 483 |
| no_chain_quoted | 0 |
| daily_loss_stop | 23 |
| no_setup | 39 |
| blocked_mtf | 383 |
| blocked_other | 15 |
| review_mtf | 0 |
| review_contract_quality | 0 |
| review_aplus_floor | 0 |
| review_no_contract | 0 |
| review_other | 0 |
| confidence_below_auto | 0 |
| sizing_rejected | 0 |
| cost_exceeds_balance | 0 |

### Top MTF block reasons

- (87) Higher timeframe aligned with Call, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
- (86) Higher timeframe aligned with Put, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
- (64) Higher timeframe aligned with Call, but lower-timeframe confirmation incomplete (5m pending, 1m pending). Entry blocked until 5m setup + 1m trigger both confirm.
- (63) Higher timeframe aligned with Put, but lower-timeframe confirmation incomplete (5m pending, 1m pending). Entry blocked until 5m setup + 1m trigger both confirm.
- (21) Higher timeframe is neutral/choppy: Higher timeframe is mixed/neutral (30m neutral, 15m bearish). Entry blocked — small-account profile requires 30m + 15m trend alignment.
