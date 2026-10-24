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

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Tex } from "../../chaos/Tex";
import { api } from "@context/convex/_generated/api";
import { DASHBOARD_CSS } from "./dashboardCss";
import { DashboardExplore } from "./DashboardExplore.web";
import { FeelPanel, FrustrationPanel, LookPanel, ModelsPanel, TasksPanel, TextsPanel, ToolsPanel, VolumePanel } from "./DashboardPanels.web";
import { SpendPanel } from "./DashboardSpend.web";
import { TrendsPanel } from "./DashboardTrends.web";
import { spendByDay, windowDayList, type TexSpend } from "./trends";
import { TEX_WINDOWS, formatMicroUsd, formatSeconds, frustrationByDay, isFrustrated, sparkPaths, textsHandled, type TexFilters, type TexReport, type TexWindow } from "./model";
import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";

export const TEX_DASHBOARD_TITLE = "Tex dashboard";

export function TexDashboard() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});
  const [days, setDays] = useState<TexWindow>("7");
  const report = useQuery(api.functions.admin.texReport, isAdmin === true ? { days: Number(days) } : "skip");
  const [filters, setFilters] = useState<TexFilters>({});
  const spend = useTexSpend(isAdmin === true ? Number(days) : null);
  return (
    <div className="td" data-testid="tex-dashboard">
      <style>{DASHBOARD_CSS}</style>
      <title>{TEX_DASHBOARD_TITLE}</title>
      {isAdmin === false ? (
        <div className="td-wrap">
          <Brand />
          <div className="td-staff" data-testid="tex-dashboard-staff-only">
            <h1 className="td-h1">Staff only</h1>
            <p>This page is for the people who run Tex. If that is you, sign in with your staff account.</p>
          </div>
        </div>
      ) : (
        <>
          <Hero report={report ?? null} spend={spend} days={days} onDays={setDays} />
          <main className="td-body">
            {report === undefined || report === null ? (
              <section className="td-card" aria-busy>
                <p className="td-empty">Loading…</p>
              </section>
            ) : (
              <Body report={report} spend={spend} onTask={(task) => setFilters({ task: [task] })} filters={filters} onFilters={setFilters} />
            )}
          </main>
          <footer className="td-foot">
            Spend is what Cloudflare's AI Gateway priced Tex's calls at, cache included, for the whole account (staging too). Without it, the page falls back to our own estimate from token counts.
          </footer>
        </>
      )}
    </div>
  );
}

/**
 * The billed spend for the window, asked of Cloudflare through Convex. Undefined
 * while asking; a failure is kept as an answer so the page can say so.
 */
function useTexSpend(days: number | null): TexSpend | undefined {
  // Held in a ref so the request follows the window alone, not the identity of the function handed back.
  const ask = useRef(useAction(api.functions.texSpend.report));
  const [answer, setAnswer] = useState<{ days: number; spend: TexSpend } | null>(null);
  useEffect(() => {
    if (days === null) return;
    let live = true;
    ask.current({ days })
      .then((spend) => live && setAnswer({ days, spend }))
      .catch(() => live && setAnswer({ days, spend: { configured: true, error: "the request failed", totalUsd: 0, testsUsd: 0, keptFrom: "", days: [], models: [], jobs: [] } }));
    return () => {
      live = false;
    };
  }, [days]);
  return answer !== null && answer.days === days ? answer.spend : undefined;
}

