# SPY 0DTE Bot — Backtest ($400.00) — data: thetadata

Generated: 2026-06-17T20:21:05.681Z

> ✅ **Real market data (ThetaData).** Underlying: actual SPY 1m RTH bars. Options:
> actual same-day 0DTE NBBO quotes — entries priced at the ASK, exits and stop/trail
> evaluation at the BID (matching the live engine). Known approximations: option
> volume/OI/unusual-score in the chain are plausible constants (the quote endpoint
> has no volume), and fills assume the full quoted side with no queue/partial-fill
> modeling. **Past performance does not predict future results. Not advice.**

## Headline

| Metric | Value |
| --- | --- |
| Start balance | $400.00 |
| End balance | $1208.00 |
| Net P&L | $808.00 |
| Return | 202.00% |
| Total trades | 6 |
| Win rate | 50.0% (3W / 3L) |
| Avg win | $358.67 |
| Avg loss | $89.33 |
| Profit factor | 4.01 |
| Max drawdown | $174.00 |
| Best / worst trade | $954.00 / $-98.00 |

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
| 2026-06-17 | real -1.38% | 6 | $808.00 |

## Trades

| Date | Side | Strike | Qty | Entry | Exit | P&L | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-17 | Put | 748 | 2 | 1.35 | 1.93 | $116.00 | Trailing stop: premium 1.93 ≤ 15% give-back from peak 2.30 ( |
| 2026-06-17 | Put | 749 | 2 | 2.37 | 1.88 | $-98.00 | Stop loss: premium 1.88 ≤ stop 1.90 (20% loss) |
| 2026-06-17 | Put | 750 | 1 | 2.26 | 2.32 | $6.00 | Profit-lock stop: premium 2.32 ≤ locked stop 2.37 (raised to |
| 2026-06-17 | Put | 749 | 2 | 1.94 | 1.53 | $-82.00 | Stop loss: premium 1.53 ≤ stop 1.55 (20% loss) |
| 2026-06-17 | Put | 748 | 3 | 1.00 | 4.18 | $954.00 | Trailing stop: premium 4.18 ≤ 15% give-back from peak 5.51 ( |
| 2026-06-17 | Put | 747 | 1 | 2.59 | 1.71 | $-88.00 | Stop loss: premium 1.71 ≤ stop 2.07 (20% loss) |

## Rejection breakdown

Why each non-trade bar didn't fire (counts across all evaluated bars):

| Bucket | Count |
| --- | ---: |
| bars_evaluated | 288 |
| no_chain_quoted | 0 |
| daily_loss_stop | 103 |
| no_setup | 27 |
| blocked_mtf | 151 |
| blocked_other | 0 |
| review_mtf | 0 |
| review_contract_quality | 0 |
| review_aplus_floor | 0 |
| review_no_contract | 0 |
| review_other | 0 |
| confidence_below_auto | 1 |
| sizing_rejected | 0 |
| cost_exceeds_balance | 0 |

### Top MTF block reasons

- (113) Higher timeframe contradicts Put: 30m trend is bullish, opposing a Put entry. Entry blocked.
- (20) Higher timeframe is neutral/choppy: Higher timeframe is mixed/neutral (30m neutral, 15m bearish). Entry blocked — small-account profile requires 30m + 15m trend alignment.
- (8) Higher timeframe aligned with Put, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
- (8) Higher timeframe aligned with Put, but lower-timeframe confirmation incomplete (5m pending, 1m pending). Entry blocked until 5m setup + 1m trigger both confirm.
- (1) Higher timeframe is neutral/choppy: Higher timeframe is mixed/neutral (30m neutral, 15m neutral). Entry blocked — small-account profile requires 30m + 15m trend alignment.
