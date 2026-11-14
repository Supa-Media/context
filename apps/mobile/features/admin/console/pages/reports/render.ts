/**
 * The Reports page's HTML, the artifact's `P.reports`, `P.reports.props` and their cards, with the
 * same classes and texts. Every value from the database goes through `esc`.
 */
import { REPLAY, esc, ic, pill, seg } from "../../kit";
import { filterReports, type Report, type ReportFilters } from "./model";

/** The two segmented controls. Counts show only once the reports have loaded. */
export function renderTools(reports: readonly Report[] | undefined, f: ReportFilters): string {
  const open = reports ? reports.filter((r) => r.open).length : null;
  const all = reports ? reports.length : null;
  return `<div class="tools">${seg(
    "State",
    [
      ["open", "Open", open],
      ["all", "All", all],
    ],
    f.st,
    "repopen",
  )}${seg(
    "From",
    [
      ["all", "Everywhere"],
      ["content", "In the app"],
      ["tex", "Texted to Tex"],
    ],
    f.src,
    "repsrc",
  )}</div>`;
}

function card(r: Report, x: string | null): string {
  return `<button class="card" data-act="sel" data-id="${esc(r.id)}" aria-selected="${x === r.id}"><div class="row"><span class="t" style="flex:1">${esc(r.title)}</span>${pill(r.src === "tex" ? "Tex" : "App", r.src === "tex" ? "team" : "")}${r.open ? pill("open", "warn") : ""}</div><div class="sub">${esc(r.kind)} · ${esc(r.reporter)} · ${esc(r.when)}</div></button>`;
}

export function renderReports(view: { reports: readonly Report[] | undefined; f: ReportFilters; x: string | null; banner: string | null }): string {
  const tools = renderTools(view.reports, view.f);
  if (view.reports === undefined) return `${tools}<div class="empty">Loading</div>`;
  const list = filterReports(view.reports, view.f);
  const banner = view.banner ? `<div class="banner"><span class="tx">${esc(view.banner)}</span></div>` : "";
  return `${tools}${banner}<div class="list">${list.map((r) => card(r, view.x)).join("") || '<div class="empty">Nothing open.</div>'}</div>`;
}

/** The side panel for one report, or null when there is none to show. */
export function renderProps(r: Report | undefined): string | null {
  if (!r) return null;
  const thread = r.thread
    ? `<div class="ppb"><div class="h">The texts</div><div class="thr">${r.thread.map(([who, text]) => `<div class="bub ${who === "tex" ? "tex" : ""}">${esc(text)}</div>`).join("")}</div>${REPLAY}</div>`
    : "";
  const comment = r.src === "tex" && r.open ? '<label class="field">Comment<textarea id="cm" placeholder="What you found"></textarea></label>' : "";
  const id = esc(r.id);
  const actions = r.open
    ? r.src === "tex"
      ? `<button class="primary" data-act="triage" data-id="${id}">Send to triage</button><button class="ghost" data-act="handle" data-id="${id}">Retire</button>`
      : `<button class="primary" data-act="handle" data-id="${id}">Mark handled</button>`
    : `<span class="sub" style="flex:1">${esc(r.handled ?? "")}</span><button class="ghost" data-act="reopen" data-id="${id}">Reopen</button>`;
  return `<div class="pph"><h3 tabindex="-1">${esc(r.title)}</h3><button class="ib sm" data-act="close" aria-label="Close">${ic("x")}</button></div>
 <div class="kv"><span class="k">From</span><span class="v">${esc(r.reporter)}</span><span class="k">About</span><span class="v">${esc(r.about)}</span><span class="k">Kind</span><span class="v">${esc(r.kind)}</span><span class="k">When</span><span class="v">${esc(r.when)}</span></div>
 <div class="ppb">${esc(r.details)}</div>
 ${thread}
 ${comment}
 <div class="row">${actions}</div>`;
}
