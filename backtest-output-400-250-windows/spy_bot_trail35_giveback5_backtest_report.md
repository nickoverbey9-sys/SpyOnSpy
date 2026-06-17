# SPY 0DTE Bot — Backtest ($400.00) — data: thetadata

Generated: 2026-06-17T06:43:50.465Z

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
| End balance | $9986.00 |
| Net P&L | $9586.00 |
| Return | 2396.50% |
| Total trades | 148 |
| Win rate | 64.2% (95W / 51L) |
| Avg win | $125.77 |
| Avg loss | $46.31 |
| Profit factor | 5.06 |
| Max drawdown | $184.00 |
| Best / worst trade | $957.00 / $-168.00 |

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
| 2026-05-27 | real -0.05% | 7 | $196.00 |
| 2026-05-28 | real +0.59% | 12 | $405.00 |
| 2026-05-29 | real +0.07% | 0 | $0.00 |
| 2026-06-01 | real +0.41% | 8 | $524.00 |
| 2026-06-02 | real +0.32% | 4 | $492.00 |
| 2026-06-03 | real -0.52% | 12 | $314.00 |
| 2026-06-04 | real +0.66% | 9 | $252.00 |
| 2026-06-05 | real -1.98% | 14 | $1531.00 |
| 2026-06-08 | real -0.54% | 10 | $592.00 |
| 2026-06-09 | real -0.88% | 13 | $2655.00 |
| 2026-06-10 | real -1.09% | 13 | $626.00 |
| 2026-06-11 | real +1.22% | 6 | $130.00 |
| 2026-06-12 | real +0.13% | 15 | $648.00 |
| 2026-06-15 | real +0.37% | 4 | $625.00 |
| 2026-06-16 | real -0.56% | 21 | $596.00 |

## Trades

