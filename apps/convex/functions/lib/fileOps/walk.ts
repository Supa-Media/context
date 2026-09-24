/**
 * Bounded walks over the keys under a path, and what a walk that stopped means.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { type PrivacyRule, type Visibility, canSee, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import { HISTORY_PREFIX, legacyStorageKey } from "@context/shared/src/storageLayout.cjs";
import { LIST_PAGE_CAP, FOLDER_OPERATION_CAP, type FileStore } from "./store";
import { FileOpError } from "./errors";

/**
 * Why a bounded walk stopped short — which is not one question but two, and
 * they need different answers.
 *
 * "Too many files" is about the customer's folder, and splitting it is a real
 * remedy. A store that says `IsTruncated: true` and then offers no continuation
 * token, or replays one it already gave, is about their storage endpoint: the
 * folder may hold three files, and splitting it will never produce the token,
 * so `FOLDER_TOO_LARGE` sends them round a remedy that cannot terminate. One
 * code told them the wrong thing in the second case, which is a smaller version
 * of the same habit as reporting a floor as a total — the message has to admit
 * what actually happened.
 */
export type WalkStop = "budget" | "store";

export function walkStopped(stop: WalkStop, tooLarge: string): FileOpError {
  return stop === "budget"
    ? new FileOpError("FOLDER_TOO_LARGE", tooLarge)
    : new FileOpError(
        "LISTING_INCOMPLETE",
        "Your storage provider did not return the whole folder listing, so nothing was changed. That is the bucket's endpoint rather than the folder — retrying may help; splitting the folder will not.",
      );
}

/**
 * Every key under a folder *this caller can see*, capped. Move, copy and
 * delete all walk it.
 *
 * The filter is the whole point and it was missing. Without it a bulk
 * operation acts on keys its caller cannot see and then names them in its
 * result: an editor deleting a shared folder permanently destroyed the
 * owner's private note inside it, purged its `.history/` too, and was handed
 * the note's path in the return value.
 *
 * **Filtered rather than refused**, which is the part that is not obvious.
 * Refusing an operation because the tree holds something invisible reports
 * that the invisible thing is there — a caller could separate "folder I can
 * move" from "folder with a private note in it" from "folder that does not
 * exist" and localise every private note to its folder without reading one.
 * The gateway settled this for `move_folder` and wrote out the reasoning; this
 * is the same decision in the control plane, so the two halves of the product
 * answer alike. A folder holding nothing visible yields no keys, and every
 * caller here turns that into the same `notFound()` a missing folder gets.
 */
export async function keysUnder(
  store: FileStore,
  folder: string,
  clearance: Clearance,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): Promise<{ keys: string[]; withheld: string[] }> {
  const prefix = `${folder}/`;
  const keys: string[] = [];
  // What was held back, which two callers need for different reasons: the
  // manifest bookkeeping must know *whether* anything was, and the history
  // purge must know *which*, so it does not sweep a survivor's snapshots.
  // Returned rather than recorded anywhere outside this call: Workers and
  // Convex reuse isolates, so a module-level flag would be one request telling
  // the next one what it saw.
  const withheld: string[] = [];
  // Whether the walk reached the end of the folder. `listFolder` reports the
  // same thing as `truncated` and `resetPrivacyManifest` as `partial`; this one
  // used to just fall out of the loop, so a folder deeper than the page cap
  // returned a short list that read exactly like a complete one — and the
  // manifest bookkeeping below rewrites rules on the strength of it.
  let complete = false;
  let stop: WalkStop = "budget";
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix, cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (isPlumbing(object.key)) continue;
      if (!canSee(object.key, clearance.scope, rules, overrides, clearance.names)) {
        withheld.push(object.key);
        continue;
      }
      keys.push(object.key);
      if (keys.length > FOLDER_OPERATION_CAP) {
        throw new FileOpError(
          "FOLDER_TOO_LARGE",
          `That folder holds more than ${FOLDER_OPERATION_CAP} files. Move or delete it in smaller pieces.`,
        );
      }
    }
    // Truncated-with-no-cursor is not finished, it is unable to continue — see
    // `listFolder`. Folding the two into one `||` set `complete` on a short
    // walk, which is the row-83 defect reachable a second way.
    if (!listing.truncated) {
      complete = true;
      break;
    }
    if (!listing.cursor) {
      stop = "store";
      break;
    }
    // A store that repeats a cursor will never finish, and the page budget
    // would spend itself before saying so. Comparing against the previous
    // cursor alone is defeated by a store alternating two of them, so this
    // keeps the set - which is what the gateway's `nextListCursor` does.
    if (seen.has(listing.cursor)) {
      stop = "store";
      break;
    }
    seen.add(listing.cursor);
    cursor = listing.cursor;
  }
  // Refused rather than truncated, which is what the gateway's own listing
  // helper does ("refusing to loop"). A partial walk cannot be operated on
  // safely: it moves some of a folder while the manifest is rewritten as
  // though all of it went, and nothing downstream can tell.
  if (!complete) {
    throw walkStopped(
      stop,
      "That folder holds too many files to move or delete in one go. Do it in smaller pieces.",
    );
  }
  return { keys, withheld };
}

