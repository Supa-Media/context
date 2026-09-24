/**
 * The free managed tier's note cap, enforced at the one seam every write
 * crosses: the store `storeForBinding` hands out.
 *
 * A context on the free tier lives in a bucket we run and pay for, with no card
 * behind it, and holds a fixed number of notes (`FREE_MANAGED_NOTE_CAP` in the
 * control plane's `lib/premium.ts`, which is what sends `noteCap` on the
 * binding). At the cap **creating** a note is refused and nothing else is:
 * reading, editing a note that exists, moving, deleting, and every way of
 * leaving with the notes keep working. A limit on how much somebody may add is
 * a different thing from a limit on leaving with it (non-negotiable #1).
 * `docs/decisions/billing.md`, "The free managed tier".
 *
 * ## Why here, and not in the tools
 *
 * A note is created by `write_note`, `save_context`, an email landing in the
 * inbox, a form response, a meeting transcript, a restore from the trash, a
 * move *into* this context from another one, the console's own file browser —
 * and by whatever is added next. A check in each of those is a list somebody
 * forgets to extend. Every one of them builds its store through
 * `storeForBinding`, so a wrapper there covers the ones that exist and the
 * ones that do not yet.
 *
 * ## What counts, and what a create is
 *
 * A note is counted exactly as the console counts one (`isCountedNoteKey`,
 * which the control plane's `lib/noteCount.ts` delegates to): Markdown outside
 * any dot-prefixed segment. Attachments, the collaboration history and every
 * other piece of plumbing are not notes and are never refused here.
 *
 * A write is a create when the key holds no note yet. A put carrying an etag
 * precondition is by construction an edit of something that exists; one with
 * `onlyIf.absent` is by construction a create; an unconditional put asks the
 * store. `index.md` and `privacy.md` are never refused — they are the context's
 * own structure, and a full context must still be able to change who sees what;
 * `activity.md` is Context's own log of what happened.
 *
 * ## Moving is not creating
 *
 * A move writes the destination and then removes the source, so for a moment
 * there is one more note than before. Refusing that at the cap would make a
 * full context unable to reorganise itself, which is not what the cap is for.
 * So a move inside one context runs inside `asRelocation`, a window in which
 * this store admits every write. It is a window rather than a per-call flag
 * because a collaborative note is moved by `@context/collaboration`'s own
 * structural writes, which no call site here can annotate. A move **into**
 * this context from another one is a create here and is capped like any other:
 * it never runs inside the window.
 *
 * ## What it does not promise
 *
 * The count is taken once per store (one request), then kept locally. Two
 * requests racing past the last free slot can both land, so the cap can be
 * overshot by the number of concurrent creates. That is a bounded, harmless
 * overshoot of a free allowance, and closing it would need a lock across
 * requests on a hot path for every write to every capped context. The walk is
 * also page-budgeted: a bucket with an extraordinary number of non-note
 * objects yields a floor, which errs towards allowing the write.
 */

import { ACTIVITY_PATH } from "../../../../packages/shared/src/activity.cjs";

export const NOTE_CAP_REACHED = "NOTE_CAP_REACHED";

/** Listing requests one count may make. Matches the console's own counter. */
const COUNT_PAGE_CAP = 40;
const COUNT_PAGE_SIZE = 1000;

/**
 * The context's own structure and bookkeeping: counted, never refused. A full
 * context must still be able to change who sees what, and the activity log is
 * written on Context's behalf after somebody else's write — refusing it would
 * fail a change the person was allowed to make.
 */
const STRUCTURE_KEYS = new Set(["index.md", "privacy.md", ACTIVITY_PATH]);

/** Markdown, and not under any dot-prefixed segment. */
export function isCountedNoteKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  if (key.split("/").some((segment) => segment.startsWith("."))) return false;
  return key.toLowerCase().endsWith(".md");
}

/** What a person is told. Names what still works, and both ways forward. */
export function noteCapMessage(cap) {
  const figure = Number(cap).toLocaleString("en-US");
  return (
    `This workspace is on the free plan, which holds ${figure} notes, and it is full. ` +
    "Existing notes can still be read, edited, moved and exported. " +
    "To add more, move to Premium or connect storage of your own."
  );
}

