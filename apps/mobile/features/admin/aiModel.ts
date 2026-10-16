/**
 * The AI tab's workflow model (boards 8-16 of the AI tools plan, the owner,
 * 2026-10-16: "I want the workflow to be something that AI can do on its own
 * … but also someone can go in and audit"). Everything here is read from the
 * notes `./aiCatalog.ts` sorts, and from the text of the scores notes; there
 * is no other store, so whatever Claude or the improver writes into
 * `@context-lc ai/` shows here the same way a person's edit does.
 *
 * The loop: golden cases set the mark; a setup is a copy of live with one
 * change (`based_on:`, `change:`); the bench runs it beside live; the
 * comparison shows which cases flipped; a person promotes. Nothing an AI does
 * makes a setup live or a drafted case count.
 *
 *   setup front matter   job, based_on (or came_from), change (or why),
 *                        status, made_by, live_since
 *   production           from: the setup it was promoted from, live_since,
 *                        promoted_by
 *   a scores note        "## Scored by" tables, "Why gates failed" lines and,
 *                        from the bench since 2026-10-16, "### Case by case"
 */

export * from "./aiNotes";

import { AI_JOBS, type AiCatalog, type AiJob, type AiNoteRow, type GateMiss, type JobRow, type ScoreRow } from "./aiCatalog";

const text = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
};

// ---------------------------------------------------------------------------
// Sizes

/** Roughly four characters a token, as every model in use counts English. */
export const CHARS_PER_TOKEN = 4;

