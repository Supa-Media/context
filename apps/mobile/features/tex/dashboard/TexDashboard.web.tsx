/**
 * tex.lc/admin: the Tex dashboard, its own page (the owner, 2026-10-24: "an
 * entirely new page, not another tab within the admin page"), drawn from the
 * approved concept: a dark hero with the headline numbers, how conversations
 * feel, frustration and what set it off, texts to finish, model performance,
 * texts and spend, tasks and tools, what needs a look, and Explore.
 *
 * Figures are `texReport` (`apps/convex/functions/lib/adminFns/texReport.ts`),
 * which is staff only on the server; the page asks `amIAdmin` only to say so
 * kindly instead of drawing an error. The arithmetic is `./model`.
 */

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { DASHBOARD_CSS } from "./dashboardCss";
import { DashboardExplore } from "./DashboardExplore.web";
import { FeelPanel, FrustrationPanel, LookPanel, ModelsPanel, SpendPanel, TasksPanel, TextsPanel, ToolsPanel, VolumePanel } from "./DashboardPanels.web";
import { TEX_WINDOWS, formatMicroUsd, formatSeconds, frustrationByDay, isFrustrated, sparkPaths, textsHandled, type TexFilters, type TexReport, type TexWindow } from "./model";
import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";

export const TEX_DASHBOARD_TITLE = "Tex dashboard";

export function TexDashboard() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});
  const [days, setDays] = useState<TexWindow>("7");
  const report = useQuery(api.functions.admin.texReport, isAdmin === true ? { days: Number(days) } : "skip");
  const [filters, setFilters] = useState<TexFilters>({});
  return (
    <div className="td" data-testid="tex-dashboard">
      <style>{DASHBOARD_CSS}</style>
      <title>{TEX_DASHBOARD_TITLE}</title>
      {isAdmin === false ? (
        <div className="td-staff" data-testid="tex-dashboard-staff-only">
          <h1 className="disp">Staff only</h1>
          <p>This page is for the people who run Tex. If that is you, sign in with your staff account.</p>
        </div>
      ) : (
        <>
          <Hero report={report ?? null} days={days} onDays={setDays} />
          <main className="td-body">
            {report === undefined || report === null ? (
              <section className="td-card" aria-busy>
                <p className="td-empty">Loading…</p>
              </section>
            ) : (
              <Body report={report} onTask={(task) => setFilters({ task: [task] })} filters={filters} onFilters={setFilters} />
            )}
          </main>
        </>
      )}
    </div>
  );
}

function Body({ report, filters, onFilters, onTask }: { report: TexReport; filters: TexFilters; onFilters: (next: TexFilters) => void; onTask: (task: string) => void }) {
  const openTask = (task: string) => {
    onTask(task);
    document.getElementById("explore")?.scrollIntoView({ behavior: "smooth" });
  };
  return (
    <>
      {report.turns.truncated || report.reviewsTruncated ? (
        <div className="td-alert">This window holds more than the page reads at once, so the figures cover the newest.</div>
      ) : null}
      <FeelPanel report={report} />
      <div className="td-row">
        <FrustrationPanel report={report} />
        <TextsPanel report={report} />
      </div>
      <ModelsPanel report={report} />
      <div className="td-row">
        <VolumePanel report={report} />
        <SpendPanel report={report} />
      </div>
      <div className="td-row">
        <TasksPanel report={report} onTask={openTask} />
        <ToolsPanel report={report} />
      </div>
      <LookPanel report={report} />
      <DashboardExplore reviews={report.reviews} filters={filters} onFilters={onFilters} />
    </>
  );
}

