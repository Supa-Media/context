/**
 * tex.lc/admin: where Tex hurts, and whether it is getting better.
 *
 * Its own page (the owner, 2026-10-24: "an entirely new page"), redesigned the
 * same evening after the owner called the scorecards meaningless without a
 * frame of reference, through two rounds of product and design review. Top to
 * bottom: the one thing to fix next and what to check on; four numbers, each
 * against its target and the window before; the problems the triage agent
 * named, with what each fix did; thirty days of trend with shipped fixes on
 * them; the bug desk; what a text costs; and everything else folded away.
 *
 * Figures are `texReport` and the triage desk (`api.functions.texDashboard`),
 * staff only on the server; the page asks `amIAdmin` only to say so kindly.
 * The reasoning is `./insights`.
 */

import { useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Tex } from "../../chaos/Tex";
import { api } from "@context/convex/_generated/api";
import { DASHBOARD_CSS } from "./dashboardCss";
import { BugsPanel, NoteReader } from "./DashboardBugs.web";
import { DashboardExplore } from "./DashboardExplore.web";
import { PainPanel } from "./DashboardPain.web";
import { ModelsPanel, TasksPanel, ToolsPanel, VolumePanel } from "./DashboardPanels.web";
import { ProgressPanel } from "./DashboardProgress.web";
import { CostPanel, SpendPanel } from "./DashboardSpend.web";
import {
  CODES_BEGAN,
  directionOf,
  formatTile,
  markersOf,
  onTarget,
  painRowsOf,
  seriesOf,
  shortDate,
  tilesOf,
  untriagedSignals,
  verdictOf,
  type BugRow,
  type Tile,
  type TriageDesk,
  type Verdict,
} from "./insights";
import { TASK_LABELS, TEX_WINDOWS, type TexFilters, type TexReport, type TexReview, type TexWindow } from "./model";
import type { TexSpend } from "./trends";

export const TEX_DASHBOARD_TITLE = "Tex dashboard";

/** The report is asked for twice the window, so every number has the window before it. */
const FETCH_DAYS: Record<TexWindow, number> = { "7": 30, "30": 90, "90": 90 };
type Who = "all" | "not_staff" | "new";

export function TexDashboard() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});
  const [days, setDays] = useState<TexWindow>("7");
  const [who, setWho] = useState<Who>("all");
  const [task, setTask] = useState<string>("all");
  const report = useQuery(api.functions.admin.texReport, isAdmin === true ? { days: FETCH_DAYS[days] } : "skip");
  const triage = useQuery(api.functions.texDashboard.triage, isAdmin === true ? {} : "skip");
  const spend = useTexSpend(isAdmin === true ? Number(days) : null);
  const [reading, setReading] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<TexFilters>({});
  const desk = triage !== undefined && triage.available ? triage : null;
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
          <header className="td-wrap">
            <Brand />
            <div className="td-top">
              <div>
                <h1 className="td-h1">Where Tex hurts, and is it getting better</h1>
                <p className="td-sub">{report ? subline(report, Number(days)) : "Everyone who texts Tex"}</p>
              </div>
              <div className="td-filters">
                <Select label="Window" value={days} onChange={(value) => setDays(value as TexWindow)} options={TEX_WINDOWS.map((w) => ({ value: w.key, label: w.label }))} testID="tex-dashboard-window" />
                <Select label="Who" value={who} onChange={(value) => setWho(value as Who)} options={[{ value: "all", label: "Everyone" }, { value: "not_staff", label: "Not the team" }, { value: "new", label: "New this week" }]} testID="tex-dashboard-who" />
                <Select label="Task" value={task} onChange={setTask} options={[{ value: "all", label: "All tasks" }, ...Object.entries(TASK_LABELS).map(([value, label]) => ({ value, label }))]} testID="tex-dashboard-task" />
              </div>
            </div>
          </header>
          <main className="td-body">
            {report === undefined || report === null ? (
              <section className="td-card" aria-busy>
                <p className="td-empty">Loading…</p>
              </section>
            ) : (
              <Body
                report={report}
                rows={narrow(report.reviews, who, task)}
                days={Number(days)}
                desk={desk}
                deskNote={triage !== undefined && !triage.available ? triage.reason : null}
                spend={spend}
                statusOf={(bug) => statuses[bug.path] ?? bug.status}
                onOpen={setReading}
                filters={filters}
                onFilters={setFilters}
              />
            )}
          </main>
          <footer className="td-foot">
            Scores are Haiku's read of each finished chat; task and frustration codes began {shortDate(CODES_BEGAN)}. Targets are starting points: 70% got what they wanted, under 15% handed back, slow replies under 60s, under 5% of replies going wrong. Spend is what Cloudflare's AI Gateway billed.
          </footer>
          {reading !== null ? <NoteReader path={reading} onClose={() => setReading(null)} onStatus={(path, status) => setStatuses((now) => ({ ...now, [path]: status }))} /> : null}
        </>
      )}
    </div>
  );
}

