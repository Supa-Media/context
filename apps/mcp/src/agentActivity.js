/**
 * Which notes agents are reading and writing in a workspace right now.
 *
 * The note room (`presence.js`) says who is in *one* note. This answers the
 * question one level up, for the file tree: a person looking at their
 * workspace should be able to see that an agent is working in it, and where,
 * without opening every note to find out.
 *
 * ## What it can honestly claim, which is less than it might look
 *
 * An MCP client is stateless. It has no session to start or end and holds no
 * socket, so the gateway learns about an agent only from the tool calls it
 * makes, and only once each call has finished. So this records two facts and
 * nothing else:
 *
 *  - **read**: `read_note` or `fetch` returned a note.
 *  - **write**: `write_note` stored one.
 *
 * It does not claim an agent is "writing now" or "about to edit a section".
 * The model finishes writing before it calls the tool, and nothing reaches us
 * until then. "Active" means a call in the last `AGENT_ACTIVITY_WINDOW_MS`, and
 * a mark fades out of the answer when the window passes.
 *
 * ## Paths are held only in memory, and only briefly
 *
 * A path is the customer's data as surely as a note's text is. So the log
 * lives in the memory of one Durable Object instance per workspace. It is
 * never written to storage, it is pruned to the window on every read and
 * write, and it is gone whenever the runtime evicts the object. Losing it
 * costs a few dots that were about to fade anyway. It is never the only copy
 * of anything: the audit trail and `activity.md` record every write
 * separately.
 *
 * ## Nothing leaves without a `canSee`
 *
 * The log holds every path any agent touched, private ones included, because
 * it cannot know who will ask. `activityForCaller` takes a visibility check
 * from the route and drops every event that fails it *before* aggregating. An
 * agent whose only work was on private notes is therefore absent from a team
 * member's answer, rather than listed with nothing next to it. Its presence
 * would itself say that somebody is working on something they cannot see.
 */

import { MAX_DISPLAY_NAME, colorFor, normalizeDisplayName } from "./presence.js";

/** How long a read or a write counts as "now". */
export const AGENT_ACTIVITY_WINDOW_MS = 5 * 60_000;

/**
 * How many events one workspace keeps.
 *
 * A ceiling on memory, not a product number. An agent reading a whole folder
 * produces one event per note, and past this the oldest go first, which is the
 * order they would have faded in anyway.
 */
export const AGENT_ACTIVITY_MAX_EVENTS = 2_000;

/** How many agents one answer lists. A pill and a popover, not a report. */
export const AGENT_ACTIVITY_MAX_AGENTS = 50;

/** The longest path the log accepts. Longer is not a note this worker wrote. */
const MAX_PATH_LENGTH = 1_024;

const KINDS = new Set(["read", "write"]);

/**
 * The Durable Object instance that holds one workspace's log.
 *
 * One namespace with the note rooms, and a key that cannot be one of theirs:
 * `roomKey` percent-encodes the workspace id, so a `:` never appears in its
 * first segment, and every key here starts with `activity:`.
 */
export function agentActivityKey(workspaceId) {
  return `activity:${encodeURIComponent(String(workspaceId))}`;
}

/** An agent's public id: the same `a:` prefix the note room uses for its caret. */
export function agentMemberId(clientKey) {
  return `a:${clientKey}`;
}

/** Drop what is older than the window, and the oldest past the ceiling. */
export function pruneActivity(log, now) {
  const cutoff = now - AGENT_ACTIVITY_WINDOW_MS;
  let first = 0;
  while (first < log.length && log[first].at < cutoff) first += 1;
  if (first > 0) log.splice(0, first);
  if (log.length > AGENT_ACTIVITY_MAX_EVENTS) log.splice(0, log.length - AGENT_ACTIVITY_MAX_EVENTS);
  return log;
}

/**
 * Validate one event from the gateway and append it.
 *
 * The only caller is the gateway, which has just authorized and completed the
 * call. It is still checked for shape, because a malformed event would reach
 * every member's sidebar.
 */
export function recordActivity(log, event, now) {
  if (!event || typeof event !== "object") return false;
  const { path, kind, actor } = event;
  if (typeof path !== "string" || !path || path.length > MAX_PATH_LENGTH) return false;
  if (!KINDS.has(kind)) return false;
  if (!actor || typeof actor !== "object") return false;
  if (typeof actor.id !== "string" || !/^[0-9a-f]{16}$/.test(actor.id)) return false;
  log.push({
    path,
    kind,
    id: agentMemberId(actor.id),
    name: normalizeDisplayName(typeof actor.name === "string" ? actor.name.slice(0, MAX_DISPLAY_NAME * 4) : ""),
    at: now,
  });
  pruneActivity(log, now);
  return true;
}

/**
 * What one caller may be shown.
 *
 * `visible(path)` is the route's `canSee`, re-asked against the live
 * `privacy.md` on every request. Events are filtered first and aggregated
 * second. Filtering after aggregation would still leak counts and agent
 * names out of events the caller cannot see.
 *
 * The answer has two parts:
 *
 *  - `marks`: one entry per visible path, `write` outranking `read`, for the
 *    tree's rows.
 *  - `agents`: one entry per agent with any visible event, newest first, for
 *    the pill and its list.
 */
export function activityForCaller(log, now, visible) {
  pruneActivity(log, now);
  const marks = new Map();
  const agents = new Map();
  for (const event of log) {
    if (!visible(event.path)) continue;

    const mark = marks.get(event.path);
    if (!mark || (event.kind === "write" && mark.kind === "read") || (event.kind === mark.kind && event.at >= mark.at)) {
      marks.set(event.path, { path: event.path, kind: event.kind, at: event.at, agent: event.id });
    }

    let agent = agents.get(event.id);
    if (!agent) {
      agent = { id: event.id, name: event.name, color: colorFor(event.id), read: new Set(), written: new Set(), at: 0, kind: event.kind, path: event.path };
      agents.set(event.id, agent);
    }
    (event.kind === "write" ? agent.written : agent.read).add(event.path);
    if (event.at >= agent.at) {
      agent.at = event.at;
      agent.kind = event.kind;
      agent.path = event.path;
      agent.name = event.name;
    }
  }
  return {
    windowMs: AGENT_ACTIVITY_WINDOW_MS,
    marks: [...marks.values()],
    agents: [...agents.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, AGENT_ACTIVITY_MAX_AGENTS)
      .map(({ read, written, ...agent }) => ({ ...agent, reads: read.size, writes: written.size })),
  };
}