/**
 * Live notes whose key extends this one's, which a file delete must not sweep.
 *
 * `a.md.notes.md` is an ordinary note and its snapshots begin with
 * `.history/a.md.`, so deleting `a.md` reached them. These are survivors in
 * exactly the sense the folder walk means, so they travel the same way.
 */
export async function namesExtending(store: FileStore, path: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let complete = false;
  let stop: WalkStop = "budget";
  const seen = new Set<string>();
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: `${path}.`, cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (object.key === path || isPlumbing(object.key)) continue;
      keys.push(object.key);
    }
    // Truncated-with-no-cursor is not finished, it is unable to continue — see
    // `listFolder`. Folding the two into one `||` set `complete` on a short
    // walk, which is the row-83 defect reachable a second way.
    if (!listing.truncated) {
      complete = true;
      break;
    }
    if (!listing.cursor) {
      stop = "store";
      break;
    }
    if (seen.has(listing.cursor)) {
      stop = "store";
      break;
    }
    seen.add(listing.cursor);
    cursor = listing.cursor;
  }
  // One `list` with a limit and no cursor was the first version of this, added
  // in the same change that stopped `keysUnder` inferring completeness — the
  // same mistake, three functions apart. A short answer here silently drops a
  // survivor, and a dropped survivor has its history swept.
  if (!complete) {
    throw walkStopped(
      stop,
      "Too many files share that name for it to be deleted safely. Rename or remove some of them first.",
    );
  }
  return keys;
}

/**
 * Every `.history/` key holding an earlier version of this path.
 *
 * `keysUnder` deliberately skips plumbing, and `.history/` is plumbing — which
 * is right for move and copy, and was wrong for delete. This is the one caller
 * that has to look inside it.
 *
 * **Matched by prefix, not by parsing the stamp.** Nothing writes these any
 * more, but every bucket connected before that holds them in five spellings
 * (`.md`, `.move.md`, `.archive.md`, `.batch-move.md`, `.inbox.md`) written by
 * four functions that no longer exist. That is the argument for prefix matching
 * rather than against it: the writers are gone, so a regex can only be checked
 * against buckets nobody can re-create. A regex that had to stay in sync would fail
 * *silently and in the wrong direction*: an unrecognised key is a copy left
 * behind under a sentence promising none. `.history/<path>.` is the one thing
 * every writer agrees on, so that is what this matches, and the only thing it
 * can over-match is another note's — equally unreachable — plumbing, which
 * would need a note literally named `<this note>.something.md`.
 *
 * No `FOLDER_OPERATION_CAP`. That cap exists to stop someone moving a folder
 * bigger than an action can carry, and refusing is a safe answer there: nothing
 * has happened yet. Refusing to finish a *purge* is not safe in the same way —
 * it would leave exactly the hidden copy this function exists to remove. The
 * listing is still bounded by `LIST_PAGE_CAP` pages.
 */
