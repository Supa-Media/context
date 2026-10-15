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
 * ## This file is on the exit path, and holds no billing state
 *
 * `scripts/check-exit-is-ungated.mjs` scans `apps/mcp/src` for billing
 * vocabulary, because every export reads through the store this wraps. What
 * arrives here is a number and nothing else — never the plan, never whether
 * anyone paid — and the wrapper touches only `put`, `copy` and `delete`.
 * Every read (`get`, `list`, `exists`, `head`) passes straight through, so a
 * full context exports exactly as an empty one does; `noteCap.test.mjs`
 * ("a full store still hands out every note") is what fails if that changes.
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
 * ## Counted from the Convex tree, never the bucket
 *
 * How many notes a context holds is a question about which notes exist, and
 * since 2026-10-13 nothing but opening and editing a note reads the bucket
 * (decided by the owner: "everything should be on convex"). The count comes
 * from whoever built the store (`countNotes`): the console's credential
 * barrier counts the tree's rows (`lib/nodes/servedCount.ts`), the gateway
 * asks the control plane (`/gateway/tree/facts`, `ask: "names"`). Only the key being written
 * is still asked of the bucket, to tell a create from an edit: that is the
 * note being written.
 *
 * ## What it does not promise
 *
 * The count is taken once per store (one request), then kept locally. Two
 * requests racing past the last free slot can both land, so the cap can be
 * overshot by the number of concurrent creates. That is a bounded, harmless
 * overshoot of a free allowance, and closing it would need a lock across
 * requests on a hot path for every write to every capped context. Where the
 * tree cannot answer (its first copy still running, the control plane not
 * reached), the write is admitted and the next create asks again: a billing
 * count must never cost somebody a note, and the tree's first copy takes
 * minutes. The tree also lags the bucket by a second or two, which can only
 * under-count by the notes written in that window.
 */

import { ACTIVITY_PATH } from "../../../../packages/shared/src/activity.cjs";

export const NOTE_CAP_REACHED = "NOTE_CAP_REACHED";

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
    "To add more, level up this workspace or connect storage of your own."
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

/** The tree's count, or null where it cannot answer. Never throws: a count never fails a write. */
async function treeCount(countNotes) {
  if (typeof countNotes !== "function") return null;
  try {
    const count = await countNotes();
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

async function holdsNote(store, key) {
  if (typeof store.exists === "function") return Boolean(await store.exists(key));
  return (await store.get(key)) !== null;
}

/**
 * The store, refusing new notes once it holds `cap` of them.
 *
 * A cap that is not a positive integer means no cap: the control plane sends
 * one only for a free context on a bucket we run. `countNotes` answers how
 * many notes the context holds from the Convex tree, or `null` where the tree
 * cannot say; with none, nothing can be counted and the cap admits.
 *
 * @param {object} store
 * @param {number|null|undefined} cap
 * @param {(() => Promise<number|null>)|null} [countNotes]
 */
export function withNoteCap(store, cap, countNotes = null) {
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
    if (counted === null) counted = await treeCount(countNotes);
    // Not counted (see the header): admitted, and the next create asks again.
    if (counted === null) return false;
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
