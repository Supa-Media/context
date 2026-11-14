/**
 * Search's "Speed and quality" view: the artifact's `P.search` quality branch, over the `quality`
 * field of `admin.searchReport` (what people do with the results: opened, first result, nothing).
 * Percentages are 0-100 numbers from the server; `series` has one bucket per hour (one day) or per day.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { days, delta, esc, kpi, legend, lines, panel, pill, seg } from "../kit";
import { S, WIN } from "../state";

/** The report the server returns (`admin.searchReport`); the quality figures are its `quality` field. */
export type SearchReport = FunctionReturnType<typeof api.functions.admin.searchReport>;
export type SearchQuality = SearchReport["quality"];
export type QualityKey = "all" | "app" | "ai" | "tex";
type QualityView = SearchQuality[QualityKey];
/** One x-axis point: the same bucket shape for each searcher, under its key. */
type QualityBucket = SearchQuality["series"][number][QualityKey];

/** The "Who searched" options: the artifact's keys and labels. */
export const FROM_OPTIONS: Array<[QualityKey, string]> = [
  ["all", "Everyone"],
  ["app", "In the app"],
  ["ai", "AI clients"],
  ["tex", "Tex"],
];

const INDEX_LABELS: Record<string, string> = {
  fast: "Fast search",
  index: "Index in the bucket",
  scan: "Reading notes one by one",
  none: "No index yet",
  failed: "Failed or timed out",
};

const EMPTY_VIEW: QualityView = {
  n: 0,
  found: 0,
  pos: [0, 0, 0, 0, 0],
  next: [0, 0],
  ms: [0, 0],
  foundBefore: 0,
};

/** The quality figures, when the server sends them; the page draws zeros until then. */
export const qualityOf = (report: SearchReport | undefined): SearchQuality | null =>
  report?.quality ?? null;

/** The "Who searched" value in the address, when it names one of the four. */
export function fromKey(raw: string): QualityKey {
  return FROM_OPTIONS.some(([k]) => k === raw) ? (raw as QualityKey) : "all";
}

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;
const count = (n: number) => n.toLocaleString("en-US");

/** One value per x-axis point of the window; zeros where the server sent no bucket. */
function seriesFor(
  buckets: QualityBucket[],
  pick: (b: QualityBucket) => number,
): number[] {
  // The log keeps 30 days, so a 90-day window gets 30 buckets: draw what there is, never a tail of zeros.
  if (buckets.length > 0 && buckets.length < days().length) return buckets.map(pick);
  return days().map((_, i) => (buckets[i] ? pick(buckets[i]) : 0));
}

/**
 * The whole quality view under its tabs. `loading` draws the same panels with a Loading body and
 * the tiles as a dash; with no `quality` yet, the figures are zeros.
 */