function Hero({ report, days, onDays }: { report: TexReport | null; days: TexWindow; onDays: (days: TexWindow) => void }) {
  const kpis = useMemo(() => (report === null ? [] : heroFigures(report)), [report]);
  return (
    <header className="td-hero">
      <div className="td-wrap">
        <div className="td-top">
          <div>
            <div className="td-brand">
              <span className="td-mark" aria-hidden>
                T
              </span>
              <span className="td-eyebrow">tex.lc · staff</span>
            </div>
            <h1 className="td-h1 disp">How Tex is doing</h1>
            <div className="td-sub">{report === null ? "Everyone who texts Tex" : windowLabel(report)}</div>
          </div>
          <div className="td-controls">
            <div className="td-seg" role="group" aria-label="Time range">
              {TEX_WINDOWS.map((w) => (
                <button key={w.key} type="button" aria-pressed={days === w.key} onClick={() => onDays(w.key)} data-testid={`tex-dashboard-days-${w.key}`}>
                  {w.label}
                </button>
              ))}
            </div>
            <a className="td-cta" href="#explore">
              Explore and filter ↓
            </a>
          </div>
        </div>
        <div className="td-kpis">
          {kpis.map((kpi) => {
            const paths = sparkPaths(kpi.spark);
            return (
              <div key={kpi.label} className="td-kpi" data-testid={`tex-dashboard-kpi-${kpi.key}`}>
                <span className="td-kpi-label">{kpi.label}</span>
                <span>
                  <span className="td-kpi-value disp num">{kpi.value}</span>
                  {kpi.unit ? <span className="td-kpi-unit">{kpi.unit}</span> : null}
                </span>
                <svg viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden>
                  <path d={paths.area} fill={kpi.color} fillOpacity={0.18} />
                  <path d={paths.line} fill="none" stroke={kpi.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                </svg>
                <span className={`td-kpi-note${kpi.crit ? " crit" : ""}`}>{kpi.note}</span>
              </div>
            );
          })}
        </div>
      </div>
    </header>
  );
}

function windowLabel(report: TexReport): string {
  const first = report.turns.byDay[0]?.day;
  const last = report.turns.byDay[report.turns.byDay.length - 1]?.day;
  const fmt = (day: string | undefined) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "");
  return `${fmt(first)} – ${fmt(last)} · everyone who texts Tex · days in UTC`;
}

interface Kpi {
  key: string;
  label: string;
  value: string;
  unit?: string;
  note: string;
  spark: number[];
  color: string;
  crit?: boolean;
}

function heroFigures(report: TexReport): Kpi[] {
  const { turns, reviews, performance } = report;
  const days = turns.byDay.map((day) => day.day);
  const frustrated = reviews.length === 0 ? null : reviews.filter(isFrustrated).length / reviews.length;
  const goal = reviews.length === 0 ? null : reviews.reduce((sum, row) => sum + row.goal, 0) / reviews.length;
  return [
    {
      key: "texts",
      label: "Texts handled",
      value: textsHandled(report).toLocaleString("en-US"),
      note: `${turns.total.toLocaleString("en-US")} turns with jobs and routines`,
      spark: turns.byDay.map((day) => day.turns),
      color: C.indigoSoft,
    },
    {
      key: "spend",
      label: "Spend",
      value: formatMicroUsd(turns.costMicroUsd),
      note: turns.priced === 0 ? "no priced turns yet" : `${formatMicroUsd(turns.costMicroUsd / turns.priced)} a turn, list price`,
      spark: turns.byDay.map((day) => day.costMicroUsd),
      color: C.emeraldBright,
    },
    {
      key: "speed",
      label: "Typical answer",
      value: turns.total === 0 ? "—" : formatSeconds(performance.time.p50),
      note: turns.total === 0 ? "no turns yet" : `slowest 1 in 20: ${formatSeconds(performance.time.p95)}`,
      spark: performance.daily.map((day) => day.p50),
      color: C.amberBright,
    },
    {
      key: "frustrated",
      label: "Frustrated",
      value: frustrated === null ? "—" : `${Math.round(frustrated * 100)}%`,
      note: `of ${reviews.length} scored conversations`,
      spark: frustrationByDay(reviews, days).map((share) => share ?? 0),
      color: C.redBright,
      crit: frustrated !== null && frustrated > 0.25,
    },
    {
      key: "goal",
      label: "Got what they wanted",
      value: goal === null ? "—" : goal.toFixed(1),
      unit: "/ 10",
      note: "average score, Haiku-judged",
      spark: days.map((day) => {
        const those = reviews.filter((row) => new Date(row.at).toISOString().slice(0, 10) === day);
        return those.length === 0 ? 0 : those.reduce((sum, row) => sum + row.goal, 0) / those.length;
      }),
      color: C.blueSoft,
    },
  ];
}
