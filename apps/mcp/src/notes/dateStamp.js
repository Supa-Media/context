/**
 * When Context fills a note's date properties (`notes/dateProperties.js` says how; Dev2, 2026-11-10;
 * `docs/decisions/app-and-console/date-properties.md`). Three moments, all on the server:
 *
 *  - **An agent's write** (`write_note`): stamped in the same save, before it is stored. The etag the agent gets back
 *    already covers the dates, so its next write is not a CONFLICT, and the change log has one entry, not two.
 *  - **A person's typing** (the app's collaboration saves, about one a second): never per keystroke. Each content save
 *    waits `DATE_QUIET_MS` behind its answer; only the save still current then stamps, as one more collaboration
 *    edit that merges into open editors like any agent's (so no cursor moves). It records no activity line and sets
 *    off no wait of its own: it is not an edit, so it cannot update itself in a loop.
 *  - **The one backfill pass** (`fill_dates`): notes that have a key but no value, filled from their rows' clocks.
 *
 * What a stamp needs comes from the tree, never a second read of the bucket: the note's first and last save and the
 * workspace's date format from its object (`workspaceStore/dateFacts.js`), and the owner's time zone from the control
 * plane (`store.ownerTimeZone`). Anything missing degrades to doing less: no first-save time leaves `created` empty
 * for later, no zone is the routines' default, never UTC.
 */

import { readDocument as readCollaborationDocument, eligible as collaborationEligible } from "@context/collaboration";
import { contentChanged, dateKeysOf, hasDateKeys, stampDates } from "./dateProperties.js";
import { replaceNoteText } from "../tools/notes/replaceInObject.js";
import { announceCommittedToPresence } from "../live/presence.js";

/** How long a person's typing must pause before the dates are set. */
export const DATE_QUIET_MS = 3_000;

/** A pass of `fill_dates` stops starting notes after this long, and says where to go on from. */
export const FILL_BUDGET_MS = 20_000;

/** A structured line about a stamp: the workspace and what happened, never a path or a word of the note. */
function said(store, event, fields = {}) {
  try {
    console.log(JSON.stringify({ event, ...(typeof store?.actor?.workspaceId === "string" ? { workspace: store.actor.workspaceId } : {}), ...fields }));
  } catch {
    // Saying it never fails the save.
  }
}

/** Leave `zone` on the workspace's object for the next save. Behind the response when the host allows it. */
function rememberZone(store, zone) {
  if (typeof store?.rememberTimeZone !== "function") return;
  const pending = Promise.resolve()
    .then(() => store.rememberTimeZone(zone))
    .catch(() => {});
  if (typeof store?.defer !== "function") return;
  try {
    store.defer(pending);
  } catch {
    // A host that refuses waitUntil still has the promise running.
  }
}

/** The workspace owner's zone, or null. */
async function ownerZone(store) {
  if (typeof store?.ownerTimeZone !== "function") return null;
  try {
    const zone = await store.ownerTimeZone();
    return typeof zone === "string" && zone !== "" ? zone : null;
  } catch {
    return null;
  }
}

/** `{created, saved, style}` for `path` from the workspace's object, or nulls where it does not answer. */
async function noteDates(store, path) {
  const none = { created: null, saved: null, style: null, zone: null };
  if (typeof store?.objectFacts !== "function") return none;
  try {
    const answer = await store.objectFacts({ ask: "dates", path });
    const dates = answer?.dates;
    if (!dates || typeof dates !== "object") return none;
    const clock = (value) => (Number.isFinite(value) ? value : null);
    return {
      created: clock(dates.created),
      saved: clock(dates.saved),
      style: typeof dates.style === "string" ? dates.style : null,
      zone: typeof dates.zone === "string" && dates.zone !== "" ? dates.zone : null,
    };
  } catch {
    return none;
  }
}

/**
 * Whether Context fills dates in the note at `path`. Not in Tex's own folder: its skills and routines keep an
 * `updated:` that Tex sets itself, by its own rule (`agent/reflect.js`), and a use of a skill is not a rewrite of it.
 */
export function stampsPath(path) {
  return typeof path === "string" && !/^tex(\/|$)/i.test(path);
}

/** Whether stamping `text` after a save from `previous` could change anything: an empty key, or a content save. */
export function stampWanted(previous, text) {
  const keys = dateKeysOf(text);
  if (keys.length === 0) return false;
  if (keys.some((key) => key.empty)) return true;
  return keys.some((key) => key.role === "modified") && contentChanged(previous, text);
}

/**
 * What a stamp reads: the note's dates from the workspace's object, and the owner's zone where the object keeps none
 * (`dateFacts.js` `rememberZone`), asked of the control plane only then. Never rejects: each half degrades to null.
 * `asked` says whether the control plane was asked, so the zone is left on the object only when it answered.
 */
async function stampInputs(store, path) {
  const dates = await noteDates(store, path);
  if (dates.zone !== null) return { dates, timeZone: dates.zone, asked: false };
  return { dates, timeZone: await ownerZone(store), asked: true };
}

/**
 * `stampInputs` begun early, beside a save's own find and checks (`tools/notes/write.js`), so a save whose kept zone
 * has expired waits on the slower of the control plane's answer and the save's own work before its stamp, not on their
 * sum (production, 2026-11-24: `cp:/gateway/time-zone` a median 399 ms in 61 of 162 saves, awaited after the checks).
 * Only reads: nothing is left on the object, and no note is changed, until `datedForWrite` uses the answer. Null where
 * this content could never be stamped at `path`, so a save with no date property asks nothing ahead.
 */