export function qualityHtml(
  tabs: string,
  quality: SearchQuality | null,
  loading: boolean,
): string {
  const k = fromKey(S.f.from);
  const v = quality?.[k] ?? EMPTY_VIEW;
  const found = v.found;
  // With no searches there is no "nothing" either: 0%, not 100%.
  const none = v.n > 0 ? 100 - found : 0;
  const val = (x: string) => (loading ? "…" : x);
  const body = (html: string) =>
    loading ? '<div class="empty">Loading…</div>' : html;
  const who = seg("Who searched", FROM_OPTIONS, k, "from");

  const kpis = `<div class="kpis">${kpi("Searches", val(count(v.n)), loading ? "" : S.d === "90" ? "in 30 days, all the log keeps" : "in " + WIN[S.d])}${kpi("Found what they wanted", val(found + "%"), loading ? "" : `opened a result · ${delta(found - v.foundBefore, true, " pts")} vs before`)}${kpi("Took the first result", val(pct(v.pos[0], found) + "%"), loading ? "" : "of searches that found something")}${kpi("Typical time", val(v.ms[0] + " ms"), loading ? "" : `slowest 1 in 20: ${v.ms[1]} ms`)}</div>`;

  const bars: Array<[string, number]> = [
    ["#1", v.pos[0]],
    ["#2", v.pos[1]],
    ["#3", v.pos[2]],
    ["#4–5", v.pos[3]],
    ["#6 or lower", v.pos[4]],
    ["Nothing", none],
  ];
  const mx = Math.max(...bars.map((b) => b[1]), 1);
  const picks = panel(
    "s-pick",
    "Which result they open",
    k === "all" || k === "app" ? "" : "opened = fetched after searching",
    body(
      `<div class="fun">${bars.map(([l, x]) => `<div class="r"><span>${l}</span><span class="tr"><span class="bb" style="width:${(x / mx) * 100}%;${l === "Nothing" ? "background:var(--warn)" : ""}"></span></span><span class="t">${x}%</span></div>`).join("")}</div>`,
    ),
  );
  const gaveUp: Array<[string, number]> = [
    ["Searched again", v.next[0]],
    ["Gave up", v.next[1]],
  ];
  const nothing = panel(
    "s-none",
    "When they open nothing",
    loading ? "" : none + "% of searches",
    body(
      `<div class="fun">${gaveUp.map(([l, x]) => `<div class="r"><span>${l}</span><span class="tr"><span class="bb" style="width:${none > 0 ? (x / none) * 100 : 0}%;background:var(--warn)"></span></span><span class="t">${x}%</span></div>`).join("")}</div><div class="sub" style="margin-top:8px">Searching again within a minute usually means the first words missed.</div>`,
    ),
  );

  // The server sends one row per bucket, each with every searcher's figures; this page draws the chosen one.
  const sr: QualityBucket[] = (quality?.series ?? []).map((row) => row[k]);
  const qpanel = panel(
    "s-q",
    "Quality per " + (S.d === "1" ? "hour" : "day"),
    "",
    body(
      lines(
        [
          { v: seriesFor(sr, (b) => b.found), c: "ok" },
          { v: seriesFor(sr, (b) => b.first), c: "c1" },
        ],
        { fmt: (x) => x + "%" },
      ) +
        legend("sq", [
          ["ok", "Found what they wanted"],
          ["c1", "Took the first result"],
        ]),
    ),
  );
  const time = panel(
    "s-t",
    "Search time",
    "",
    body(
      lines(
        [
          { v: seriesFor(sr, (b) => b.p95), c: "c4" },
          { v: seriesFor(sr, (b) => b.p50), c: "c1", area: true },
        ],
        { fmt: (x) => x + " ms" },
      ) +
        legend("srch", [
          ["c1", "Typical time"],
          ["c4", "Slowest 1 in 20"],
        ]),
    ),
  );

  const byIndex = quality?.byIndex ?? [];
  const which = panel(
    "s-which",
    "By index",
    "",
    body(
      `<div class="tbl"><table><tr><th>Answered by</th><th class="r">Share</th><th class="r">Found</th><th class="r hp">First result</th><th class="r">Typical</th></tr>${
        byIndex
          .map(
            (row) =>
              `<tr><td>${esc(INDEX_LABELS[row.answeredBy] ?? row.answeredBy)}</td><td class="r">${row.share}%</td><td class="r">${row.found}%</td><td class="r hp">${row.first}%</td><td class="r">${row.p50} ms</td></tr>`,
          )
          .join("") ||
        '<tr><td colspan="5" class="empty">No searches in this window</td></tr>'
      }</table></div>`,
    ),
  );
  const misses = quality?.misses ?? [];
  const miss = panel(
    "s-miss",
    "Where search misses most",
    "",
    body(
      `<div class="tbl"><table><tr><th>Workspace</th><th class="r">Searches</th><th class="r">Found</th><th class="hp">Why</th></tr>${
        misses
          .map((row) => {
            // `why` is null when nothing explains the miss yet: no reason, no pill, and no link.
            const failed = row.why !== null && row.why.includes("failed");
            const link =
              failed && row.slug !== null
                ? ` class="click" tabindex="0" data-act="goidx" data-id="${esc(row.slug)}"`
                : "";
            const name =
              row.slug === null ? "a deleted workspace" : `@${esc(row.slug)}`;
            return `<tr${link}><td>${name}</td><td class="r">${row.n}</td><td class="r">${row.found}%</td><td class="hp">${row.why === null ? '<span class="sub">—</span>' : pill(row.why, failed ? "bad" : "")}</td></tr>`;
          })
          .join("") ||
        '<tr><td colspan="4" class="empty">No misses in this window</td></tr>'
      }</table></div><div class="sub" style="margin-top:8px">What people typed is never shown here.</div>`,
    ),
  );

  return `<div class="tools">${tabs}${who}</div>${kpis}<div class="grid2">${picks}${nothing}</div>${qpanel}${time}<div class="grid2">${which}${miss}</div>`;
}
