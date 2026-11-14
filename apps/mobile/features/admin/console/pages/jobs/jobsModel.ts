/**
 * The staff console's Jobs page (artifact "Staff console", 2026-11-14), read
 * from the same `@context-lc ai/` notes the old AI tab read (`../../../aiCatalog`,
 * `../../../aiModel`). Nothing here is stored anywhere else: a job's list row,
 * its setups, its runs and its cases are all what the notes and the bench's
 * scores notes say.
 *
 * Tex's own row only links to the Lab: its models, prompt and cases live
 * there (texConfig is the source of truth), and the gateway ignores what a
 * setup note says for it.
 */

import { AI_JOBS, type AiCatalog } from "../../../aiCatalog";
import {
  activity,
  jobPage,
  liveScore,
  liveSince,
  nextStep,
  promotedBy,
  runLabel,
  scoreHistory,
  type ActivityItem,
  type ActivityWho,
  type Candidate,
  type JobPage,
  type RunRead,
  type SetupStatus,
} from "../../../aiModel";
import { runsPassed, wilson, type Passed } from "../../../aiExperiments";
import { goLiveGates, replyOf, type RepliesCase } from "../../../aiCompareModel";
import { groupTitle, parseTestList, type TestList } from "../../../testList";

/** The job whose row links to the Lab instead of opening here. */
export const LAB_JOB = "texting-assistant";
export const LAB_URL = "https://context.lc/lab";

export type Tone = "" | "ok" | "bad" | "acc" | "warn";

// ---------------------------------------------------------------------------
// Time

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-11-06` → `Nov 6`. */
export function dayLabel(day: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? "");
  if (!match) return null;
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}`;
}