function narrow(rows: readonly TexReview[], who: Who, task: string): TexReview[] {
  return rows.filter((row) => (who === "all" || (who === "new" ? row.who === "new" : row.who !== "staff")) && (task === "all" || row.task === task));
}

/** The window's spend, asked of Cloudflare through Convex; a failure is kept as an answer so the page can say so. */
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

function Body(props: {
  report: TexReport;
  rows: TexReview[];
  days: number;
  desk: TriageDesk | null;
  deskNote: string | null;
  spend: TexSpend | undefined;
  statusOf: (bug: BugRow) => string;
  onOpen: (path: string) => void;
  filters: TexFilters;
  onFilters: (next: TexFilters) => void;
}) {
  const { report, rows, days, desk, spend, onOpen } = props;
  // Small arrays, worked out afresh each render, so "now" moves with the page.
  const now = Date.now();
  const tiles = tilesOf(report, rows, days, now);
  const pain = painRowsOf(desk, rows, now);
  const untriaged = untriagedSignals(desk, rows, now);
  const verdict = verdictOf(pain, untriaged, tiles);
  const series = seriesOf(report, rows);
  const turnDays = report.turns.byDay.map((day) => day.day);
  const markers = markersOf(desk, turnDays);
  const exploreSignal = (code: string) => {
    props.onFilters({ signal: [code] });
    const more = document.getElementById("more") as HTMLDetailsElement | null;
    if (more) more.open = true;
    document.getElementById("explore")?.scrollIntoView({ behavior: "smooth" });
  };
  const send = useSendToTriage();
  return (
    <>
      {report.turns.truncated || report.reviewsTruncated ? <div className="td-alert">This window holds more than the page reads at once, so the figures cover the newest.</div> : null}
      {props.deskNote === "not_a_member" ? <div className="td-alert">You are staff but not a member of the team context, so problems and bug reports are hidden from you.</div> : null}
      <Today verdict={verdict} onSend={send} onSignal={exploreSignal} />
      <section className="td-tiles" aria-label="This window against its targets">
        {tiles.map((tile) => (
          <TileCard key={tile.key} tile={tile} days={days} />
        ))}
      </section>
      <p className="td-pain-meta">Bar: the tick is the target, the ring is the window before, the dot is now. Blue is on target, ochre is not yet.</p>
      <PainPanel rows={pain} untriaged={untriaged} onOpen={onOpen} onSignal={exploreSignal} onSend={send} />
      <ProgressPanel series={series} days={turnDays} markers={markers} />
      {desk !== null ? <BugsPanel bugs={desk.bugs} days={turnDays} statusOf={props.statusOf} onOpen={onOpen} /> : null}
      <CostPanel report={report} spend={spend} days={days} />
      <details id="more" className="td-more">
        <summary>Everything else: models, tools, tasks, volume, spend and every scored chat</summary>
        <div className="td-more-body">
          <ModelsPanel report={report} />
          <div className="td-row">
            <TasksPanel report={report} onTask={(task) => props.onFilters({ task: [task] })} />
            <ToolsPanel report={report} />
          </div>
          <div className="td-row">
            <VolumePanel report={report} />
            <SpendPanel report={report} spend={spend} />
          </div>
          <DashboardExplore reviews={rows} filters={props.filters} onFilters={props.onFilters} />
        </div>
      </details>
    </>
  );
}

