/**
 * Which notes agents are reading and writing in a workspace right now.
 *
 * The note room (`presence.js`) says who is in *one* note. This answers the
 * question one level up, for the file tree and the live map: a person looking
 * at their workspace should be able to see that an agent is working in it,
 * and where, without opening every note to find out.
 *
 * ## What it can honestly claim, which is less than it might look
 *
 * An MCP client is stateless. It has no session to start or end and holds no
 * socket, so the gateway learns about an agent only from the tool calls it
 * makes, and only once each call has finished. So this records four facts and
 * nothing else:
 *
 *  - **read**: `read_note` or `fetch` returned a note.
 *  - **edit**: `write_note` changed a note that was there.
 *  - **create**: `write_note` stored a note that was not.
 *  - **move**: `move_note`, `move_notes`, `move_folder` or `archive_note`
 *    renamed a note, one event per note moved, `from` → `path`.
 *
 * `edit`, `create` and `move` are all a **write** to the file tree and the
 * agent list, which predate the distinction and still read `read | write`.
 * The finer kind is for the live map, alongside (`events`, `doing`).
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
 *
 * **A move is shown only when both ends are.** Revealing just the visible end
 * — as a note appearing from nowhere, or vanishing — would be true about the
 * tree and would still say something the caller's listing never says: that
 * the note came from, or went to, somewhere they cannot see, at this moment,
 * by this agent. So a half-hidden move is dropped from every part of the
 * answer, and the note simply appears or disappears at the caller's next
 * listing, as it would have before the map existed.
 *
 * ## People's own finished actions ride the same log
 *
 * Moves and creates made in the console go through the control plane, not a
 * tool call, so the console announces them itself on its heartbeat
 * (`live/activityHeartbeat.js`, which checks both ends and that the change
 * really happened). They are kept as `actor: "person"` events: in `events`
 * for the map, never in `marks` or `agents`, which are about agents.
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

/** How many events one answer carries for the map, newest last. */
export const AGENT_ACTIVITY_MAX_ANSWER_EVENTS = 200;

/** How many reads one agent's "What it's reading" lists, oldest first. */
export const AGENT_ACTIVITY_MAX_READ_PATHS = 30;

/**
 * How many events one tool call may add. A folder move is one event per note,
 * and a folder of thousands would otherwise push every other agent's work out
 * of the log in one call. The gateway keeps the first this many.
 */
export const AGENT_ACTIVITY_MAX_ENTRIES_PER_CALL = 200;

/** The longest path the log accepts. Longer is not a note this worker wrote. */
const MAX_PATH_LENGTH = 1_024;

/** What the log stores. `write`, from an older gateway, is stored as `edit`. */
export const ACTIVITY_KINDS = new Set(["read", "edit", "create", "move"]);

/** What a person's console may announce of its own: never a read or an edit. */
const PERSON_KINDS = new Set(["create", "move"]);

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

function goodPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_LENGTH;
}

function cleanName(value) {
  return normalizeDisplayName(typeof value === "string" ? value.slice(0, MAX_DISPLAY_NAME * 4) : "");
}

/** One `{kind, path, from?}` checked for shape, or `null`. */
function entryFrom(raw, kinds) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "write" ? "edit" : raw.kind;
  if (!kinds.has(kind) || !goodPath(raw.path)) return null;
  if (kind !== "move") return { kind, path: raw.path };
  if (!goodPath(raw.from) || raw.from === raw.path) return null;
  return { kind, path: raw.path, from: raw.from };
}

/**
 * Strictly later than the newest event, so `since=<at>` is exact.
 *
 * Two events in one millisecond would otherwise share an `at`, and a client
 * asking for "after the newest one I hold" would never be given the second.
 * A millisecond of drift is invisible on a five-minute window.
 */
function stamp(log, now) {
  const last = log.length > 0 ? log[log.length - 1].at : -Infinity;
  return Math.max(now, last + 1);
}

/**
 * Validate one call's events from the gateway and append them.
 *
 * The only caller is the gateway, which has just authorized and completed the
 * call. It is still checked for shape, because a malformed event would reach
 * every member's sidebar. Two shapes: `{path, kind, actor}` (one event, as an
 * older gateway sends it) and `{entries: [...], actor}` (a move of several).
 * One malformed entry refuses the whole call rather than half of it.
 */
export function recordActivity(log, event, now) {
  if (!event || typeof event !== "object") return false;
  const { actor } = event;
  if (!actor || typeof actor !== "object") return false;
  if (typeof actor.id !== "string" || !/^[0-9a-f]{16}$/.test(actor.id)) return false;
  if (actor.owner !== undefined && (typeof actor.owner !== "string" || !/^[0-9a-f]{16}$/.test(actor.owner))) {
    return false;
  }
  const raw = Array.isArray(event.entries) ? event.entries : [event];
  if (raw.length === 0 || raw.length > AGENT_ACTIVITY_MAX_ENTRIES_PER_CALL) return false;
  const entries = raw.map((entry) => entryFrom(entry, ACTIVITY_KINDS));
  if (entries.some((entry) => entry === null)) return false;
  const name = cleanName(actor.name);
  for (const entry of entries) {
    log.push({
      ...entry,
      id: agentMemberId(actor.id),
      name,
      actor: "agent",
      ...(actor.owner === undefined ? {} : { owner: actor.owner }),
      at: stamp(log, now),
    });
  }
  pruneActivity(log, now);
  return true;
}

