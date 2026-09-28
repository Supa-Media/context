/**
 * Which notes agents read or wrote in the last few minutes, as the file tree
 * and its foot draw it.
 *
 * The gateway's answer (`GET /agent-activity`, `apps/mcp/src/agentActivity.js`)
 * is already filtered to what this person may see. This module parses it
 * defensively and turns it into two things the explorer draws:
 *
 *  - **a mark on a row**: an outlined square for "an agent read this", a filled
 *    one for "an agent wrote this". One per row, never an avatar, so a
 *    workspace with a hundred agents in it looks the same as one with two.
 *  - **one line in the foot**, "3 agents active", which opens the list of who.
 *
 * ## What a mark does not claim
 *
 * The gateway learns about an agent only from finished tool calls, so a filled
 * square means "wrote this, recently", never "is writing this now". The words
 * in the list say "Wrote" and "Read", in the past tense, for the same reason.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";

export type AgentMarkKind = "read" | "write";

export interface AgentMark {
  path: string;
  kind: AgentMarkKind;
  /** Epoch milliseconds. */
  at: number;
  /** The agent whose event this mark shows, an `a:` id. */
  agent: string;
}

export interface ActiveAgent {
  id: string;
  name: string;
  /** `null` when the gateway sent no usable colour; the view supplies one. */
  color: string | null;
  /** When it last read or wrote anything this person can see. */
  at: number;
  kind: AgentMarkKind;
  /** The note that event was about. */
  path: string;
  /** How many visible notes it read, and wrote, in the window. */
  reads: number;
  writes: number;
}

/**
 * Somebody with this workspace open right now.
 *
 * The gateway counts a person while their console keeps asking for this
 * answer, so "active" means "has it open in a visible tab", not "opened it
 * this week". No note, deliberately: an open console is not a claim about
 * where in the workspace somebody is.
 */
export interface ActivePerson {
  id: string;
  name: string;
  color: string | null;
  /** The viewer's own entry. */
  self: boolean;
}

/** The hook's answer, as a plain value the explorer can be handed in a test. */
export interface AgentActivityView {
  agents: readonly ActiveAgent[];
  marks: readonly AgentMark[];
  /**
   * Who has the workspace open, newest first and capped, and how many there
   * are in all. Absent from an older gateway, which the bar reads as nobody.
   */
  people?: readonly ActivePerson[];
  peopleCount?: number;
}

const EMPTY: AgentActivityView = { agents: [], marks: [] };

function kind(value: unknown): AgentMarkKind | null {
  return value === "read" || value === "write" ? value : null;
}

function colour(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

/**
 * A name from the gateway, made safe to draw.
 *
 * The gateway has already stripped it. It is stripped again here because this
 * module also talks to self-hosted and older gateways, and a name is drawn
 * straight into somebody's sidebar.
 */
function label(value: unknown, fallback = "An agent"): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufff9-\ufffb]/g, "")
    .trim()
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Parse the route's JSON. Anything malformed is dropped, never thrown. */
export function decodeAgentActivity(value: unknown): AgentActivityView {
  if (!value || typeof value !== "object") return EMPTY;
  const raw = value as Record<string, unknown>;
  const marks: AgentMark[] = [];
  for (const entry of Array.isArray(raw.marks) ? raw.marks : []) {
    if (!entry || typeof entry !== "object") continue;
    const one = entry as Record<string, unknown>;
    const k = kind(one.kind);
    if (typeof one.path !== "string" || !one.path || k === null || typeof one.agent !== "string") continue;
    if (typeof one.at !== "number" || !Number.isFinite(one.at)) continue;
    marks.push({ path: one.path, kind: k, at: one.at, agent: one.agent });
  }
  const agents: ActiveAgent[] = [];
  for (const entry of Array.isArray(raw.agents) ? raw.agents : []) {
    if (!entry || typeof entry !== "object") continue;
    const one = entry as Record<string, unknown>;
    const k = kind(one.kind);
    if (typeof one.id !== "string" || !one.id || k === null || typeof one.path !== "string") continue;
    if (typeof one.at !== "number" || !Number.isFinite(one.at)) continue;
    agents.push({
      id: one.id,
      name: label(one.name),
      color: colour(one.color),
      at: one.at,
      kind: k,
      path: one.path,
      reads: typeof one.reads === "number" && one.reads >= 0 ? Math.floor(one.reads) : 0,
      writes: typeof one.writes === "number" && one.writes >= 0 ? Math.floor(one.writes) : 0,
    });
  }
  agents.sort((a, b) => b.at - a.at);
  const people: ActivePerson[] = [];
  for (const entry of Array.isArray(raw.people) ? raw.people : []) {
    if (!entry || typeof entry !== "object") continue;
    const one = entry as Record<string, unknown>;
    if (typeof one.id !== "string" || !one.id) continue;
    people.push({ id: one.id, name: label(one.name, "Someone"), color: colour(one.color), self: one.self === true });
  }
  const counted =
    typeof raw.peopleCount === "number" && Number.isFinite(raw.peopleCount) && raw.peopleCount >= 0
      ? Math.floor(raw.peopleCount)
      : 0;
  return { agents, marks, people, peopleCount: Math.max(counted, people.length) };
}