/** Send a problem's note to the triage agent with no comment, from the row or the top of the page. */
function useSendToTriage() {
  const act = useRef(useAction(api.functions.texDashboard.act));
  return (path: string) => {
    void act.current({ path, action: "triage" }).catch(() => undefined);
  };
}

function Today({ verdict, onSend, onSignal }: { verdict: Verdict; onSend: (path: string) => void; onSignal: (code: string) => void }) {
  const [sent, setSent] = useState(false);
  const next = verdict.next;
  return (
    <section className="td-today" aria-label="Today" data-testid="tex-dashboard-today">
      <div className="td-today-next">
        <span className="td-eyebrow">Do next</span>
        {next === null ? (
          <p className="td-today-line">Nothing open. Every problem triage named has a fix on the way.</p>
        ) : (
          <>
            <p className="td-today-line">
              {next.name}: {next.detail}
            </p>
            <div className="td-filters">
              {next.theme !== null ? (
                <button
                  type="button"
                  className="td-btn light"
                  disabled={sent}
                  onClick={() => {
                    onSend(next.theme!.path);
                    setSent(true);
                  }}
                >
                  {sent ? "Sent to triage" : "Send to triage to fix"}
                </button>
              ) : null}
              {next.signal !== null ? (
                <button type="button" className="td-btn light" onClick={() => onSignal(next.signal!)}>
                  See the chats
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
      <div className="td-today-checks">
        <span className="td-eyebrow">Check on</span>
        {verdict.checks.length === 0 ? <p>No shipped fix or slide to watch yet.</p> : verdict.checks.map((check) => <p key={check.key} className={check.tone}>{check.text}</p>)}
      </div>
    </section>
  );
}

function TileCard({ tile, days }: { tile: Tile; days: number }) {
  const scale = tile.unit === "pct" ? 1 : Math.max(tile.target * 2.5, tile.value ?? 0, tile.before ?? 0);
  const x = (value: number) => `${Math.min(1, value / scale) * 100}%`;
  const good = onTarget(tile);
  const direction = directionOf(tile);
  return (
    <div className="td-tile" data-testid={`tex-dashboard-tile-${tile.key}`}>
      <span className="td-kpi-label">{tile.label}</span>
      <span className="td-tile-row">
        <span className="td-trend-value num">{formatTile(tile.unit, tile.value)}</span>
        <span className={`td-delta${direction === "better" ? " good" : direction === "worse" ? " bad" : ""}`}>
          {direction === null ? (tile.before === null ? "no window before" : `was ${formatTile(tile.unit, tile.before)}, too few to call`) : direction === "same" ? "about the same" : `${direction}, was ${formatTile(tile.unit, tile.before)}`}
        </span>
      </span>
      <span className="td-gauge" aria-hidden>
        <span className="track" />
        <span className="tick" style={{ left: x(tile.target) }} />
        {tile.before !== null ? <span className="ring" style={{ left: x(tile.before) }} /> : null}
        {tile.value !== null ? <span className={`dot${good === false ? " warn" : ""}`} style={{ left: x(tile.value) }} /> : null}
      </span>
      <span className="td-pain-meta">
        Target {tile.better === "up" ? "" : "under "}
        {formatTile(tile.unit, tile.target)} · {tile.n.toLocaleString("en-US")} {tile.unit === "pct" && tile.key !== "troubled" ? "scored chats" : "replies"} in {days} days · {tile.foot}
      </span>
    </div>
  );
}

function Select({ label, value, onChange, options, testID }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; testID: string }) {
  return (
    <label className="td-select">
      <span className="td-sr">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} data-testid={testID}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
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

function subline(report: TexReport, days: number): string {
  const since = Date.now() - days * 86_400_000;
  const scored = report.reviews.filter((row) => row.at > since);
  const staff = scored.filter((row) => row.who === "staff").length;
  const fresh = scored.filter((row) => row.who === "new").length;
  return `Last ${days} days against the ${days} before · ${scored.length} scored chats: ${staff} team, ${fresh} new, ${scored.length - staff - fresh} others · days in UTC`;
}
