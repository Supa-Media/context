/**
 * Setups as experiments (boards 17, 18 and 20 of the AI tools plan; the
 * owner, 2026-10-16: "we should only be showing setups that are live, and
 * setups that are being presently experimented with … a simple way to
 * archive setups").
 *
 * Two things live here. What the Setups list shows: live, then the
 * experiments still in play, with everything retired, lost or untouched for
 * two weeks behind "Show archived". And how sure a score is, which the ML
 * review of 2026-10-16 found the tab overstated: a round is a handful of
 * cases run three times, live scored 100% and then 93.3% on the same code,
 * and one flipped run was drawn as "beat live". So a score is runs passed
 * with a likely range (Wilson, 95%), and a gap against live is "better" or
 * "worse" only when its whole range (Newcombe's, for two proportions) is on
 * one side of zero; anything else is too close to call.
 */

import type { RunRead, SetupInfo, SetupStatus } from "./aiModel";
import { splitFront, withoutKeys } from "./aiNotes";

// ---------------------------------------------------------------------------
// How sure

export interface Passed {
  passed: number;
  runs: number;
}

/** z for a 95% range. */
const Z = 1.96;

/** The Wilson score range of `passed` out of `runs`, as two fractions. */
export function wilson(passed: number, runs: number): [number, number] {
  if (runs <= 0) return [0, 1];
  const p = passed / runs;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * runs)) / (1 + z2 / runs);
  const spread = (Z * Math.sqrt((p * (1 - p)) / runs + z2 / (4 * runs * runs))) / (1 + z2 / runs);
  return [Math.max(0, centre - spread), Math.min(1, centre + spread)];
}

/** A setup's runs passed in a round, summed over the case-by-case table's column for it; null when the round has none. */
export function runsPassed(run: RunRead, column: string): Passed | null {
  if (run.cases === null) return null;
  let passed = 0;
  let runs = 0;
  for (const row of run.cases) {
    const cell = row.cells[column];
    if (cell === undefined) continue;
    passed += cell.passed;
    runs += cell.runs;
  }
  return runs === 0 ? null : { passed, runs };
}

const percent = (fraction: number, digits: number) => String(Number((fraction * 100).toFixed(digits)));

/** `likely 88–99.6%`: the range written the way a person reads it, the low end whole. */
export function passedRange({ passed, runs }: Passed): string {
  const [low, high] = wilson(passed, runs);
  return `likely ${percent(Math.floor(low * 100) / 100, 0)}–${percent(high, 1)}%`;
}

export type GapVerdict = "better" | "worse" | "too close";

export interface Gap {
  /** The difference in percentage points, candidate minus live. */
  points: number;
  low: number;
  high: number;
  verdict: GapVerdict;
}

/** A candidate's runs passed against live's in the same round: the difference and its 95% range (Newcombe, method 10). */
export function gapAgainstLive(mine: Passed, live: Passed): Gap {
  const p1 = mine.passed / mine.runs;
  const p2 = live.passed / live.runs;
  const [l1, u1] = wilson(mine.passed, mine.runs);
  const [l2, u2] = wilson(live.passed, live.runs);
  const d = p1 - p2;
  const low = d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2);
  const high = d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2);
  const verdict: GapVerdict = low > 0 ? "better" : high < 0 ? "worse" : "too close";
  return { points: d * 100, low: low * 100, high: high * 100, verdict };
}

/** `+2 pts, could be −6 to +12`. */
export function gapLabel(gap: Gap): string {
  const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value))}`;
  return `${signed(gap.points)} pts, could be ${signed(gap.low)} to ${signed(gap.high)}`;
}

// ---------------------------------------------------------------------------
// What the list shows

/** A setup untouched this long, and not live, is put away with the rest. */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** Behind "Show archived": retired, lost, or not touched for two weeks; live and a setup that beat live never are. */
export function archivedSetup(setup: SetupInfo & { status: SetupStatus }, now: number): boolean {
  if (setup.status === "live" || setup.status === "beat live") return false;
  if (setup.status === "retired" || setup.status === "lost") return true;
  const at = setup.row.updatedAt;
  return at !== null && now - at > STALE_AFTER_MS;
}

/** A setup's name as a person reads it: its `title:`, else its file name without the date, as words. */
export function setupTitle(setup: SetupInfo): string {
  const title = setup.row.properties.title;
  if (typeof title === "string" && title.trim() !== "") return title.trim();
  const words = setup.name.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/[-_]+/g, " ").trim();
  return words === "" ? setup.name : words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// New experiment

/** What a live note carries about how it went live, which a new experiment does not. */
const NOT_COPIED = new Set(["from", "live_since", "promoted_by", "came_from", "why", "status", "made_by", "based_on", "change", "title", "job"]);

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * A new experiment's note: live's text with the bookkeeping of how live got
 * there taken out, and `based_on`, `change`, `title` and `made_by` set. Live's
 * models, skills and prompt are kept as they are, so the one change made in
 * the editor afterwards is the only difference Compare shows.
 */
export function experimentText(liveRaw: string, { job, basedOn, change, by }: { job: string; basedOn: string; change: string; by: string }): string {
  const { front, body } = splitFront(liveRaw);
  const kept = withoutKeys(front, NOT_COPIED);
  const said = oneLine(change);
  const title = said.length > 60 ? `${said.slice(0, 59).replace(/\s+\S*$/, "")}…` : said;
  return [
    "---",
    `job: ${oneLine(job)}`,
    ...kept,
    `title: ${title}`,
    `based_on: ${oneLine(basedOn)}`,
    `change: ${said}`,
    `made_by: ${oneLine(by)}`,
    "---",
    body.replace(/^\r?\n?/, "\n"),
  ].join("\n");
}

/** The note a new experiment is written to: its change's first five words, never a name already taken. */
export function experimentPath(job: string, change: string, taken: ReadonlySet<string>): string {
  const words = change.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const base = words.slice(0, 5).join("-").slice(0, 48).replace(/-+$/, "") || "experiment";
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return `ai/setups/${job}/${name}.md`;
}