function Body({ report, spend, filters, onFilters, onTask }: { report: TexReport; spend: TexSpend | undefined; filters: TexFilters; onFilters: (next: TexFilters) => void; onTask: (task: string) => void }) {
  const openTask = (task: string) => {
    onTask(task);
    document.getElementById("explore")?.scrollIntoView({ behavior: "smooth" });
  };
  return (
    <>
      {report.turns.truncated || report.reviewsTruncated ? (
        <div className="td-alert">This window holds more than the page reads at once, so the figures cover the newest.</div>
      ) : null}
      <TrendsPanel report={report} spend={spend} />
      <FeelPanel report={report} />
      <div className="td-row">
        <FrustrationPanel report={report} />
        <TextsPanel report={report} />
      </div>
      <ModelsPanel report={report} />
      <div className="td-row">
        <VolumePanel report={report} />
        <SpendPanel report={report} spend={spend} />
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

function Hero({ report, spend, days, onDays }: { report: TexReport | null; spend: TexSpend | undefined; days: TexWindow; onDays: (days: TexWindow) => void }) {
  const kpis = useMemo(() => (report === null ? [] : heroFigures(report, spend)), [report, spend]);
  return (
    <header className="td-wrap">
      <Brand />
      <div className="td-top">
        <div>
          <h1 className="td-h1">How Tex is doing</h1>
          <p className="td-sub">{report === null ? "Everyone who texts Tex" : windowLabel(report)}</p>
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
            Explore and filter
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
                <span className="td-kpi-value num">{kpi.value}</span>
                {kpi.unit ? <span className="td-kpi-unit">{kpi.unit}</span> : null}
              </span>
              <svg viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden>
                <path d={paths.area} fill={kpi.color} fillOpacity={0.12} />
                <path d={paths.line} fill="none" stroke={kpi.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </svg>
              <span className={`td-kpi-note${kpi.crit ? " crit" : ""}`}>{kpi.note}</span>
            </div>
          );
        })}
      </div>
    </header>
  );
}

/** tex.lc's own header: Tex, the wordmark, and a quiet pill saying whose page this is. */
function Brand() {
  return (
    <div className="td-head">
      <a className="td-brand" href="/" aria-label="tex.lc home">
        <span className="td-mark" aria-hidden>
          <Tex chaos={0} scheme="light" />
        </span>
        <span className="td-word">
          tex<b>.lc</b>
        </span>
      </a>
      <span className="td-staff-pill">Staff</span>
    </div>
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

function heroFigures(report: TexReport, spend: TexSpend | undefined): Kpi[] {
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
      color: C.blue,
    },
    spendFigure(report, spend),
    {
      key: "speed",
      label: "Typical answer",
      value: turns.total === 0 ? "—" : formatSeconds(performance.time.p50),
      note: turns.total === 0 ? "no turns yet" : `slowest 1 in 20: ${formatSeconds(performance.time.p95)}`,
      spark: performance.daily.map((day) => day.p50),
      color: C.ochre,
    },
    {
      key: "frustrated",
      label: "Frustrated",
      value: frustrated === null ? "—" : `${Math.round(frustrated * 100)}%`,
      note: `of ${reviews.length} scored conversations`,
      spark: frustrationByDay(reviews, days).map((share) => share ?? 0),
      color: C.bad,
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
      color: C.blue,
    },
  ];
}

/** Spend: Cloudflare's billed figure when it answered, else our estimate, saying which. */
function spendFigure(report: TexReport, spend: TexSpend | undefined): Kpi {
  const money = spendByDay(report, spend, windowDayList(report));
  const live = spend !== undefined && spend.configured && spend.error === null ? spend : null;
  const turns = report.turns.total;
  if (live !== null) {
    return {
      key: "spend",
      label: "Spend",
      value: formatMicroUsd(live.totalUsd * 1_000_000),
      note: turns === 0 ? "billed by Cloudflare's AI Gateway" : `${formatMicroUsd((live.totalUsd / turns) * 1_000_000)} a turn · billed, cache included`,
      spark: money.values.map((value) => value ?? 0),
      color: C.ink,
    };
  }
  return {
    key: "spend",
    label: "Spend",
    value: formatMicroUsd(report.turns.costMicroUsd),
    note: spend === undefined ? "asking Cloudflare…" : "our estimate, not billed",
    spark: money.values.map((value) => value ?? 0),
    color: C.ink,
  };
}
