/**
 * The AI tab's catalog: every place AI runs in Context, and the notes that
 * say how it runs and how good it is.
 *
 * **The data is the `ai/` folder of `@context-lc` and nothing else** (decided
 * by the owner, 2026-10-16: "whatever is in the admin panel, AI panel, is
 * like the underlying data is still the AI folder in context-lc. And it's
 * just like whoever can write to that folder is an admin"). There is no
 * second store: a skill, a test or a setup is a note there, opened and edited
 * in the normal note editor, and the rows below are read from the tree's
 * front matter (`folderNotes`), never from the bucket.
 *
 * **Jobs are declared here, in code, and never from the page** (the owner,
 * 2026-10-16: "a job should be like kind of predefined in the code"). A job
 * with no setup note or no test list is drawn as such, not hidden: that gap is
 * what the page is for.
 *
 *   ai/production/<job>.md          the live setup a job runs (Tex reads it)
 *   ai/production/skills/<name>.md  the live skills
 *   ai/setups/<job>/<name>.md       setups being tried against the live one
 *   ai/tests/<name>.md              test lists; `job:` names the job graded
 *   ai/results/<…> scores.md        one round's scores, newest first
 */

/** A note as `folderNotes` answers it: `props` is `{ properties, heading, lede }` as JSON. */
export interface FolderNote {
  path: string;
  updatedAt?: number;
  /** The note's bytes, when the tree lists them: a prompt's size is drawn from it. */
  size?: number;
  props: string;
}

export const AI_FOLDER = "ai";
/** The workflow that runs a round: always the live setup, live skills and the tests in Context. */
export const RUN_TESTS_URL = "https://github.com/Supa-Media/context/actions/workflows/ai-benchmark.yml";
/** Where jobs are declared, for "add a job": in code, through a pull request. */
export const JOBS_SOURCE_URL = "https://github.com/Supa-Media/context/blob/main/apps/mobile/features/admin/aiCatalog.ts";

export type JobGroup = "people" | "background" | "other";

export const JOB_GROUPS: readonly { key: JobGroup; label: string }[] = [
  { key: "people", label: "Talking to people" },
  { key: "background", label: "Working in the background" },
  { key: "other", label: "Other" },
];

export interface AiJob {
  key: string;
  label: string;
  group: JobGroup;
  /** One line on where people meet it. */
  where: string;
  /** True when AI Benchmark can run a round for it today. */
  benchable: boolean;
  /**
   * Where its setup lives today: a note under `ai/production/`, still in code
   * (the next step is moving it to a note), nothing to set (no prompt), or
   * the person's own AI.
   */
  home: "note" | "code" | "none" | "theirs";
  /** The model it runs on when that is set in code, for the row's second line. */
  model?: string;
}

/**
 * Every place AI runs. A new AI feature adds its row here in the same pull
 * request that adds the feature, with a setup note and a test list.
 */
export const AI_JOBS: readonly AiJob[] = [
  { key: "texting-assistant", label: "Tex, by text", group: "people", where: "Everyone with Tex", benchable: true, home: "note" },
  { key: "app-assistant", label: "App assistant", group: "people", where: "Ask in the app", benchable: false, home: "note" },
  { key: "connected-ais", label: "Connected AIs", group: "people", where: "Claude, ChatGPT and others on the MCP", benchable: false, home: "theirs", model: "their own models" },
  { key: "dream", label: "Nightly dream", group: "background", where: "Tex's about-me, every night", benchable: false, home: "code", model: "Haiku 5.5" },
  { key: "auto-organize", label: "Auto-organize", group: "background", where: "Sorting the inbox", benchable: false, home: "code", model: "Clef" },
  { key: "what-changed", label: "What changed", group: "background", where: "Tidy-up suggestions", benchable: false, home: "code", model: "GLM-4.7 Flash" },
  { key: "meeting-transcription", label: "Meeting transcription", group: "other", where: "Recorded meetings", benchable: false, home: "none", model: "Whisper" },
  { key: "meeting-summaries", label: "Meeting summaries", group: "other", where: "Recorded meetings", benchable: false, home: "code", model: "Haiku 5.5" },
  { key: "search", label: "Search by meaning", group: "other", where: "Search, for people and AIs", benchable: true, home: "code", model: "bge-m3" },
];

