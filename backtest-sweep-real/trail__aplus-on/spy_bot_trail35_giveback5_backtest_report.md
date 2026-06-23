# SPY 0DTE Bot — Backtest ($400.00) — data: thetadata

Generated: 2026-06-23T00:47:09.102Z

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
| End balance | $4543.00 |
| Net P&L | $4143.00 |
| Return | 1035.75% |
| Total trades | 68 |
| Win rate | 69.1% (47W / 21L) |
| Avg win | $122.85 |
| Avg loss | $77.67 |
| Profit factor | 3.54 |
| Max drawdown | $294.00 |
| Best / worst trade | $621.00 / $-168.00 |

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
| 2026-06-01 | real +0.41% | 4 | $309.00 |
| 2026-06-02 | real +0.32% | 5 | $504.00 |
| 2026-06-03 | real -0.52% | 11 | $518.00 |
| 2026-06-04 | real +0.66% | 1 | $64.00 |
| 2026-06-05 | real -1.98% | 3 | $844.00 |
| 2026-06-08 | real -0.54% | 2 | $-213.00 |
| 2026-06-09 | real -0.88% | 3 | $327.00 |
| 2026-06-10 | real -1.09% | 6 | $427.00 |
| 2026-06-11 | real +1.22% | 2 | $-217.00 |
| 2026-06-12 | real +0.13% | 10 | $478.00 |
| 2026-06-15 | real +0.37% | 3 | $530.00 |
| 2026-06-16 | real -0.56% | 16 | $792.00 |
| 2026-06-17 | real -1.38% | 2 | $-220.00 |
| 2026-06-18 | real -0.16% | 0 | $0.00 |

## Trades

