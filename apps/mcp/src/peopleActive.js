/**
 * Who has a workspace open right now, for the console's "N people active".
 *
 * `agentActivity.js` answers "which agents touched this workspace lately"
 * from the tool calls they make. People make no tool calls while they read,
 * but every open console asks `/agent-activity` every half minute while its
 * tab is visible (`AGENT_ACTIVITY_POLL_MS` in the app). That ask is the
 * heartbeat: a person is active while their console keeps asking, and stops
 * being active a little after it stops, which is what a hidden tab, a closed
 * laptop and a closed window all look like from here.
 *
 * ## What is held, and for how long
 *
 * One entry per person, in the memory of the workspace's activity object, and
 * nothing else: an opaque id (a digest of the account id, never the id), the
 * display name the note rooms already show beside a caret, and when they last
 * asked — and, since the live map, which note they have open and whether they
 * are editing it, when their console says so. That note is the person's own
 * claim, so the route lets them make it only about a note they can see and
 * that exists (`live/activityHeartbeat.js`), and shows it to each caller only
 * through that caller's own `canSee`. A console with no note open says
 * nothing about where in the workspace somebody is. It is never written to storage and is pruned on every read and write, so
 * eviction costs one poll's worth of undercount.
 *
 * ## Who is counted
 *
 * Only the console's own client. An MCP client holding a grant can call the
 * same route, and an agent is already counted as an agent; counting it as a
 * person too would put a robot in the people number. The route decides that,
 * not this module.
 */

import { MAX_DISPLAY_NAME, colorFor, normalizeDisplayName } from "./presence.js";

/**
 * How long one ask keeps a person active.
 *
 * Two poll intervals and some slack: one late poll (a slow network, a busy
 * tab) must not blink somebody out and back in.
 */
export const PEOPLE_ACTIVE_WINDOW_MS = 75_000;

/** A ceiling on memory, not a product number: past it the stalest go first. */
export const PEOPLE_ACTIVE_MAX = 10_000;

/** How many people one answer names. The count is exact; the faces are a glance. */
export const PEOPLE_ACTIVE_MAX_LISTED = 50;

/** A person's public id: `p:` beside the agents' `a:`, so the two never collide. */
export function personMemberId(key) {
  return `p:${key}`;
}

/** Drop whoever has not asked within the window. */
export function prunePeople(roster, now) {
  const cutoff = now - PEOPLE_ACTIVE_WINDOW_MS;
  for (const [id, person] of roster) {
    if (person.at < cutoff) roster.delete(id);
  }
  if (roster.size > PEOPLE_ACTIVE_MAX) {
    const stalest = [...roster.values()].sort((a, b) => a.at - b.at);
    for (const person of stalest.slice(0, roster.size - PEOPLE_ACTIVE_MAX)) roster.delete(person.id);
  }
  return roster;
}

/** The longest note path a heartbeat may carry, as for agents' events. */
const MAX_PATH_LENGTH = 1_024;

/** `{path, doing}` checked for shape, or `null`. */
function noteFrom(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.path !== "string" || !raw.path || raw.path.length > MAX_PATH_LENGTH) return null;
  return { path: raw.path, doing: raw.doing === "edit" ? "edit" : "read" };
}

/**
 * Note that one person's console asked just now.
 *
 * The gateway is the only caller and has resolved the session already. The
 * shape is still checked, because the name reaches every member's sidebar.
 */
export function recordPerson(roster, person, now) {
  if (!person || typeof person !== "object") return false;
  if (typeof person.key !== "string" || !/^[0-9a-f]{16}$/.test(person.key)) return false;
  const id = personMemberId(person.key);
  const note = noteFrom(person.note);
  roster.set(id, {
    id,
    name: normalizeDisplayName(typeof person.name === "string" ? person.name.slice(0, MAX_DISPLAY_NAME * 4) : ""),
    at: now,
    // Every ask says where they are now, so an ask with no note clears it.
    path: note?.path ?? null,
    doing: note?.doing ?? null,
  });
  prunePeople(roster, now);
  return true;
}

/**
 * The people part of one caller's answer.
 *
 * `self` marks the caller's own entry, so a console can tell "you and 3
 * others" from "4 other people" without knowing its own opaque id. Every
 * member of a workspace may see who else has it open: they already see each
 * other's names in any note they share, and a name here says less than a
 * caret does, because it carries no note.
 */
export function peopleForCaller(roster, now, selfKey) {
  prunePeople(roster, now);
  const self = typeof selfKey === "string" ? personMemberId(selfKey) : null;
  const listed = [...roster.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, PEOPLE_ACTIVE_MAX_LISTED)
    .map((person) => ({
      id: person.id,
      name: person.name,
      color: colorFor(person.id),
      self: person.id === self,
      // Unfiltered here: this object has no `privacy.md`. The route nulls
      // every path the caller cannot see before anything leaves the worker.
      path: person.path ?? null,
      doing: person.path ? person.doing : null,
    }));
  return { peopleCount: roster.size, people: listed };
}
