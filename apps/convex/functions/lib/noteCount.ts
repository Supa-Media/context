/**
 * How many notes are in a bucket.
 *
 * The console has never shown this, and the reason was not an oversight: it had
 * no honest number to show. Issue #25 was the console drawing "1,284 objects"
 * over a bucket holding six, because the figure was a shared constant rather
 * than an observation. The fix at the time was to stop printing it. This is the
 * other half — something that actually looks, so the tile can come back.
 *
 * ## Notes, not objects
 *
 * An object count is a number about our own plumbing wearing the label "your
 * notes". `.history/` on a live context holds every revision of every file:
 * tens of thousands of objects standing for a few hundred notes. So this counts
 * Markdown outside the plumbing prefixes and nothing else — attachments,
 * revisions and audit logs are all real things in the bucket, and none of them
 * is what somebody means when they ask how many notes they have.
 *
 * What it *does* include is the files a scaffold wrote — `index.md`,
 * `privacy.md`, the folder READMEs. They are files in the bucket, the Browse
 * pane lists them, and a person can count them by eye. A number that quietly
 * excluded "ours" would be a number nobody could reproduce from what is on
 * screen, which is how #25 happened in the first place.
 *
 * ## Why the walk is shaped the way it is
 *
 * Delimited at the root, then flat inside each folder that is not plumbing.
 * That is the same shape as `hasExistingContext`, for the same reason: a flat
 * listing returns `.history/…` first, because `.` sorts before every digit and
 * letter. A flat walk with any page budget therefore spends the whole budget
 * inside the history and reports **zero notes for the biggest contexts there
 * are**. Collapsing that subtree to one prefix at the root and then never
 * descending into it is what makes the count possible at all.
 *
 * ## It admits when it stopped
 *
 * The budget is real — this runs against somebody else's bucket, on their
 * request quota — so a large enough context yields a floor rather than a total,
 * and says which it is. A truncated count printed as a total is #25 with extra
 * steps, so `truncated` travels with the number everywhere it goes.
 */

import { isPlumbingKey, type ScaffoldStore } from "./scaffold";

/** Objects per listing request. Matches the scaffold detector. */
export const COUNT_PAGE_SIZE = 1000;

/**
 * Listing requests one count may make, across the whole walk.
 *
 * Forty pages is a root listing plus roughly 39,000 notes — far past any real
 * context, and still a bounded number of requests against a bucket we do not
 * own. Exported so a test can shrink it: proving the truncation path with the
 * real cap would mean seeding 40,000 objects.
 */
export const COUNT_PAGE_CAP = 40;

export interface NoteCount {
  /** Markdown files outside the plumbing. A floor when `truncated`. */
  notes: number;
  /** The walk hit its page budget. `notes` is what it had reached by then. */
  truncated: boolean;
}

/** Markdown, and not something under a dot-prefixed segment. */
export function isNoteKey(key: string): boolean {
  return !isPlumbingKey(key) && key.toLowerCase().endsWith(".md");
}

/**
 * Count the notes in a bucket, or `null` if the bucket would not say.
 *
 * `null` rather than a throw, and rather than zero. The caller is a
 * verification probe whose job is to record a status; a listing that failed
 * partway must not fail the probe, and must not be recorded as "this context
 * has no notes" — which is what a `0` here would mean once it reached a tile.
 */
export async function countNotes(
  store: Pick<ScaffoldStore, "list">,
  options: { pageCap?: number; pageSize?: number } = {},
): Promise<NoteCount | null> {
  const pageCap = options.pageCap ?? COUNT_PAGE_CAP;
  const pageSize = options.pageSize ?? COUNT_PAGE_SIZE;

  let notes = 0;
  let pages = 0;
  const folders: string[] = [];

  try {
    // The root, delimited — so `.history/` is one entry rather than a wall.
    let cursor: string | undefined = undefined;
    for (;;) {
      if (pages >= pageCap) return { notes, truncated: true };
      const listing: Awaited<ReturnType<ScaffoldStore["list"]>> = await store.list({
        prefix: "",
        delimiter: "/",
        cursor,
        limit: pageSize,
      });
      pages += 1;
      for (const object of listing.objects ?? []) {
        if (isNoteKey(object.key)) notes += 1;
      }
      for (const prefix of listing.delimitedPrefixes ?? []) {
        if (!isPlumbingKey(prefix)) folders.push(prefix);
      }
      if (!listing.truncated || !listing.cursor) break;
      cursor = listing.cursor;
    }

    // Then flat inside each real folder. Plumbing nested deeper — a `.trash/`
    // under a project — is still caught, because `isNoteKey` looks at every
    // segment rather than just the first.
    for (const folder of folders) {
      let folderCursor: string | undefined = undefined;
      for (;;) {
        if (pages >= pageCap) return { notes, truncated: true };
        const listing: Awaited<ReturnType<ScaffoldStore["list"]>> = await store.list({
          prefix: folder,
          cursor: folderCursor,
          limit: pageSize,
        });
        pages += 1;
        for (const object of listing.objects ?? []) {
          if (isNoteKey(object.key)) notes += 1;
        }
        if (!listing.truncated || !listing.cursor) break;
        folderCursor = listing.cursor;
      }
    }
  } catch {
    return null;
  }

  return { notes, truncated: false };
}