export function tokensOf(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** `6912` → `6.9k`, `412` → `412`. */
export function compact(value: number): string {
  const size = Math.abs(value);
  if (size < 1000) return String(Math.round(value));
  const k = value / 1000;
  return `${Math.abs(k) >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

/** A prompt's size as a row reads it: `6.9k tokens`, or null when the tree did not list it. */
export function sizeLabel(chars: number | null): string | null {
  return chars === null ? null : `${compact(tokensOf(chars))} tokens`;
}

/** A size difference in tokens, signed: `+1.5k`, `−10`, `0`. */
export function sizeDelta(chars: number | null, from: number | null): string | null {
  if (chars === null || from === null) return null;
  const delta = tokensOf(chars) - tokensOf(from);
  if (delta === 0) return "0";
  return `${delta > 0 ? "+" : "−"}${compact(Math.abs(delta))}`;
}

// ---------------------------------------------------------------------------
// Setups

export type SetupStatus = "live" | "beat live" | "tied" | "lost" | "not run" | "draft" | "retired";

export interface SetupInfo {
  row: AiNoteRow;
  /** The file name, which is how the bench names it in a scores table. */
  name: string;
  job: string;
  basedOn: string | null;
  change: string | null;
  madeBy: string | null;
  /** The status its front matter claims, before the runs are read. */
  claimed: SetupStatus | null;
  retired: boolean;
}

const STATUSES: readonly SetupStatus[] = ["live", "beat live", "tied", "lost", "not run", "draft", "retired"];

/** `ai/setups/<job>/<name>.md` or `ai/setups/retired/<job>/<name>.md` → `<job>`. */
export function setupJob(path: string): string | null {
  const parts = path.split("/");
  if (parts[0] !== "ai" || parts[1] !== "setups") return null;
  if (parts[2] === "retired") return parts.length === 5 ? parts[3]! : null;
  return parts.length === 4 ? parts[2]! : null;
}

/**
 * A note's long `why:` or `came_from:` as one cell holds it: its first
 * sentence. Real setups carry a paragraph there, and a row is one line.
 */
export function firstSentence(value: string | null): string | null {
  if (value === null) return null;
  const end = /[.!?](?=\s|$)/.exec(value);
  return (end ? value.slice(0, end.index) : value).trim() || null;
}

/** The setup a `came_from:` sentence starts with (`guide-haiku of round five …` → `guide-haiku`), or the one it names by path. */
function setupNamed(value: string | null): string | null {
  if (value === null) return null;
  const path = /setups\/[a-z0-9-]+\/([A-Za-z0-9_-]+)/.exec(value)?.[1];
  if (path) return path;
  const lead = /^([a-z0-9]+(?:-[a-z0-9]+)+)\b/.exec(value)?.[1];
  return lead ?? null;
}

export function setupInfo(row: AiNoteRow): SetupInfo {
  const props = row.properties;
  const retired = row.path.startsWith("ai/setups/retired/");
  const status = text(props.status)?.toLowerCase() ?? null;
  return {
    row,
    name: row.name,
    job: text(props.job) ?? setupJob(row.path) ?? "",
    // `came_from: guide-haiku of round five` names the setup it revised, under the same name: no base.
    basedOn: [text(props.based_on) ?? setupNamed(text(props.came_from))].find((name) => name !== row.name) ?? null,
    change: text(props.change) ?? firstSentence(text(props.why)),
    madeBy: text(props.made_by),
    claimed: retired ? "retired" : STATUSES.includes(status as SetupStatus) ? (status as SetupStatus) : null,
    retired,
  };
}

/**
 * The setup a job's production note says it was promoted from: its `from:`,
 * or, on a note promoted before `from:` existed, the last setup its
 * `came_from:` names.
 */
export function liveFrom(production: AiNoteRow | null): string | null {
  if (production === null) return null;
  const from = text(production.properties.from);
  if (from !== null) return from;
  const named = [...(text(production.properties.came_from) ?? "").matchAll(/setups\/[a-z0-9-]+\/([A-Za-z0-9_-]+)/g)];
  return named.at(-1)?.[1] ?? null;
}

export function liveSince(production: AiNoteRow | null): string | null {
  return production === null ? null : text(production.properties.live_since);
}

/**
 * Who promoted it, as a name: `promoted_by:` often runs on into a paragraph
 * of who promoted which part when (`Seyi, 2026-10-11 (website skills: …)`),
 * and a name is what a cell has room for.
 */
export function promotedBy(production: AiNoteRow | null): string | null {
  return production === null ? null : nameOf(text(production.properties.promoted_by));
}

/** The name a `made_by:` or `promoted_by:` line starts with, before any date, list or aside. */
export function nameOf(value: string | null): string | null {
  if (value === null) return null;
  const name = value.split(/[,;(]| on \d| \d{4}-/)[0]!.trim();
  return name === "" ? null : name.length > 24 ? `${name.slice(0, 23)}…` : name;
}

/** The first day a line names (`2026-10-11`), for a promotion that has no `live_since:`. */
function dayIn(value: string | null): string | null {
  return /\d{4}-\d{2}-\d{2}/.exec(value ?? "")?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Runs: a scores note's text

export interface SetupScore {
  setup: string;
  /** 0-100, or null when the round could not score it. */
  score: number | null;
  scoreText: string;
  gatesPassed: boolean;
  /** Question numbers whose gate failed. */
  gatesFailed: number[];
  judgeLines: string;
  /** Dollars a question. */
  price: number | null;
  /** Median seconds. */
  speed: number | null;
  texts: number | null;
  errors: number;
  goodEnough: boolean;
  misses: GateMiss[];
}

export interface CaseCell {
  passed: number;
  runs: number;
}

export interface CaseRow {
  question: number;
  title: string;
  /** By setup name, as the table's columns name them. */
  cells: Record<string, CaseCell>;
}

export interface RunRead {
  judge: string | null;
  date: string | null;
  setups: SetupScore[];
  /** The latest round's case-by-case table; null for rounds scored before it was written. */
  cases: CaseRow[] | null;
  best: string | null;
}

const number = (cell: string | undefined, pattern: RegExp): number | null => {
  const match = pattern.exec(cell ?? "");
  return match ? Number(match[1]) : null;
};

/** The table rows directly under `at` in `body`, as cells, stopping at its first non-table line. */
function tableAfter(body: string, at: number): string[][] {
  const lines = body.slice(at).split("\n");
  const start = lines.findIndex((line) => line.startsWith("| "));
  if (start === -1) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    rows.push(line.replace(/^\|\s?/, "").replace(/\s?\|\s*$/, "").split(" | ").map((cell) => cell.trim()));
  }
  // The header and its `---` line.
  return rows.slice(2);
}

/**
 * The latest "## Scored by" section of a scores note: every setup's row, the
 * lines that broke its gates, and the case-by-case table when the round
 * wrote one. `null` when the note has no scored section.
 */
export function readRun(raw: string): RunRead | null {
  const at = `\n${raw}`.lastIndexOf("\n## Scored by ");
  if (at === -1) return null;
  const section = raw.slice(Math.max(0, at - 1));
  const end = section.indexOf("\n## ", 3);
  const body = end === -1 ? section : section.slice(0, end);
  const head = /^## Scored by (.+?), (\d{4}-\d{2}-\d{2})/.exec(body.trimStart());
  const setups: SetupScore[] = tableAfter(body, 0)
    .filter((cells) => cells.length >= 9)
    .map((cells) => {
      const gates = cells[2] ?? "";
      const failed = /\(([^)]*)\)/.exec(gates)?.[1] ?? "";
      return {
        setup: cells[0]!,
        score: number(cells[1], /(\d+(?:\.\d+)?)%/),
        scoreText: cells[1] ?? "",
        gatesPassed: gates === "passed",
        gatesFailed: [...failed.matchAll(/q(\d+)/g)].map((match) => Number(match[1])),
        judgeLines: cells[3] ?? "",
        price: number(cells[4], /\$(\d+(?:\.\d+)?)/),
        speed: number(cells[5], /(\d+(?:\.\d+)?)\s*s/),
        texts: number(cells[6], /(\d+(?:\.\d+)?)/),
        errors: number(cells[7], /(\d+)/) ?? 0,
        goodEnough: cells[8] === "yes",
        misses: [],
      };
    });
  for (const setup of setups) {
    const why = body.indexOf(`Why gates failed, ${setup.setup}:`);
    if (why === -1) continue;
    for (const line of body.slice(why).split("\n").slice(1)) {
      if (!line.startsWith("- ")) break;
      const match = /^- q(\d+) (.+?):\s*(.+)$/.exec(line);
      if (match) setup.misses.push({ question: Number(match[1]), rule: match[2]!, runs: match[3]! });
    }
  }
  let cases: CaseRow[] | null = null;
  const grid = body.indexOf("\n### Case by case");
  if (grid !== -1) {
    const header = body.slice(grid).split("\n").find((line) => line.startsWith("| "));
    const names = header ? header.replace(/^\|\s?/, "").replace(/\s?\|\s*$/, "").split(" | ").slice(1).map((cell) => cell.trim()) : [];
    cases = tableAfter(body, grid + 1).flatMap((cells) => {
      const title = /^(\d+)\.\s*(.*)$/.exec(cells[0] ?? "");
      if (!title) return [];
      const row: CaseRow = { question: Number(title[1]), title: title[2]!, cells: {} };
      names.forEach((name, index) => {
        const cell = /(\d+) of (\d+)/.exec(cells[index + 1] ?? "");
        if (cell) row.cells[name] = { passed: Number(cell[1]), runs: Number(cell[2]) };
      });
      return [row];
    });
  }
  // A round that did not write the line still says which setups were good enough.
  const said = /Best setup that passes every bar: (.+?)\.\s*$/m.exec(body)?.[1];
  const passing = setups.filter((row) => row.goodEnough).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]?.setup ?? null;
  const best = said === undefined ? passing : said === "none" ? null : said;
  return { judge: head?.[1] ?? null, date: head?.[2] ?? null, setups, cases, best };
}

/** `2026-10-14 core gh-33 scores` → `gh-33`; the label a run goes by. */
export function runLabel(row: ScoreRow): string {
  return /\bgh-\d+\b/.exec(row.name)?.[0] ?? row.day ?? row.name;
}

/** The order runs happened in: the day, then the bench's run number. */
export function runOrder(a: ScoreRow, b: ScoreRow): number {
  const n = (row: ScoreRow) => Number(/\bgh-(\d+)\b/.exec(row.name)?.[1] ?? 0);
  return (a.day ?? "").localeCompare(b.day ?? "") || n(a) - n(b) || (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
}

/** A run's row for a setup: by its file name, or `production` for whatever was live. */
export function scoreFor(run: RunRead, setup: string, live: string | null): SetupScore | null {
  return (
    run.setups.find((row) => row.setup === setup) ??
    (setup === live ? run.setups.find((row) => row.setup === "production") ?? null : null)
  );
}

/** The row that stands for live in a run: the live setup by name, else `production`, else the first. */
export function liveScore(run: RunRead, live: string | null): SetupScore | null {
  return (live === null ? null : scoreFor(run, live, live)) ?? run.setups.find((row) => row.setup === "production") ?? run.setups[0] ?? null;
}

// ---------------------------------------------------------------------------
// A job's page

export interface Candidate extends SetupInfo {
  status: SetupStatus;
  /** Its score in the latest run that had it, beside live's in that run. */
  score: SetupScore | null;
  liveScore: SetupScore | null;
  /** The run the score is from. */
  run: ScoreRow | null;
  /** Its size and the size of what it was based on (or live), in chars. */
  size: number | null;
  baseSize: number | null;
}

export interface JobPage {
  job: AiJob;
  row: JobRow;
  /** The setup live came from, by name; null when production names none. */
  live: string | null;
  candidates: Candidate[];
  retired: Candidate[];
  /** The runs on this job's tests, oldest first, with their read text when it has been read. */
  runs: { row: ScoreRow; read: RunRead | null }[];
}

/** Every run on a job's tests, oldest first. */
export function jobRuns(catalog: AiCatalog, job: string): ScoreRow[] {
  const row = catalog.jobs.find((item) => item.job.key === job);
  const tests = new Set((row?.tests ?? []).map((test) => test.name));
  return catalog.results.filter((result) => tests.has(result.test) || result.test === job).sort(runOrder);
}

function candidateOf(
  info: SetupInfo,
  live: string | null,
  runs: readonly { row: ScoreRow; read: RunRead | null }[],
  sizes: ReadonlyMap<string, number | null>,
  liveSize: number | null,
): Candidate {
  let found: { run: ScoreRow; score: SetupScore; live: SetupScore | null } | null = null;
  for (const { row, read } of [...runs].reverse()) {
    if (read === null) continue;
    const score = scoreFor(read, info.name, live);
    if (score === null) continue;
    found = { run: row, score, live: liveScore(read, live) };
    break;
  }
  let status: SetupStatus;
  if (info.retired) status = "retired";
  else if (live !== null && info.name === live) status = "live";
  else if (info.claimed === "draft") status = "draft";
  else if (found === null) status = info.claimed === "lost" ? "lost" : "not run";
  else {
    const mine = found.score;
    const theirs = found.live;
    if (theirs === null || theirs.setup === mine.setup) status = info.claimed ?? "not run";
    else if (!mine.gatesPassed && theirs.gatesPassed) status = "lost";
    else if ((mine.score ?? 0) > (theirs.score ?? 0) && (mine.gatesPassed || !theirs.gatesPassed)) status = "beat live";
    else if ((mine.score ?? 0) === (theirs.score ?? 0)) status = "tied";
    else status = "lost";
  }
  const baseSize = info.basedOn !== null && sizes.has(info.basedOn) ? sizes.get(info.basedOn)! : liveSize;
  return {
    ...info,
    status,
    score: found?.score ?? null,
    liveScore: found?.live ?? null,
    run: found?.run ?? null,
    size: info.row.size,
    baseSize,
  };
}

const STATUS_ORDER: Record<SetupStatus, number> = { live: 0, "beat live": 1, tied: 2, "not run": 3, draft: 4, lost: 5, retired: 6 };

/** A job's page, from the catalog and whichever scores notes have been read (`reads`, by path). */
export function jobPage(catalog: AiCatalog, job: string, reads: ReadonlyMap<string, RunRead>): JobPage | null {
  const row = catalog.jobs.find((item) => item.job.key === job);
  if (!row) return null;
  const live = liveFrom(row.setup);
  const runs = jobRuns(catalog, job).map((result) => ({ row: result, read: reads.get(result.path) ?? null }));
  const mine = (setup: AiNoteRow) => setupJob(setup.path) === job;
  const own = catalog.setups.filter(mine).map(setupInfo);
  const gone = catalog.retired.filter(mine).map(setupInfo);
  const sizes = new Map([...own, ...gone].map((info) => [info.name, info.row.size]));
  const liveSize = row.setup?.size ?? null;
  const candidates = own
    .map((info) => candidateOf(info, live, runs, sizes, liveSize))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0));
  const retired = gone.map((info) => candidateOf(info, live, runs, sizes, liveSize));
  return { job: row.job, row, live, candidates, retired, runs };
}

export interface ScorePoint {
  label: string;
  path: string;
  /** Live's score in that run. */
  score: number | null;
  /** The setup that stood for live, so a change of it marks a promotion. */
  setup: string | null;
  promoted: boolean;
}

/** Live's score in every run of a job, oldest first; a point where the live setup changed is a promotion. */
export function scoreHistory(page: JobPage): ScorePoint[] {
  const points: ScorePoint[] = [];
  let was: string | null = null;
  for (const { row, read } of page.runs) {
    const live = read === null ? null : liveScore(read, page.live);
    const setup = live?.setup === "production" ? page.live ?? "production" : live?.setup ?? null;
    points.push({ label: runLabel(row), path: row.path, score: live?.score ?? null, setup, promoted: was !== null && setup !== null && setup !== was });
    if (setup !== null) was = setup;
  }
  return points;
}

// ---------------------------------------------------------------------------
// The next step

export type NextKind = "review" | "fix" | "run" | "first-test" | "move-prompt" | "none";

export interface NextStep {
  kind: NextKind;
  label: string;
  /** The candidate a review points at. */
  candidate?: string;
}

/** The one thing to do next on a job, as board 8 draws it. */
export function nextStep(page: JobPage): NextStep {
  const { job, row } = page;
  if (job.home === "code") return { kind: "move-prompt", label: "Move its prompt to a note" };
  if (row.tests.length === 0) return { kind: "first-test", label: "Write its first test" };
  const better = page.candidates.filter((item) => item.status === "beat live" || (item.status === "tied" && (item.size ?? 0) < (item.baseSize ?? 0)));
  if (better.length === 1) return { kind: "review", label: "Review 1 candidate", candidate: better[0]!.name };
  if (better.length > 1) return { kind: "review", label: `Review ${better.length} candidates`, candidate: better[0]!.name };
  const latest = page.runs.at(-1);
  if (latest === undefined) return { kind: "run", label: "Run its tests" };
  const live = latest.read === null ? null : liveScore(latest.read, page.live);
  if (live !== null && !live.gatesPassed && live.gatesFailed.length > 0) {
    return { kind: "fix", label: `Fix case ${live.gatesFailed.join(", ")}` };
  }
  return { kind: "none", label: "Nothing to do" };
}

// ---------------------------------------------------------------------------
// Activity, derived from the notes

export type ActivityWho = "improver" | "bench" | "person" | "ai";

export interface ActivityItem {
  at: number;
  who: string;
  kind: ActivityWho;
  job: string | null;
  /** What happened, short: `Drafted live-6`, `Ran core (gh-33)`, `Promoted live-5`. */
  what: string;
  /** The line under it: the change a setup makes, a run's scores; null when there is nothing to add. */
  detail: string | null;
  /** The note it came from. */
  path: string;
  /** Waiting on a person: a drafted setup or case, a candidate that beat live. */
  needsPerson: boolean;
}

/** Who made something, as Activity draws it: the improver and Claude by name, a person by theirs. */
export function whoOf(madeBy: string | null): { who: string; kind: ActivityWho } {
  const name = nameOf(madeBy);
  // A note that does not say who made it is not credited to anyone.
  if (name === null) return { who: NOT_RECORDED, kind: "person" };
  const lower = name.toLowerCase();
  if (lower === "improver") return { who: "Improver", kind: "improver" };
  if (/claude|chatgpt|codex|cursor|\bai\b/.test(lower)) return { who: name, kind: "ai" };
  return { who: name, kind: "person" };
}

/** Who, when the note does not say. */
export const NOT_RECORDED = "—";

/** Every change the notes record, newest first: setups drafted, runs, promotions. */
export function activity(catalog: AiCatalog, reads: ReadonlyMap<string, RunRead>): ActivityItem[] {
  const items: ActivityItem[] = [];
  const jobLabel = (key: string | null) => AI_JOBS.find((job) => job.key === key)?.label ?? key;
  for (const row of [...catalog.setups, ...catalog.retired]) {
    const info = setupInfo(row);
    const { who, kind } = whoOf(info.madeBy);
    const retired = info.retired;
    items.push({
      at: row.updatedAt ?? 0,
      who,
      kind,
      job: jobLabel(info.job),
      what: `${retired ? "Retired" : "Drafted"} ${info.name}`,
      detail: [info.change, info.basedOn ? `from ${info.basedOn}` : null].filter(Boolean).join(" · ") || null,
      path: row.path,
      needsPerson: !retired && kind !== "person" && info.claimed !== "lost",
    });
  }
  for (const result of catalog.results) {
    const read = reads.get(result.path);
    const scores = read?.setups.map((row) => `${row.setup} ${row.scoreText}`).join(", ");
    items.push({
      at: result.updatedAt ?? 0,
      who: "Test bench",
      kind: "bench",
      job: jobLabel(catalog.jobs.find((job) => job.tests.some((test) => test.name === result.test))?.job.key ?? result.test),
      what: `Ran ${result.test} (${runLabel(result)})`,
      detail: scores || null,
      path: result.path,
      needsPerson: false,
    });
  }
  for (const row of catalog.jobs) {
    const from = liveFrom(row.setup);
    if (row.setup === null || from === null) continue;
    const by = promotedBy(row.setup);
    const since = liveSince(row.setup) ?? dayIn(text(row.setup.properties.promoted_by));
    items.push({
      at: row.setup.updatedAt ?? 0,
      who: by ?? NOT_RECORDED,
      kind: "person",
      job: row.job.label,
      what: `Promoted ${from}`,
      detail: since ? `live since ${since}` : null,
      path: row.setup.path,
      needsPerson: false,
    });
  }
  return items.sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------------------
// Golden cases: drafted

/** The bullet that marks a case an AI wrote and no person has checked: `- drafted: by improver`. */
export const DRAFTED_KEY = "drafted";