export function stampInputsAhead(store, path, content) {
  if (typeof content !== "string" || !stampsPath(path) || !hasDateKeys(content)) return null;
  return stampInputs(store, path).catch(() => null);
}

/**
 * `write_note`'s text with its date properties filled, before it is stored. `storedBody` is the note as it is now
 * (null for a new note: its first save is now). A rewrite that changed nothing but dates keeps `modified` as it was;
 * an empty `modified` on such a rewrite takes the note's last save, not now. `ahead` is `stampInputsAhead`'s promise
 * for the same store and path, when the save began it; without it (or if it came to nothing) the inputs are asked now.
 */
export async function datedForWrite(store, path, content, storedBody, now = Date.now(), ahead = null) {
  if (typeof content !== "string" || !stampsPath(path) || !hasDateKeys(content) || !stampWanted(storedBody, content)) return content;
  // The zone kept beside the facts (`dateFacts.js` `rememberZone`) answers without the control plane. The first save
  // after it expires still asks, then leaves the answer there for the next one.
  const { dates, timeZone, asked } = (ahead === null ? null : await ahead) ?? (await stampInputs(store, path));
  if (asked && timeZone !== null) rememberZone(store, timeZone);
  const changed = contentChanged(storedBody, content);
  return stampDates(content, {
    previous: storedBody,
    modifiedAt: changed ? now : (dates.saved ?? now),
    createdAt: storedBody === null ? now : dates.created,
    timeZone,
    workspaceStyle: dates.style,
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * After a person's collaboration save (`live/collaborationRoute.js`): set the dates once their typing has paused.
 * `committed` is the save's answer (`{text, etag, documentId}`), `before` the note's text before it, `savedAt` when
 * it landed. Runs behind the answer (`store.defer`); returns the work's promise for a host without one, and tests.
 */
export function stampAfterQuiet(store, path, committed, before, savedAt, { quietMs = DATE_QUIET_MS } = {}) {
  if (!stampsPath(path) || typeof committed?.text !== "string" || typeof committed.etag !== "string" || !stampWanted(before, committed.text)) return null;
  const work = (async () => {
    try {
      await pause(quietMs);
      const current = await readCollaborationDocument(store, path);
      // A later save is waiting its own pause; this one is not the last.
      if (current?.etag !== committed.etag || typeof current.text !== "string") return "superseded";
      const dates = await noteDates(store, path);
      const timeZone = dates.zone ?? (await ownerZone(store));
      if (dates.zone === null && timeZone !== null) rememberZone(store, timeZone);
      const text = stampDates(current.text, { previous: before, modifiedAt: savedAt, createdAt: dates.created, timeZone, workspaceStyle: dates.style });
      if (text === current.text) return "unchanged";
      const result = await replaceNoteText(store, path, { expectedEtag: current.etag, onlyCurrent: true, text });
      await announceCommittedToPresence(store, path, result);
      said(store, "date_properties_stamped", { by: "quiet" });
      return "stamped";
    } catch (error) {
      // A conflict is somebody else's save landing first: it stamps after its own pause.
      said(store, "date_properties_skipped", { by: "quiet", code: String(error?.code ?? "error").slice(0, 40) });
      return "skipped";
    }
  })();
  if (typeof store?.defer === "function") {
    try {
      store.defer(work);
    } catch {
      // A host that refuses waitUntil still runs the work, unawaited.
    }
  }
  return work;
}

/**
 * One page of the backfill (`fill_dates`): every note the caller may see that has a date key with no value, filled
 * from its row's clocks (`dateGaps`). `{served: false}` where the workspace's notes are not in its object yet.
 *
 * @returns {Promise<{served: boolean, filled: number, looked: number, next: string|null}>}
 */
export async function fillDatesPage(store, { after = null, budgetMs = FILL_BUDGET_MS, now = Date.now } = {}) {
  if (typeof store?.objectFacts !== "function") return { served: false, filled: 0, looked: 0, next: null };
  const started = now();
  const timeZone = await ownerZone(store);
  let cursor = after;
  let filled = 0;
  let looked = 0;
  for (;;) {
    const page = await store.objectFacts({ ask: "dateGaps", ...(cursor ? { after: cursor } : {}) });
    if (!page || !Array.isArray(page.gaps)) return { served: cursor !== after || looked > 0, filled, looked, next: cursor };
    for (const gap of page.gaps) {
      if (now() - started > budgetMs) return { served: true, filled, looked, next: cursor };
      cursor = gap.path;
      if (!stampsPath(gap.path)) continue;
      looked += 1;
      try {
        const current = await readCollaborationDocument(store, gap.path);
        if (typeof current?.text !== "string" || !collaborationEligible(gap.path, current.text)) continue;
        const text = stampDates(current.text, {
          previous: current.text,
          modifiedAt: Number.isFinite(gap.saved) ? gap.saved : gap.created,
          createdAt: Number.isFinite(gap.created) ? gap.created : null,
          timeZone,
          workspaceStyle: typeof page.style === "string" ? page.style : null,
        });
        if (text === current.text) continue;
        const result = await replaceNoteText(store, gap.path, { expectedEtag: current.etag, onlyCurrent: true, text });
        await announceCommittedToPresence(store, gap.path, result);
        filled += 1;
      } catch {
        // A note somebody is saving right now fills on their save; the pass goes on.
      }
    }
    if (typeof page.next !== "string") return { served: true, filled, looked, next: null };
    cursor = page.next;
  }
}