export interface AiNoteRow {
  path: string;
  /** The file name without `.md`. */
  name: string;
  title: string;
  lede: string;
  updatedAt: number | null;
  /** Bytes, when the tree listed them; `null` is unknown, never zero. */
  size: number | null;
  properties: Record<string, unknown>;
}

export interface ScoreRow extends AiNoteRow {
  /** The test list the round ran (`core`, `search`, …). */
  test: string;
  score: string | null;
  gates: string | null;
  goodEnough: string | null;
  setup: string | null;
  /** The round's day, from the note's name. */
  day: string | null;
}

export interface JobRow {
  job: AiJob;
  setup: AiNoteRow | null;
  tests: AiNoteRow[];
  setupsTried: number;
  latest: ScoreRow | null;
}

export interface AiCatalog {
  jobs: JobRow[];
  skills: AiNoteRow[];
  tests: AiNoteRow[];
  setups: AiNoteRow[];
  /** Setups under `ai/setups/retired/<job>/`: measured and not to run again, behind "show". */
  retired: AiNoteRow[];
  results: ScoreRow[];
  /**
   * Notes under `ai/` none of the groups above claims (READMEs, probes). A
   * round's raw answers and its key under `results/`, and a setup's own copies
   * of skills, are left out: the scores note and the live skill stand for them.
   */
  other: AiNoteRow[];
}

