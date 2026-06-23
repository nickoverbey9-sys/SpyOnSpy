# SPY 0DTE Bot — Backtest ($400.00) — data: thetadata

Generated: 2026-06-23T00:45:47.522Z

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
| End balance | $9003.00 |
| Net P&L | $8603.00 |
| Return | 2150.75% |
| Total trades | 89 |
| Win rate | 70.8% (63W / 25L) |
| Avg win | $168.73 |
| Avg loss | $81.08 |
| Profit factor | 5.24 |
| Max drawdown | $336.00 |
| Best / worst trade | $957.00 / $-160.00 |

## Risk profile under test

- Hard stop loss: 20% of premium · NO fixed take-profit (let winners run)
- Trailing stop: arms at +25%, exits on a 15% give-back from the post-arm peak
- All sizes (2–4 contract ladder): full position runs together, no partial trims
- Exits: hard stop -20% · +25% arm / 15% give-back trailing stop · flatten/invalidation
- Max loss per trade: $100 (~7.5% of account) · Daily loss stop (backtest): $1000
- Entry filters: 30m+15m trend alignment, 5m setup + 1m trigger required;
  no time-of-day entry blockers; hard flatten 14:30 CT
- Quality filters: min option premium $0.15, max spread 30% of mid
- Sizing ladder: preferred 4 → fallback steps down to minimum 2 (blocks below 2), capped by cash and per-trade stop risk

## Per-session

| Date | Regime | Trades | P&L |
| --- | --- | --- | --- |
| 2026-05-29 | real +0.07% | 0 | $0.00 |
| 2026-06-01 | real +0.41% | 6 | $893.00 |
| 2026-06-02 | real +0.32% | 5 | $504.00 |
| 2026-06-03 | real -0.52% | 12 | $582.00 |
| 2026-06-04 | real +0.66% | 7 | $296.00 |
| 2026-06-05 | real -1.98% | 8 | $1125.00 |
| 2026-06-08 | real -0.54% | 9 | $619.00 |
| 2026-06-09 | real -0.88% | 9 | $2861.00 |
| 2026-06-10 | real -1.09% | 5 | $88.00 |
| 2026-06-11 | real +1.22% | 4 | $188.00 |
| 2026-06-12 | real +0.13% | 9 | $603.00 |
| 2026-06-15 | real +0.37% | 3 | $530.00 |
| 2026-06-16 | real -0.56% | 9 | $360.00 |
| 2026-06-17 | real -1.38% | 3 | $-46.00 |
| 2026-06-18 | real -0.16% | 0 | $0.00 |

## Trades

