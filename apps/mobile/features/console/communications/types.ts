/**
 * Shared shapes for the communications console: the Inbox landing page, one
 * channel's days, one channel-day, and one contact.
 *
 * Every type here is a *view* built from what `FileBrowser` already returns —
 * `FileEntry[]` from a listing, `{text, etag}` from `readRaw` — never a new
 * shape the gateway has to grow a tool to produce. See `paths.ts` for what
 * decides a path belongs on one of these views at all, and
 * `docs/decisions/app-and-console.md`, *The communications console reads
 * through `FileBrowser`, not a new tool* for why.
 */

/**
 * A connected messaging channel — never `"meetings"`, which files beside them
 * but is not one.
 *
 * Spelled out rather than derived as `(typeof CHANNELS)[number]`: `CHANNELS`
 * in `@context/communications` is `Object.freeze([...])` with no JSDoc type
 * annotation, so `allowJs` infers its element type as plain `string` and a
 * derived union would silently be `string` too. `paths.test.ts` asserts these
 * three names against `CHANNELS` itself, so a channel added there and not here
 * fails a test rather than widening this type's guarantee quietly.
 */
export type CommsChannel = "email" | "google-chat" | "imessage";

/**
 * Every direct child of the Inbox, per `docs/decisions/communications.md`:
 * meetings, each mailbox, the two flat channels, and contacts — the last one
 * has no "active day" of its own, so its row reads its recency off the
 * folder's own file metadata rather than off a channel-day shape. See
 * `inbox.ts`'s `activeDatesFor`.
 */
export type InboxKind = "meetings" | "contacts" | CommsChannel;

/** One row of the Inbox landing page: one channel, its label, its recency. */
export interface InboxRow {
  kind: InboxKind;
  /** The mailbox slug, for `kind === "email"` only. `""` for every other kind. */
  account: string;
  /** The folder this row opens: `0-inbox/meetings`, `0-inbox/email/<slug>`, … */
  path: string;
  /** The address, for a mailbox; a fixed name otherwise (`"Google Chat"`, …). */
  label: string;
  /** `YYYY-MM-DD` of the most recent active day, or `null` for an empty channel. */
  lastActive: string | null;
  /** How many active days this channel has, capped by how many the caller asked for. */
  activeDays: number;
}

/** One active day of one channel, as the Channel view lists it — a day, not a file. */
export interface ChannelDayRow {
  channel: InboxKind;
  account: string;
  date: string;
  /** The path of part 1. Every part shares this day's row; see `stitchDayPaths`. */
  path: string;
  /** How many parts this day split into. `1` for the common case. */
  parts: number;
  messages: number | null;
  threads: number | null;
}

/** One attachment, described — never the bytes. */
export interface MessageAttachment {
  filename: string;
  contentType: string;
  /** As rendered, e.g. `"48213 bytes"` — a display string, not a byte count to compute with. */
  size: string;
}

/** One message inside a channel-day view, with its body ready to render. */
export interface DayMessageView {
  anchor: string;
  thread: string;
  time: string;
  sender: string;
  subject: string;
  body: string;
  attachments: MessageAttachment[];
}

/** Messages grouped under one thread heading, in the order the day renders them. */
export interface DayThreadView {
  thread: string;
  messages: DayMessageView[];
}

/** One channel-day, fully parsed and with its parts stitched into one view. */
export interface ChannelDayView {
  channel: string;
  account: string;
  date: string;
  threads: DayThreadView[];
  /** `true` when any part failed to load — the view renders what it has, honestly. */
  partial: boolean;
}

/** One identifier on a contact page. */
export interface ContactIdentifier {
  kind: string;
  value: string;
}

/** One activity link on a contact page: a day this person appears in. */
export interface ContactActivity {
  date: string;
  channel: string;
  /** Bucket-relative, with no `.md` — matches what `activityLink` writes. */
  path: string;
  anchor: string;
  label: string;
}

/** A contact page, parsed for display. */
export interface ContactView {
  name: string;
  organization: string;
  identifiers: ContactIdentifier[];
  conflicts: string[];
  activity: ContactActivity[];
  notes: string;
}
