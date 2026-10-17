/**
 * The AI tab's note edits (boards 10, 14 and 15 of the AI tools plan): a
 * setup's front matter rewritten for promotion, the prompt diff Compare
 * shows, the helper agents and who may call them, and a skill's reach. Split
 * from `./aiModel.ts`, which re-exports all of it; every edit here changes
 * only the lines it names and leaves the rest of the note as written.
 */

import { AI_JOBS, type AiNoteRow } from "./aiCatalog";

const text = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
};


// ---------------------------------------------------------------------------
// Promote

/** Front matter keys a setup carries about itself, which the production note does not. */
const SETUP_ONLY = new Set(["job", "based_on", "came_from", "change", "why", "status", "made_by", "live_since", "from", "promoted_by"]);

/** Splits a note into its front matter lines and its body. */
export function splitFront(raw: string): { front: string[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) return { front: [], body: raw };
  return { front: match[1]!.split(/\r?\n/), body: raw.slice(match[0].length) };
}

/** The front matter with each top-level key in `drop` removed, with its indented lines. */
export function withoutKeys(front: readonly string[], drop: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of front) {
    const top = /^([A-Za-z_][\w-]*):/.exec(line);
    if (top) skipping = drop.has(top[1]!);
    else if (!/^\s/.test(line) && line.trim() !== "") skipping = false;
    if (!skipping) out.push(line);
  }
  return out;
}

/**
 * The production note a promotion writes: the candidate's text, with its own
 * bookkeeping keys taken out and `job`, `from`, `live_since` and
 * `promoted_by` set, so the job page can say what is live, since when and
 * who said yes. The gateway reads the rest exactly as it read the setup.
 */
export function promotedText(setupRaw: string, { job, from, day, by }: { job: string; from: string; day: string; by: string }): string {
  const { front, body } = splitFront(setupRaw);
  const kept = withoutKeys(front, SETUP_ONLY);
  const clean = (value: string) => value.replace(/[\r\n]/g, " ").trim();
  return ["---", `job: ${clean(job)}`, ...kept, `from: ${clean(from)}`, `live_since: ${clean(day)}`, `promoted_by: ${clean(by)}`, "---", body.replace(/^\r?\n?/, "\n")].join("\n");
}

/** A note's front matter with one top-level key set (added at the end when absent). */
export function withFrontKey(raw: string, key: string, value: string): string {
  const { front, body } = splitFront(raw);
  const line = `${key}: ${value.replace(/[\r\n]/g, " ").trim()}`;
  const kept = withoutKeys(front, new Set([key]));
  const had = front.length > 0;
  return ["---", ...kept, line, "---", had ? body.replace(/^\r?\n?/, "\n") : `\n${raw}`].join("\n");
}

// ---------------------------------------------------------------------------
// Prompt diff

export type DiffLine = { kind: "same" | "gone" | "added"; text: string } | { kind: "folded"; count: number };

/**
 * A line diff of two prompts, with runs of more than `context * 2` unchanged
 * lines folded to a count, as board 10 draws it. A plain LCS: prompts are a
 * few hundred lines, so the table stays small.
 */