/** A create refused at the cap. Carries no key and no content. */
export class NoteCapReached extends Error {
  constructor(cap) {
    super(noteCapMessage(cap));
    this.name = "NoteCapReached";
    this.code = NOTE_CAP_REACHED;
    this.cap = cap;
  }
}

/**
 * How many notes the store holds, stopping as soon as it reaches `limit`.
 *
 * Delimited at the root, then flat inside each folder that is not plumbing —
 * the same shape as the console's counter, for its reason: `.context/` sorts
 * first and holds far more objects than there are notes.
 */
export async function countNotesUpTo(store, limit) {
  let notes = 0;
  let pages = 0;
  const folders = [];
  let cursor;
  for (;;) {
    if (pages >= COUNT_PAGE_CAP) return notes;
    const listing = await store.list({ prefix: "", delimiter: "/", cursor, limit: COUNT_PAGE_SIZE });
    pages += 1;
    for (const object of listing.objects || []) {
      if (isCountedNoteKey(object.key)) notes += 1;
    }
    if (notes >= limit) return notes;
    for (const prefix of listing.delimitedPrefixes || []) {
      if (!prefix.startsWith(".")) folders.push(prefix);
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
  for (const folder of folders) {
    let folderCursor;
    for (;;) {
      if (pages >= COUNT_PAGE_CAP) return notes;
      const listing = await store.list({ prefix: folder, cursor: folderCursor, limit: COUNT_PAGE_SIZE });
      pages += 1;
      for (const object of listing.objects || []) {
        if (isCountedNoteKey(object.key)) notes += 1;
      }
      if (notes >= limit) return notes;
      if (!listing.truncated || !listing.cursor) break;
      folderCursor = listing.cursor;
    }
  }
  return notes;
}

async function holdsNote(store, key) {
  if (typeof store.exists === "function") return Boolean(await store.exists(key));
  return (await store.get(key)) !== null;
}

/**
 * The store, refusing new notes once it holds `cap` of them.
 *
 * A cap that is not a positive integer means no cap: the control plane sends
 * one only for a free context on a bucket we run.
 */
export function withNoteCap(store, cap) {
  if (!store || !Number.isInteger(cap) || cap <= 0) return store;
  let counted = null;
  let relocating = 0;

  /** Whether writing `key` would add a note, given the put's own precondition. */
  async function wouldCreate(key, options) {
    if (!isCountedNoteKey(key) || STRUCTURE_KEYS.has(key)) return false;
    if (options?.onlyIf?.absent === true) return true;
    if (typeof options?.onlyIf?.etagMatches === "string") return false;
    return !(await holdsNote(store, key));
  }

  async function admit(key, options) {
    if (relocating > 0) return false;
    if (!(await wouldCreate(key, options))) return false;
    if (counted === null) counted = await countNotesUpTo(store, cap);
    if (counted >= cap) throw new NoteCapReached(cap);
    return true;
  }

  const wrapped = Object.assign(
    Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store)),
    {
      noteCap: cap,

      async put(key, value, options) {
        const creating = await admit(key, options);
        const result = await store.put(key, value, options);
        if (creating && result && counted !== null) counted += 1;
        return result;
      },

      /** Run a move inside this context: its source goes, so nothing is added. */
      async relocate(run) {
        relocating += 1;
        try {
          return await run();
        } finally {
          relocating -= 1;
          // Sources went and destinations came; recount rather than guess.
          counted = null;
        }
      },

      async delete(key, options) {
        const result = await store.delete(key, options);
        // Whether it held a note is not known without another read, and a
        // stale-high count only costs a recount on the next create.
        if (isCountedNoteKey(key)) counted = null;
        return result;
      },
    },
  );
  if (typeof store.copy === "function") {
    wrapped.copy = async (source, destination, options) => {
      const creating = await admit(destination, options);
      const result = await store.copy(source, destination, options);
      if (creating && result && counted !== null) counted += 1;
      return result;
    };
  }
  return wrapped;
}

/**
 * Run a move inside one context without the cap refusing its destination.
 *
 * An uncapped store has nothing to exempt, so this is just `run()` there.
 */
export function asRelocation(store, run) {
  if (typeof store?.relocate === "function") return store.relocate(run);
  return run();
}
