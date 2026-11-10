/**
 * tex.lc/admin's basics, at the top of the page (Dev2, 2026-11-10: "DAUs, Tex
 * messages sent and received, average cost per text, total costs (ai
 * inference), notes created/edited, with a date filter last 24, last 7d,
 * custom date range etc").
 *
 * Its own window, apart from the page's 7/30/90-day one below, because these
 * figures are asked of Cloudflare for exactly the hours chosen
 * (`api.functions.texStats.report`, `apps/convex/functions/lib/adminFns/
 * texStats.ts`). Counts only: no figure here can name anybody.
 */

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";
import { AreaChart, Card } from "./DashboardPanels.web";
import { formatMicroUsd } from "./model";

export type TexStats = FunctionReturnType<typeof api.functions.texStats.report>;
type Ready = Extract<TexStats, { configured: true }>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const BASICS_RANGES = [
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "custom", label: "Custom range" },
] as const;
type RangeKey = (typeof BASICS_RANGES)[number]["key"];

/** `YYYY-MM-DD` of a time, in the viewer's own day. */
function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The viewer's midnight starting `day` (`YYYY-MM-DD`), or NaN. */
function localMidnight(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).getTime() : NaN;
}

/** The window a choice names: a custom range runs from the start day's midnight to the end of the end day. */
export function windowOf(key: RangeKey, custom: { start: string; end: string }, now: number): { from: number; to: number } | null {
  if (key === "24h") return { from: now - DAY_MS, to: now };
  if (key === "7d") return { from: now - 7 * DAY_MS, to: now };
  if (key === "30d") return { from: now - 30 * DAY_MS, to: now };
  const from = localMidnight(custom.start);
  const end = localMidnight(custom.end);
  if (!Number.isFinite(from) || !Number.isFinite(end) || end < from) return null;
  return { from, to: Math.min(now, end + DAY_MS) };
}

const usd = (value: number) => formatMicroUsd(value * 1_000_000);
const count = (value: number) => Math.round(value).toLocaleString("en-US");