| Date | Side | Strike | Qty | Entry | Exit | P&L | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-01 | Call | 756 | 2 | 1.40 | 1.08 | $-64.00 | Stop loss: premium 1.08 ≤ stop 1.12 (20% loss) |
| 2026-06-01 | Call | 756 | 3 | 0.96 | 1.51 | $165.00 | Trailing stop: premium 1.51 ≤ 15% give-back from peak 1.78 ( |
| 2026-06-01 | Call | 756 | 4 | 0.94 | 1.26 | $128.00 | Trailing stop: premium 1.26 ≤ 15% give-back from peak 1.52 ( |
| 2026-06-01 | Call | 757 | 4 | 0.71 | 0.91 | $80.00 | Trailing stop: premium 0.91 ≤ 15% give-back from peak 1.24 ( |
| 2026-06-02 | Call | 758 | 4 | 0.94 | 1.02 | $32.00 | Trailing stop: premium 1.02 ≤ 15% give-back from peak 1.23 ( |
| 2026-06-02 | Call | 758 | 4 | 1.04 | 2.10 | $424.00 | Trailing stop: premium 2.10 ≤ 15% give-back from peak 2.59 ( |
| 2026-06-02 | Call | 759 | 4 | 0.35 | 0.45 | $40.00 | Trailing stop: premium 0.45 ≤ 15% give-back from peak 0.57 ( |
| 2026-06-02 | Call | 759 | 4 | 0.52 | 0.51 | $-4.00 | Trailing stop: premium 0.51 ≤ 15% give-back from peak 0.65 ( |
| 2026-06-02 | Call | 759 | 4 | 0.47 | 0.50 | $12.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 756 | 3 | 1.27 | 1.41 | $42.00 | Trailing stop: premium 1.41 ≤ 15% give-back from peak 1.81 ( |
| 2026-06-03 | Put | 755 | 4 | 1.05 | 1.32 | $108.00 | Trailing stop: premium 1.32 ≤ 15% give-back from peak 1.65 ( |
| 2026-06-03 | Put | 756 | 4 | 1.00 | 1.21 | $84.00 | Trailing stop: premium 1.21 ≤ 15% give-back from peak 1.47 ( |
| 2026-06-03 | Put | 755 | 4 | 0.71 | 0.82 | $44.00 | Trailing stop: premium 0.82 ≤ 15% give-back from peak 0.97 ( |
| 2026-06-03 | Put | 755 | 4 | 0.77 | 0.95 | $72.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 1.00 | 1.01 | $4.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 1.07 | 1.02 | $-20.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 0.66 | 0.91 | $100.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 0.92 | 0.97 | $20.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 0.94 | 1.02 | $32.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 754 | 4 | 0.53 | 0.61 | $32.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-04 | Call | 753 | 4 | 1.19 | 1.35 | $64.00 | Trailing stop: premium 1.35 ≤ 15% give-back from peak 1.63 ( |
| 2026-06-05 | Put | 748 | 4 | 1.21 | 1.89 | $272.00 | Trailing stop: premium 1.89 ≤ 15% give-back from peak 2.26 ( |
| 2026-06-05 | Put | 741 | 4 | 0.70 | 0.88 | $72.00 | Trailing stop: premium 0.88 ≤ 15% give-back from peak 1.04 ( |
| 2026-06-05 | Put | 741 | 4 | 0.89 | 2.14 | $500.00 | Trailing stop: premium 2.14 ≤ 15% give-back from peak 2.99 ( |
| 2026-06-08 | Put | 741 | 3 | 1.53 | 1.18 | $-105.00 | Stop loss: premium 1.18 ≤ stop 1.22 (20% loss) |
| 2026-06-08 | Put | 740 | 4 | 1.13 | 0.86 | $-108.00 | Stop loss: premium 0.86 ≤ stop 0.90 (20% loss) |
| 2026-06-09 | Put | 744 | 3 | 1.46 | 3.53 | $621.00 | Trailing stop: premium 3.53 ≤ 15% give-back from peak 4.95 ( |
| 2026-06-09 | Put | 732 | 3 | 1.38 | 0.96 | $-126.00 | Stop loss: premium 0.96 ≤ stop 1.10 (20% loss) |
| 2026-06-09 | Put | 733 | 3 | 1.65 | 1.09 | $-168.00 | Stop loss: premium 1.09 ≤ stop 1.32 (20% loss) |
| 2026-06-10 | Put | 734 | 2 | 2.33 | 2.65 | $64.00 | Trailing stop: premium 2.65 ≤ 15% give-back from peak 3.72 ( |
| 2026-06-10 | Put | 729 | 2 | 1.69 | 1.80 | $22.00 | Trailing stop: premium 1.80 ≤ 15% give-back from peak 2.16 ( |
| 2026-06-10 | Put | 729 | 3 | 1.51 | 1.40 | $-33.00 | Trailing stop: premium 1.40 ≤ 15% give-back from peak 2.30 ( |
| 2026-06-10 | Put | 729 | 3 | 1.37 | 2.15 | $234.00 | Trailing stop: premium 2.15 ≤ 15% give-back from peak 2.56 ( |
| 2026-06-10 | Put | 727 | 4 | 1.12 | 0.89 | $-92.00 | Stop loss: premium 0.89 ≤ stop 0.90 (20% loss) |
| 2026-06-10 | Put | 727 | 4 | 1.12 | 1.70 | $232.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-11 | Call | 736 | 4 | 1.13 | 0.85 | $-112.00 | Stop loss: premium 0.85 ≤ stop 0.90 (20% loss) |
| 2026-06-11 | Call | 736 | 3 | 1.35 | 1.00 | $-105.00 | Stop loss: premium 1.00 ≤ stop 1.08 (20% loss) |
| 2026-06-12 | Call | 740 | 2 | 2.49 | 2.58 | $18.00 | Trailing stop: premium 2.58 ≤ 15% give-back from peak 3.23 ( |
| 2026-06-12 | Call | 740 | 2 | 1.69 | 3.46 | $354.00 | Trailing stop: premium 3.46 ≤ 15% give-back from peak 4.27 ( |
| 2026-06-12 | Call | 741 | 2 | 2.04 | 1.61 | $-86.00 | Stop loss: premium 1.61 ≤ stop 1.63 (20% loss) |
| 2026-06-12 | Call | 740 | 2 | 1.91 | 2.55 | $128.00 | Trailing stop: premium 2.55 ≤ 15% give-back from peak 3.30 ( |
| 2026-06-12 | Call | 742 | 3 | 1.34 | 1.46 | $36.00 | Trailing stop: premium 1.46 ≤ 15% give-back from peak 1.91 ( |
| 2026-06-12 | Call | 742 | 4 | 0.94 | 0.89 | $-20.00 | Trailing stop: premium 0.89 ≤ 15% give-back from peak 1.19 ( |
| 2026-06-12 | Call | 742 | 4 | 0.87 | 0.67 | $-80.00 | Stop loss: premium 0.67 ≤ stop 0.70 (20% loss) |
| 2026-06-12 | Call | 742 | 4 | 0.66 | 0.77 | $44.00 | Trailing stop: premium 0.77 ≤ 15% give-back from peak 0.94 ( |
| 2026-06-12 | Call | 741 | 4 | 0.46 | 0.78 | $128.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-12 | Call | 741 | 4 | 0.66 | 0.55 | $-44.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-15 | Call | 754 | 4 | 1.12 | 0.90 | $-88.00 | Stop loss: premium 0.90 ≤ stop 0.90 (20% loss) |
| 2026-06-15 | Call | 753 | 3 | 1.38 | 3.24 | $558.00 | Trailing stop: premium 3.24 ≤ 15% give-back from peak 3.83 ( |
| 2026-06-15 | Call | 755 | 4 | 0.50 | 0.65 | $60.00 | Trailing stop: premium 0.65 ≤ 15% give-back from peak 0.77 ( |
| 2026-06-16 | Put | 754 | 4 | 1.00 | 1.80 | $320.00 | Trailing stop: premium 1.80 ≤ 15% give-back from peak 2.26 ( |
| 2026-06-16 | Put | 753 | 4 | 1.00 | 1.09 | $36.00 | Trailing stop: premium 1.09 ≤ 15% give-back from peak 1.29 ( |
| 2026-06-16 | Put | 752 | 4 | 0.79 | 1.00 | $84.00 | Trailing stop: premium 1.00 ≤ 15% give-back from peak 1.20 ( |
| 2026-06-16 | Put | 753 | 4 | 0.71 | 0.94 | $92.00 | Trailing stop: premium 0.94 ≤ 15% give-back from peak 1.21 ( |
| 2026-06-16 | Put | 753 | 4 | 1.07 | 1.10 | $12.00 | Trailing stop: premium 1.10 ≤ 15% give-back from peak 1.42 ( |
| 2026-06-16 | Put | 752 | 4 | 0.67 | 0.84 | $68.00 | Trailing stop: premium 0.84 ≤ 15% give-back from peak 1.04 ( |
| 2026-06-16 | Put | 752 | 4 | 0.74 | 0.58 | $-64.00 | Stop loss: premium 0.58 ≤ stop 0.59 (20% loss) |
| 2026-06-16 | Put | 751 | 4 | 0.29 | 0.32 | $12.00 | Trailing stop: premium 0.32 ≤ 15% give-back from peak 0.42 ( |
| 2026-06-16 | Put | 751 | 4 | 0.30 | 0.31 | $4.00 | Trailing stop: premium 0.31 ≤ 15% give-back from peak 0.43 ( |
| 2026-06-16 | Put | 751 | 4 | 0.39 | 0.86 | $188.00 | Trailing stop: premium 0.86 ≤ 15% give-back from peak 1.07 ( |
| 2026-06-16 | Put | 751 | 4 | 0.49 | 0.55 | $24.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-16 | Put | 751 | 4 | 0.71 | 0.62 | $-36.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-16 | Put | 751 | 4 | 0.68 | 0.69 | $4.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-16 | Put | 750 | 4 | 0.30 | 0.31 | $4.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-16 | Put | 751 | 4 | 0.38 | 0.63 | $100.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-16 | Put | 751 | 4 | 0.65 | 0.51 | $-56.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-17 | Put | 749 | 2 | 2.37 | 1.88 | $-98.00 | Stop loss: premium 1.88 ≤ stop 1.90 (20% loss) |
| 2026-06-17 | Put | 750 | 2 | 2.26 | 1.65 | $-122.00 | Stop loss: premium 1.65 ≤ stop 1.81 (20% loss) |

## Rejection breakdown

Why each non-trade bar didn't fire (counts across all evaluated bars):

| Bucket | Count |
| --- | ---: |
| bars_evaluated | 4422 |
| no_chain_quoted | 0 |
| daily_loss_stop | 445 |
| no_setup | 636 |
| blocked_mtf | 2992 |
| blocked_other | 0 |
| review_mtf | 265 |
| review_contract_quality | 1 |
| review_aplus_floor | 6 |
| review_no_contract | 0 |
| review_other | 0 |
| confidence_below_auto | 0 |
| sizing_rejected | 9 |
| cost_exceeds_balance | 0 |

### Top MTF block reasons

- (599) Higher timeframe contradicts Put: 30m trend is bullish, opposing a Put entry. Entry blocked.
- (529) Higher timeframe aligned with Call, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
- (438) Higher timeframe aligned with Call, but lower-timeframe confirmation incomplete (5m pending, 1m pending). Entry blocked until 5m setup + 1m trigger both confirm.
- (364) Higher timeframe aligned with Put, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
- (294) Higher timeframe contradicts Call: 30m trend is bearish, opposing a Call entry. Entry blocked.

### Top MTF downgrade reasons

- (2) A+ gate: not an A+ entry — Mid-range chase: trigger 754.03 is 1.86 (0.25%) from the nearest qualifying resistance 755.89 (30m EMA200 + 15m VWAP); outside the 0.15% A+ proximity band. Higher/lower timeframes aligned, but the entry is not near a supply/demand · support/resistance · step-in level, so it is downgraded from auto-entry.
- (2) A+ gate: not an A+ entry — Mid-range chase: trigger 754.15 is 2.05 (0.27%) from the nearest qualifying support 752.1 (daily open + 15m VWAP); outside the 0.15% A+ proximity band. Higher/lower timeframes aligned, but the entry is not near a supply/demand · support/resistance · step-in level, so it is downgraded from auto-entry.
- (2) A+ gate: not an A+ entry — Mid-range chase: trigger 755.41 is 2.17 (0.29%) from the nearest qualifying support 753.24 (30m EMA200 + 15m VWAP); outside the 0.15% A+ proximity band. Higher/lower timeframes aligned, but the entry is not near a supply/demand · support/resistance · step-in level, so it is downgraded from auto-entry.
- (2) A+ gate: not an A+ entry — Mid-range chase: trigger 756.23 is 2.94 (0.39%) from the nearest qualifying support 753.29 (30m EMA200 + 15m VWAP); outside the 0.15% A+ proximity band. Higher/lower timeframes aligned, but the entry is not near a supply/demand · support/resistance · step-in level, so it is downgraded from auto-entry.
- (2) A+ gate: not an A+ entry — Mid-range chase: trigger 756.52 is 2.23 (0.29%) from the nearest qualifying support 754.29 (15m swing high + 15m swing low); outside the 0.15% A+ proximity band. Higher/lower timeframes aligned, but the entry is not near a supply/demand · support/resistance · step-in level, so it is downgraded from auto-entry.
