/**
 * What the turn log (`apps/convex/functions/agentTurns.ts`) keeps of a turn's
 * trace, from `route.js`.
 */

/** The router's confidence as the turn log takes it: 0 to 1, or nothing. A number Clef got wrong never costs the turn its log. */
function confidenceOf(entry) {
  const value = entry.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  return { confidence: Math.min(1, Math.max(0, value)) };
}

/**
 * A trace entry as the turn log takes it (`apps/convex/functions/agentTurns.ts`):
 * kinds, names, numbers and flags, never a word the router or a provider
 * wrote. The router's own word (`pick`) and a fallback's `from` stay in this
 * worker's log line; the status a provider answered is a number and goes, as
 * does the router's confidence in a think pick (a number from 0 to 1).
 */
export function wireTraceEntry(entry) {
  const base = { kind: entry.kind, ok: entry.ok !== false, ms: entry.ms ?? 0 };
  if (entry.kind === "tool") return { ...base, tool: entry.tool, ...(entry.held ? { held: true } : {}) };
  if (entry.kind === "router") return { ...base, tier: entry.tier, model: entry.model, ...confidenceOf(entry) };
  if (entry.kind === "fallback") return { ...base, model: entry.model, ...(typeof entry.status === "number" ? { status: entry.status } : {}) };
  return {
    ...base,
    // Which model ran the round: a planned turn has two (`modelPlan.js`).
    ...(typeof entry.model === "string" ? { model: entry.model } : {}),
    ...(entry.retried ? { retried: true } : {}),
    ...(entry.cut ? { cut: true } : {}),
    ...(typeof entry.status === "number" ? { status: entry.status } : {}),
  };
}

/**
 * Where a turn came from, for the turn log's `kind`: a routine's run, a
 * background job, a group chat, a person's own texts, or the app.
 */
export function turnKind({ runner, job, group, texting }) {
  if (runner) return "routine";
  if (job) return "job";
  if (group) return "group";
  return texting ? "one" : "app";
}

/** A text this old is not waiting, it was replayed: no wait is recorded for it. */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * How long the text this turn answers waited before the gateway had it: from
 * `arrivedAt`, the time the texting Worker took in the first message the turn
 * covers, to `received`, when this route read the request. That wait is the
 * group pause, the decision, the queue and any retry, none of which the
 * turn's own `ms` sees. Nothing for a missing, future or day-old time; a
 * clock a little ahead of ours counts as no wait.
 */
export function waitBefore(arrivedAt, received) {
  if (typeof arrivedAt !== "number" || !Number.isFinite(arrivedAt)) return undefined;
  const wait = received - arrivedAt;
  if (wait > MAX_WAIT_MS || wait < -60_000) return undefined;
  return Math.max(0, Math.round(wait));
}

/**
 * The row `recordAgentTurn` keeps of a finished turn: names, outcomes, times
 * and token counts, never text. `waitMs` is `waitBefore`'s, when the Worker said when the text came in. `parts` is `meterParts(turn)` (`modelPlan.js`),
 * each model's own counts, which the control plane prices; a failed turn has
 * none and is priced from its own counts.
 */
export function turnReport({ provider, outcome, model, timing, usage, parts, kind, ms, waitMs }) {
  return {
    provider,
    model: typeof model === "string" ? model : "unknown",
    outcome,
    kind,
    ms,
    ...(typeof waitMs === "number" ? { waitMs } : {}),
    modelMs: timing?.modelMs ?? 0,
    toolMs: timing?.toolMs ?? 0,
    rounds: timing?.rounds ?? 0,
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    ...(Array.isArray(parts) && parts.length > 0
      ? { usage: parts.filter((part) => typeof part.model === "string").map(({ model: name, input, output, cacheRead, cacheWrite }) => ({ model: name, input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 })) }
      : {}),
    trace: Array.isArray(timing?.trace) ? timing.trace.map(wireTraceEntry) : [],
  };
}

/*
  A group turn's timing as one line under its answer in the chat's note
  (`groupMemoryNote.js`), where the chat's history can be read: when the
  first text it answers came in, when the gateway started it, when its answer
  was ready, and the fixed replies the texting Worker sent since the last
  turn, such as the settings menu, which never reach the gateway on their own
  (`fixed`, `groupSay.ts`). Times in UTC and durations only, never words.
*/
const DAY = 24 * 60 * 60 * 1000;
const FIXED_PATH = /^[a-z_]{1,24}$/;
const STAGES = [["queueMs", "waited"], ["startMs", "workflow start"], ["membersMs", "member list"], ["controlMs", "control plane"], ["replyMs", "reply"]];

const clock = (at) => `${new Date(at).toISOString().slice(11, 19)}Z`;
export function span(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
const within = (value, now) => Number.isFinite(value) && Math.abs(now - value) <= DAY;
const length = (value) => Number.isFinite(value) && value >= 0 && value <= DAY;

/** One fixed reply as the Worker reported it, or null when any part is out of shape. */
function fixedPart(entry, now) {
  if (entry === null || typeof entry !== "object" || !FIXED_PATH.test(String(entry.path))) return null;
  if (!within(entry.arrivedAt, now) || !within(entry.sentAt, now) || entry.sentAt < entry.arrivedAt) return null;
  const stages = STAGES.filter(([key]) => entry[key] !== undefined);
  if (!stages.every(([key]) => length(entry[key]))) return null;
  const named = entry.path.replace(/_/g, " ");
  return `${named} reply: asked ${clock(entry.arrivedAt)}, sent ${clock(entry.sentAt)} (${span(entry.sentAt - entry.arrivedAt)}; ${stages.map(([key, word]) => `${word} ${span(entry[key])}`).join(", ")})`;
}

/** The hidden timing line's words for a group turn, or null when nothing is known. */
export function groupTimingLine({ arrivedAt, received, done, fixed }) {
  const parts = [];
  if (Array.isArray(fixed)) for (const entry of fixed.slice(-5)) {
    const part = fixedPart(entry, received);
    if (part !== null) parts.push(`before this, ${part}`);
  }
  const wait = waitBefore(arrivedAt, received);
  const asked = wait === undefined ? "" : `asked ${clock(received - wait)}, `;
  const waited = wait === undefined ? "" : ` (waited ${span(wait)})`;
  parts.push(`${asked}Tex started ${clock(received)}${waited}, answer ready ${clock(done)} (${span(done - received)})`);
  return parts.join("; ");
}
