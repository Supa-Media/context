/**
 * Search's "Indexes" view: the artifact's `P.search` indexes branch and `P.search.props` (an index's
 * side panel), over the real per-workspace indexes joined by `searchIndexes.ts`. The three columns
 * use the artifact's state words (Ready, Indexing, Retrying, Failed, Can't read, Paused, Off by owner).
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { esc, ic, kpi, panel, pill, plural, seg } from "../kit";
import { S } from "../state";
import { ago } from "./ago";
import {
  joinIndexes,
  type IndexCell,
  type IndexKey,
  type WorkspaceIndexes,
} from "../../searchIndexes";

export type MeaningReport = FunctionReturnType<
  typeof api.functions.meaningAdmin.meaningIndexReport
>;
export type MigrationReport = FunctionReturnType<
  typeof api.functions.nodesMigration.report
>;

const COLUMNS: Array<[IndexKey, string]> = [
  ["files", "File tree"],
  ["fast", "Fast search"],
  ["meaning", "Search by meaning"],
];
const BAD = /Failed|Retrying|Can't|Paused/;

/** The index row's key in the address: the slug, or the id for a workspace that no longer has one. */
export const rowKey = (row: Pick<WorkspaceIndexes, "slug" | "workspaceId">) =>
  row.slug ?? row.workspaceId;
const rowName = (row: Pick<WorkspaceIndexes, "slug">) =>
  row.slug ? `@${esc(row.slug)}` : "a deleted workspace";

/** The artifact's state word for one index cell, from the label `searchIndexes.ts` gave it. */
export function stateWord(cell: IndexCell): string {
  switch (cell.label) {
    case "Ready":
    case "Paused":
    case "Retrying":
    case "Failed":
    case "Off by owner":
    case "Catching up":
      return cell.label;
    case "Can't read":
    case "Waiting":
      return "Can't read";
    case "Indexing":
    case "Filling":
    case "Not started":
    case "Setting up":
      return "Indexing";
    default:
      return cell.label;
  }
}

/** The artifact's pill tone for a table cell. */
const tableTone = (s: string) =>
  s === "Ready"
    ? "ok"
    : BAD.test(s)
      ? s === "Paused"
        ? "warn"
        : "bad"
      : s === "Off by owner"
        ? ""
        : "acc";
/** The artifact's pill tone in the side panel (Paused and Ready differ from the table's rule there). */
const panelTone = (s: string) =>
  s === "Ready"
    ? "ok"
    : /Failed|Retrying|Can't/.test(s)
      ? "bad"
      : s === "Paused"
        ? "warn"
        : "acc";

export type RowStates = Record<IndexKey, string>;
export const statesOf = (row: WorkspaceIndexes): RowStates => ({
  files: stateWord(row.files),
  fast: stateWord(row.fast),
  meaning: stateWord(row.meaning),
});
const needsAttention = (s: RowStates) =>
  Object.values(s).some((x) => BAD.test(x));

/** The rows the page lists: each workspace with any index, joined; empty until both reports load. */
export function indexRowsOf(
  meaning: MeaningReport | undefined,
  migration: MigrationReport | undefined,
): WorkspaceIndexes[] {
  if (meaning === undefined || migration === undefined) return [];
  return joinIndexes(meaning.rows, migration.rows, migration.paused);
}