export function promptDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const raw: { kind: "same" | "gone" | "added"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      raw.push({ kind: "gone", text: a[i]! });
      i += 1;
    } else {
      raw.push({ kind: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) raw.push({ kind: "gone", text: a[i++]! });
  while (j < m) raw.push({ kind: "added", text: b[j++]! });

  const out: DiffLine[] = [];
  let k = 0;
  while (k < raw.length) {
    if (raw[k]!.kind !== "same") {
      out.push(raw[k]!);
      k += 1;
      continue;
    }
    let end = k;
    while (end < raw.length && raw[end]!.kind === "same") end += 1;
    const run = raw.slice(k, end);
    const lead = k === 0 ? 0 : context;
    const tail = end === raw.length ? 0 : context;
    if (run.length > lead + tail + 1) {
      out.push(...run.slice(0, lead), { kind: "folded", count: run.length - lead - tail }, ...run.slice(run.length - tail));
    } else out.push(...run);
    k = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helper agents

export interface AiHelper {
  key: string;
  label: string;
  model: string;
  /** Who calls it today. */
  calledBy: string;
  canDo: string;
  /** What it never does without a person; "nothing" when it changes nothing of anybody's. */
  needsPerson: string;
  /**
   * What it may call, as the six v2 tools and their actions
   * (`apps/mcp/src/tools/v2/actions.js`): `write · save`, `send · email`.
   * Never an old tool name. An action the table does not have yet is marked
   * "(not built)".
   */
  tools: string[];
  /** Built and running, or written down and not built yet. */
  state: "running" | "planned";
  /** The callers its "who may call it" switches offer. */
  callers: string[];
}

/**
 * The AIs other AIs call, declared in code like jobs (board 15). Each may also
 * have a note, `ai/agents/<key>.md`, holding its prompt and its `callers:`.
 */
export const AI_HELPERS: readonly AiHelper[] = [
  {
    key: "mail-checker",
    label: "Mail checker",
    model: "Haiku 5.5",
    calledBy: "Tex, connected AIs",
    canDo: "Check a draft, send one email",
    needsPerson: "every send",
    tools: ["fetch", "send · email (not built)"],
    state: "planned",
    callers: ["texting-assistant", "connected-ais", "improver"],
  },
  {
    key: "improver",
    label: "Improver",
    model: "Opus 5.5 · nightly",
    calledBy: "the clock, or you",
    canDo: "Draft setups and cases",
    needsPerson: "promoting, new cases",
    tools: ["search", "fetch", "write · save"],
    state: "planned",
    callers: [],
  },
  {
    key: "judge",
    label: "Judge",
    model: "Haiku 5.5",
    calledBy: "the test bench",
    canDo: "Score a reply against a case's rules",
    needsPerson: "nothing",
    tools: [],
    state: "running",
    callers: [],
  },
  {
    key: "dream",
    label: "Nightly dream",
    model: "Haiku 5.5 · nightly",
    calledBy: "the clock",
    canDo: "Rewrite about-me, tidy personal skills",
    needsPerson: "nothing",
    tools: ["fetch", "write · save"],
    state: "running",
    callers: [],
  },
];

export const HELPERS_FOLDER = "ai/agents";

/** Who may call a helper, from its note's `callers:`; a helper with no note is called by nobody new. */
export function helperCallers(note: AiNoteRow | null): string[] {
  const value = note?.properties.callers;
  if (Array.isArray(value)) return value.map(text).filter((item): item is string => item !== null);
  const one = text(value);
  return one === null ? [] : one.split(",").map((item) => item.trim()).filter(Boolean);
}

/** A caller's name for a switch: a job's label, or the helper's. */
export function callerLabel(key: string): string {
  return AI_JOBS.find((job) => job.key === key)?.label ?? AI_HELPERS.find((helper) => helper.key === key)?.label ?? key;
}

// ---------------------------------------------------------------------------
// Skill reach

export type ReachKey = "tex" | "mcp" | "helpers";

/**
 * Who gets a skill. Tex is the live texting setup's `skills:` list, the one
 * place the gateway reads it from, so that switch edits the setup and nothing
 * else. Every connected AI and helper agents are the skill's own `reach:`
 * front matter, which the tools V2 read when they offer skills to a client.
 */
export function skillReach(skill: AiNoteRow, texSkills: readonly string[]): Record<ReachKey, boolean> {
  const reach = Array.isArray(skill.properties.reach)
    ? (skill.properties.reach as unknown[]).map(text).filter((item): item is string => item !== null)
    : (text(skill.properties.reach) ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const named = new Set(reach.map((item) => item.toLowerCase()));
  return { tex: texSkills.includes(skill.name), mcp: named.has("mcp"), helpers: named.has("helpers") };
}

/** The names in a setup's `skills:` section (`name: when to read it` lines). */
export function setupSkills(raw: string): string[] {
  const { front } = splitFront(raw);
  const at = front.findIndex((line) => /^skills:\s*$/.test(line));
  if (at === -1) return [];
  const names: string[] = [];
  for (const line of front.slice(at + 1)) {
    const item = /^ {2}([a-z0-9][a-z0-9-]*):/.exec(line);
    if (!item) {
      if (/^\S/.test(line)) break;
      continue;
    }
    names.push(item[1]!);
  }
  return names;
}

/**
 * A setup's text with a skill added to or taken out of its `skills:` section.
 * Adding keeps every other line, with `when` as the line the model reads to
 * decide whether to open it; the section is made when there is none.
 */
export function withSkill(raw: string, name: string, on: boolean, when: string): string {
  const { front, body } = splitFront(raw);
  if (front.length === 0) return raw;
  const lines = [...front];
  let at = lines.findIndex((line) => /^skills:\s*$/.test(line));
  const end = (() => {
    if (at === -1) return -1;
    let index = at + 1;
    while (index < lines.length && (/^\s/.test(lines[index]!) || lines[index]!.trim() === "")) index += 1;
    return index;
  })();
  const own = at === -1 ? -1 : lines.slice(at + 1, end).findIndex((line) => line.startsWith(`  ${name}:`));
  if (on) {
    if (own !== -1) return raw;
    const entry = `  ${name}: ${when.replace(/[\r\n]/g, " ").trim() || name}`;
    if (at === -1) {
      lines.push("skills:", entry);
    } else lines.splice(end, 0, entry);
  } else {
    if (own === -1) return raw;
    lines.splice(at + 1 + own, 1);
    at = lines.findIndex((line) => /^skills:\s*$/.test(line));
    // An emptied section goes too: `skills:` with nothing under it reads as a mistake.
    if (at !== -1 && (at + 1 >= lines.length || /^\S/.test(lines[at + 1]!))) lines.splice(at, 1);
  }
  return ["---", ...lines, "---", body.replace(/^\r?\n?/, "\n")].join("\n");
}

/** A skill's `reach:` with one entry switched; Tex is never written here (see `skillReach`). */
export function withReach(raw: string, key: "mcp" | "helpers", on: boolean): string {
  const { front } = splitFront(raw);
  const line = front.find((item) => /^reach:/.test(item));
  const current = line
    ? line
        .replace(/^reach:\s*/, "")
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  const next = on ? [...new Set([...current, key])] : current.filter((item) => item !== key);
  return withFrontKey(raw, "reach", `[${next.join(", ")}]`);
}