export function BasicsPanel({ enabled }: { enabled: boolean }) {
  const [range, setRange] = useState<RangeKey>("24h");
  const now = useRef(Date.now());
  const [custom, setCustom] = useState({ start: localDay(now.current - 7 * DAY_MS), end: localDay(now.current) });
  const span = windowOf(range, custom, now.current);
  const stats = useTexStats(enabled ? span : null);
  return (
    <Card title="The basics" meta="people, texts, cost and notes for the window you pick" testID="tex-dashboard-basics" wide>
      <div className="td-filters" data-testid="tex-dashboard-basics-range">
        <label className="td-select">
          <span className="td-sr">Window</span>
          <select
            value={range}
            onChange={(event) => {
              now.current = Date.now();
              setRange(event.target.value as RangeKey);
            }}
            data-testid="tex-dashboard-basics-window"
          >
            {BASICS_RANGES.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {range === "custom" ? (
          <>
            <input className="td-date" type="date" aria-label="From" value={custom.start} max={custom.end} onChange={(event) => setCustom((was) => ({ ...was, start: event.target.value }))} data-testid="tex-dashboard-basics-from" />
            <input className="td-date" type="date" aria-label="To" value={custom.end} min={custom.start} max={localDay(Date.now())} onChange={(event) => setCustom((was) => ({ ...was, end: event.target.value }))} data-testid="tex-dashboard-basics-to" />
          </>
        ) : null}
      </div>
      {span === null ? <p className="td-empty">Pick a start day on or before the end day.</p> : <Figures stats={stats} />}
    </Card>
  );
}

function Figures({ stats }: { stats: TexStats | "failed" | undefined }) {
  if (stats === undefined) return <p className="td-empty">Asking Cloudflare…</p>;
  if (stats === "failed") return <p className="td-empty">The figures could not be read just now. Try again in a minute.</p>;
  if (!stats.configured) return <p className="td-empty">Cloudflare's analytics aren't connected on this deployment, so there is nothing to count.</p>;
  return <ReadyFigures stats={stats} />;
}

function ReadyFigures({ stats }: { stats: Ready }) {
  const { texts, people, notes, cost } = stats;
  const received = texts.inOne + texts.inGroup;
  const sent = texts.outOne + texts.outGroup;
  const per = stats.bucket === "hour" ? "hour" : "day";
  const tiles: { key: string; label: string; value: string; foot: string }[] = [
    { key: "dau", label: "Daily active people", value: stats.dailyActive.toFixed(stats.dailyActive < 10 ? 1 : 0), foot: `${count(people.any)} people in all · ${count(people.one)} 1:1 · ${count(people.group)} in groups` },
    { key: "received", label: "Texts received", value: count(received), foot: `${count(texts.inOne)} 1:1 · ${count(texts.inGroup)} group messages to Tex · ${count(texts.heardGroup)} more only heard` },
    { key: "sent", label: "Texts sent", value: count(sent), foot: `${count(texts.outOne)} 1:1 · ${count(texts.outGroup)} in groups` },
    { key: "per-text", label: "Cost per text", value: stats.costPerTextUsd === null ? "—" : usd(stats.costPerTextUsd), foot: "inference cost over texts received" },
    { key: "cost", label: "Inference cost", value: usd(cost.totalUsd), foot: cost.testsUsd > 0 ? `test runs cost another ${usd(cost.testsUsd)}` : "as Cloudflare's AI Gateway billed it" },
    { key: "created", label: "Notes created", value: count(notes.created), foot: "every workspace, by Tex, apps and people" },
    { key: "edited", label: "Notes edited", value: count(notes.edited), foot: `${count(notes.saves)} saves in all` },
  ];
  const failed = [stats.errors.texts && `texts (${stats.errors.texts})`, stats.errors.notes && `notes (${stats.errors.notes})`, stats.errors.cost && `cost (${stats.errors.cost})`].filter(Boolean);
  return (
    <>
      {failed.length > 0 ? <div className="td-alert">Some figures could not be read, so they show as zero: {failed.join(", ")}.</div> : null}
      <div className="td-tiles" data-testid="tex-dashboard-basics-tiles">
        {tiles.map((tile) => (
          <div key={tile.key} className="td-tile" data-testid={`tex-dashboard-basics-${tile.key}`}>
            <span className="td-kpi-label">{tile.label}</span>
            <span className="td-trend-value num">{tile.value}</span>
            <span className="td-pain-meta">{tile.foot}</span>
          </div>
        ))}
      </div>
      <div className="td-row">
        <div className="td-sep" style={{ flex: "1 1 320px", minWidth: 0 }}>
          <span className="td-small-h">Texts received per {per}</span>
          <AreaChart values={stats.series.map((s) => s.textsIn)} color={C.blue} fill={C.blueWash} label={`Texts received per ${per}`} />
          <SeriesAxis stats={stats} />
        </div>
        <div className="td-sep" style={{ flex: "1 1 320px", minWidth: 0 }}>
          <span className="td-small-h">Inference cost per {per}</span>
          <AreaChart values={stats.series.map((s) => s.usd)} color={C.ink} fill={C.tray} label={`Inference cost per ${per}`} />
          <SeriesAxis stats={stats} />
        </div>
      </div>
      <p className="td-pain-meta">
        People are counted by an id, never a number. Texts, people and notes have been counted only since this card shipped (Nov 10, 2026, late UTC), so earlier hours read zero; cost includes staging's Tex. Charts are in UTC {per}s.
      </p>
    </>
  );
}

function SeriesAxis({ stats }: { stats: Ready }) {
  const first = stats.series[0]?.at;
  const last = stats.series[stats.series.length - 1]?.at;
  if (first === undefined || last === undefined) return null;
  const label = (ms: number) =>
    stats.bucket === "hour"
      ? new Date(ms).toLocaleString("en-US", { hour: "numeric", day: "numeric", month: "short" })
      : new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="td-axis">
      <span>{label(first)}</span>
      <span>{label(last)}</span>
    </div>
  );
}

/** The window's figures, asked again whenever the window changes; a failure is kept as an answer. */
function useTexStats(span: { from: number; to: number } | null): TexStats | "failed" | undefined {
  const ask = useRef(useAction(api.functions.texStats.report));
  const [answer, setAnswer] = useState<{ key: string; stats: TexStats | "failed" } | null>(null);
  const key = span === null ? null : `${span.from}:${span.to}`;
  useEffect(() => {
    if (span === null || key === null) return;
    let live = true;
    ask.current({ from: span.from, to: span.to })
      .then((stats) => live && setAnswer({ key, stats }))
      .catch(() => live && setAnswer({ key, stats: "failed" }));
    return () => {
      live = false;
    };
    // The key stands for the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return answer !== null && answer.key === key ? answer.stats : undefined;
}
