// The Google Chat sync: spaces -> messages -> channel-day notes.
//
// Every dependency that touches the network, the clock, or a stored
// credential is injected — `listSpaces`, `listMessages`, `now` — so this
// whole module is exercised end to end against a fixture Chat API server in
// `test/googleChat.test.mjs`, the same shape
// `docs/decisions/communications.md`, "The Gmail restricted scope is
// Google's decision, so v1 runs on fixtures" argues for the rendering layer,
// one layer further out. Nothing here imports Convex, an OAuth library, or a
// storage adapter: `connection` is a plain object this module is handed, and
// the caller — not yet built; the shared Google-account connection this is
// designed against is a sibling product's table — is the only thing that
// needs to change once a real one exists. See
// `docs/decisions/communications.md`, "Chat sync is built against an
// injected client, never against Convex directly".

import { planChannelDay } from "../../../../../packages/communications/src/note.js";
import { fnv1a64 } from "../../../../../packages/communications/src/anchors.js";
import { chatMessageToEvent, fallbackSpaceLabel, isHistoryOn, spaceDisplayName } from "./transform.js";
import { DAY_MS, REGEN_LOOKBACK_DAYS } from "./protocol.js";

/** A hard ceiling behind the cycle check, for a provider that emits fresh junk forever. */
const MAX_PAGE_WALK = 1000;

/** Fixed, content-free failure a scheduler can classify without parsing provider prose. */
export class ChatPaginationError extends Error {
  constructor() {
    super("Google Chat pagination did not converge");
    this.name = "ChatPaginationError";
    this.code = "PAGINATION_STALLED";
  }
}

function acceptNextPageToken(seen, nextPageToken, pages) {
  if (!nextPageToken) return undefined;
  if (seen.has(nextPageToken) || pages >= MAX_PAGE_WALK) {
    throw new ChatPaginationError();
  }
  seen.add(nextPageToken);
  return nextPageToken;
}