/**
 * A person's console announcing a create or a move it just finished.
 *
 * The route has checked both ends against the caller's `canSee`, and that the
 * change really happened, before sending it; see `live/activityHeartbeat.js`.
 * The id is the person's `p:` id from `peopleActive.js`.
 */
export function recordPersonActivity(log, person, did, now) {
  if (!person || typeof person !== "object") return false;
  if (typeof person.key !== "string" || !/^[0-9a-f]{16}$/.test(person.key)) return false;
  const entry = entryFrom(did, PERSON_KINDS);
  if (entry === null) return false;
  const id = `p:${person.key}`;
  // The same announcement twice in the window is one event: a console that
  // retries, or one that repeats itself, does not replay an animation.
  if (log.some((e) => e.id === id && e.kind === entry.kind && e.path === entry.path && e.from === entry.from)) {
    return false;
  }
  log.push({ ...entry, id, name: cleanName(person.name), actor: "person", at: stamp(log, now) });
  pruneActivity(log, now);
  return true;
}

/** Whether one event may be shown to a caller. A move needs both ends. */
export function eventVisible(event, visible) {
  if (!visible(event.path)) return false;
  return event.kind !== "move" || visible(event.from);
}

/** The tree's two-valued kind, for consumers that predate the map. */
function legacyKind(kind) {
  return kind === "read" ? "read" : "write";
}

/**
 * What one caller may be shown.
 *
 * `visible(path)` is the route's `canSee`, re-asked against the live
 * `privacy.md` on every request. Events are filtered first and aggregated
 * second. Filtering after aggregation would still leak counts and agent
 * names out of events the caller cannot see.
 *
 * The answer has three parts:
 *
 *  - `marks`: one entry per visible path, `write` outranking `read`, for the
 *    tree's rows.
 *  - `agents`: one entry per agent with any visible event, newest first, for
 *    the pill, its list and the map. `kind` stays `read | write`; `doing` is
 *    the finer kind of its newest event, `from` that event's origin when it
 *    was a move, and `readPaths` the visible notes it read, oldest first.
 *  - `events`: the visible events themselves, newest last, for the map's
 *    animations — only those after `since` when it is given.
 */
export function activityForCaller(log, now, visible, callerOwner = null, { since = null } = {}) {
  pruneActivity(log, now);
  const marks = new Map();
  const agents = new Map();
  const events = [];
  for (const event of log) {
    if (!eventVisible(event, visible)) continue;

    if (since === null || event.at > since) {
      events.push({
        at: event.at,
        kind: event.kind,
        path: event.path,
        ...(event.kind === "move" ? { from: event.from, to: event.path } : {}),
        actor: { id: event.id, kind: event.actor === "person" ? "person" : "agent", name: event.name },
      });
    }
    // People's own actions are for the map. The tree's marks and the agent
    // list are about agents, and a person is never drawn as one.
    if (event.actor === "person") continue;

    const kind = legacyKind(event.kind);
    const mark = marks.get(event.path);
    if (!mark || (kind === "write" && mark.kind === "read") || (kind === mark.kind && event.at >= mark.at)) {
      marks.set(event.path, { path: event.path, kind, at: event.at, agent: event.id });
    }

    let agent = agents.get(event.id);
    if (!agent) {
      agent = {
        id: event.id,
        name: event.name,
        color: colorFor(event.id),
        self: callerOwner !== null && event.owner === callerOwner,
        read: new Set(),
        written: new Set(),
        readPaths: [],
        at: 0,
        kind,
        doing: event.kind,
        path: event.path,
        from: undefined,
      };
      agents.set(event.id, agent);
    }
    if (kind === "write") {
      agent.written.add(event.path);
    } else {
      agent.read.add(event.path);
      // In the order it read them; a note read twice in a row is listed once.
      if (agent.readPaths[agent.readPaths.length - 1] !== event.path) agent.readPaths.push(event.path);
      if (agent.readPaths.length > AGENT_ACTIVITY_MAX_READ_PATHS) agent.readPaths.shift();
    }
    if (event.at >= agent.at) {
      agent.at = event.at;
      agent.kind = kind;
      agent.doing = event.kind;
      agent.path = event.path;
      agent.from = event.kind === "move" ? event.from : undefined;
      agent.name = event.name;
    }
  }
  return {
    windowMs: AGENT_ACTIVITY_WINDOW_MS,
    marks: [...marks.values()],
    agents: [...agents.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, AGENT_ACTIVITY_MAX_AGENTS)
      .map(({ read, written, from, ...agent }) => ({
        ...agent,
        ...(from === undefined ? {} : { from }),
        reads: read.size,
        writes: written.size,
      })),
    events: events.slice(-AGENT_ACTIVITY_MAX_ANSWER_EVENTS),
  };
}
