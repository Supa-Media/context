// Event anchors: the stable link target inside a calendar-day note, and the
// mechanism `meetingLink.js` uses to point a meeting note at one.
//
// Same reasoning `../anchors.js` gives for a message anchor, restated for an
// event rather than re-derived: the provider's id is attacker-influenced
// enough to keep out of a heading (a title is a sibling field on the same
// resource, and an id an inviter chooses the shape of is not a promise it is
// inert), it means something to the provider and nothing to the customer, and
// FNV-1a is a synchronous, already-used hash rather than a new dependency on
// `crypto.subtle`.

import { fnv1a64 } from "../anchors.js";
import { EVENT_ANCHOR_HEX_LENGTH, EVENT_ANCHOR_PREFIX } from "./protocol.js";

export { fnv1a64 };

/**
 * The three-field join, NUL-separated for the same reason `anchorInput` in
 * `../anchors.js` is: a separator a caller can write is a separator a caller
 * can forge.
 */
function anchorInput(event) {
  const account = String(event?.account ?? "");
  const calendarId = String(event?.calendarId ?? "");
  const eventId = String(event?.eventId ?? "");
  return `${account}\u0000${calendarId}\u0000${eventId}`;
}

/**
 * The anchor for one event occurrence: `evt-` plus 16 hex characters.
 *
 * Stable across regeneration of the day and across a resync, because
 * `singleEvents` expansion already gives a recurring instance its own,
 * unchanging id — this hashes that id rather than minting a position, so a
 * link into "the 09:00 standup on the 7th" survives an event moving to 09:30.
 *
 * @param {import("./protocol.js").CalendarEventInstance} event
 * @returns {string}
 */
export function eventAnchor(event) {
  return `${EVENT_ANCHOR_PREFIX}${fnv1a64(anchorInput(event))}`;
}

/** Is this string one `eventAnchor` produced? */
export function isEventAnchor(value) {
  return (
    typeof value === "string" &&
    value.startsWith(EVENT_ANCHOR_PREFIX) &&
    new RegExp(`^[0-9a-f]{${EVENT_ANCHOR_HEX_LENGTH}}$`).test(value.slice(EVENT_ANCHOR_PREFIX.length))
  );
}

/**
 * The cache key one event occurrence is tracked under across a sync's
 * lifetime — every account, calendar and provider id it could ever collide
 * with, joined the same way the anchor's input is. Deliberately distinct from
 * the anchor (a cache key is never written anywhere and does not need to be
 * short), so a future change to one is not a change to the other.
 *
 * @param {{account?: string, calendarId?: string, eventId?: string}} event
 * @returns {string}
 */
export function eventCacheKey(event) {
  return anchorInput(event);
}
