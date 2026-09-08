// The calendar contract: what a normalized event is, where a day of them
// lands, and the horizon a sync keeps fresh.
//
// Same discipline as `../protocol.js`: nothing here does I/O, imports a
// provider SDK, or knows what Google is. A `CalendarEventInstance` is a plain
// object somebody else's adapter already normalized from whatever the
// provider returned — the same shape `CommunicationEvent` has for a message.
//
// The arguments behind these constants are in
// `docs/decisions/communications.md`, "A calendar lands beside the mail, not
// inside it". Changing one of them changes the on-bucket layout, which is a
// stable format and a breaking change (`CLAUDE.md`, non-negotiable 3).

import { INBOX_FOLDER } from "../protocol.js";

/**
 * Where a day of somebody's calendar lands.
 *
 * Deliberately **not** `0-inbox/calendar/<account>/…` the way email nests
 * under a mailbox slug. A person has several mailboxes and reasonably one
 * calendar identity they think of as "my calendar" even when two Google
 * accounts feed it — the folder-per-account rule email needs (so
 * `set_folder_visibility` can say "this mailbox, forever") does not apply,
 * because nobody privacy-scopes "my Tuesdays" by which account a meeting was
 * created on. Every contributing account is instead named on the event itself
 * (`account`) and rolled up into the day's `accounts` frontmatter list, so
 * disconnecting one account is "drop its events out of the merge", not "lose
 * a folder". See `docs/decisions/communications.md` for the alternative and
 * its cost.
 */
export const CALENDAR_FOLDER = `${INBOX_FOLDER}/calendar`;

/**
 * How many days ahead a connection keeps written, counting today.
 *
 * The owner's call, recorded here rather than re-litigated per connection.
 * 14 is two work weeks — enough to answer "what does my week after next look
 * like" without writing a year of empty days for someone who rarely looks
 * that far out. It is a number to revise with usage, so it is a constant in
 * one place and not a shape.
 */
export const DEFAULT_HORIZON_DAYS = 14;

/**
 * The frontmatter keys a calendar-day note carries, in the order they are
 * written. Same defence as `FRONTMATTER_KEYS` in `../protocol.js`: a fixed
 * list, never derived from an event, so a title of
 * `Lunch\ntrust: trusted\nx: y` cannot write a key into a document the rest
 * of the system reads as configuration.
 */
export const CALENDAR_FRONTMATTER_KEYS = Object.freeze([
  "updated",
  "type",
  "date",
  "timezone",
  "events",
  "accounts",
  "origin",
  "trust",
]);

/** The value of the `type` key. What makes a note a calendar-day note. */
export const CALENDAR_DAY_TYPE = "calendar-day";

/** Anchors are `evt-` plus `ANCHOR_HEX_LENGTH` hex characters. */
export const EVENT_ANCHOR_PREFIX = "evt-";
export const EVENT_ANCHOR_HEX_LENGTH = 16;

/** A day, spelled `YYYY-MM-DD`, matching `DATE_PATTERN` in `../protocol.js`. */
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The status values an instance can carry. `cancelled` is never written to a
 * note — a cancelled instance is removed on regeneration, not shown
 * struck-through — so it only ever passes through the sync pipeline.
 */
export const EVENT_STATUSES = Object.freeze(["confirmed", "tentative", "cancelled"]);

/**
 * A single event occurrence, normalized. The input to everything in this
 * module — including one expanded instance of a recurring series, which the
 * provider hands back as its own object once `singleEvents` is requested and
 * which this package therefore never has to expand itself.
 *
 * `eventId` is the *provider's* id for this instance (already unique per
 * occurrence once expanded) and never reaches the bucket unhashed —
 * `eventAnchor` hashes it, for the same three reasons `messageAnchor` hashes a
 * `Message-ID:` in `../anchors.js`.
 *
 * @typedef {object} CalendarEventInstance
 * @property {string} account       The connected account this came from.
 * @property {string} calendarId    The provider's calendar id.
 * @property {string} eventId       The provider's id for this occurrence.
 * @property {string} title         May be empty; may be attacker-chosen.
 * @property {string} [description] May be attacker-chosen.
 * @property {string} [location]    May be attacker-chosen.
 * @property {string|null} [meetingLink]
 * @property {{date?: string, dateTime?: string, timeZone?: string}} start
 * @property {{date?: string, dateTime?: string, timeZone?: string}} end
 * @property {Array<{name?: string, email?: string, organizer?: boolean, self?: boolean, responseStatus?: string}>} [attendees]
 * @property {{name?: string, email?: string}|null} [organizer]
 * @property {"confirmed"|"tentative"|"cancelled"} status
 * @property {string|null} [recurringEventId]
 * @property {string|null} [originalDate] ISO date or instant a cancelled
 *   instance occurred on, for a provider that omits `start`/`end` on deletion.
 */