export async function historyKeysFor(
  store: FileStore,
  path: string,
  pathIsFolder: boolean,
  /**
   * The notes actually deleted, or `null` to sweep the whole subtree.
   *
   * `null` is the owner's case and keeps the original behaviour exactly,
   * orphaned snapshots included — a folder's history is theirs and the promise
   * that nothing survives a permanent delete is the point of this function.
   *
   * A team caller now deletes only what they could see, so sweeping the whole
   * subtree would destroy the history of the private notes they left standing.
   * The live note surviving while every version of it is purged is the same
   * data loss wearing a smaller number.
   */
  deleted: readonly string[] | null,
  /**
   * Notes left standing, whose snapshots must survive with them.
   *
   * The prefix match above is deliberately not a parse, and its stated cost was
   * that it "can over-match another note's — equally unreachable — plumbing,
   * which would need a note literally named `<this note>.something.md`". That
   * was true while the whole folder went, because the over-matched note was
   * being deleted too. Once a caller deletes only part of a folder it is false:
   * `a.md.notes.md` survives and `.history/a.md.notes.md.<stamp>.md` begins
   * with `.history/a.md.`, so deleting `a.md` took every version of a note it
   * did not delete.
   *
   * Answered with the survivors themselves rather than a stamp regex. A regex
   * would have to track five snapshot spellings across two apps and would fail
   * silently in the wrong direction; this cannot drift, because it compares
   * against real keys.
   *
   * **A single-file delete has survivors too**, which the first version of this
   * missed by only thinking about folders: deleting `a.md` matched
   * `.history/a.md.notes.md.<stamp>.md`, and `a.md.notes.md` is a live note
   * nobody asked to delete. That one is older than the filtering — it is true
   * on `main` — and it is the same sentence being false, so it is fixed here
   * rather than left with a comment that describes only half of it.
   */
  survivors: readonly string[],
): Promise<string[]> {
  // A folder's history mirrors its shape (`.history/1-projects/note.md.<stamp>.md`),
  // so the whole subtree goes. A file's history is the siblings sharing its name.
  const keys: string[] = [];
  const currentPrefix = pathIsFolder ? `${HISTORY_PREFIX}${path}/` : `${HISTORY_PREFIX}${path}.`;
  const storagePrefixes = [currentPrefix, legacyStorageKey(currentPrefix)].filter(
    (value): value is string => Boolean(value),
  );
  for (const prefix of storagePrefixes) {
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
      const listing = await store.list({ prefix, cursor, limit: 1000 });
      for (const object of listing.objects ?? []) {
        const logicalKey = `${currentPrefix}${object.key.slice(prefix.length)}`;
        // For a file, a `/` in the tail would mean a directory we did not put
        // there — leave it rather than sweep something we cannot explain.
        if (!(pathIsFolder || !object.key.slice(prefix.length).includes("/"))) continue;
        if (deleted !== null) {
          // Which note does this snapshot belong to? `.history/a.md.X.md` could
          // be a version of `a.md` stamped `X`, or of a note actually called
          // `a.md.X` — a prefix test cannot tell, and testing the deleted set and
          // the survivors separately gets it wrong in both directions at once:
          // `a.md` shields `a.md.notes.md`'s snapshots from a delete that took
          // it, and `a.md.notes.md` is swept by a delete of `a.md`.
          //
          // Longest match decides, the same way `visibilityOf` resolves a key
          // against overlapping folder rules. The snapshot belongs to the most
          // specific note whose name it extends, and it goes only if that note
          // is one of the ones actually deleted.
          let owner: string | null = null;
          for (const key of [...deleted, ...survivors]) {
            if (!logicalKey.startsWith(`${HISTORY_PREFIX}${key}.`)) continue;
            if (owner === null || key.length > owner.length) owner = key;
          }
          if (owner === null || !deleted.includes(owner)) continue;
        }
        keys.push(object.key);
      }
      // The one walk with nowhere to put the answer. Its only caller has already
      // deleted the live keys by the time it runs, so it cannot refuse, and
      // `DeleteResult` carries only `paths` — there is no `truncated` to report
      // through. A short walk here leaves snapshots of a note somebody
      // permanently deleted, which is the lie the delete copy must not tell.
      //
      // Already reachable at `LIST_PAGE_CAP`, and the fold below does not widen
      // it as much as it looks: on a store that misreports consistently,
      // `deletePath` never gets this far, because `keysUnder` (folder) or
      // `namesExtending` (file) refuses first. What is left needs a store that
      // misbehaves only under `.history/`, or only sometimes — narrow, but not
      // nothing, and stating "not made worse" flatly would be the overclaim.
      // Left as it is rather than papered over: the fix is to resolve the history
      // before the live keys go, which is a bigger change than this one.
      if (!listing.truncated || !listing.cursor) break;
      cursor = listing.cursor;
    }
  }
  return keys;
}

/** Does this path name a folder (something has keys under it)? */
export async function isFolder(store: FileStore, path: string): Promise<boolean> {
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < LIST_PAGE_CAP; pageNumber += 1) {
    const listing = await store.list({ prefix: `${path}/`, cursor, limit: 1_000 });
    if ((listing.objects ?? []).length > 0 || (listing.delimitedPrefixes ?? []).length > 0) {
      return true;
    }
    if (!listing.truncated) return false;
    if (!listing.cursor || listing.cursor === cursor) {
      throw new FileOpError(
        "LISTING_INCOMPLETE",
        "Context could not determine whether this path is a folder.",
      );
    }
    cursor = listing.cursor;
  }
  throw new FileOpError(
    "FOLDER_TOO_LARGE",
    "This folder is too large to inspect safely in this flow.",
  );
}
