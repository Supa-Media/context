/**
 * The contact lookup (`packages/communications/src/contactLookup.js`) on the
 * gateway's own store, for the Gmail and Google Chat sync writers.
 *
 * One lookup per sync run: one listing of the contacts folder and one of its
 * archive mirror, and the snapshot at `CONTACT_INDEX_KEY` so a page is only
 * read again when its etag moved. The snapshot is plumbing and a disposable
 * derivative — unreadable is empty, and `save` writing it is a cache write
 * that nothing depends on having happened.
 */

import {
  CONTACT_INDEX_KEY,
  createContactLookup,
  upsertContactDraft,
} from "../../../../packages/communications/src/index.js";
import { listAllKeys } from "../notes/storage.js";
import { loadPrivacyState } from "../privacy/state.js";
import { toolMoveNote } from "../tools/moves/note.js";

/** The snapshot is bounded so a corrupted or hostile one cannot become a large parse on every run. */
const SNAPSHOT_BYTE_CAP = 8_000_000;

async function readSnapshot(store) {
  try {
    const object = await store.get(CONTACT_INDEX_KEY);
    if (!object) return { snapshot: null, text: null };
    const text = await object.text();
    if (text.length > SNAPSHOT_BYTE_CAP) return { snapshot: null, text: null };
    return { snapshot: JSON.parse(text), text };
  } catch {
    return { snapshot: null, text: null };
  }
}

/**
 * @param {import("../store/index.js").ContextStore} store
 * @param {{root?: string}} [options]
 */
export async function openContactLookup(store, options = {}) {
  const loaded = await readSnapshot(store);
  let saved = loaded.text;
  const lookup = createContactLookup({
    root: options.root,
    snapshot: loaded.snapshot,
    list: async (prefix) => (await listAllKeys(store, prefix)).map(({ key, etag }) => ({ key, version: etag })),
    read: async (path) => {
      const object = await store.get(path);
      return object ? object.text() : null;
    },
  });
  return {
    lookup,
    /** Keep the lookup for the next run. Best effort: losing it costs one rebuild. */
    async save() {
      const text = JSON.stringify(lookup.snapshot());
      if (text === saved) return;
      try {
        await store.put(CONTACT_INDEX_KEY, text);
        saved = text;
      } catch {
        // A cache that did not save is a cache that is rebuilt.
      }
    },
  };
}

/**
 * The gateway's move, as the owner's own, so an archived contact comes back
 * the way `move_note` would bring it: links rewritten, forwarding recorded,
 * visibility never widened (`toolMoveNote` takes the narrower of the two).
 */
async function moveContactPage(store, from, to) {
  const privacy = await loadPrivacyState(store);
  if (privacy.error) return { ok: false, message: "privacy.md could not be read" };
  /*
    No expected etag. The tool compares it against the collaboration
    document's version where the store keeps one, which is not the object
    etag this read saw; and nothing here needs the guard — whatever the page
    holds when it moves is what is read back at the live path and merged.
  */
  const result = await toolMoveNote(store, "private", privacy.rules, privacy.overrides, from, to);
  return result.isError ? { ok: false, message: "an archived contact could not be moved back" } : { ok: true };
}

/**
 * Conflict-safe contact merge through the lookup: every retry re-reads the
 * page that owns the new etag, and a page is created only where nobody has one.
 *
 * @param {import("../store/index.js").ContextStore} store
 * @param {object} draft
 * @param {{root?: string, remainingQuotaBytes: number, contacts?: {lookup: object}}} options
 * @returns {Promise<{wrote: boolean, bytes: number, quotaExceeded: boolean}>}
 */
export async function writeContactDraft(store, draft, options = {}) {
  const opened = options.contacts ?? (await openContactLookup(store, { root: options.root }));
  const conditional = Boolean(store.capabilities?.conditionalWrite);
  let bytes = 0;
  const result = await upsertContactDraft(opened.lookup, draft, {
    read: async (path) => {
      const object = await store.get(path);
      return object ? { text: await object.text(), etag: object.etag } : null;
    },
    write: async (path, text, etag) => {
      bytes = new TextEncoder().encode(text).length;
      if (bytes > options.remainingQuotaBytes) return { ok: false, stop: "quota" };
      // A new page is created only if it is still absent where the store can
      // say so, so two syncs starting the same person converge on one page.
      const onlyIf = etag !== null
        ? (conditional ? { etagMatches: etag } : null)
        : (store.capabilities?.conditionalCreate ? { absent: true } : null);
      const put = onlyIf ? await store.put(path, text, { onlyIf }) : await store.put(path, text);
      if (onlyIf && !put) return { ok: false, conflict: true };
      return { ok: true, version: put?.etag };
    },
    move: (from, to) => moveContactPage(store, from, to),
  }, { root: options.root });
  if (!options.contacts) await opened.save();
  if (result.status === "written") return { wrote: true, bytes, quotaExceeded: false };
  if (result.stop === "quota") return { wrote: false, bytes: 0, quotaExceeded: true };
  if (result.status === "error") throw new Error(`writeContactDraft: ${result.message ?? "contact could not be written"}`);
  return { wrote: false, bytes: 0, quotaExceeded: false };
}