/**
 * Which rows carry a mark, given which folders are open.
 *
 * The rule `activity.markedRows` uses for the "new" dot, for the same reason:
 * a note gets its mark when every folder above it is open, and otherwise the
 * nearest closed folder carries it. A write outranks a read, so a closed
 * folder with one note written and ten read shows the filled square.
 */
export function agentMarkRows(
  marks: readonly AgentMark[],
  expanded: ReadonlySet<string>,
): Map<string, AgentMarkKind> {
  const rows = new Map<string, AgentMarkKind>();
  for (const mark of marks) {
    const segments = mark.path.split("/");
    let row = mark.path;
    for (let cut = 1; cut < segments.length; cut += 1) {
      const folder = segments.slice(0, cut).join("/");
      if (!expanded.has(folder)) {
        row = folder;
        break;
      }
    }
    if (rows.get(row) !== "write") rows.set(row, mark.kind);
  }
  return rows;
}

/**
 * A count the bar can afford: "940", "2.4k", "12k", "1.2m".
 *
 * Exact below a thousand, where every person is somebody the reader might
 * know; rounded above it, where the number is a sense of size.
 */
export function compactCount(count: number): string {
  const n = Math.max(0, Math.floor(count));
  if (n < 1_000) return String(n);
  const [unit, suffix] = n < 1_000_000 ? [1_000, "k"] : [1_000_000, "m"];
  const scaled = n / unit;
  const shown = scaled < 10 ? Math.floor(scaled * 10) / 10 : Math.floor(scaled);
  return `${String(shown).replace(/\.0$/, "")}${suffix}`;
}

/**
 * How many people the bar counts, or `null` when it says nothing about people.
 *
 * Nothing until somebody *else* has the workspace open: "1 person active" to
 * the one person looking is not news, and a personal workspace is always
 * exactly that. Once somebody else is here the count includes the viewer, the
 * way any room's headcount does.
 */
export function peopleActive(view: AgentActivityView | undefined): number | null {
  const count = view?.peopleCount ?? 0;
  const others = count - ((view?.people ?? []).some((person) => person.self) ? 1 : 0);
  return others > 0 ? count : null;
}

/**
 * The two halves of the activity bar: people, then agents, either absent.
 *
 * One bar, not two: people and agents are the same fact about a workspace
 * (who is working in it now) and are drawn by one component, circles for
 * people and squares for agents, as everywhere else in the console.
 */
export function activeParts(view: AgentActivityView | undefined): { people: string | null; agents: string | null } {
  const people = peopleActive(view);
  const agents = view?.agents.length ?? 0;
  return {
    people: people === null ? null : `${compactCount(people)} ${people === 1 ? "person" : "people"} active`,
    agents: agents === 0 ? null : `${compactCount(agents)} ${agents === 1 ? "agent" : "agents"} active`,
  };
}

/** The bar's whole line. `null` when nobody and no agent is active, and then nothing is drawn. */
export function agentsLine(view: AgentActivityView | undefined): string | null {
  const { people, agents } = activeParts(view);
  if (people === null && agents === null) return null;
  return [people, agents].filter((part) => part !== null).join(" · ");
}

/** How long ago, in the short form a list row can afford. */
export function agoShort(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return seconds < 5 ? "now" : `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * The note's name without its folders or `.md`, for a line that has little room.
 *
 * **Contained here rather than at each caller**, because every use of this is a
 * display: the agent row's line, and that row's accessibility label. Never a
 * key, never a comparison. A note's name comes out of a bucket Context does not
 * own — an editor in a shared workspace picks filenames, and so do Obsidian's
 * sync plugin and the provider's console — so one U+202E in one reverses the
 * rendering of the rest of the row it is drawn in, beside "Wrote", the agent's
 * name and the timestamp. `isolateForDisplay` adds nothing to a name with
 * nothing hostile in it. `displayContainment.test.ts` is the list of every
 * boundary that draws a string Context did not choose, and this is on it.
 */
export function noteName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return isolateForDisplay(base.endsWith(".md") ? base.slice(0, -3) : base);
}

/**
 * What one agent's row says under its name.
 *
 * "Wrote launch-plan" for one note, "Read 4 notes" for several: the list is
 * a glance, and the full path is one press away (the row opens the note).
 */
export function describeAgent(agent: ActiveAgent): string {
  if (agent.kind === "write") {
    return agent.writes > 1 ? `Wrote ${agent.writes} notes` : `Wrote ${noteName(agent.path)}`;
  }
  return agent.reads > 1 ? `Read ${agent.reads} notes` : `Read ${noteName(agent.path)}`;
}

/** A row's accessible description of an agent mark. */
export function describeAgentMark(kind: AgentMarkKind): string {
  return kind === "write" ? "an agent wrote here recently" : "an agent read this recently";
}
