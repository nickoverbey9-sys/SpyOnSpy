import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

// ─────────────────────────────────────────────────────────────────────────────
// BotCockpit — the SpyOnSpy mockup layout, wired to the REAL bot API.
//
// This ports the whiteboard mockup (Current SPY · Account · Automate · Readiness
// · Automation Activity · Live Signals · SPY chart · Live Activity · Daily
// Scorecard · Source Scoreboard · Entry Guards) onto live data from the
// /api/bot/* endpoints and the live `snapshot` (SPY price + candles).
//
// Styling is a faithful copy of the mockup's CSS, scoped under `.cockpit` so its
// color variables never leak into the rest of the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = 5000;

function useBot<T = any>(path: string) {
  return useQuery<T>({ queryKey: [path], refetchInterval: POLL_MS });
}

// ── formatting helpers ───────────────────────────────────────────────────────
const fmtUsd = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pnlColor = (n: number) =>
  n > 0 ? "var(--up)" : n < 0 ? "var(--down)" : "var(--ink-dim)";
const num = (v: any, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const etTime = (iso?: string | null) => {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
};

const EV_COLORS: Record<string, string> = {
  ENTRY: "var(--accent)",
  EXIT: "var(--up)",
  SIGNAL: "var(--ink)",
  GUARD: "var(--warn)",
  MARK: "var(--ink-dim)",
  LIFECYCLE: "var(--accent)",
};

// ── panel shell ──────────────────────────────────────────────────────────────
function Panel({
  label,
  children,
  flush = false,
}: {
  label: string;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="ck-panel">
      <div className="ck-panel-rail" />
      <header className="ck-panel-head">{label}</header>
      <div className={flush ? "ck-panel-body flush" : "ck-panel-body"}>{children}</div>
    </section>
  );
}

// ── Current SPY ──────────────────────────────────────────────────────────────
function CurrentSpy({ snapshot }: { snapshot: any }) {
  const spy = snapshot?.spy;
  const last = num(spy?.price);
  const change = num(spy?.change);
  const changePct = num(spy?.changePercent);
  const up = change >= 0;
  return (
    <Panel label="Current SPY">
      <div className="ck-spy">
        <div className="ck-spy-price">${last.toFixed(2)}</div>
        <div className="ck-spy-chg" style={{ color: up ? "var(--up)" : "var(--down)" }}>
          {up ? "▲" : "▼"} {Math.abs(change).toFixed(2)} ({Math.abs(changePct).toFixed(2)}%)
        </div>
        <div className="ck-spy-meta">
          {spy?.session ? `${spy.session} · ` : ""}Last update {etTime(snapshot?.timestamp)} ET
        </div>
      </div>
    </Panel>
  );
}

// ── Account Balance & P&L ────────────────────────────────────────────────────
function AccountBalance({ data }: { data: any }) {
  const a = data?.account ?? {};
  const equity = num(a.totalEquity);
  const dayPnl = num(a.dayPnl ?? data?.dailyLoss?.netRealizedPnlToday);
  const openPnl = num(data?.botPnl?.unrealizedPnl);
  const dayPct = equity > 0 ? (dayPnl / equity) * 100 : 0;
  const dayUp = dayPnl >= 0;
  return (
    <Panel label="Account Balance & P&L">
      <div className="ck-acct">
        <div className="ck-acct-equity">
          ${equity.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </div>
        <div className="ck-acct-day" style={{ color: dayUp ? "var(--up)" : "var(--down)" }}>
          {dayUp ? "+" : ""}
          {fmtUsd(dayPnl)} ({dayUp ? "+" : ""}
          {dayPct.toFixed(2)}%) today
        </div>
        <div className="ck-acct-grid">
          <div>
            <span className="ck-mini-k">Buying power</span>
            <span className="ck-mini-v">{fmtUsd(num(a.buyingPower))}</span>
          </div>
          <div>
            <span className="ck-mini-k">Cash</span>
            <span className="ck-mini-v">{fmtUsd(num(a.cash))}</span>
          </div>
          <div>
            <span className="ck-mini-k">Open P&L</span>
            <span className="ck-mini-v" style={{ color: pnlColor(openPnl) }}>
              {openPnl >= 0 ? "+" : ""}
              {fmtUsd(openPnl)}
            </span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ── Automate — Current Trades ────────────────────────────────────────────────
function AutomateTrades({ positions, auto }: { positions: any; auto: any }) {
  const open: any[] = positions?.open ?? [];
  const running = !!auto?.running;
  return (
    <Panel label="Automate — Current Trades" flush>
      <div className="ck-arm-bar">
        <span className={`ck-arm-dot ${running ? "on" : "off"}`} />
        <span className="ck-arm-text">{running ? "LOOP RUNNING" : "HALTED"}</span>
        <span className="ck-arm-count">{open.length} open</span>
      </div>
      <div className="ck-trades">
        {open.length === 0 ? (
          <div className="ck-empty">No open positions</div>
        ) : (
          open.map((t, i) => {
            const contract = t.optionSymbol ?? t.contract ?? t.symbol ?? "—";
            const entry = num(t.entryPremium ?? t.entry);
            const mark = num(t.currentMark ?? t.mark ?? t.lastMark);
            const qty = num(t.contracts ?? t.qty);
            const pnl = num(t.unrealizedPnl ?? t.pnl);
            return (
              <div className="ck-trade" key={t.id ?? i}>
                <div className="ck-trade-top">
                  <span className="ck-trade-contract">{contract}</span>
                  <span className="ck-trade-pnl" style={{ color: pnlColor(pnl) }}>
                    {pnl >= 0 ? "+" : ""}
                    {fmtUsd(pnl)}
                  </span>
                </div>
                <div className="ck-trade-bot">
                  <span>
                    {qty} @ {entry.toFixed(2)} → {mark.toFixed(2)}
                  </span>
                  <span className="ck-trade-stop">{t.side ?? ""}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ── Autotrade Readiness ──────────────────────────────────────────────────────
function AutotradeReadiness({ status }: { status: any }) {
  const r = status?.autoTradeReadiness ?? {};
  const checks: any[] = r.checks ?? [];
  const ready = !!r.autoReady;
  const passed = checks.filter((c) => c.ok).length;
  return (
    <Panel label="Autotrade Readiness" flush>
      <div className={`ck-ready-verdict ${ready ? "ok" : "no"}`}>
        <span className="ck-ready-led" />
        <span className="ck-ready-text">{ready ? "READY" : "NOT READY"}</span>
        <span className="ck-ready-count">
          {passed}/{checks.length} cleared
        </span>
      </div>
      <div className="ck-ready-list">
        {checks.map((c, i) => (
          <div className="ck-ready-row" key={c.label ?? i}>
            <span className={`ck-ck ${c.ok ? "pass" : "fail"}`}>{c.ok ? "✓" : "✕"}</span>
            <span className="ck-ready-name">{c.label}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── Automation Activity (health) ─────────────────────────────────────────────
function AutomationActivity({ auto }: { auto: any }) {
  const running = !!auto?.running;
  const rows: Array<[string, string, string?]> = [
    ["Loop", running ? "Running" : "Stopped", running ? "var(--up)" : "var(--down)"],
    ["Mode", auto?.observeOnly ? "Observe-only" : auto?.enabled ? "Armed" : "Paper"],
    ["Last tick", `${etTime(auto?.lastTick)} ET`],
    ["Next tick", `${etTime(auto?.nextTickApprox)} ET`],
    ["Managed", String((auto?.managedPositions ?? []).length)],
  ];
  return (
    <Panel label="Automation Activity" flush>
      <div className="ck-health-bar">
        <span className={`ck-pulse ${running ? "on" : "off"}`} />
        <span className="ck-health-state">{running ? "LIVE LOOP" : "HALTED"}</span>
      </div>
      <div className="ck-health-list">
        {rows.map(([k, v, c]) => (
          <div className="ck-health-row" key={k}>
            <span className="ck-health-k">{k}</span>
            <span className="ck-health-v" style={c ? { color: c } : {}}>
              {v}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── Live Signals ─────────────────────────────────────────────────────────────
function LiveSignals({ data }: { data: any }) {
  const signals: any[] = data?.signals ?? [];
  return (
    <Panel label="Live Trade Signals" flush>
      <div className="ck-sig-list">
        {signals.length === 0 ? (
          <div className="ck-empty">No live signals</div>
        ) : (
          signals.map((s, i) => {
            const dir = s.bias === "Call" ? "long" : "short";
            const strength = num(s.confidence);
            return (
              <div className="ck-sig-row" key={s.id ?? i}>
                <span className="ck-sig-time">{etTime(s.generatedAt).slice(0, 5)}</span>
                <span className={`ck-sig-dir ${dir}`}>
                  {dir === "long" ? "▲ LONG" : "▼ SHORT"}
                </span>
                <span className="ck-sig-source">{s.setup?.title ?? "—"}</span>
                <div className="ck-sig-strength">
                  <div
                    className="ck-sig-bar"
                    style={{
                      width: `${strength}%`,
                      background: strength >= 60 ? "var(--up)" : "var(--ink-faint)",
                    }}
                  />
                </div>
                <span className="ck-sig-status">{(s.status ?? "").toLowerCase()}</span>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ── SPY 5m candlestick chart ─────────────────────────────────────────────────
function SpyChart({ snapshot }: { snapshot: any }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const h = 300;
  const padL = 8,
    padR = 52,
    padT = 14,
    padB = 22;

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      setW(Math.max(360, entries[0].contentRect.width));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const raw: any[] = snapshot?.spy?.candles5m ?? [];
  const candles = raw
    .map((c) => ({
      t: c.label ?? "",
      o: num(c.open),
      h: num(c.high),
      l: num(c.low),
      c: num(c.close),
    }))
    .filter((c) => c.h > 0);

  if (candles.length < 2) {
    return (
      <Panel label="SPY · 5m" flush>
        <div className="ck-empty" style={{ padding: 32 }}>
          Waiting for candles…
        </div>
      </Panel>
    );
  }

  const lo = Math.min(...candles.map((c) => c.l));
  const hi = Math.max(...candles.map((c) => c.h));
  const pad = (hi - lo) * 0.08 || 0.5;
  const yMin = lo - pad,
    yMax = hi + pad;

  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const n = candles.length;
  const step = plotW / n;
  const bw = Math.max(2, step * 0.62);

  const x = (i: number) => padL + step * i + step / 2;
  const y = (price: number) => padT + (1 - (price - yMin) / (yMax - yMin)) * plotH;

  const last = candles[candles.length - 1];
  const up = last.c >= candles[0].o;

  const ticks = 4;
  const tickVals = Array.from({ length: ticks + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / ticks);

  return (
    <Panel label="SPY · 5m" flush>
      <div className="ck-chart-head">
        <span className="ck-chart-last">${last.c.toFixed(2)}</span>
        <span className="ck-chart-sub" style={{ color: up ? "var(--up)" : "var(--down)" }}>
          {up ? "▲" : "▼"} session {up ? "+" : ""}
          {(last.c - candles[0].o).toFixed(2)}
        </span>
        <span className="ck-chart-rth">RTH · 5-min</span>
      </div>
      <div className="ck-chart-wrap" ref={wrapRef}>
        <svg width={w} height={h} className="ck-chart-svg" role="img" aria-label="SPY 5 minute candlestick chart">
          {tickVals.map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={padL + plotW} y1={y(v)} y2={y(v)} className="ck-grid-line" />
              <text x={padL + plotW + 6} y={y(v) + 3} className="ck-axis-text">
                {v.toFixed(2)}
              </text>
            </g>
          ))}
          {candles.map((c, i) => {
            const green = c.c >= c.o;
            const col = green ? "var(--up)" : "var(--down)";
            const yO = y(c.o),
              yC = y(c.c);
            const top = Math.min(yO, yC);
            const bodyH = Math.max(1, Math.abs(yC - yO));
            return (
              <g key={i}>
                <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" />
                <rect x={x(i) - bw / 2} y={top} width={bw} height={bodyH} fill={col} opacity={green ? 0.9 : 0.85} />
              </g>
            );
          })}
          <line x1={padL} x2={padL + plotW} y1={y(last.c)} y2={y(last.c)} className="ck-last-line" />
        </svg>
      </div>
    </Panel>
  );
}

// ── Live Activity / Trade Data ───────────────────────────────────────────────
function LiveActivity({ auto, fills }: { auto: any; fills: any }) {
  const events: any[] = auto?.recentEvents ?? [];
  const fillRows: any[] = fills?.fills ?? [];
  const rows = [
    ...fillRows.map((f) => ({
      t: etTime(f.at ?? f.timestamp),
      ev: (f.action ?? "FILL").toUpperCase(),
      msg: f.summary ?? f.message ?? `${f.side ?? ""} ${f.optionSymbol ?? ""}`,
    })),
    ...events.map((e) => ({
      t: etTime(e.at),
      ev: (e.kind ?? "EVENT").toUpperCase(),
      msg: e.message ?? "",
    })),
  ].slice(0, 12);
  return (
    <Panel label="Live Activity / Trade Data" flush>
      <div className="ck-feed">
        {rows.length === 0 ? (
          <div className="ck-empty" style={{ padding: 16 }}>
            No activity yet
          </div>
        ) : (
          rows.map((r, i) => (
            <div className="ck-feed-row" key={i}>
              <span className="ck-feed-time">{r.t}</span>
              <span className="ck-feed-tag" style={{ color: EV_COLORS[r.ev] || "var(--ink)" }}>
                {r.ev}
              </span>
              <span className="ck-feed-msg">{r.msg}</span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

// ── Daily Scorecard ──────────────────────────────────────────────────────────
function DailyScorecard({ data }: { data: any }) {
  const s = data?.scorecard ?? {};
  const realized = num(s.realizedPnlToday);
  const unreal = num(s.unrealizedPnl);
  const worst = num(s.worstTrade);
  const stats: Array<[string, any, number?]> = [
    ["Trades", num(s.tradeCount)],
    ["Wins", num(s.wins)],
    ["Losses", num(s.losses)],
    ["Win rate", `${num(s.winRate)}%`],
    ["Realized", fmtUsd(realized), realized],
    ["Unrealized", fmtUsd(unreal), unreal],
    ["Worst", fmtUsd(worst), worst],
    ["Contracts", num(s.contractsTraded)],
  ];
  return (
    <Panel label="Daily Scorecard">
      <div className="ck-score">
        {stats.map(([k, v, color]) => (
          <div className="ck-score-cell" key={k}>
            <div className="ck-stat-k">{k}</div>
            <div className="ck-stat-v" style={color !== undefined ? { color: pnlColor(color) } : {}}>
              {v}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── Setup Source Scoreboard ──────────────────────────────────────────────────
function SourceScoreboard({ data }: { data: any }) {
  const rows: any[] = data?.scorecard?.rows ?? [];
  const max = Math.max(1, ...rows.map((r) => Math.abs(num(r.netPnl))));
  return (
    <Panel label="Setup Source Scoreboard" flush>
      <div className="ck-board">
        {rows.length === 0 ? (
          <div className="ck-empty" style={{ padding: 16 }}>
            No source data yet
          </div>
        ) : (
          rows.map((r) => {
            const pnl = num(r.netPnl);
            return (
              <div className="ck-board-row" key={r.source}>
                <span className="ck-board-name">{r.source}</span>
                <span className="ck-board-meta">
                  {num(r.trades)}t · {num(r.winRate)}%
                </span>
                <div className="ck-board-bar-track">
                  <div
                    className="ck-board-bar"
                    style={{
                      width: `${(Math.abs(pnl) / max) * 100}%`,
                      background: pnl >= 0 ? "var(--up)" : "var(--down)",
                    }}
                  />
                </div>
                <span className="ck-board-pnl" style={{ color: pnlColor(pnl) }}>
                  {pnl >= 0 ? "+" : ""}
                  {fmtUsd(pnl)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ── Entry Guards ─────────────────────────────────────────────────────────────
function EntryGuards({ status }: { status: any }) {
  const g = status?.entryGuards ?? {};
  const tg = g.timeGuard ?? {};
  const fx = status?.flattenExit ?? {};
  const daily = status?.daily ?? {};
  const rows = [
    { name: "Entry allowed", state: g.allowed ? "pass" : "block", detail: g.reason ?? "" },
    {
      name: "Time guardrail",
      state: tg.blocked ? "block" : "pass",
      detail: tg.blocked ? "blackout window" : "RTH window OK",
    },
    {
      name: "High-impact news",
      state: g.nearHighImpactNews ? "block" : "pass",
      detail: g.nearHighImpactNews ? "near event" : "clear",
    },
    {
      name: "Flatten cutoff",
      state: fx.pastFlatten ? "block" : "pass",
      detail: `flatten ${fx.flattenCT ?? "--"}`,
    },
    {
      name: "Daily loss cap",
      state: "pass",
      detail: `${fmtUsd(num(daily.dailyLossUsed))} / ${fmtUsd(num(daily.maxDailyLoss))}`,
    },
    {
      name: "Kill switch",
      state: status?.killSwitchActive ? "block" : "pass",
      detail: status?.killSwitchActive ? "ACTIVE" : "disarmed",
    },
  ];
  return (
    <Panel label="Entry Guards" flush>
      <div className="ck-guards">
        {rows.map((gr) => (
          <div className="ck-guard" key={gr.name}>
            <span className={`ck-guard-led ${gr.state}`} />
            <span className="ck-guard-name">{gr.name}</span>
            <span className="ck-guard-detail">{gr.detail}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── cockpit root ─────────────────────────────────────────────────────────────
export default function BotCockpit({ snapshot }: { snapshot: any }) {
  const account = useBot("/api/bot/account");
  const positions = useBot("/api/bot/positions");
  const status = useBot("/api/bot/status");
  const automation = useBot("/api/bot/automation/status");
  const signals = useBot("/api/bot/signals");
  const fills = useBot("/api/bot/fills");
  const scorecard = useBot("/api/bot/scorecard");
  const bySource = useBot("/api/bot/scorecard/by-source");

  return (
    <div className="cockpit">
      <style>{CSS}</style>
      <div className="ck-grid">
        <div className="ck-row ck-row-top">
          <CurrentSpy snapshot={snapshot} />
          <AccountBalance data={account.data} />
          <AutomateTrades positions={positions.data} auto={automation.data} />
        </div>
        <div className="ck-row ck-row-live">
          <SpyChart snapshot={snapshot} />
          <LiveActivity auto={automation.data} fills={fills.data} />
        </div>
        <div className="ck-row ck-row-trips">
          <AutotradeReadiness status={status.data} />
          <AutomationActivity auto={automation.data} />
          <LiveSignals data={signals.data} />
        </div>
        <div className="ck-row ck-row-score">
          <DailyScorecard data={scorecard.data} />
        </div>
        <div className="ck-row ck-row-bottom">
          <SourceScoreboard data={bySource.data} />
          <EntryGuards status={status.data} />
        </div>
      </div>
    </div>
  );
}

// ── styles (scoped to .cockpit; ported from the mockup) ──────────────────────
const CSS = `
.cockpit{
  --bg:#0b0e13; --bg-2:#11161e; --panel:#141a24; --panel-2:#0f141c;
  --line:#222c3a; --line-soft:#1a2230;
  --ink:#e7edf5; --ink-dim:#8a97a8; --ink-faint:#5b6675;
  --accent:#4ea3ff; --up:#3ad29f; --down:#ff5d6c; --warn:#f5b740;
  --mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  color:var(--ink); font-family:var(--mono);
}
.cockpit *{box-sizing:border-box}
.ck-grid{display:flex;flex-direction:column;gap:18px}
.ck-row{display:grid;gap:18px}
.ck-row-top{grid-template-columns:0.85fr 0.85fr 1.3fr}
.ck-row-trips{grid-template-columns:1fr 1fr 1fr}
.ck-row-live{grid-template-columns:1.55fr 1fr}
.ck-row-score{grid-template-columns:1fr}
.ck-row-bottom{grid-template-columns:1fr 1fr}

.ck-panel{
  position:relative;background:linear-gradient(180deg,var(--panel),var(--panel-2));
  border:1px solid var(--line);border-radius:12px;overflow:hidden;
  display:flex;flex-direction:column;min-height:0;
}
.ck-panel-rail{position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--accent);opacity:.55}
.ck-panel-head{
  padding:11px 16px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--ink-dim);border-bottom:1px solid var(--line-soft);
}
.ck-panel-body{padding:16px}
.ck-panel-body.flush{padding:0}
.ck-empty{padding:20px 16px;color:var(--ink-faint);font-size:12px;text-align:center}

.ck-spy{display:flex;flex-direction:column;gap:6px;padding:6px 2px}
.ck-spy-price{font-size:38px;font-weight:700;letter-spacing:-.02em;line-height:1}
.ck-spy-chg{font-size:14px;font-weight:600}
.ck-spy-meta{font-size:11px;color:var(--ink-faint);margin-top:4px}

.ck-arm-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line-soft);background:var(--panel-2)}
.ck-arm-dot{width:9px;height:9px;border-radius:50%}
.ck-arm-dot.on{background:var(--up);box-shadow:0 0 10px var(--up)}
.ck-arm-dot.off{background:var(--ink-faint)}
.ck-arm-text{font-size:12px;font-weight:700;letter-spacing:.12em}
.ck-arm-count{margin-left:auto;font-size:11px;color:var(--ink-dim)}
.ck-trades{display:flex;flex-direction:column}
.ck-trade{padding:12px 16px;border-bottom:1px solid var(--line-soft)}
.ck-trade:last-child{border-bottom:none}
.ck-trade-top{display:flex;justify-content:space-between;align-items:baseline}
.ck-trade-contract{font-size:13px;font-weight:600}
.ck-trade-pnl{font-size:13px;font-weight:700}
.ck-trade-bot{display:flex;justify-content:space-between;margin-top:5px;font-size:11px;color:var(--ink-dim)}
.ck-trade-stop{color:var(--ink-faint)}

.ck-acct{display:flex;flex-direction:column;gap:4px;padding:4px 2px}
.ck-acct-equity{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1}
.ck-acct-day{font-size:13px;font-weight:600;margin-bottom:6px}
.ck-acct-grid{display:flex;flex-direction:column;gap:7px;border-top:1px solid var(--line-soft);padding-top:10px}
.ck-acct-grid>div{display:flex;justify-content:space-between;align-items:baseline}
.ck-mini-k{font-size:11px;color:var(--ink-faint)}
.ck-mini-v{font-size:13px;font-weight:600}

.ck-ready-verdict{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line-soft)}
.ck-ready-verdict.ok{background:rgba(58,210,159,.08)}
.ck-ready-verdict.no{background:rgba(245,183,64,.08)}
.ck-ready-led{width:9px;height:9px;border-radius:50%}
.ck-ready-verdict.ok .ck-ready-led{background:var(--up);box-shadow:0 0 10px var(--up)}
.ck-ready-verdict.no .ck-ready-led{background:var(--warn);box-shadow:0 0 10px var(--warn)}
.ck-ready-text{font-size:12px;font-weight:700;letter-spacing:.1em}
.ck-ready-count{margin-left:auto;font-size:11px;color:var(--ink-dim)}
.ck-ready-list{display:flex;flex-direction:column}
.ck-ready-row{display:grid;grid-template-columns:18px 1fr;gap:10px;align-items:center;padding:9px 16px;border-bottom:1px solid var(--line-soft);font-size:12px}
.ck-ready-row:last-child{border-bottom:none}
.ck-ck{font-weight:700;text-align:center;font-size:12px}
.ck-ck.pass{color:var(--up)}
.ck-ck.fail{color:var(--down)}
.ck-ready-name{color:var(--ink-dim)}

.ck-health-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line-soft);background:var(--panel-2)}
.ck-pulse{width:9px;height:9px;border-radius:50%}
.ck-pulse.on{background:var(--up);animation:ckpulse 2s infinite}
.ck-pulse.off{background:var(--ink-faint)}
@keyframes ckpulse{0%{box-shadow:0 0 0 0 rgba(58,210,159,.5)}70%{box-shadow:0 0 0 8px rgba(58,210,159,0)}100%{box-shadow:0 0 0 0 rgba(58,210,159,0)}}
.ck-health-state{font-size:12px;font-weight:700;letter-spacing:.12em}
.ck-health-list{display:flex;flex-direction:column}
.ck-health-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:9px 16px;border-bottom:1px solid var(--line-soft);font-size:12px}
.ck-health-row:last-child{border-bottom:none}
.ck-health-k{color:var(--ink-faint)}
.ck-health-v{font-weight:600;text-align:right}

.ck-sig-list{display:flex;flex-direction:column}
.ck-sig-row{display:grid;grid-template-columns:44px 70px 1fr 54px 80px;gap:10px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--line-soft);font-size:11px}
.ck-sig-row:last-child{border-bottom:none}
.ck-sig-time{color:var(--ink-faint)}
.ck-sig-dir{font-weight:700;font-size:10px;letter-spacing:.04em}
.ck-sig-dir.long{color:var(--up)}
.ck-sig-dir.short{color:var(--down)}
.ck-sig-source{color:var(--ink-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ck-sig-strength{height:5px;background:var(--panel-2);border-radius:3px;overflow:hidden}
.ck-sig-bar{height:100%;border-radius:3px}
.ck-sig-status{text-align:right;color:var(--ink-faint);font-size:10px}

.ck-score{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.ck-score-cell{padding:4px 0}
.ck-stat-k{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}
.ck-stat-v{font-size:18px;font-weight:700;margin-top:2px}
@media(max-width:720px){.ck-score{grid-template-columns:repeat(2,1fr)}}

.ck-chart-head{display:flex;align-items:baseline;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line-soft);background:var(--panel-2)}
.ck-chart-last{font-size:20px;font-weight:700;letter-spacing:-.01em}
.ck-chart-sub{font-size:12px;font-weight:600}
.ck-chart-rth{margin-left:auto;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-faint)}
.ck-chart-wrap{width:100%}
.ck-chart-svg{display:block;width:100%}
.ck-grid-line{stroke:var(--line-soft);stroke-width:1}
.ck-axis-text{fill:var(--ink-faint);font-size:9px;font-family:var(--mono)}
.ck-last-line{stroke:var(--accent);stroke-width:1;stroke-dasharray:3 3;opacity:.5}

.ck-feed{max-height:336px;overflow:auto}
.ck-feed-row{display:grid;grid-template-columns:72px 80px 1fr;gap:12px;align-items:baseline;padding:10px 16px;border-bottom:1px solid var(--line-soft);font-size:12px}
.ck-feed-row:last-child{border-bottom:none}
.ck-feed-time{color:var(--ink-faint)}
.ck-feed-tag{font-weight:700;font-size:10px;letter-spacing:.08em}
.ck-feed-msg{color:var(--ink-dim)}

.ck-board{display:flex;flex-direction:column}
.ck-board-row{display:grid;grid-template-columns:150px 64px 1fr 70px;gap:12px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--line-soft);font-size:12px}
.ck-board-row:last-child{border-bottom:none}
.ck-board-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ck-board-meta{color:var(--ink-faint);font-size:11px}
.ck-board-bar-track{height:6px;background:var(--panel-2);border-radius:4px;overflow:hidden}
.ck-board-bar{height:100%;border-radius:4px}
.ck-board-pnl{text-align:right;font-weight:700}

.ck-guards{display:flex;flex-direction:column}
.ck-guard{display:grid;grid-template-columns:14px 1fr auto;gap:12px;align-items:center;padding:11px 16px;border-bottom:1px solid var(--line-soft);font-size:12px}
.ck-guard:last-child{border-bottom:none}
.ck-guard-led{width:8px;height:8px;border-radius:50%}
.ck-guard-led.pass{background:var(--up);box-shadow:0 0 8px var(--up)}
.ck-guard-led.block{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.ck-guard-led.fail{background:var(--down);box-shadow:0 0 8px var(--down)}
.ck-guard-name{font-weight:600}
.ck-guard-detail{color:var(--ink-faint);font-size:11px;text-align:right}

@media(max-width:1080px){
  .ck-row-top{grid-template-columns:1fr 1fr}
  .ck-row-trips{grid-template-columns:1fr 1fr}
  .ck-row-live{grid-template-columns:1fr}
}
@media(max-width:720px){
  .ck-row-top,.ck-row-trips,.ck-row-bottom{grid-template-columns:1fr}
}
`;
