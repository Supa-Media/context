/**
 * Usage: the artifact's `P.usage` (thread "Build console Home, Growth and Usage" ports it), with real data. The numbers
 * come from PostHog (`useUsageData`), our own counters (`admin.usageReport`), the workspace objects' note counts
 * (`texStats.report`) and the census (`admin.censusReport`). Each panel draws its loading state until its source lands.
 * The view models are `usageData.ts`; the mock's markup and classes are kept as they are.
 */
import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { useReportOnce } from "../../useReportOnce";
import { useUsageData } from "../../useUsageData";
import { esc, kpi, panel, pill, spark } from "../kit";
import { S, WIN } from "../state";
import type { ConsolePage } from "../types";
import type { Delta } from "./homeData";
import {
  analyticsNote,
  captureRows,
  clientRows,
  eventRows,
  journeys,
  usageTiles,
  type AnalyticsLike,
  type UsageTile,
} from "./usageData";

type TexStats = FunctionReturnType<typeof api.functions.texStats.report>;
type UsageReport = FunctionReturnType<typeof api.functions.admin.usageReport>;
type CensusReport = FunctionReturnType<typeof api.functions.admin.censusReport>;

/** Notes created in the window, from the workspace objects' own counts; null when the figures are not set up or failed. */
export type NotesCreated = { total: number; points: number[] };

export type UsageData = {
  analytics: AnalyticsLike | undefined;
  usage: UsageReport | undefined;
  notes: NotesCreated | null | undefined;
  census: CensusReport | undefined;
};

const DAY_MS = 86_400_000;
const LOADING = '<div class="empty">Loading…</div>';

/** `texStats.report` for the last `days` days, asked again when the window changes; null when not set up or failed. */
function useNotesCreated(days: number): NotesCreated | null | undefined {
  const ask = useRef(useAction(api.functions.texStats.report));
  const [answer, setAnswer] = useState<{
    key: number;
    notes: NotesCreated | null;
  } | null>(null);
  useEffect(() => {
    let live = true;
    const to = Date.now();
    const from = to - days * DAY_MS;
    ask
      .current({ from, to })
      .then((stats: TexStats) => {
        if (live)
          setAnswer({
            key: days,
            notes: stats.configured
              ? {
                  total: stats.notes.created,
                  points: stats.series.map((p) => p.notesCreated),
                }
              : null,
          });
      })
      .catch(() => {
        if (live) setAnswer({ key: days, notes: null });
      });
    return () => {
      live = false;
    };
    // The window stands for the answer; a render never asks again on its own.
  }, [days]);
  return answer !== null && answer.key === days ? answer.notes : undefined;
}

function useData(): UsageData {
  const days = Number(S.d);
  const analytics = useUsageData(days);
  const usage = useReportOnce(api.functions.admin.usageReport, { days });
  const notes = useNotesCreated(days);
  const census = useReportOnce(api.functions.admin.censusReport, { days: 30 });
  return { analytics, usage, notes, census };
}

/** A change as the mock draws it: `<span class="up|dn">+12%</span>`. */
const deltaHtml = (d: Delta | undefined) =>
  d ? `<span class="${d.good ? "up" : "dn"}">${esc(d.text)}</span>` : "";

/** The tile's detail: the visits read "530 visitors · +12%", the session reads "+38s · active time" (the mock's order). */
function tileDetail(t: UsageTile): string {
  const change = deltaHtml(t.delta);
  return t.key === "session" ? change + esc(t.detail) : esc(t.detail) + change;
}

export function renderUsage(d: UsageData | undefined): string {
  const analytics = d?.analytics;
  const note = analyticsNote(analytics);
  const tiles = usageTiles(analytics);

  const eventsBody =
    d?.usage === undefined || d.notes === undefined
      ? LOADING
      : `<div class="tbl"><table><tr><th>Event</th><th class="r">In ${WIN[S.d]}</th><th class="hp">Trend</th><th class="r">Today vs yesterday</th></tr>${eventRows(
          d.usage.series,
          d.notes,
        )
          .map(
            (row) =>
              `<tr><td>${esc(row.label)}</td><td class="r">${row.total.toLocaleString("en-US")}</td><td class="hp">${spark(row.trend)}</td><td class="r">${row.change ? deltaHtml(row.change) : "—"}</td></tr>`,
          )
          .join("")}</table></div>`;

  const journeysBody =
    analytics === undefined
      ? LOADING
      : `<div class="grid2">${journeys(analytics)
          .map(
            (j) =>
              `<div><div style="font-weight:600;margin-bottom:6px">${esc(j.title)}</div><div class="fun">${j.steps
                .map(
                  (s) =>
                    `<div class="r"><span>${esc(s.label)}</span><span class="tr"><span class="bb" style="width:${s.width}%;background:var(--c2)"></span></span><span class="t">${s.people.toLocaleString("en-US")} · ${s.pct}%</span></div>`,
                )
                .join("")}</div></div>`,
          )
          .join("")}</div>`;

  const clientsBody =
    d?.census === undefined
      ? LOADING
      : `<div class="tbl"><table><tr><th>Client</th><th class="r">Grants</th><th class="r">People</th><th>Last used</th></tr>${
          clientRows(d.census.clients, Date.now())
            .map(
              (c) =>
                `<tr><td>${esc(c.name)}</td><td class="r">${c.grants}</td><td class="r">${c.people}</td><td>${esc(c.last)}</td></tr>`,
            )
            .join("") ||
          '<tr><td colspan="4" class="empty">No AI clients connected</td></tr>'
        }</table></div>`;

  const captureBody =
    d?.census === undefined
      ? LOADING
      : `<div class="kv">${captureRows(d.census.sources)
          .map(
            (r) =>
              `<span class="k">${esc(r.k)}</span><span class="v">${esc(r.v)} ${r.pills.map((p) => pill(p, "warn")).join(" ")}</span>`,
          )
          .join("")}</div>`;

  return (
    (note
      ? `<div class="banner warn"><span class="tx">${esc(note)}</span></div>`
      : "") +
    `<div class="kpis">${tiles.map((t) => kpi(esc(t.label), esc(t.value), tileDetail(t))).join("")}</div>` +
    panel("u-ev", "Events", "", eventsBody) +
    panel("u-j", "Journeys", "visitors, not accounts", journeysBody) +
    `<div class="grid2">` +
    panel(
      "u-cli",
      "Connected AI clients",
      "names are self-reported",
      clientsBody,
    ) +
    panel("u-cap", "Capture sources", "", captureBody) +
    `</div>`
  );
}

// The registry holds every page as `ConsolePage` (its data is `unknown` there), so `render` takes that type and
// narrows it back to this page's data, which `useData` is the only source of.
export const usagePage: ConsolePage = {
  key: "usage",
  filters: {},
  windowed: true,
  useData,
  render: (d) => renderUsage(d as UsageData | undefined),
};