/** `2d ago`, `5h ago`, `just now`; null for an unknown time. */
export function ago(at: number | null, now: number): string | null {
  if (at === null || at <= 0) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Activity's When: `08:12` today, `Nov 13` before. */
export function whenLabel(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

// ---------------------------------------------------------------------------
// The list

export interface JobListRow {
  key: string;
  name: string;
  /** Tex: the row links to the Lab. */
  lab: boolean;
  /** The live setup's name, or what the job runs on when nothing is live. */
  live: string | null;
  /** Live's score in the latest run, 0-100. */
  score: number | null;
  /** Live's score in every run, oldest first. */
  trend: number[];
  /** The latest run, as `2d ago`. */
  last: string | null;
  /** A setup beats live and waits for a person. */
  cand: boolean;
  /** The next thing to do, when there is one and no setup beats live. */
  next: string | null;
}

const liveName = (page: JobPage): string | null => page.live ?? (page.row.setup ? page.row.setup.name : page.job.model ?? null);

/** The rows of the Jobs list, in the catalog's order, Tex's first. */
export function jobList(catalog: AiCatalog, reads: ReadonlyMap<string, RunRead>, now: number): JobListRow[] {
  const keys = [LAB_JOB, ...AI_JOBS.map((job) => job.key).filter((key) => key !== LAB_JOB)];
  return keys.flatMap((key): JobListRow[] => {
    const job = AI_JOBS.find((item) => item.key === key);
    if (!job) return [];
    if (key === LAB_JOB) return [{ key, name: job.label, lab: true, live: null, score: null, trend: [], last: null, cand: false, next: null }];
    const page = jobPage(catalog, key, reads);
    if (page === null) return [];
    const trend = scoreHistory(page).flatMap((point) => (point.score === null ? [] : [point.score]));
    const latest = page.runs.at(-1) ?? null;
    const lastRead = [...page.runs].reverse().find((run) => run.read !== null)?.read ?? null;
    const live = lastRead ? liveScore(lastRead, page.live) : null;
    const cand = page.candidates.some((item) => item.status === "beat live");
    const step = nextStep(page);
    return [
      {
        key,
        name: job.label,
        lab: false,
        live: liveName(page),
        score: live?.score ?? null,
        trend,
        last: latest ? ago(latest.row.updatedAt, now) ?? dayLabel(latest.row.day) : null,
        cand,
        next: cand || step.kind === "none" || step.kind === "review" ? null : step.label,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// A job's head

export interface JobHead {
  live: string;
  /** `since Nov 6 · by seyi`. */
  since: string;
  score: string;
  /** `36 of 42 checks pass`. */
  checks: string;
  /** `$0.03 · 3.1 s`. */
  costSpeed: string;
  trend: number[];
}

const money = (dollars: number) => `$${dollars < 0.01 ? dollars.toFixed(3) : dollars.toFixed(2)}`;

export function jobHead(page: JobPage): JobHead {
  const latest = [...page.runs].reverse().find((run) => run.read !== null)?.read ?? null;
  const live = latest ? liveScore(latest, page.live) : null;
  const passed = latest && live ? runsPassed(latest, live.setup) : null;
  const since = dayLabel(liveSince(page.row.setup));
  const by = promotedBy(page.row.setup);
  const parts = [live?.price != null ? money(live.price) : null, live?.speed != null ? `${live.speed} s` : null].filter(Boolean);
  return {
    live: liveName(page) ?? "nothing live",
    since: [since ? `since ${since}` : null, by ? `by ${by}` : null].filter(Boolean).join(" · "),
    score: live?.score != null ? `${live.score}%` : "—",
    checks: passed ? `${passed.passed} of ${passed.runs} checks pass` : live ? (live.gatesPassed ? "every gate passed" : "a gate failed") : "not run yet",
    costSpeed: parts.length ? parts.join(" · ") : "—",
    trend: scoreHistory(page).flatMap((point) => (point.score === null ? [] : [point.score])),
  };
}

// ---------------------------------------------------------------------------
// Cases: every case of every test list the job owns

export type RuleKind = "must" | "must not" | "may" | "judge";
export const RULE_KINDS: readonly RuleKind[] = ["must", "must not", "may", "judge"];

export interface CaseCard {
  /** `<test>-<number>`: letters, digits and hyphens, as the URL holds it. */
  id: string;
  /** The test list note it lives in. */
  path: string;
  test: string;
  number: number;
  name: string;
  /** What happens: the case's description. */
  when: string;
  /** Its rule lines: the line index, the kind and the text. */
  rules: { index: number; kind: string; text: string }[];
  /** The test list's own name. */
  group: string;
}

export const caseId = (test: string, number: number) => `${test.replace(/[^A-Za-z0-9-]/g, "-")}-${number}`;

export function casesOf(test: { name: string; title: string; path: string }, list: TestList): CaseCard[] {
  const group = groupTitle(list) ?? test.title ?? test.name;
  return list.cases.map((item) => ({
    id: caseId(test.name, item.number),
    path: test.path,
    test: test.name,
    number: item.number,
    name: item.title,
    when: item.description,
    rules: item.rules.map((line) => ({ index: line.index, kind: line.key, text: line.value })),
    group,
  }));
}

/** The job's cases, from each test list's text (null when not read yet). */
export function jobCases(tests: readonly { name: string; title: string; path: string }[], texts: ReadonlyMap<string, string | null>): CaseCard[] {
  return tests.flatMap((test) => {
    const text = texts.get(test.path);
    return text == null ? [] : casesOf(test, parseTestList(text));
  });
}

/** Cases grouped by their list's name, in the order the lists come. */
export function caseGroups(cases: readonly CaseCard[]): { group: string; cases: CaseCard[] }[] {
  const groups: { group: string; cases: CaseCard[] }[] = [];
  for (const item of cases) {
    const found = groups.find((entry) => entry.group === item.group);
    if (found) found.cases.push(item);
    else groups.push({ group: item.group, cases: [item] });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Setups

export interface SetupRow {
  name: string;
  path: string;
  change: string | null;
  /** `36/42`, or `—`. */
  passed: string;
  vs: string;
  tone: Tone;
  live: boolean;
  /** Compare is offered for every setup but live and the retired. */
  canCompare: boolean;
}

export function vsOf(status: SetupStatus): { vs: string; tone: Tone } {
  switch (status) {
    case "live":
      return { vs: "Live", tone: "ok" };
    case "beat live":
      return { vs: "Better", tone: "ok" };
    case "lost":
      return { vs: "Worse", tone: "bad" };
    case "too close":
    case "tied":
      return { vs: "Too close to call", tone: "" };
    case "draft":
      return { vs: "Draft", tone: "" };
    case "retired":
      return { vs: "Retired", tone: "" };
    default:
      return { vs: "Not run yet", tone: "" };
  }
}

const passedText = (passed: Passed | null) => (passed ? `${passed.passed}/${passed.runs}` : "—");

/** Live first, then the setups being tried, as the page orders them. */
export function setupRows(page: JobPage): SetupRow[] {
  const rows = page.candidates.map((item): SetupRow => {
    const { vs, tone } = vsOf(item.status);
    const live = item.status === "live";
    return { name: item.name, path: item.row.path, change: item.change, passed: passedText(item.passed), vs, tone, live, canCompare: !live && item.status !== "retired" };
  });
  if (!rows.some((row) => row.live) && page.row.setup) {
    // Live with no setup note of its own under setups/: production stands for it.
    const latest = [...page.runs].reverse().find((run) => run.read !== null)?.read ?? null;
    const score = latest ? liveScore(latest, page.live) : null;
    rows.unshift({
      name: liveName(page) ?? page.row.setup.name,
      path: page.row.setup.path,
      change: null,
      passed: passedText(latest && score ? runsPassed(latest, score.setup) : null),
      vs: "Live",
      tone: "ok",
      live: true,
      canCompare: false,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Runs

export interface RunRowView {
  path: string;
  name: string;
  day: string;
  live: string;
  best: string;
  bars: "passed" | "failed" | "running";
}

/** Every run, newest first. A run whose scores are not written yet is still running. */
export function runRows(page: JobPage): RunRowView[] {
  return [...page.runs].reverse().map(({ row, read }) => {
    const live = read ? liveScore(read, page.live) : null;
    const others = read ? read.setups.filter((setup) => setup !== live && setup.setup !== "production").sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : [];
    const best = others[0];
    return {
      path: row.path,
      name: `${row.test} ${runLabel(row)}`,
      day: dayLabel(row.day) ?? "—",
      live: live?.scoreText || (read ? "—" : "…"),
      best: best ? `${best.setup} ${best.scoreText}` : read ? "—" : "…",
      bars: read === null || live === null ? "running" : live.gatesPassed ? "passed" : "failed",
    };
  });
}

// ---------------------------------------------------------------------------
// Compare

export interface DifferingCase {
  question: number;
  title: string;
  /** Who missed, and the rule. */
  missedBy: "live" | "setup" | null;
  rule: string | null;
  liveReply: string | null;
  setupReply: string | null;
}

export interface CompareView {
  liveName: string;
  livePassed: string;
  name: string;
  passed: string;
  vs: string;
  tone: Tone;
  /** `91%`: how likely it really beats live, from the two runs-passed counts. */
  sure: string;
  /** `3 runs each`. */
  sureDetail: string;
  differ: DifferingCase[];
  /** Better beyond the noise and every case group ran with no gate failed. */
  canGoLive: boolean;
  /** Why Make it live is off. */
  blocked: string | null;
}

/** The normal distribution's CDF (Abramowitz and Stegun 7.1.26). */
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** The chance a setup really passes more often than live, from runs passed. */
export function chanceBetter(mine: Passed, live: Passed): number {
  const p1 = mine.passed / mine.runs;
  const p2 = live.passed / live.runs;
  // Wilson-centred spreads keep 0/n and n/n from claiming certainty.
  const spread = (passed: Passed) => {
    const [low, high] = wilson(passed.passed, passed.runs);
    return (high - low) / (2 * 1.96);
  };
  const se = Math.hypot(spread(mine), spread(live));
  if (se === 0) return p1 > p2 ? 1 : p1 < p2 ? 0 : 0.5;
  return phi((p1 - p2) / se);
}

const short = (text: string | null) => (text === null ? null : text.length > 280 ? `${text.slice(0, 279)}…` : text);

function lastReply(reply: { turns: { from: string; text: string }[] } | null): string | null {
  if (reply === null) return null;
  const said = reply.turns.filter((turn) => turn.from === "reply").at(-1)?.text ?? "";
  return said.trim() === "" ? "(stays quiet)" : short(said);
}

export function compareView(page: JobPage, candidate: Candidate, replies: ReadonlyMap<number, RepliesCase> | null): CompareView {
  const live = liveName(page) ?? "live";
  const { vs, tone } = vsOf(candidate.status);
  const mine = candidate.passed;
  const theirs = candidate.livePassed;
  const chance = mine && theirs ? chanceBetter(mine, theirs) : null;
  const differ: DifferingCase[] = [];
  const round = candidate.rounds[0] ?? null;
  const read = round?.read ?? null;
  const liveRow = read ? liveScore(read, page.live) : null;
  if (read?.cases && liveRow) {
    for (const row of read.cases) {
      const a = row.cells[liveRow.setup];
      const b = row.cells[candidate.name];
      if (!a || !b || a.passed / a.runs === b.passed / b.runs) continue;
      const missedBy = a.passed / a.runs < b.passed / b.runs ? "live" : "setup";
      const scored = missedBy === "live" ? liveRow : read.setups.find((setup) => setup.setup === candidate.name);
      const item = replies?.get(row.question) ?? null;
      const missedReply = item ? replyOf(item, missedBy === "live" ? liveRow.setup : candidate.name, missedBy === "live") : null;
      differ.push({
        question: row.question,
        title: row.title,
        missedBy,
        rule: scored?.misses.find((miss) => miss.question === row.question)?.rule ?? missedReply?.missed[0] ?? null,
        liveReply: item ? lastReply(replyOf(item, liveRow.setup, true)) : null,
        setupReply: item ? lastReply(replyOf(item, candidate.name)) : null,
      });
    }
  }
  const gates = goLiveGates(page, candidate);
  const failing = gates.find((gate) => !gate.ok);
  const sameRuns = mine && theirs && mine.runs === theirs.runs;
  return {
    liveName: live,
    livePassed: passedText(theirs),
    name: candidate.name,
    passed: passedText(mine),
    vs,
    tone,
    sure: chance === null ? "—" : `${Math.round(chance * 100)}%`,
    sureDetail: mine && theirs ? (sameRuns ? `${mine.runs} runs each` : `${mine.runs} and ${theirs.runs} runs`) : "not run against live yet",
    differ,
    canGoLive: page.row.setup !== null && failing === undefined,
    blocked: page.row.setup === null ? "Nothing is live on this job to replace" : failing ? failing.label : null,
  };
}

// ---------------------------------------------------------------------------
// Activity

export type WhoFilter = "all" | "agents" | "people" | "bench";

export interface ActivityRowView {
  key: string;
  when: string;
  who: string;
  kind: Exclude<WhoFilter, "all">;
  job: string;
  what: string;
}

const KIND: Record<ActivityWho, Exclude<WhoFilter, "all">> = { improver: "agents", ai: "agents", person: "people", bench: "bench" };

export function activityRows(catalog: AiCatalog, reads: ReadonlyMap<string, RunRead>, now: number): ActivityRowView[] {
  return activity(catalog, reads)
    .filter((item: ActivityItem) => item.job !== AI_JOBS.find((job) => job.key === LAB_JOB)?.label)
    .map((item, index) => ({
      key: `${item.path}#${index}`,
      when: item.at > 0 ? whenLabel(item.at, now) : "—",
      who: item.who,
      kind: KIND[item.kind],
      job: item.job ?? "—",
      what: item.detail ? `${item.what}: ${item.detail}` : item.what,
    }));
}

export const filterActivity = (rows: readonly ActivityRowView[], who: WhoFilter) => rows.filter((row) => who === "all" || row.kind === who);
