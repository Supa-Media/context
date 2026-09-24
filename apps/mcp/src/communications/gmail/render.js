import { placeDayParts } from "../dayPlacement.js";
import {
  contactDraftsFromCommunication,
  contactPathForDraft,
  mergeContactNote,
  planChannelDay,
} from "../../../../../packages/communications/src/index.js";
import { readManifest, writeManifest, resolveDayAttachments } from "./attachments.js";

/* -------------------------------------------------------------------------- */
/* Rendering one day — pure, given its events                                 */
/* -------------------------------------------------------------------------- */

/**
 * The `updated` frontmatter value for a day, when the caller does not pin one.
 *
 * **Deterministic in the message set, not in wall-clock time.** The latest
 * message's own `sentAt` is stable across any number of reruns as long as the
 * day's mail has not changed, and it advances exactly when a new message
 * does land — which is what makes re-syncing an untouched day byte-identical
 * rather than merely content-identical modulo a timestamp that ticks forward
 * on every pass. `renderChannelDayNote`'s own default (`new Date().toISOString()`)
 * is right for a note a person is editing right now; it is wrong for a value
 * this module recomputes on a schedule against the same underlying mail.
 */
function latestSentAt(events) {
  let latest = 0;
  for (const event of events) {
    const at = Date.parse(String(event?.sentAt ?? ""));
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return new Date(latest).toISOString();
}

/**
 * Every part of one channel-day, ready to write.
 *
 * A day with zero events writes nothing — "one channel-day note per active
 * day" (`docs/decisions/communications.md`) means an inactive day is not a
 * file at all, not an empty one.
 *
 * @param {{mailboxSlug: string, address: string, date: string,
 *          events: object[], nonce: string, now?: string, root?: string,
 *          folder?: string}} options
 * @returns {import("../../../../../packages/communications/src/protocol.js").ChannelDayPart[]}
 */
export function renderDay(options) {
  if (!options.events.length) return [];
  return planChannelDay(
    {
      channel: "email",
      account: options.mailboxSlug,
      address: options.address,
      date: options.date,
      events: options.events,
      nonce: options.nonce,
      now: options.now ?? latestSentAt(options.events),
      origin: "gmail-sync",
    },
    { root: options.root, folder: options.folder },
  );
}

/* -------------------------------------------------------------------------- */
/* Writing a day's parts through the storage adapter                          */
/* -------------------------------------------------------------------------- */

/**
 * Write one rendered part, conditional on the etag this call read.
 *
 * A day is fully regenerated from the same query every time it is touched, so
 * the common case — nothing changed since the last pass — writes the same
 * bytes over the same etag and is a no-op the store can no-op on its own; the
 * conditional write exists for the case that matters, two sync passes racing
 * on the same day, so the loser retries against the winner's etag rather than
 * clobbering it. `maxAttempts` bounds that retry rather than looping forever
 * against a store that never settles.
 *
 * @param {import("../../store/index.js").ContextStore} store
 * @param {import("../../../../../packages/communications/src/protocol.js").ChannelDayPart} part
 * @returns {Promise<{path: string, bytes: number, wrote: boolean}>}
 */
export async function writeDayPart(store, part, maxAttempts = 3) {
  const bytes = new TextEncoder().encode(part.text).length;
  if (!store.capabilities?.conditionalWrite) {
    /*
      NO CONDITIONAL WRITE STILL MEANS NO POINTLESS WRITE.
      This branch used to `put` unconditionally, which made "re-syncing an
      unchanged day writes nothing" true on R2 and S3 and false on exactly the
      backends CLAUDE.md already flags — B2 and Wasabi — where a scheduled loop
      would then rewrite every touched day on every pass forever, and count the
      bytes again each time against the connection's quota. The read-compare is
      the same one the conditional branch does; what this backend cannot give
      is the *atomicity* that turns a race into a retry, and that is the
      degradation, not "write blindly".
    */
    const current = await store.get(part.path);
    if (current && (await current.text()) === part.text) {
      return { path: part.path, bytes, wrote: false };
    }
    await store.put(part.path, part.text);
    return { path: part.path, bytes, wrote: true };
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = await store.get(part.path);
    if (existing && (await existing.text()) === part.text) {
      // Already exactly this. Nothing to write, nothing to race.
      return { path: part.path, bytes, wrote: false };
    }
    const result = existing
      ? await store.put(part.path, part.text, { onlyIf: { etagMatches: existing.etag } })
      : await store.put(part.path, part.text);
    if (result) return { path: part.path, bytes, wrote: true };
    // `null` means the precondition failed — someone else wrote first.
    // Loop and re-read; the content is a pure function of Gmail's state, so
    // converging on the current etag is always possible.
  }
  throw new Error(`writeDayPart: gave up after ${maxAttempts} attempts on ${part.path}`);
}

/** Conflict-safe contact merge: every retry re-merges against the bytes that own the new etag. */
export async function writeContactDraft(store, draft, options = {}, maxAttempts = 3) {
  const build = async () => {
    const path = contactPathForDraft(draft, { root: options.root });
    if (path === null) return null;
    const existing = await store.get(path);
    const existingText = existing ? await existing.text() : "";
    const update = mergeContactNote(existingText, draft, { root: options.root });
    if (update === null) return null;
    return { existing, existingText, update, bytes: new TextEncoder().encode(update.text).length };
  };

  if (!store.capabilities?.conditionalWrite) {
    const next = await build();
    if (next === null) return { wrote: false, bytes: 0, quotaExceeded: false };
    if (next.bytes > options.remainingQuotaBytes) return { wrote: false, bytes: 0, quotaExceeded: true };
    if (next.existing && next.existingText === next.update.text) return { wrote: false, bytes: 0, quotaExceeded: false };
    await store.put(next.update.path, next.update.text);
    return { wrote: true, bytes: next.bytes, quotaExceeded: false };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const next = await build();
    if (next === null) return { wrote: false, bytes: 0, quotaExceeded: false };
    if (next.bytes > options.remainingQuotaBytes) return { wrote: false, bytes: 0, quotaExceeded: true };
    if (next.existing && next.existingText === next.update.text) return { wrote: false, bytes: 0, quotaExceeded: false };
    const result = next.existing
      ? await store.put(next.update.path, next.update.text, { onlyIf: { etagMatches: next.existing.etag } })
      : await store.put(next.update.path, next.update.text);
    if (result) return { wrote: true, bytes: next.bytes, quotaExceeded: false };
  }
  throw new Error("writeContactDraft: contact did not settle after the bounded retry");
}

/**
 * Regenerate and write one day, quota-bound — note text AND, when
 * `fetchImpl`/`accessToken` are supplied, any attachments this day's
 * messages reference.
 *
 * Attachment resolution runs FIRST, against the same `remainingQuotaBytes`
 * the note text then shares: a day whose attachments consumed the whole
 * budget writes no attachment past that point and still writes the note
 * text describing them (metadata-only, per `resolveDayAttachments`'s own
 * quota check) — the note is never skipped because a picture was too big.
 *
 * `fetchImpl`/`accessToken` are optional and gate the whole feature: a
 * caller that omits them (every test that predates attachment fetching,
 * and any future caller that only wants deterministic rendering) gets
 * exactly the old metadata-only behaviour, because `resolveDayAttachments`
 * is never invoked at all.
 *
 * @param {{store: import("../../store/index.js").ContextStore, mailboxSlug: string,
 *          address: string, date: string, events: object[], nonce: string,
 *          now?: string, root?: string, folder?: string, remainingQuotaBytes: number,
 *          fetchImpl?: FetchLike, accessToken?: string,
 *          attachmentMode?: "metadata-only"|"store",
 *          attachmentRetentionDays?: number|"forever"}} options
 * @returns {Promise<{bytesWritten: number, partsWritten: number, quotaExceeded: boolean}>}
 */
export async function syncOneDay(options) {
  let remaining = options.remainingQuotaBytes;
  let bytesWritten = 0;

  if (options.fetchImpl && options.accessToken) {
    // Wall-clock, deliberately never `options.now`: retention math ("N days
    // from when this was written") is about real elapsed time, unlike the
    // note's own `updated` field, which `renderDay` keys to the latest
    // message's timestamp so that re-rendering an unchanged day is
    // byte-identical. Conflating the two would make `attachmentRetentionDays`
    // count from whatever `now` a caller happened to pass for rendering,
    // which for a backfill can be far in the past.
    const resolutionNow = new Date().toISOString();
    const manifest = await readManifest(options.store, options.mailboxSlug, options.folder);
    const resolved = await resolveDayAttachments({
      store: options.store,
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      mailboxSlug: options.mailboxSlug,
      folder: options.folder,
      date: options.date,
      events: options.events,
      attachmentMode: options.attachmentMode ?? "metadata-only",
      retentionDays: options.attachmentRetentionDays ?? DEFAULT_ATTACHMENT_RETENTION_DAYS,
      now: resolutionNow,
      remainingQuotaBytes: remaining,
      manifest,
    });
    bytesWritten += resolved.bytesWritten;
    remaining -= resolved.bytesWritten;
    if (resolved.manifestChanged) await writeManifest(options.store, options.mailboxSlug, resolved.manifest, options.folder);
  }

  // `options.now` travels through UNCHANGED — see `renderDay`'s own default
  // (the latest event's `sentAt`) for why this function must never invent a
  // wall-clock fallback here: doing so would override that determinism for
  // every caller that goes through `syncOneDay`, which is every caller.
  /*
    Rendered in the dated tree, then placed: a day this bucket already holds a
    flat note for keeps it, parts and all. `dayPlacement.js` has the argument —
    a regenerated day that changes folders under itself is one day in two
    places, both of which parse as that day.
  */
  const parts = await placeDayParts(options.store, renderDay(options));
  let partsWritten = 0;
  for (const part of parts) {
    const bytes = new TextEncoder().encode(part.text).length;
    if (bytes > remaining) {
      // Quota-bound, per connection: stop before writing past what the
      // estimator showed, rather than writing partway into a day and calling
      // it done. A day skipped this way is picked up by the next pass once
      // the connection's usage has room again.
      return { bytesWritten, partsWritten, quotaExceeded: true };
    }
    const result = await writeDayPart(options.store, part);
    if (result.wrote) {
      bytesWritten += result.bytes;
      remaining -= result.bytes;
    }
    partsWritten += 1;
  }

  let contactsWritten = 0;
  const drafts = contactDraftsFromCommunication(options.events, {
    root: options.root,
    folder: options.folder,
    selfAddresses: [options.address],
  });
  for (const draft of drafts) {
    const result = await writeContactDraft(options.store, draft, {
      root: options.root,
      remainingQuotaBytes: remaining,
    });
    if (result.quotaExceeded) {
      return { bytesWritten, partsWritten, contactsWritten, quotaExceeded: true };
    }
    if (result.wrote) {
      bytesWritten += result.bytes;
      remaining -= result.bytes;
      contactsWritten += 1;
    }
  }
  return { bytesWritten, partsWritten, contactsWritten, quotaExceeded: false };
}

/** How long a fetched attachment stays before `sweepExpiredAttachments` deletes it, absent a connection-level choice. */
const DEFAULT_ATTACHMENT_RETENTION_DAYS = 90;

