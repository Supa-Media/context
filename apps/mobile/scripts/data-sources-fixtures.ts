/**
 * The invented workspace the data sources shots draw (`data-sources-shots.ts`,
 * stage B, and `area-metric-shots.ts`, stage C): a data folder with GitHub,
 * Cloudflare, Stripe, the built-in Context source and an Eval CI push source,
 * their sheets, and the six metric notes the boards show. Every value is
 * made up here, deterministically, so each run draws the same numbers.
 */

import type { FolderListSource, ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

/** Tuesday 24 November 2026, 11:00 UTC, as the boards are drawn. */
export const NOW = Date.UTC(2026, 10, 24, 11, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** A small deterministic generator, so every run draws the same numbers. */
export function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
export const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const csv = (header: string, rows: readonly (readonly (string | number)[])[]) => `${header}\n${rows.map((row) => row.join(",")).join("\n")}\n`;

/* As the boards draw them, newest week first: PRs merged each calendar week, their lines in thousands, and open-to-live minutes each rolling week. */
export const MERGED_PER_WEEK = [7, 6, 7, 9, 6, 8];
export const LINES_PER_WEEK = [18.2, 17, 22, 12, 19, 14];
export const LEAD_PER_WEEK = [22, 24, 31, 28, 37, 34, 41];

export function pullRequests(): string {
  const rand = seeded(7);
  const rows: (string | number)[][] = [];
  const count = 1284;
  const span = 26 * 7 * DAY;
  const monday = Date.UTC(2026, 10, 23);
  const merges = new Map<number, number>();
  // Newest first, so each week's quota goes to its latest pull requests.
  for (let n = count - 1; n >= 0; n -= 1) {
    const opened = NOW - 50 * MIN - Math.floor(((count - 1 - n) / count) * span);
    const rolling = Math.floor((NOW - opened) / (7 * DAY));
    const lead = (LEAD_PER_WEEK[rolling] ?? 41) - 1 + Math.floor(rand() * 3);
    const week = Math.max(0, Math.ceil((monday - (opened + lead * MIN)) / (7 * DAY)));
    const quota = MERGED_PER_WEEK[week] ?? 9;
    const done = merges.get(week) ?? 0;
    const mergedHere = done < quota && rand() < (week === 0 ? 1 : 0.5);
    if (mergedHere) merges.set(week, done + 1);
    const merged = mergedHere ? iso(opened + (lead - 4) * MIN) : "";
    const deployed = mergedHere ? iso(opened + lead * MIN) : "";
    // Each merged change carries its week's share of the lines, three parts added to one removed.
    const lines = Math.round(((LINES_PER_WEEK[week] ?? 15) * 1000) / quota);
    const added = mergedHere ? Math.round(lines * 0.75) : 0;
    const removed = mergedHere ? lines - added : 0;
    rows.unshift([n % 3 === 0 ? "acme/context" : "acme/app", 4000 + n, `Change ${n}`, ["dev", "sam", "ana"][n % 3]!, iso(opened), merged, deployed, added, removed]);
  }
  return csv("repo,number,title,author:person,opened:date,merged:date,deployed:date,lines added:number,lines removed:number", rows);
}

export function deploys(): string {
  const rows: (string | number)[][] = [];
  for (let n = 0; n < 412; n += 1) {
    const started = NOW - 78 * MIN - n * 11 * HOUR;
    rows.push(["acme/app", `a${(n * 7919).toString(16)}`, n % 4 === 0 ? "staging" : "production", iso(started), iso(started + 6 * MIN), "ok"]);
  }
  return csv("repo,sha,environment,started:date,finished:date,status", rows);
}

export function workflowRuns(): string {
  const rows: (string | number)[][] = [];
  for (let n = 0; n < 3920; n += 1) {
    const started = NOW - 60 * MIN - n * 70 * MIN;
    rows.push(["acme/app", "ci", "main", iso(started), iso(started + 9 * MIN), "success"]);
  }
  return csv("repo,workflow,branch,started:date,finished:date,conclusion", rows);
}

/** Revenue per AI dollar by month, June to November, as board 12 draws it. */
export const RATIO = [6.1, 6.8, 7.4, 8.2, 8.9, 9.4];

export function aiSpend(): string {
  const rows: (string | number)[][] = [];
  for (let n = 181; n >= 0; n -= 1) {
    const at = Date.UTC(2026, 10, 24) - n * DAY;
    rows.push([day(at), "claude", (40).toFixed(2)]);
  }
  return csv("date:date,model,usd:number", rows);
}

export function revenue(): string {
  const rows: (string | number)[][] = [];
  for (let n = 179; n >= 0; n -= 1) {
    const at = Date.UTC(2026, 10, 24) - n * DAY;
    const month = new Date(at).getUTCMonth();
    const ratio = RATIO[month - 5] ?? 6;
    for (const plan of ["Team", "Pro", "Free"]) rows.push([day(at), plan, ((40 * ratio) / 3).toFixed(4)]);
  }
  return csv("date:date,plan,usd:number", rows);
}

export function benchRuns(): string {
  const rand = seeded(11);
  const rows: (string | number)[][] = [];
  const count = 2031;
  for (let n = count - 1; n >= 0; n -= 1) {
    const at = NOW - 12 * MIN - n * 2 * HOUR;
    const daysAgo = Math.floor((NOW - at) / DAY);
    const p95 = Math.round(1436 - daysAgo * 18 - rand() * 40);
    const requests = 1200;
    const errors = Math.round(requests * Math.max(0.004, 0.022 - daysAgo * 0.0028) + (rand() - 0.5));
    rows.push([iso(at), n % 2 === 0 ? "search" : "answers", p95, errors, requests]);
  }
  return csv("date:date,suite,p95 ms:number,errors:number,requests:number", rows);
}

export const METRICS: readonly { slug: string; props: Record<string, string>; body: string }[] = [
  { slug: "open-to-live", props: { metric: "Open to live", formula: "median(github/pull-requests.deployed - opened)", every: "7 days", format: "duration" }, body: "" },
  { slug: "prs-merged-week", props: { metric: "PRs merged / week", formula: "count(github/pull-requests.merged)", every: "week", format: "0" }, body: "" },
  { slug: "lines-changed-week", props: { metric: "Lines changed / week", formula: "sum(github/pull-requests.lines added + lines removed)", every: "week", format: "0.0k" }, body: "" },
  {
    slug: "revenue-per-ai-dollar",
    props: { metric: "Revenue per AI dollar", formula: "sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.usd)", every: "month", format: "$0.00" },
    body: "Stripe revenue in a month, divided by what Cloudflare AI cost that month. Written by Claude from “revenue per dollar of AI spend, monthly”, checked by Dev.",
  },
  { slug: "error-rate", props: { metric: "Error rate", formula: "sum(eval-ci/bench-runs.errors) / sum(eval-ci/bench-runs.requests)", every: "day", format: "0.0%" }, body: "" },
  { slug: "p95-latency", props: { metric: "p95 latency", formula: "p95(eval-ci/bench-runs.p95 ms)", every: "day", format: "0" }, body: "" },
];

export const ABOUTS: Record<string, { props: Record<string, string | string[]>; lede?: string; updatedAt: number }> = {
  "data/github": {
    props: { source: "github", repositories: ["acme/app", "acme/context"], every: "hour", history: "last 90 days", access: "read-only" },
    lede: "Pull requests, deploys and workflow runs from acme/app and acme/context, kept as plain sheets.",
    updatedAt: NOW - 3 * DAY,
  },
  "data/cloudflare": { props: { source: "cloudflare", every: "hour" }, updatedAt: NOW - 9 * DAY },
  "data/stripe": { props: { source: "stripe", every: "hour" }, updatedAt: NOW - 9 * DAY },
  "data/context": {
    props: { source: "context", "notes-by-status": ["areas/reliability/incidents/", "projects/"], "time-to-answered": ["inbox/questions/"] },
    updatedAt: NOW - 6 * DAY,
  },
  "data/eval-ci": {
    props: { source: "push", name: "Eval CI" },
    lede: "Rows sent by our eval job. Anything with a key can add rows here; nothing can read them back with it.",
    updatedAt: NOW - 21 * DAY,
  },
};

export const AREAS: Record<string, string> = {
  Velocity: "Open to live · target under 30 min",
  Engineering: "PRs merged / week · target over 10",
  Finance: "Revenue per AI dollar · target over $5",
  MCP: "Error rate · target under 1%",
  "Search quality": "p95 latency · target under 1000",
};

export const SHEETS: Record<string, string> = {
  "data/github/pull-requests.csv": pullRequests(),
  "data/github/deploys.csv": deploys(),
  "data/github/workflow-runs.csv": workflowRuns(),
  "data/cloudflare/ai-spend.csv": aiSpend(),
  "data/stripe/revenue.csv": revenue(),
  "data/eval-ci/bench-runs.csv": benchRuns(),
};

export function countedNotes(): ListNote[] {
  const out: ListNote[] = [];
  const add = (folder: string, status: string, n: number) => {
    for (let i = 0; i < n; i += 1) out.push({ path: `${folder}/${status}-${i}.md`, properties: { status } });
  };
  add("areas/reliability/incidents", "closed", 14);
  add("projects", "active", 6);
  add("projects", "done", 31);
  for (let i = 0; i < 12; i += 1) {
    const asked = NOW - (i + 1) * 9 * HOUR;
    out.push({ path: `inbox/questions/q-${i}.md`, properties: { asked: iso(asked), answered: iso(asked + (30 + i * 7) * MIN) } });
  }
  return out;
}

export const NOTES: ListNote[] = [
  ...Object.entries(ABOUTS).map(([folder, about]) => ({
    path: `${folder}/about.md`,
    updatedAt: about.updatedAt,
    properties: about.props,
    ...(about.lede === undefined ? {} : { lede: about.lede }),
  })),
  ...METRICS.map((m) => ({ path: `data/metrics/${m.slug}.md`, updatedAt: NOW - 5 * DAY, properties: m.props })),
  ...Object.entries(AREAS).map(([area, metric]) => ({ path: `areas/${area}/about.md`, properties: { metric } })),
  { path: "areas/reliability/about.md", properties: {} },
  ...countedNotes(),
];

export function entry(path: string, kind: "file" | "folder", updatedAt?: number): FileEntry {
  return {
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  } as FileEntry;
}

export const SOURCES = ["github", "cloudflare", "stripe", "context", "eval-ci"];
export const LISTINGS: Record<string, FolderListing> = {};
export function listing(path: string, entries: FileEntry[]): void {
  LISTINGS[path] = { path, folderDefault: "team", truncated: false, manifestUsable: true, entries };
}
listing("data", [...SOURCES.map((s) => entry(`data/${s}`, "folder")), entry("data/metrics", "folder")]);
for (const s of SOURCES) {
  const sheets = Object.keys(SHEETS).filter((p) => p.startsWith(`data/${s}/`));
  listing(`data/${s}`, [entry(`data/${s}/about.md`, "file", ABOUTS[`data/${s}`]!.updatedAt), ...sheets.map((p) => entry(p, "file", NOW - HOUR))]);
}
listing("data/metrics", METRICS.map((m) => entry(`data/metrics/${m.slug}.md`, "file", NOW - 5 * DAY)));

export const source: FolderListSource = {
  load: async (folder, subfolders) => ({
    notes: NOTES.filter((note) => {
      const prefix = folder === "" ? "" : `${folder}/`;
      return note.path.startsWith(prefix) && (subfolders || !note.path.slice(prefix.length).includes("/"));
    }),
    complete: true,
  }),
  readBody: async (path) => (SHEETS[path] === undefined ? null : { text: SHEETS[path]!, encrypted: false }),
};

export type Nesting = { listingOf: (path: string) => FolderListing | undefined; loadListing: () => void };
export const nesting: Nesting = {
  listingOf: (path: string) => LISTINGS[path],
  loadListing: () => {},
};
