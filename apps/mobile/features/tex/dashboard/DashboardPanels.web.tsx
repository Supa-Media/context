/**
 * The Tex dashboard's detail cards (tex.lc/admin, `./TexDashboard.web`):
 * models, volume, tasks and tools, folded under "Everything else", and the
 * card and chart pieces the other sections draw with. Every figure comes from
 * `texReport` through `./model`; none of them can hold a word anybody wrote.
 */

import type { ReactNode } from "react";
import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";
import { KIND_LABELS, formatMicroUsd, formatSeconds, frustrationByTask, modelLabel, sparkPaths, type TexReport } from "./model";

export function Card({ title, meta, children, testID, wide }: { title: string; meta?: string; children: ReactNode; testID: string; wide?: boolean }) {
  return (
    <section className="td-card" data-testid={testID} style={wide ? { flexBasis: "100%" } : undefined}>
      <div className="td-card-head">
        <h2 className="td-h2">{title}</h2>
        {meta ? <span className="td-meta">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Bar({ label, share, value, tone }: { label: string; share: number; value: string; tone?: "warm" | "crit" }) {
  return (
    <div className="td-bar">
      <span>{label}</span>
      <div className={`td-bar-track${tone === "warm" ? " warm" : ""}`}>
        <div className={`td-bar-fill${tone ? ` ${tone}` : ""}`} style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} />
      </div>
      <span className="td-bar-value num">{value}</span>
    </div>
  );
}

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function AreaChart({ values, color, fill, label }: { values: number[]; color: string; fill: string; label: string }) {
  const paths = sparkPaths(values, 600, 160);
  return (
    <svg className="td-chart" viewBox="0 0 600 160" preserveAspectRatio="none" style={{ height: 160 }} role="img" aria-label={label}>
      {[40, 80, 120].map((y) => (
        <line key={y} x1={0} y1={y} x2={600} y2={y} stroke={C.line} strokeDasharray="4 4" />
      ))}
      <path d={paths.area} fill={fill} fillOpacity={0.6} />
      <path d={paths.line} fill="none" stroke={color} strokeWidth={3} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Axis({ days }: { days: readonly string[] }) {
  if (days.length === 0) return null;
  return (
    <div className="td-axis">
      <span>{shortDay(days[0])}</span>
      <span>{shortDay(days[days.length - 1])}</span>
    </div>
  );
}

export function ModelsPanel({ report }: { report: TexReport }) {
  const { performance, turns } = report;
  const spendOf = (model: string) => turns.models.find((m) => m.model === model)?.costMicroUsd ?? 0;
  const cacheOf = (model: string) => {
    const m = turns.models.find((row) => row.model === model);
    return m && m.inputTokens + m.cacheReadTokens > 0 ? m.cacheReadTokens / (m.inputTokens + m.cacheReadTokens) : null;
  };
  const { time, router } = performance;
  const spent = time.modelMs + time.toolMs;
  const share = (ms: number) => (time.totalMs === 0 ? 0 : ms / time.totalMs);
  const stuck = turns.total === 0 ? 0 : (turns.exhausted + turns.failed) / turns.total;
  return (
    <Card
      title="Model performance"
      meta={router.picks === 0 ? "per model, from each turn's trace" : `Router sent ${Math.round((router.think / router.picks) * 100)}% to thinking${router.confidence === null ? "" : ` · sure ${router.confidence.toFixed(2)} on average`}`}
      testID="tex-dashboard-models"
    >
      {performance.models.length === 0 ? (
        <p className="td-empty">No model rounds in this window.</p>
      ) : (
        <div className="td-models">
          {performance.models.slice(0, 6).map((m) => {
            const cache = cacheOf(m.model);
            const pct = (n: number) => (m.rounds === 0 ? "0%" : `${Math.round((n / m.rounds) * 100)}%`);
            return (
              <div key={m.model} className="td-model">
                <div>
                  <div className="td-model-name">{modelLabel(m.model)}</div>
                  <div className="td-model-role">{m.model}</div>
                </div>
                <div className="td-stats">
                  <div className="td-stat"><span>Rounds</span><span className="num">{m.rounds.toLocaleString("en-US")}</span></div>
                  <div className="td-stat"><span>Spend</span><span className="num">{formatMicroUsd(spendOf(m.model))}</span></div>
                  <div className="td-stat"><span>Typical round</span><span className="num">{formatSeconds(m.p50)}</span></div>
                  <div className="td-stat"><span>Slowest 1 in 20</span><span className="num">{formatSeconds(m.p95)}</span></div>
                </div>
                <div className="td-lines">
                  <div><span>Errors / retried</span><span className={`num${m.failed > 0 ? " bad" : ""}`}>{pct(m.failed)} / {pct(m.retried)}</span></div>
                  <div><span>Ran out of room</span><span className={`num${m.cut > 0 ? " bad" : ""}`}>{pct(m.cut)}</span></div>
                  <div><span>Fell back onto it</span><span className="num">{m.fallbacks}</span></div>
                  <div><span>Cache hit</span><span className="num">{cache === null ? "—" : `${Math.round(cache * 100)}%`}</span></div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="td-row">
        <div style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="td-small-h">Typical answer time per day</span>
          <AreaChart values={performance.daily.map((d) => d.p50)} color={C.blue} fill={C.blueWash} label="Typical answer time per day" />
          <Axis days={turns.byDay.map((d) => d.day)} />
        </div>
        <div style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="td-small-h">Where a turn's time goes</span>
          <div className="td-split" aria-hidden>
            <div style={{ width: `${share(time.modelMs) * 100}%`, background: C.blue }} />
            <div style={{ width: `${share(time.toolMs) * 100}%`, background: C.ochre }} />
            <div style={{ width: `${share(Math.max(0, time.totalMs - spent)) * 100}%`, background: C.hair }} />
          </div>
          <div className="td-legend">
            <span><span className="td-dot" style={{ background: C.blue }} />Model thinking {Math.round(share(time.modelMs) * 100)}%</span>
            <span><span className="td-dot" style={{ background: C.ochre }} />Tools {Math.round(share(time.toolMs) * 100)}%</span>
            <span><span className="td-dot" style={{ background: C.hair }} />Everything else {Math.round(share(Math.max(0, time.totalMs - spent)) * 100)}%</span>
          </div>
          <span className="td-meta">
            {performance.wait.turns === 0 ? (
              <>Waiting before Tex starts: not timed yet</>
            ) : (
              <>
                Waiting before Tex starts (pause, decision, queue): typical <b className="num">{formatSeconds(performance.wait.p50)}</b>, slowest 1 in 20{" "}
                <b className="num">{formatSeconds(performance.wait.p95)}</b>, longest <b className="num">{formatSeconds(performance.wait.max)}</b> over {performance.wait.turns} timed turns
              </>
            )}
          </span>
          <span className="td-meta">
            Stuck or failed turns: <b className="num">{(stuck * 100).toFixed(1)}%</b> ({turns.exhausted} ran out of steps, {turns.failed} failed)
          </span>
        </div>
      </div>
    </Card>
  );
}

export function VolumePanel({ report }: { report: TexReport }) {
  const { turns } = report;
  const kinds = (Object.entries(turns.byKind) as [string, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return (
    <Card title="Texts processed" meta={`${turns.total.toLocaleString("en-US")} turns in ${report.turnDays} days`} testID="tex-dashboard-volume">
      <AreaChart values={turns.byDay.map((d) => d.turns)} color={C.blue} fill={C.blueWash} label="Turns per day" />
      <Axis days={turns.byDay.map((d) => d.day)} />
      <div className="td-sep">
        <span className="td-small-h">Where they came from</span>
        <div className="td-bars">
          {kinds.map(([kind, n]) => (
            <Bar key={kind} label={KIND_LABELS[kind] ?? kind} share={turns.total === 0 ? 0 : n / turns.total} value={n.toLocaleString("en-US")} />
          ))}
        </div>
      </div>
    </Card>
  );
}

export function TasksPanel({ report, onTask }: { report: TexReport; onTask: (task: string) => void }) {
  const tasks = frustrationByTask(report.reviews);
  return (
    <Card title="Tasks" meta="what conversations were for · tap one to explore it" testID="tex-dashboard-tasks">
      {tasks.length === 0 ? (
        <p className="td-empty">No scored conversations yet.</p>
      ) : (
        <div className="td-tasks">
          {tasks.map((task) => (
            <button key={task.task} type="button" className="td-task" onClick={() => onTask(task.task)} data-testid={`tex-dashboard-task-${task.task}`}>
              <b>{task.label}</b>
              <span className="big num">{task.n}</span>
              <span className={`meta${task.share >= 0.5 ? " crit" : ""}`}>{Math.round(task.share * 100)}% frustrated</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

export function ToolsPanel({ report }: { report: TexReport }) {
  const tools = report.turns.tools;
  const speed = new Map(report.performance.tools.map((t) => [t.tool, t.p50]));
  return (
    <Card title="Tool use" meta="calls · failed · typical time" testID="tex-dashboard-tools">
      {tools.length === 0 ? (
        <p className="td-empty">No tool calls in this window.</p>
      ) : (
        <div className="td-bars">
          {tools.slice(0, 10).map((tool) => (
            <Bar
              key={tool.tool}
              label={tool.tool}
              share={tool.calls / tools[0].calls}
              tone={tool.failed / tool.calls >= 0.2 ? "crit" : undefined}
              value={`${tool.calls}${tool.failed > 0 ? ` · ${Math.round((tool.failed / tool.calls) * 100)}% failed` : ""} · ${formatSeconds(speed.get(tool.tool) ?? 0)}`}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