| Date | Side | Strike | Qty | Entry | Exit | P&L | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-05-27 | Put | 749 | 4 | 0.99 | 0.88 | $-44.00 | Breakeven stop: premium 0.88 ≤ protected stop 0.99 (raised t |
| 2026-05-27 | Put | 749 | 4 | 0.84 | 0.98 | $56.00 | Trailing stop: premium 0.98 ≤ 15% give-back from peak 1.26 ( |
| 2026-05-27 | Put | 749 | 4 | 0.80 | 1.19 | $156.00 | Trailing stop: premium 1.19 ≤ 15% give-back from peak 1.41 ( |
| 2026-05-27 | Put | 749 | 4 | 1.02 | 1.10 | $32.00 | Trailing stop: premium 1.10 ≤ 15% give-back from peak 1.30 ( |
| 2026-05-27 | Put | 749 | 4 | 0.98 | 1.07 | $36.00 | Trailing stop: premium 1.07 ≤ 15% give-back from peak 1.33 ( |
| 2026-05-27 | Put | 749 | 4 | 0.69 | 0.54 | $-60.00 | Stop loss: premium 0.54 ≤ stop 0.55 (20% loss) |
| 2026-05-27 | Put | 750 | 4 | 0.75 | 0.80 | $20.00 | Trailing stop: premium 0.80 ≤ 15% give-back from peak 1.00 ( |
| 2026-05-28 | Call | 751 | 4 | 0.86 | 0.87 | $4.00 | Profit-lock stop: premium 0.87 ≤ locked stop 0.90 (raised to |
| 2026-05-28 | Call | 750 | 3 | 1.34 | 1.33 | $-3.00 | Profit-lock stop: premium 1.33 ≤ locked stop 1.41 (raised to |
| 2026-05-28 | Call | 753 | 4 | 0.28 | 1.27 | $396.00 | Trailing stop: premium 1.27 ≤ 15% give-back from peak 1.54 ( |
| 2026-05-28 | Call | 753 | 3 | 1.42 | 1.06 | $-108.00 | Stop loss: premium 1.06 ≤ stop 1.14 (20% loss) |
| 2026-05-28 | Call | 753 | 4 | 1.02 | 1.29 | $108.00 | Trailing stop: premium 1.29 ≤ 15% give-back from peak 1.53 ( |
| 2026-05-28 | Call | 754 | 4 | 0.89 | 0.89 | $0.00 | Breakeven stop: premium 0.89 ≤ protected stop 0.89 (raised t |
| 2026-05-28 | Call | 755 | 4 | 0.25 | 0.27 | $8.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-05-28 | Call | 755 | 4 | 0.30 | 0.35 | $20.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-05-28 | Call | 755 | 4 | 0.30 | 0.33 | $12.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-05-28 | Call | 755 | 4 | 0.33 | 0.35 | $8.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-05-28 | Call | 755 | 4 | 0.40 | 0.41 | $4.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-05-28 | Call | 755 | 4 | 0.44 | 0.33 | $-44.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-01 | Call | 756 | 3 | 1.40 | 1.08 | $-96.00 | Stop loss: premium 1.08 ≤ stop 1.12 (20% loss) |
| 2026-06-01 | Call | 756 | 4 | 0.96 | 0.98 | $8.00 | Profit-lock stop: premium 0.98 ≤ locked stop 1.01 (raised to |
| 2026-06-01 | Call | 757 | 4 | 0.56 | 0.85 | $116.00 | Trailing stop: premium 0.85 ≤ 15% give-back from peak 1.07 ( |
| 2026-06-01 | Call | 756 | 4 | 0.94 | 1.26 | $128.00 | Trailing stop: premium 1.26 ≤ 15% give-back from peak 1.52 ( |
| 2026-06-01 | Call | 757 | 4 | 0.71 | 0.91 | $80.00 | Trailing stop: premium 0.91 ≤ 15% give-back from peak 1.24 ( |
| 2026-06-01 | Call | 758 | 4 | 0.36 | 0.37 | $4.00 | Profit-lock stop: premium 0.37 ≤ locked stop 0.38 (raised to |
| 2026-06-01 | Call | 758 | 4 | 0.93 | 0.58 | $-140.00 | Stop loss: premium 0.58 ≤ stop 0.74 (20% loss) |
| 2026-06-01 | Call | 758 | 4 | 0.62 | 1.68 | $424.00 | Trailing stop: premium 1.68 ≤ 15% give-back from peak 2.02 ( |
| 2026-06-02 | Call | 758 | 4 | 0.94 | 1.02 | $32.00 | Trailing stop: premium 1.02 ≤ 15% give-back from peak 1.23 ( |
| 2026-06-02 | Call | 758 | 4 | 1.04 | 2.10 | $424.00 | Trailing stop: premium 2.10 ≤ 15% give-back from peak 2.59 ( |
| 2026-06-02 | Call | 759 | 4 | 0.35 | 0.45 | $40.00 | Trailing stop: premium 0.45 ≤ 15% give-back from peak 0.57 ( |
| 2026-06-02 | Call | 759 | 4 | 0.52 | 0.51 | $-4.00 | Profit-lock stop: premium 0.51 ≤ locked stop 0.55 (raised to |
| 2026-06-03 | Put | 756 | 3 | 1.27 | 1.21 | $-18.00 | Profit-lock stop: premium 1.21 ≤ locked stop 1.33 (raised to |
| 2026-06-03 | Put | 756 | 4 | 1.23 | 1.41 | $72.00 | Trailing stop: premium 1.41 ≤ 15% give-back from peak 1.81 ( |
| 2026-06-03 | Put | 755 | 4 | 1.05 | 0.98 | $-28.00 | Breakeven stop: premium 0.98 ≤ protected stop 1.05 (raised t |
| 2026-06-03 | Put | 755 | 4 | 1.00 | 0.97 | $-12.00 | Breakeven stop: premium 0.97 ≤ protected stop 1.00 (raised t |
| 2026-06-03 | Put | 755 | 4 | 1.15 | 1.17 | $8.00 | Profit-lock stop: premium 1.17 ≤ locked stop 1.21 (raised to |
| 2026-06-03 | Put | 754 | 4 | 0.83 | 0.94 | $44.00 | Trailing stop: premium 0.94 ≤ 15% give-back from peak 1.13 ( |
| 2026-06-03 | Put | 754 | 4 | 0.95 | 1.11 | $64.00 | Trailing stop: premium 1.11 ≤ 15% give-back from peak 1.36 ( |
| 2026-06-03 | Put | 756 | 4 | 1.00 | 1.21 | $84.00 | Trailing stop: premium 1.21 ≤ 15% give-back from peak 1.47 ( |
| 2026-06-03 | Put | 755 | 4 | 0.71 | 0.82 | $44.00 | Trailing stop: premium 0.82 ≤ 15% give-back from peak 0.97 ( |
| 2026-06-03 | Put | 755 | 4 | 0.77 | 0.95 | $72.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 1.00 | 1.01 | $4.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-03 | Put | 755 | 4 | 1.07 | 1.02 | $-20.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-04 | Call | 753 | 3 | 1.48 | 1.15 | $-99.00 | Stop loss: premium 1.15 ≤ stop 1.18 (20% loss) |
| 2026-06-04 | Call | 753 | 4 | 1.19 | 1.35 | $64.00 | Trailing stop: premium 1.35 ≤ 15% give-back from peak 1.63 ( |
| 2026-06-04 | Call | 753 | 3 | 1.55 | 1.64 | $27.00 | Trailing stop: premium 1.64 ≤ 15% give-back from peak 1.96 ( |
| 2026-06-04 | Call | 754 | 4 | 1.15 | 1.92 | $308.00 | Trailing stop: premium 1.92 ≤ 15% give-back from peak 2.26 ( |
| 2026-06-04 | Call | 756 | 4 | 0.92 | 0.97 | $20.00 | Profit-lock stop: premium 0.97 ≤ locked stop 0.97 (raised to |
| 2026-06-04 | Call | 757 | 4 | 0.52 | 0.53 | $4.00 | Profit-lock stop: premium 0.53 ≤ locked stop 0.55 (raised to |
| 2026-06-04 | Call | 757 | 4 | 0.55 | 0.43 | $-48.00 | Stop loss: premium 0.43 ≤ stop 0.44 (20% loss) |
| 2026-06-04 | Call | 757 | 4 | 0.54 | 0.57 | $12.00 | Profit-lock stop: premium 0.57 ≤ locked stop 0.57 (raised to |
| 2026-06-04 | Call | 758 | 4 | 0.45 | 0.36 | $-36.00 | Stop loss: premium 0.36 ≤ stop 0.36 (20% loss) |
| 2026-06-05 | Put | 749 | 2 | 1.86 | 1.30 | $-112.00 | Stop loss: premium 1.30 ≤ stop 1.49 (20% loss) |
| 2026-06-05 | Put | 748 | 4 | 1.21 | 1.24 | $12.00 | Profit-lock stop: premium 1.24 ≤ locked stop 1.27 (raised to |
| 2026-06-05 | Put | 748 | 4 | 1.19 | 1.89 | $280.00 | Trailing stop: premium 1.89 ≤ 15% give-back from peak 2.26 ( |
| 2026-06-05 | Put | 747 | 3 | 1.38 | 1.42 | $12.00 | Profit-lock stop: premium 1.42 ≤ locked stop 1.45 (raised to |
| 2026-06-05 | Put | 746 | 3 | 1.37 | 1.67 | $90.00 | Trailing stop: premium 1.67 ≤ 15% give-back from peak 2.05 ( |
| 2026-06-05 | Put | 745 | 3 | 1.44 | 1.40 | $-12.00 | Breakeven stop: premium 1.40 ≤ protected stop 1.44 (raised t |
| 2026-06-05 | Put | 744 | 4 | 1.07 | 1.22 | $60.00 | Trailing stop: premium 1.22 ≤ 15% give-back from peak 1.56 ( |
| 2026-06-05 | Put | 744 | 3 | 1.38 | 1.92 | $162.00 | Trailing stop: premium 1.92 ≤ 15% give-back from peak 2.56 ( |
| 2026-06-05 | Put | 741 | 4 | 0.70 | 0.88 | $72.00 | Trailing stop: premium 0.88 ≤ 15% give-back from peak 1.04 ( |
| 2026-06-05 | Put | 741 | 4 | 0.89 | 2.14 | $500.00 | Trailing stop: premium 2.14 ≤ 15% give-back from peak 2.99 ( |
| 2026-06-05 | Put | 739 | 3 | 1.37 | 1.42 | $15.00 | Profit-lock stop: premium 1.42 ≤ locked stop 1.44 (raised to |
| 2026-06-05 | Put | 738 | 4 | 0.89 | 0.90 | $4.00 | Profit-lock stop: premium 0.90 ≤ locked stop 0.93 (raised to |
| 2026-06-05 | Put | 738 | 4 | 0.99 | 2.38 | $556.00 | Trailing stop: premium 2.38 ≤ 15% give-back from peak 2.80 ( |
| 2026-06-05 | Put | 736 | 4 | 1.19 | 0.92 | $-108.00 | Stop loss: premium 0.92 ≤ stop 0.95 (20% loss) |
| 2026-06-08 | Put | 741 | 4 | 1.21 | 1.34 | $52.00 | Trailing stop: premium 1.34 ≤ 15% give-back from peak 1.65 ( |
| 2026-06-08 | Put | 741 | 4 | 1.11 | 1.43 | $128.00 | Trailing stop: premium 1.43 ≤ 15% give-back from peak 1.69 ( |
| 2026-06-08 | Put | 741 | 3 | 1.34 | 1.30 | $-12.00 | Breakeven stop: premium 1.30 ≤ protected stop 1.34 (raised t |
| 2026-06-08 | Put | 740 | 4 | 0.98 | 1.04 | $24.00 | Trailing stop: premium 1.04 ≤ 15% give-back from peak 1.30 ( |
| 2026-06-08 | Put | 741 | 4 | 0.92 | 1.07 | $60.00 | Trailing stop: premium 1.07 ≤ 15% give-back from peak 1.35 ( |
| 2026-06-08 | Put | 741 | 4 | 1.07 | 1.01 | $-24.00 | Profit-lock stop: premium 1.01 ≤ locked stop 1.12 (raised to |
| 2026-06-08 | Put | 741 | 4 | 0.70 | 0.75 | $20.00 | Trailing stop: premium 0.75 ≤ 15% give-back from peak 0.94 ( |
| 2026-06-08 | Put | 741 | 4 | 0.75 | 1.44 | $276.00 | Trailing stop: premium 1.44 ≤ 15% give-back from peak 1.76 ( |
| 2026-06-08 | Put | 739 | 4 | 0.78 | 0.62 | $-64.00 | Stop loss: premium 0.62 ≤ stop 0.62 (20% loss) |
| 2026-06-08 | Put | 739 | 4 | 0.64 | 0.97 | $132.00 | Trailing stop: premium 0.97 ≤ 15% give-back from peak 1.28 ( |
| 2026-06-09 | Put | 744 | 3 | 1.46 | 1.42 | $-12.00 | Breakeven stop: premium 1.42 ≤ protected stop 1.46 (raised t |
| 2026-06-09 | Put | 744 | 3 | 1.37 | 3.53 | $648.00 | Trailing stop: premium 3.53 ≤ 15% give-back from peak 4.95 ( |
| 2026-06-09 | Put | 741 | 2 | 1.67 | 1.69 | $4.00 | Profit-lock stop: premium 1.69 ≤ locked stop 1.75 (raised to |
| 2026-06-09 | Put | 740 | 3 | 1.54 | 4.73 | $957.00 | Trailing stop: premium 4.73 ≤ 15% give-back from peak 5.82 ( |
| 2026-06-09 | Put | 736 | 1 | 2.57 | 1.97 | $-60.00 | Stop loss: premium 1.97 ≤ stop 2.06 (20% loss) |
| 2026-06-09 | Put | 735 | 3 | 1.63 | 4.04 | $723.00 | Trailing stop: premium 4.04 ≤ 15% give-back from peak 5.20 ( |
| 2026-06-09 | Put | 729 | 2 | 1.96 | 1.96 | $0.00 | Profit-lock stop: premium 1.96 ≤ locked stop 2.06 (raised to |
| 2026-06-09 | Put | 728 | 2 | 2.00 | 1.89 | $-22.00 | Profit-lock stop: premium 1.89 ≤ locked stop 2.10 (raised to |
| 2026-06-09 | Put | 727 | 2 | 2.38 | 2.80 | $84.00 | Trailing stop: premium 2.80 ≤ 15% give-back from peak 3.45 ( |
| 2026-06-09 | Put | 724 | 4 | 1.15 | 2.43 | $512.00 | Trailing stop: premium 2.43 ≤ 15% give-back from peak 3.57 ( |
| 2026-06-09 | Put | 732 | 2 | 2.05 | 1.95 | $-20.00 | Profit-lock stop: premium 1.95 ≤ locked stop 2.15 (raised to |
| 2026-06-09 | Put | 732 | 3 | 1.38 | 1.41 | $9.00 | Profit-lock stop: premium 1.41 ≤ locked stop 1.45 (raised to |
| 2026-06-09 | Put | 733 | 3 | 1.65 | 1.09 | $-168.00 | Stop loss: premium 1.09 ≤ stop 1.32 (20% loss) |
| 2026-06-10 | Put | 734 | 2 | 2.33 | 2.65 | $64.00 | Trailing stop: premium 2.65 ≤ 15% give-back from peak 3.72 ( |
| 2026-06-10 | Put | 732 | 2 | 2.46 | 3.39 | $186.00 | Trailing stop: premium 3.39 ≤ 15% give-back from peak 4.12 ( |
| 2026-06-10 | Put | 729 | 2 | 1.99 | 2.29 | $60.00 | Trailing stop: premium 2.29 ≤ 15% give-back from peak 2.77 ( |
| 2026-06-10 | Put | 729 | 1 | 2.74 | 2.01 | $-73.00 | Stop loss: premium 2.01 ≤ stop 2.19 (20% loss) |
| 2026-06-10 | Put | 730 | 2 | 2.05 | 2.10 | $10.00 | Profit-lock stop: premium 2.10 ≤ locked stop 2.15 (raised to |
| 2026-06-10 | Put | 730 | 2 | 1.92 | 1.95 | $6.00 | Profit-lock stop: premium 1.95 ≤ locked stop 2.02 (raised to |
| 2026-06-10 | Put | 730 | 2 | 2.01 | 1.82 | $-38.00 | Breakeven stop: premium 1.82 ≤ protected stop 2.01 (raised t |
| 2026-06-10 | Put | 729 | 2 | 1.69 | 1.80 | $22.00 | Trailing stop: premium 1.80 ≤ 15% give-back from peak 2.16 ( |
| 2026-06-10 | Put | 729 | 3 | 1.51 | 1.40 | $-33.00 | Profit-lock stop: premium 1.40 ≤ locked stop 1.59 (raised to |
| 2026-06-10 | Put | 729 | 3 | 1.37 | 2.15 | $234.00 | Trailing stop: premium 2.15 ≤ 15% give-back from peak 2.56 ( |
| 2026-06-10 | Put | 727 | 4 | 1.12 | 1.07 | $-20.00 | Profit-lock stop: premium 1.07 ≤ locked stop 1.18 (raised to |
| 2026-06-10 | Put | 727 | 4 | 1.17 | 1.11 | $-24.00 | Profit-lock stop: premium 1.11 ≤ locked stop 1.23 (raised to |
| 2026-06-10 | Put | 727 | 4 | 1.12 | 1.70 | $232.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-11 | Call | 732 | 2 | 2.04 | 1.91 | $-26.00 | Profit-lock stop: premium 1.91 ≤ locked stop 2.14 (raised to |
| 2026-06-11 | Call | 731 | 1 | 2.57 | 1.85 | $-72.00 | Stop loss: premium 1.85 ≤ stop 2.06 (20% loss) |
| 2026-06-11 | Call | 733 | 4 | 0.77 | 1.62 | $340.00 | Trailing stop: premium 1.62 ≤ 15% give-back from peak 2.33 ( |
| 2026-06-11 | Call | 734 | 2 | 1.69 | 1.54 | $-30.00 | Profit-lock stop: premium 1.54 ≤ locked stop 1.77 (raised to |
| 2026-06-11 | Call | 734 | 2 | 1.91 | 2.30 | $78.00 | Trailing stop: premium 2.30 ≤ 15% give-back from peak 3.09 ( |
| 2026-06-11 | Call | 736 | 4 | 1.25 | 0.85 | $-160.00 | Stop loss: premium 0.85 ≤ stop 1.00 (20% loss) |
| 2026-06-12 | Call | 738 | 2 | 2.40 | 3.56 | $232.00 | Trailing stop: premium 3.56 ≤ 15% give-back from peak 4.25 ( |
| 2026-06-12 | Call | 740 | 1 | 2.80 | 2.58 | $-22.00 | Profit-lock stop: premium 2.58 ≤ locked stop 2.94 (raised to |
| 2026-06-12 | Call | 740 | 1 | 2.75 | 1.93 | $-82.00 | Stop loss: premium 1.93 ≤ stop 2.20 (20% loss) |
| 2026-06-12 | Call | 740 | 2 | 1.69 | 3.46 | $354.00 | Trailing stop: premium 3.46 ≤ 15% give-back from peak 4.27 ( |
| 2026-06-12 | Call | 742 | 1 | 2.66 | 2.97 | $31.00 | Trailing stop: premium 2.97 ≤ 15% give-back from peak 3.52 ( |
| 2026-06-12 | Call | 741 | 2 | 2.04 | 1.99 | $-10.00 | Profit-lock stop: premium 1.99 ≤ locked stop 2.14 (raised to |
| 2026-06-12 | Call | 740 | 2 | 1.91 | 1.90 | $-2.00 | Breakeven stop: premium 1.90 ≤ protected stop 1.91 (raised t |
| 2026-06-12 | Call | 740 | 2 | 2.24 | 2.55 | $62.00 | Trailing stop: premium 2.55 ≤ 15% give-back from peak 3.30 ( |
| 2026-06-12 | Call | 742 | 3 | 1.34 | 1.46 | $36.00 | Trailing stop: premium 1.46 ≤ 15% give-back from peak 1.91 ( |
| 2026-06-12 | Call | 742 | 3 | 1.27 | 1.34 | $21.00 | Trailing stop: premium 1.34 ≤ 15% give-back from peak 1.86 ( |
| 2026-06-12 | Call | 742 | 4 | 0.94 | 0.89 | $-20.00 | Profit-lock stop: premium 0.89 ≤ locked stop 0.99 (raised to |
| 2026-06-12 | Call | 742 | 4 | 0.87 | 0.67 | $-80.00 | Breakeven stop: premium 0.67 ≤ protected stop 0.87 (raised t |
| 2026-06-12 | Call | 742 | 4 | 0.66 | 0.77 | $44.00 | Trailing stop: premium 0.77 ≤ 15% give-back from peak 0.94 ( |
| 2026-06-12 | Call | 741 | 4 | 0.46 | 0.78 | $128.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-12 | Call | 741 | 4 | 0.66 | 0.55 | $-44.00 | Hard flatten: past 14:30 CT cutoff |
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
| 2026-06-16 | Put | 751 | 4 | 0.68 | 0.69 | $4.00 | Hard flatten: past 14:30 CT cutoff |
| 2026-06-16 | Put | 750 | 4 | 0.30 | 0.31 | $4.00 | Hard flatten: past 14:30 CT cutoff |

## Rejection breakdown

Why each non-trade bar didn't fire (counts across all evaluated bars):

| Bucket | Count |
| --- | ---: |
| bars_evaluated | 4068 |
| no_chain_quoted | 0 |
| daily_loss_stop | 216 |
| no_setup | 566 |
| blocked_mtf | 2948 |
| blocked_other | 180 |
| review_mtf | 0 |
| review_contract_quality | 1 |
| review_aplus_floor | 0 |
| review_no_contract | 0 |
| review_other | 0 |
| confidence_below_auto | 9 |
| sizing_rejected | 0 |
| cost_exceeds_balance | 0 |

### Top MTF block reasons

- (632) Higher timeframe aligned with Call, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
- (493) Higher timeframe aligned with Call, but lower-timeframe confirmation incomplete (5m pending, 1m pending). Entry blocked until 5m setup + 1m trigger both confirm.
- (380) Higher timeframe aligned with Put, but lower-timeframe confirmation incomplete (5m pending, 1m ok). Entry blocked until 5m setup + 1m trigger both confirm.
- (333) Higher timeframe contradicts Put: 30m trend is bullish, opposing a Put entry. Entry blocked.
- (292) Higher timeframe contradicts Call: 30m trend is bearish, opposing a Call entry. Entry blocked.