/** The Indexes tab's badge: workspaces with a failed or can't-read index, or null for none. */
export function failingCount(rows: WorkspaceIndexes[]): number | null {
  return (
    rows.filter((row) =>
      Object.values(statesOf(row)).some((s) => /Failed|Can't/.test(s)),
    ).length || null
  );
}

function changedOf(row: WorkspaceIndexes): string {
  return row.changedAt === null ? "—" : ago(row.changedAt);
}

/** The Indexes view under its tabs. `loading` keeps the same panels with a Loading body. */
export function indexesHtml(
  tabs: string,
  rows: WorkspaceIndexes[],
  loading: boolean,
): string {
  const val = (x: string | number) => (loading ? "…" : String(x));
  const cnt = (key: IndexKey, s: string) =>
    loading ? 0 : rows.filter((row) => statesOf(row)[key] === s).length;
  const failed = cnt("meaning", "Failed");
  const show =
    S.f.idx === "all"
      ? rows
      : rows.filter((row) => needsAttention(statesOf(row)));
  const kpis = `<div class="kpis">${kpi("File tree", val(cnt("files", "Ready") + " ready"), loading ? "" : cnt("files", "Paused") + " paused")}${kpi("Fast search", val(cnt("fast", "Ready") + " ready"), loading ? "" : `${cnt("fast", "Retrying")} retrying · ${cnt("fast", "Can't read")} can't read`)}${kpi("Search by meaning", val(cnt("meaning", "Ready") + " ready"), loading ? "" : failed + " failed")}</div>`;
  const table = show
    .map((row) => {
      const s = statesOf(row);
      const cells = COLUMNS.map(
        ([key]) => `<td>${pill(s[key], tableTone(s[key]))}</td>`,
      ).join("");
      return `<tr class="click" tabindex="0" data-act="sel" data-id="${esc(rowKey(row))}" aria-selected="${S.x === rowKey(row)}"><td>${rowName(row)}</td>${cells}<td class="hp">${esc(changedOf(row))}</td></tr>`;
    })
    .join("");
  const body = loading
    ? '<div class="empty">Loading…</div>'
    : `<div class="tbl"><table><tr><th>Workspace</th><th>File tree</th><th>Fast search</th><th>By meaning</th><th class="hp">Changed</th></tr>${table || '<tr><td colspan="5" class="empty">Every index is healthy</td></tr>'}</table></div>`;
  const meta = loading ? "" : plural(show.length, "workspace", "workspaces");
  const acts =
    seg(
      "Show",
      [
        ["attention", "Needs attention"],
        ["all", "All"],
      ],
      S.f.idx,
      "idxf",
    ) +
    (failed && !loading
      ? `<button class="ghost" data-act="restartall">Restart ${failed} failed</button>`
      : "");
  return `<div class="tools">${tabs}</div>${kpis}${panel("s-idx", "Indexes", meta, body, acts)}`;
}

/** The side panel for one index row (the artifact's `P.search.props`), or null when there is no such row. */
export function indexProps(row: WorkspaceIndexes): string {
  const s = statesOf(row);
  const items: Array<{
    key: IndexKey;
    name: string;
    cell: IndexCell;
    i: number;
    btn: string;
  }> = [
    {
      key: "files",
      name: "File tree",
      cell: row.files,
      i: 1,
      btn: s.files === "Paused" ? "Resume facts" : "Pause facts",
    },
    {
      key: "fast",
      name: "Fast search",
      cell: row.fast,
      i: 2,
      btn: "Restart fast search",
    },
    {
      key: "meaning",
      name: "Search by meaning",
      cell: row.meaning,
      i: 3,
      btn: "Restart meaning",
    },
  ];
  const parts = items.map(({ key, name, cell, i, btn }) => {
    const state = s[key];
    if (state === "Off by owner") {
      return `<div class="ppb"><div class="row"><b style="flex:1">${name}</b>${pill(state)}</div><div class="sub">Turned off by the workspace owner</div></div>`;
    }
    // The cell's own words: why it is stuck, else how far it has got.
    const figure = cell.figure ? (/^[\d,]+( of [\d,]+)?$/.test(cell.figure) ? `${cell.figure} notes` : cell.figure) : "";
    // The artifact's words: a stuck index names its last error; a ready file tree says what its facts cover.
    const problem = cell.problem && key !== "files" ? `Last error: ${cell.problem}` : cell.problem;
    const files = figure ? `Facts for ${figure}` : state === "Ready" ? "Facts for every note" : "";
    const sub = problem ?? ((key === "files" ? files : figure) || (state === "Ready" ? "Up to date" : ""));
    const canAct =
      !row.archived &&
      state !== "Ready" &&
      cell.health !== "none" &&
      (key === "files" || cell.health !== "off");
    const button = canAct
      ? `<button class="ghost" style="align-self:flex-start" data-act="restart" data-id="${esc(rowKey(row))}" data-i="${i}">${btn}</button>`
      : "";
    return `<div class="ppb"><div class="row"><b style="flex:1">${name}</b>${pill(state, panelTone(state))}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}${button}</div>`;
  });
  return `<div class="pph"><h3 tabindex="-1">${rowName(row)}</h3><button class="ib sm" data-act="close" aria-label="Close">${ic("x")}</button></div>${parts.join("")}`;
}