function parseProps(raw: string): { properties: Record<string, unknown>; heading: string; lede: string } {
  try {
    const parsed = JSON.parse(raw) as { properties?: unknown; heading?: unknown; lede?: unknown };
    const properties =
      parsed.properties !== null && typeof parsed.properties === "object" && !Array.isArray(parsed.properties)
        ? (parsed.properties as Record<string, unknown>)
        : {};
    return {
      properties,
      heading: typeof parsed.heading === "string" ? parsed.heading : "",
      lede: typeof parsed.lede === "string" ? parsed.lede : "",
    };
  } catch {
    return { properties: {}, heading: "", lede: "" };
  }
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function noteRow(note: FolderNote): AiNoteRow {
  const { properties, heading, lede } = parseProps(note.props);
  const file = note.path.slice(note.path.lastIndexOf("/") + 1);
  const name = file.replace(/\.md$/, "");
  return {
    path: note.path,
    name,
    title: text(properties.title) ?? (heading || name),
    lede,
    updatedAt: typeof note.updatedAt === "number" ? note.updatedAt : null,
    size: typeof note.size === "number" && Number.isFinite(note.size) ? note.size : null,
    properties,
  };
}

/** `2026-10-14 core gh-33 scores` → day 2026-10-14, test `core`. */
function scoreRow(row: AiNoteRow): ScoreRow {
  const named = /^(\d{4}-\d{2}-\d{2}) (\S+)/.exec(row.name);
  const props = row.properties;
  return {
    ...row,
    test: text(props.test) ?? named?.[2] ?? row.name,
    score: text(props.score),
    gates: text(props.gates),
    goodEnough: text(props.good_enough),
    setup: text(props.setup),
    day: named?.[1] ?? null,
  };
}

const isAbout = (name: string) => name === "about" || name === "README";

/** The notes of `ai/`, sorted into what the AI tab draws. */
export function buildCatalog(notes: readonly FolderNote[]): AiCatalog {
  const live = new Map<string, AiNoteRow>();
  const skills: AiNoteRow[] = [];
  const tests: AiNoteRow[] = [];
  const setups: AiNoteRow[] = [];
  const retired: AiNoteRow[] = [];
  const results: ScoreRow[] = [];
  const other: AiNoteRow[] = [];
  for (const note of notes) {
    if (!note.path.startsWith(`${AI_FOLDER}/`) || !note.path.endsWith(".md")) continue;
    const row = noteRow(note);
    const parts = note.path.split("/").slice(1, -1);
    const [area, sub] = parts;
    if (isAbout(row.name)) other.push(row);
    else if (area === "production" && parts.length === 1) live.set(row.name, row);
    else if (area === "production" && sub === "skills" && parts.length === 2) skills.push(row);
    else if (area === "tests" && parts.length === 1) tests.push(row);
    // A setup's own copies of skills, and retired setups, are not setups being tried.
    else if (area === "setups" && parts.length === 2 && sub !== "retired") setups.push(row);
    else if (area === "setups" && parts.length === 3 && sub === "retired") retired.push(row);
    else if (area === "results" && parts.length === 1 && row.name.endsWith(" scores")) results.push(scoreRow(row));
    else if (!(area === "results" || area === "setups")) other.push(row);
  }
  const byName = (a: AiNoteRow, b: AiNoteRow) => a.title.localeCompare(b.title);
  skills.sort(byName);
  tests.sort(byName);
  setups.sort(byName);
  other.sort(byName);
  // Newest round first: the day in the name, then the note's own time.
  results.sort((a, b) => (b.day ?? "").localeCompare(a.day ?? "") || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.name.localeCompare(a.name));

  const jobOf = (row: AiNoteRow) => text(row.properties.job);
  const jobs = AI_JOBS.map((job): JobRow => {
    const own = tests.filter((test) => jobOf(test) === job.key || (jobOf(test) === null && test.name === job.key));
    const names = new Set(own.map((test) => test.name));
    return {
      job,
      setup: live.get(job.key) ?? null,
      tests: own,
      setupsTried: setups.filter((setup) => setup.path.split("/")[2] === job.key).length,
      latest: results.find((result) => names.has(result.test) || result.test === job.key) ?? null,
    };
  });
  // A live setup no job claims is still shown, under Other, so it is never lost.
  const claimed = new Set(AI_JOBS.map((job) => job.key));
  for (const [name, row] of live) if (!claimed.has(name)) other.push(row);
  retired.sort(byName);
  return { jobs, skills, tests, setups, retired, results, other };
}

/** Rows whose name, title or opening line hold every word of `query`. */
export function matches(row: AiNoteRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${row.name} ${row.title} ${row.lede}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** What a job's quality cell says; `read` is its latest round read from the note's text. */
export function jobQuality(row: JobRow, read?: ScoresRead): { label: string; tone: "ok" | "warn" | "none" } {
  if (row.tests.length === 0) return { label: "No test yet", tone: "none" };
  if (row.latest === null) return { label: "Not run yet", tone: "none" };
  const score = row.latest.score ?? read?.score ?? null;
  if (score === null) return { label: `Ran ${row.latest.day ?? "before"}`, tone: "none" };
  const gates = row.latest.gates ?? read?.gates ?? null;
  const verdict = row.latest.goodEnough ?? (read ? (read.goodEnough ? "yes" : "no") : null);
  const passed = verdict === "yes" || verdict === "true";
  return { label: `${score}${gates === null ? "" : ` · gates ${gates}`}`, tone: passed ? "ok" : "warn" };
}

/** `anthropic/claude-haiku-5-5` → `Haiku 5.5`; anything else keeps its last segment. */
export function modelName(id: string): string {
  const last = id.slice(id.lastIndexOf("/") + 1);
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(last);
  if (claude) return `${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return last;
}

/** The models a setup names (`models: { main, smart }` or `model:`), as one line. */
export function setupModels(setup: AiNoteRow | null): string | null {
  if (setup === null) return null;
  const props = setup.properties;
  const one = text(props.model);
  if (one !== null) return modelName(one);
  const many = props.models;
  if (many !== null && typeof many === "object" && !Array.isArray(many)) {
    const ids = Object.values(many as Record<string, unknown>).map(text).filter((id): id is string => id !== null);
    const names = [...new Set(ids.map(modelName))];
    return names.length === 0 ? null : names.join(" → ");
  }
  return null;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter((item): item is string => item !== null);
  const one = text(value);
  return one === null ? [] : one.split(",").map((part) => part.trim()).filter(Boolean);
}

export type Reach = "tex" | "mcp";

/**
 * Who gets a skill, from its `reach:` front matter. Absent is Tex alone, which
 * is what every skill is today: only Tex reads `ai/production/skills/`.
 */
export function reachOf(row: AiNoteRow): Reach[] {
  const named = list(row.properties.reach).map((item) => item.toLowerCase());
  const reach = (["tex", "mcp"] as const).filter((item) => named.includes(item));
  return reach.length === 0 ? ["tex"] : reach;
}

/** The test lists whose `covers:` names this note, by its file name. */
export function provedBy(row: AiNoteRow, tests: readonly AiNoteRow[]): AiNoteRow[] {
  return tests.filter((test) => list(test.properties.covers).includes(row.name));
}

/** The folder a skill sits in under `ai/production/skills/`, `""` at its top. */
export function skillFolder(row: AiNoteRow): string {
  const rest = row.path.slice("ai/production/skills/".length);
  return rest.includes("/") ? rest.slice(0, rest.lastIndexOf("/")) : "";
}

/**
 * Where a job's model spend is counted in the AI costs report. Tex by text and
 * the app assistant are one `assistant` feature there, so both rows show it.
 */
export const COST_FEATURE: Readonly<Record<string, string>> = {
  "texting-assistant": "assistant",
  "app-assistant": "assistant",
  "auto-organize": "organizer",
  "what-changed": "whatChanged",
  "meeting-transcription": "transcription",
  search: "meaning",
};

export interface GateMiss {
  question: number;
  rule: string;
  runs: string;
}

export interface ScoresRead {
  setup: string;
  score: string;
  gates: string;
  goodEnough: boolean;
  misses: GateMiss[];
}

/**
 * A scores note's live result, read from its text: the `production` row of the
 * latest "## Scored by" table (else its first row), and that setup's
 * "Why gates failed" lines. The same reading `liveScoreRow` in
 * `apps/mcp/bench/context.mjs` does, for rounds scored before the note
 * carried it in front matter.
 */
export function readScores(raw: string): ScoresRead | null {
  const at = `\n${raw}`.lastIndexOf("\n## Scored by ");
  if (at === -1) return null;
  const section = raw.slice(at);
  const end = section.indexOf("\n## ", 3);
  const body = end === -1 ? section : section.slice(0, end);
  const rows = body
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| setup ") && !line.startsWith("| ---"))
    .map((line) => line.slice(2, -2).split(" | ").map((cell) => cell.trim()));
  const row = rows.find((cells) => cells[0] === "production") ?? rows[0];
  if (!row || row.length < 3) return null;
  const setup = row[0]!;
  const misses: GateMiss[] = [];
  const why = body.indexOf(`Why gates failed, ${setup}:`);
  if (why !== -1) {
    for (const line of body.slice(why).split("\n").slice(1)) {
      if (!line.startsWith("- ")) break;
      const m = /^- q(\d+) (.+?):\s*(.+)$/.exec(line);
      if (m) misses.push({ question: Number(m[1]), rule: m[2]!, runs: m[3]! });
    }
  }
  return { setup, score: row[1]!, gates: row[2]!, goodEnough: (row[8] ?? "") === "yes", misses };
}

export interface Attention {
  /** Jobs whose latest round did not pass. */
  failing: JobRow[];
  /** Jobs with no test list. */
  untested: JobRow[];
  /** Skills no test list `covers:`. */
  unproved: AiNoteRow[];
  /** Jobs with no live setup note. */
  noSetup: JobRow[];
}

/** `scores` is each latest round read from its text, for rounds older than the front matter. */
export function attention(catalog: AiCatalog, scores: ReadonlyMap<string, ScoresRead> = new Map()): Attention {
  const passed = (row: JobRow): boolean | null => {
    if (row.latest === null) return null;
    if (row.latest.goodEnough !== null) return ["yes", "true"].includes(row.latest.goodEnough);
    return scores.get(row.latest.path)?.goodEnough ?? null;
  };
  return {
    failing: catalog.jobs.filter((row) => passed(row) === false),
    untested: catalog.jobs.filter((row) => row.tests.length === 0),
    unproved: catalog.skills.filter((skill) => provedBy(skill, catalog.tests).length === 0),
    noSetup: catalog.jobs.filter((row) => row.setup === null && row.job.key !== "connected-ais"),
  };
}