function calendarDate(iso) {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * A day note's `updated` value must describe the provider data, not the wall
 * clock of whichever scheduled pass happened to regenerate it. Otherwise a
 * quiet Chat day is byte-different every few minutes and a real store has to
 * rewrite it forever. Gmail's scheduled path uses the same rule: the newest
 * message timestamp advances exactly when the day gains a message. An
 * unavailable-only notice has no message timestamp, so the day's own stable
 * midnight is the honest fallback.
 */
function stableDayUpdated(events, date) {
  let latest = Date.parse(`${date}T00:00:00.000Z`);
  for (const event of events) {
    const sentAt = Date.parse(String(event?.sentAt ?? ""));
    if (Number.isFinite(sentAt) && sentAt > latest) latest = sentAt;
  }
  return new Date(latest).toISOString();
}

/**
 * The per-day fence nonce, deterministic for a given connection and date so
 * two syncs of the same day are byte-identical, but not derivable by a
 * message sender who does not hold `nonceSeed` — the property the package's
 * own fence security argues for
 * (`packages/communications/src/note.js`, "the nonce is why the fence is
 * worth anything"). `nonceSeed` is a random value generated once at connect
 * time and stored **in the clear** on the connection row — deliberately, and
 * this comment said "sealed alongside the refresh token" until review caught
 * it, which is the kind of claim that gets believed rather than checked. It
 * is not a credential: it opens no account and reaches no message, and the
 * worst a leak buys is one connection's fence marker, which `defangFence`
 * strips out of every sender-written body anyway, so the fence survives a
 * seed a sender somehow learned. What the seed does buy is that the nonce is
 * never derived from the account handle or the date alone, both of which a
 * motivated sender can simply guess. If it ever becomes the *only* thing
 * standing between a sender and a closed fence, it belongs in an envelope and
 * this paragraph is the one to reverse.
 */
export function dayNonce(nonceSeed, account, date) {
  return fnv1a64(`${String(nonceSeed ?? "")} ${String(account ?? "")} ${String(date ?? "")}`);
}

/** `"included"` unless the connection says otherwise — a newly joined space starts visible. */
function spaceState(spaceSettings, key) {
  const value = spaceSettings && typeof spaceSettings === "object" ? spaceSettings[key] : undefined;
  return value === "excluded" || value === "paused" ? value : "included";
}

/**
 * One space's messages, from `sinceMs` to now, however many pages that
 * takes. Returns the events found and the latest `createTime` seen, so the
 * caller can advance that space's cursor independently of every other
 * space's — one space failing must never stall another's.
 */
async function readSpaceMessages({ listMessages, space, account, sinceMs }) {
  const spaceName = String(space?.name ?? "");
  const events = [];
  let latestMs = sinceMs;
  let pageToken;
  let pages = 0;
  const seenPageTokens = new Set();
  do {
    pages += 1;
    const page = await listMessages({ spaceName, sinceCreateTime: new Date(sinceMs).toISOString(), pageToken });
    for (const message of page.items ?? []) {
      const date = calendarDate(message?.createTime);
      if (!date) continue;
      events.push({ date, event: chatMessageToEvent({ space, message, account }) });
      const t = Date.parse(message.createTime);
      if (Number.isFinite(t) && t > latestMs) latestMs = t;
    }
    pageToken = acceptNextPageToken(seenPageTokens, page.nextPageToken, pages);
  } while (pageToken);
  return { events, latestMs };
}

/**
 * Run one sync pass: list every space this account belongs to, read new (and
 * recently-synced, for edits and deletions) messages from each included one,
 * and produce the channel-day note parts that need writing.
 *
 * **Idempotent.** The same connection state and the same Chat API responses
 * produce byte-identical note parts on every call — nothing here reads the
 * caller's clock except through the injected `now`, and every event's anchor,
 * thread key and space key are pure functions of provider ids
 * (`packages/communications`, "the same message rendered twice gets the same
 * anchor").
 *
 * **Forward-only.** A space with no cursor yet is baselined at `now`, so the
 * first pass records where future sync should begin without importing old
 * messages.
 *
 * **Resilient.** One space's failure (network, an unexpected error) is
 * recorded in `errors` and does not stop any other space's sync, nor does it
 * move that space's cursor — the next run retries it from where it left off.
 *
 * @param {{
 *   listSpaces: (args: {pageToken?: string}) => Promise<{items: object[], nextPageToken?: string}>,
 *   listMessages: (args: {spaceName: string, sinceCreateTime: string, pageToken?: string}) => Promise<{items: object[], nextPageToken?: string}>,
 *   connection: {
 *     account: string, nonceSeed: string,
 *     cursors?: Record<string, string>, spaceSettings?: Record<string, "included"|"excluded"|"paused">,
 *     backfillDays?: number, destinationFolder?: string,
 *   },
 *   now?: string, root?: string,
 * }} args
 */
export async function syncGoogleChat({ listSpaces, listMessages, connection, now = new Date().toISOString(), root }) {
  const account = String(connection?.account ?? "");
  const nonceSeed = String(connection?.nonceSeed ?? "");
  const nowMs = Date.parse(now);
  const today = calendarDate(now);

  const spaces = [];
  let spacePageToken;
  let spacePages = 0;
  const seenSpacePageTokens = new Set();
  do {
    spacePages += 1;
    const page = await listSpaces({ pageToken: spacePageToken });
    for (const space of page.items ?? []) spaces.push(space);
    spacePageToken = acceptNextPageToken(
      seenSpacePageTokens,
      page.nextPageToken,
      spacePages,
    );
  } while (spacePageToken);

  const cursors = { ...(connection?.cursors ?? {}) };
  const spaceSettings = connection?.spaceSettings ?? {};

  /** date (YYYY-MM-DD) -> CommunicationEvent[] */
  const eventsByDay = new Map();
  /** today's date only -> spaceName -> {label, reason} */
  const unavailableToday = new Map();
  const spacesSeen = [];
  const errors = [];

  for (const space of spaces) {
    const spaceName = String(space?.name ?? "");
    if (!spaceName) continue;
    const state = spaceState(spaceSettings, spaceName);
    spacesSeen.push({ key: spaceName, state });
    if (state !== "included") continue;

    const existingCursorMs = Date.parse(cursors[spaceName] ?? "");
    const hasCursor = Number.isFinite(existingCursorMs);
    const sinceMs = hasCursor
      ? existingCursorMs - REGEN_LOOKBACK_DAYS * DAY_MS
      : nowMs;
    const historyOn = isHistoryOn(space);

    try {
      // Read regardless of `historyOn`: Chat can still return the handful of
      // messages it retains transiently even with history off, and a real
      // message that did arrive must never be shadowed by the notice below —
      // a day can carry both genuine content and an honest gap at once.
      const { events, latestMs } = await readSpaceMessages({ listMessages, space, account, sinceMs });
      for (const { date, event } of events) {
        if (!eventsByDay.has(date)) eventsByDay.set(date, []);
        eventsByDay.get(date).push(event);
      }
      cursors[spaceName] = new Date(Math.max(latestMs, hasCursor ? existingCursorMs : nowMs)).toISOString();
      if (!historyOn) {
        unavailableToday.set(spaceName, { label: spaceDisplayName(space) || fallbackSpaceLabel(space), reason: "history-off" });
      }
    } catch (err) {
      if (err && err.code === "PERMISSION_DENIED") {
        unavailableToday.set(spaceName, { label: spaceDisplayName(space) || fallbackSpaceLabel(space), reason: "no-access" });
        // The cursor is left untouched: access may return, and when it does
        // the next sync should read forward from where this connection last
        // actually saw the space, not from whatever `now` happened to be
        // while it was locked out.
      } else {
        errors.push({ space: spaceName, message: String(err?.message ?? err) });
        // Same reasoning as a denied space: leave the cursor alone so a
        // transient failure is retried, not silently skipped forever.
      }
    }
  }

  const notes = [];
  const dates = new Set(eventsByDay.keys());
  if (unavailableToday.size && today) dates.add(today);

  for (const date of dates) {
    const events = eventsByDay.get(date) ?? [];
    const unavailableSpaces = date === today ? [...unavailableToday.values()] : [];
    const parts = planChannelDay(
      {
        channel: "google-chat",
        address: account,
        date,
        events,
        unavailableSpaces,
        nonce: dayNonce(nonceSeed, account, date),
        now: stableDayUpdated(events, date),
        origin: "google-chat-sync",
      },
      { root, folder: connection?.destinationFolder }
    );
    for (const part of parts) notes.push(part);
  }

  return { notes, cursors, spaces: spacesSeen, errors };
}
