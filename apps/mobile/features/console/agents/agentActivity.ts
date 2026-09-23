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

/** The hook's answer, as a plain value the explorer can be handed in a test. */
export interface AgentActivityView {
  agents: readonly ActiveAgent[];
  marks: readonly AgentMark[];
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
function label(value: unknown): string {
  if (typeof value !== "string") return "An agent";
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufff9-\ufffb]/g, "")
    .trim()
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : "An agent";
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
  return { agents, marks };
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

/** The foot's line. `null` when no agent is active, and then nothing is drawn. */
export function agentsLine(view: AgentActivityView | undefined): string | null {
  const count = view?.agents.length ?? 0;
  if (count === 0) return null;
  return count === 1 ? "1 agent active" : `${count} agents active`;
}

/** How long ago, in the short form a list row can afford. */
export function agoShort(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return seconds < 5 ? "now" : `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/** The note's name without its folders or `.md`, for a line that has little room. */
export function noteName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
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