| Date | Side | Strike | Qty | Entry | Exit | P&L | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-01 | Call | 756 | 2 | 1.40 | 1.08 | $-64.00 | Stop loss: premium 1.08 ≤ stop 1.12 (20% loss) |
| 2026-06-01 | Call | 756 | 3 | 0.96 | 1.51 | $165.00 | Trailing stop: premium 1.51 ≤ 15% give-back from peak 1.78 ( |
| 2026-06-01 | Call | 756 | 4 | 0.94 | 1.26 | $128.00 | Trailing stop: premium 1.26 ≤ 15% give-back from peak 1.52 ( |
| 2026-06-01 | Call | 757 | 4 | 0.71 | 0.91 | $80.00 | Trailing stop: premium 0.91 ≤ 15% give-back from peak 1.24 ( |
| 2026-06-01 | Call | 758 | 4 | 0.36 | 0.76 | $160.00 | Trailing stop: premium 0.76 ≤ 15% give-back from peak 0.93 ( |
| 2026-06-01 | Call | 758 | 4 | 0.62 | 1.68 | $424.00 | Trailing stop: premium 1.68 ≤ 15% give-back from peak 2.02 ( |
| 2026-06-02 | Call | 758 | 4 | 0.94 | 1.02 | $32.00 | Trailing stop: premium 1.02 ≤ 15% give-back from peak 1.23 ( |
| 2026-06-02 | Call | 758 | 4 | 1.04 | 2.10 | $424.00 | Trailing stop: premium 2.10 ≤ 15% give-back from peak 2.59 ( |
| 2026-06-02 | Call | 759 | 4 | 0.35 | 0.45 | $40.00 | Trailing stop: premium 0.45 ≤ 15% give-back from peak 0.57 ( |
| 2026-06-02 | Call | 759 | 4 | 0.52 | 0.51 | $-4.00 | Trailing stop: premium 0.51 ≤ 15% give-back from peak 0.65 ( |
| 2026-06-02 | Call | 759 | 4 | 0.47 | 0.50 | $12.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 756 | 3 | 1.27 | 1.41 | $42.00 | Trailing stop: premium 1.41 ≤ 15% give-back from peak 1.81 ( |
| 2026-06-03 | Put | 755 | 4 | 1.05 | 1.32 | $108.00 | Trailing stop: premium 1.32 ≤ 15% give-back from peak 1.65 ( |
| 2026-06-03 | Put | 754 | 4 | 0.95 | 1.11 | $64.00 | Trailing stop: premium 1.11 ≤ 15% give-back from peak 1.36 ( |
| 2026-06-03 | Put | 756 | 4 | 1.00 | 1.21 | $84.00 | Trailing stop: premium 1.21 ≤ 15% give-back from peak 1.47 ( |
| 2026-06-03 | Put | 755 | 4 | 0.71 | 0.82 | $44.00 | Trailing stop: premium 0.82 ≤ 15% give-back from peak 0.97 ( |
| 2026-06-03 | Put | 755 | 4 | 0.77 | 0.95 | $72.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 1.00 | 1.01 | $4.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 1.07 | 1.02 | $-20.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 0.66 | 0.91 | $100.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 0.92 | 0.97 | $20.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 0.94 | 1.02 | $32.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 754 | 4 | 0.53 | 0.61 | $32.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-04 | Call | 753 | 3 | 1.48 | 1.15 | $-99.00 | Stop loss: premium 1.15 ≤ stop 1.18 (20% loss) |
| 2026-06-04 | Call | 753 | 4 | 1.19 | 1.35 | $64.00 | Trailing stop: premium 1.35 ≤ 15% give-back from peak 1.63 ( |
| 2026-06-04 | Call | 753 | 3 | 1.55 | 1.64 | $27.00 | Trailing stop: premium 1.64 ≤ 15% give-back from peak 1.96 ( |
| 2026-06-04 | Call | 754 | 4 | 1.15 | 1.92 | $308.00 | Trailing stop: premium 1.92 ≤ 15% give-back from peak 2.26 ( |
| 2026-06-04 | Call | 756 | 4 | 0.92 | 0.90 | $-8.00 | Trailing stop: premium 0.90 ≤ 15% give-back from peak 1.15 ( |
| 2026-06-04 | Call | 757 | 4 | 0.54 | 0.64 | $40.00 | Trailing stop: premium 0.64 ≤ 15% give-back from peak 0.80 ( |
| 2026-06-04 | Call | 758 | 4 | 0.45 | 0.36 | $-36.00 | Stop loss: premium 0.36 ≤ stop 0.36 (20% loss) |
| 2026-06-05 | Put | 749 | 2 | 1.86 | 1.30 | $-112.00 | Stop loss: premium 1.30 ≤ stop 1.49 (20% loss) |
| 2026-06-05 | Put | 748 | 4 | 1.21 | 1.89 | $272.00 | Trailing stop: premium 1.89 ≤ 15% give-back from peak 2.26 ( |
| 2026-06-05 | Put | 747 | 3 | 1.38 | 2.27 | $267.00 | Trailing stop: premium 2.27 ≤ 15% give-back from peak 2.68 ( |
| 2026-06-05 | Put | 745 | 3 | 1.44 | 1.70 | $78.00 | Trailing stop: premium 1.70 ≤ 15% give-back from peak 2.11 ( |
| 2026-06-05 | Put | 744 | 3 | 1.38 | 1.92 | $162.00 | Trailing stop: premium 1.92 ≤ 15% give-back from peak 2.56 ( |
| 2026-06-05 | Put | 741 | 4 | 0.70 | 0.88 | $72.00 | Trailing stop: premium 0.88 ≤ 15% give-back from peak 1.04 ( |
| 2026-06-05 | Put | 741 | 4 | 0.89 | 2.14 | $500.00 | Trailing stop: premium 2.14 ≤ 15% give-back from peak 2.99 ( |
| 2026-06-05 | Put | 739 | 3 | 1.37 | 0.99 | $-114.00 | Stop loss: premium 0.99 ≤ stop 1.10 (20% loss) |
| 2026-06-08 | Put | 741 | 4 | 1.21 | 1.34 | $52.00 | Trailing stop: premium 1.34 ≤ 15% give-back from peak 1.65 ( |
| 2026-06-08 | Put | 741 | 4 | 1.11 | 1.43 | $128.00 | Trailing stop: premium 1.43 ≤ 15% give-back from peak 1.69 ( |
| 2026-06-08 | Put | 741 | 3 | 1.34 | 1.47 | $39.00 | Trailing stop: premium 1.47 ≤ 15% give-back from peak 1.79 ( |
| 2026-06-08 | Put | 741 | 4 | 0.92 | 1.07 | $60.00 | Trailing stop: premium 1.07 ≤ 15% give-back from peak 1.35 ( |
| 2026-06-08 | Put | 741 | 4 | 1.07 | 1.01 | $-24.00 | Trailing stop: premium 1.01 ≤ 15% give-back from peak 1.44 ( |
| 2026-06-08 | Put | 741 | 4 | 0.70 | 0.75 | $20.00 | Trailing stop: premium 0.75 ≤ 15% give-back from peak 0.94 ( |
| 2026-06-08 | Put | 741 | 4 | 0.75 | 1.44 | $276.00 | Trailing stop: premium 1.44 ≤ 15% give-back from peak 1.76 ( |
| 2026-06-08 | Put | 739 | 4 | 0.78 | 0.62 | $-64.00 | Stop loss: premium 0.62 ≤ stop 0.62 (20% loss) |
| 2026-06-08 | Put | 739 | 4 | 0.64 | 0.97 | $132.00 | Trailing stop: premium 0.97 ≤ 15% give-back from peak 1.28 ( |
| 2026-06-09 | Put | 744 | 3 | 1.46 | 3.53 | $621.00 | Trailing stop: premium 3.53 ≤ 15% give-back from peak 4.95 ( |
| 2026-06-09 | Put | 741 | 2 | 1.67 | 1.69 | $4.00 | Trailing stop: premium 1.69 ≤ 15% give-back from peak 2.24 ( |
| 2026-06-09 | Put | 740 | 3 | 1.54 | 4.73 | $957.00 | Trailing stop: premium 4.73 ≤ 15% give-back from peak 5.82 ( |
| 2026-06-09 | Put | 736 | 2 | 2.17 | 1.68 | $-98.00 | Stop loss: premium 1.68 ≤ stop 1.74 (20% loss) |
| 2026-06-09 | Put | 735 | 3 | 1.63 | 4.04 | $723.00 | Trailing stop: premium 4.04 ≤ 15% give-back from peak 5.20 ( |
| 2026-06-09 | Put | 729 | 2 | 1.96 | 1.96 | $0.00 | Trailing stop: premium 1.96 ≤ 15% give-back from peak 2.54 ( |
| 2026-06-09 | Put | 728 | 2 | 2.00 | 3.32 | $264.00 | Trailing stop: premium 3.32 ≤ 15% give-back from peak 4.01 ( |
| 2026-06-09 | Put | 724 | 4 | 1.15 | 2.43 | $512.00 | Trailing stop: premium 2.43 ≤ 15% give-back from peak 3.57 ( |
| 2026-06-09 | Put | 732 | 2 | 2.05 | 1.44 | $-122.00 | Stop loss: premium 1.44 ≤ stop 1.64 (20% loss) |
| 2026-06-10 | Put | 734 | 2 | 2.33 | 2.65 | $64.00 | Trailing stop: premium 2.65 ≤ 15% give-back from peak 3.72 ( |
| 2026-06-10 | Put | 732 | 2 | 2.46 | 3.39 | $186.00 | Trailing stop: premium 3.39 ≤ 15% give-back from peak 4.12 ( |
| 2026-06-10 | Put | 729 | 2 | 1.99 | 2.29 | $60.00 | Trailing stop: premium 2.29 ≤ 15% give-back from peak 2.77 ( |
| 2026-06-10 | Put | 730 | 2 | 2.05 | 1.50 | $-110.00 | Stop loss: premium 1.50 ≤ stop 1.64 (20% loss) |
| 2026-06-10 | Put | 730 | 2 | 2.01 | 1.45 | $-112.00 | Stop loss: premium 1.45 ≤ stop 1.61 (20% loss) |
| 2026-06-11 | Call | 732 | 2 | 2.04 | 1.47 | $-114.00 | Stop loss: premium 1.47 ≤ stop 1.63 (20% loss) |
| 2026-06-11 | Call | 733 | 4 | 0.77 | 1.62 | $340.00 | Trailing stop: premium 1.62 ≤ 15% give-back from peak 2.33 ( |
| 2026-06-11 | Call | 734 | 2 | 1.69 | 2.30 | $122.00 | Trailing stop: premium 2.30 ≤ 15% give-back from peak 3.09 ( |
| 2026-06-11 | Call | 736 | 4 | 1.25 | 0.85 | $-160.00 | Stop loss: premium 0.85 ≤ stop 1.00 (20% loss) |
| 2026-06-12 | Call | 738 | 2 | 2.40 | 3.56 | $232.00 | Trailing stop: premium 3.56 ≤ 15% give-back from peak 4.25 ( |
| 2026-06-12 | Call | 741 | 2 | 2.48 | 1.98 | $-100.00 | Stop loss: premium 1.98 ≤ stop 1.98 (20% loss) |
| 2026-06-12 | Call | 740 | 2 | 1.69 | 3.46 | $354.00 | Trailing stop: premium 3.46 ≤ 15% give-back from peak 4.27 ( |
| 2026-06-12 | Call | 743 | 2 | 2.17 | 2.36 | $38.00 | Trailing stop: premium 2.36 ≤ 15% give-back from peak 2.86 ( |
| 2026-06-12 | Call | 741 | 2 | 2.04 | 1.61 | $-86.00 | Stop loss: premium 1.61 ≤ stop 1.63 (20% loss) |
| 2026-06-12 | Call | 740 | 2 | 1.91 | 2.55 | $128.00 | Trailing stop: premium 2.55 ≤ 15% give-back from peak 3.30 ( |
| 2026-06-12 | Call | 742 | 3 | 1.34 | 1.46 | $36.00 | Trailing stop: premium 1.46 ≤ 15% give-back from peak 1.91 ( |
| 2026-06-12 | Call | 742 | 3 | 1.27 | 1.34 | $21.00 | Trailing stop: premium 1.34 ≤ 15% give-back from peak 1.86 ( |
| 2026-06-12 | Call | 742 | 4 | 0.94 | 0.89 | $-20.00 | Trailing stop: premium 0.89 ≤ 15% give-back from peak 1.19 ( |
| 2026-06-15 | Call | 754 | 4 | 1.12 | 0.90 | $-88.00 | Stop loss: premium 0.90 ≤ stop 0.90 (20% loss) |
| 2026-06-15 | Call | 753 | 3 | 1.38 | 3.24 | $558.00 | Trailing stop: premium 3.24 ≤ 15% give-back from peak 3.83 ( |
| 2026-06-15 | Call | 755 | 4 | 0.50 | 0.65 | $60.00 | Trailing stop: premium 0.65 ≤ 15% give-back from peak 0.77 ( |
| 2026-06-16 | Put | 754 | 4 | 1.00 | 1.80 | $320.00 | Trailing stop: premium 1.80 ≤ 15% give-back from peak 2.26 ( |
| 2026-06-16 | Put | 753 | 4 | 1.17 | 0.92 | $-100.00 | Stop loss: premium 0.92 ≤ stop 0.94 (20% loss) |
| 2026-06-16 | Put | 753 | 4 | 1.00 | 1.09 | $36.00 | Trailing stop: premium 1.09 ≤ 15% give-back from peak 1.29 ( |
| 2026-06-16 | Put | 752 | 4 | 0.95 | 0.73 | $-88.00 | Stop loss: premium 0.73 ≤ stop 0.76 (20% loss) |
| 2026-06-16 | Put | 752 | 4 | 0.79 | 1.00 | $84.00 | Trailing stop: premium 1.00 ≤ 15% give-back from peak 1.20 ( |
| 2026-06-16 | Put | 753 | 4 | 0.71 | 0.94 | $92.00 | Trailing stop: premium 0.94 ≤ 15% give-back from peak 1.21 ( |
| 2026-06-16 | Put | 753 | 4 | 1.07 | 1.10 | $12.00 | Trailing stop: premium 1.10 ≤ 15% give-back from peak 1.42 ( |
| 2026-06-16 | Put | 752 | 4 | 0.67 | 0.84 | $68.00 | Trailing stop: premium 0.84 ≤ 15% give-back from peak 1.04 ( |
| 2026-06-16 | Put | 752 | 4 | 0.74 | 0.58 | $-64.00 | Stop loss: premium 0.58 ≤ stop 0.59 (20% loss) |
| 2026-06-17 | Put | 748 | 3 | 1.35 | 1.93 | $174.00 | Trailing stop: premium 1.93 ≤ 15% give-back from peak 2.30 ( |
| 2026-06-17 | Put | 749 | 2 | 2.37 | 1.88 | $-98.00 | Stop loss: premium 1.88 ≤ stop 1.90 (20% loss) |
| 2026-06-17 | Put | 750 | 2 | 2.26 | 1.65 | $-122.00 | Stop loss: premium 1.65 ≤ stop 1.81 (20% loss) |

## Rejection breakdown

Why each non-trade bar didn't fire (counts across all evaluated bars):

| Bucket | Count |
| --- | ---: |
| bars_evaluated | 4023 |
| no_chain_quoted | 0 |
| daily_loss_stop | 776 |
| no_setup | 540 |
| blocked_mtf | 2609 |
| blocked_other | 0 |
| review_mtf | 0 |
| review_contract_quality | 0 |
| review_aplus_floor | 0 |
| review_no_contract | 0 |
| review_other | 0 |
| confidence_below_auto | 4 |
| sizing_rejected | 5 |
| cost_exceeds_balance | 0 |

### Top MTF block reasons

- (596) Higher timeframe contradicts Put: 30m trend is bullish, opposing a Put entry. Entry blocked.
- (427) Higher timeframe aligned with Call, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
- (366) Higher timeframe aligned with Call, but lower-timeframe confirmation incomplete (5m pending, 1m pending). Entry blocked until 5m setup + 1m trigger both confirm.
- (294) Higher timeframe contradicts Call: 30m trend is bearish, opposing a Call entry. Entry blocked.
- (238) Higher timeframe aligned with Put, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
