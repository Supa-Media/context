/**
 * The three facts about a context, in one line.
 *
 * `R2 · brain · 100% indexed · 12 notes, 8 folders` — the bucket it is bound
 * to, how much of it is in the hosted index, and how much of its tree has
 * actually been read.
 *
 * ## Why this is a module and not two `join`s at two call sites
 *
 * It was two: `app/(app)/console/_layout.tsx` built `binding · index` for the
 * phone and `Explorer` appended the counts. That split was invisible while
 * both halves were drawn by one component, and it stopped being invisible the
 * moment the phone lost its file tree — the composition had to move and half
 * of it was somewhere else. The words themselves already come from single
 * owners (`storagePillLabel`, `describeIndexProgress`, and now `loadedCounts`);
 * what lives here is the one place that decides they are three parts of one
 * line and what separates them.
 *
 * ## What an absence means, at each of the three
 *
 * Each part is omitted rather than filled in, and each omission means
 * something different:
 *
 *  - **the binding** is `undefined` while the subscription has not answered
 *    (`ConsoleData.storage` is three-valued for exactly this) and `null` for a
 *    context with no bucket. The second is a claim worth making — "no bucket
 *    connected" — and the first is not, so only the second is drawn.
 *  - **the index figure** is `null` for a member, for a context with fast
 *    search off, and before the status has answered. `describeIndexProgress`
 *    is the one place that decides which, and it is a **security control**:
 *    the index counts private notes a member cannot read, so a total — or any
 *    percentage of it — is the size of what they are not being shown. Nothing
 *    here may substitute a dash, a `0%` or a skeleton for it.
 *  - **the counts** are always drawn, because "Nothing read yet" is a true
 *    statement about a tree nobody has expanded and an empty string is not.
 */

import { describeIndexProgress, type FastSearchStatus } from "../search/fastSearch";
import { storagePillLabel } from "../storage/pill";
import type { ConsoleStorage } from "../types";
import type { FolderListing } from "./types";

type Listings = Readonly<Record<string, FolderListing | undefined>>;

/**
 * What the tree has actually been read to say.
 *
 * Only what has been read. A tree that lazily loads one folder at a time
 * cannot honestly print a total for the bucket, and inventing one is the same
 * failure the console's stat tiles were removed for. It used to end with the
 * word "read" to say so out loud; that word is gone because the line carries
 * the binding in front of it and Obsidian's own is "4,707 files, 4,060
 * folders". The honesty is unchanged — the numbers are still only what has
 * been loaded, and "Nothing read yet" is still what an unread tree says.
 *
 * It lived inside `Explorer` and moved here rather than being copied, because
 * the phone reads it from a folder page now and the desktop still reads it
 * from the tree's foot. Two counters over one `listings` map is two answers to
 * "how much of this context have I got".
 */
export function loadedCounts(listings: Listings): string {
  let notes = 0;
  let folders = 0;
  for (const listing of Object.values(listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.kind === "folder") folders += 1;
      else notes += 1;
    }
  }
  if (notes === 0 && folders === 0) return "Nothing read yet";
  return `${notes} note${notes === 1 ? "" : "s"}, ${folders} folder${folders === 1 ? "" : "s"}`;
}

/**
 * The whole line, or as much of it as is true.
 *
 * Never `null`: `loadedCounts` always has something honest to say, so a foot
 * that draws this is never an empty band. What varies is how many of the three
 * parts are in it.
 */
export function contextFootLine({
  storage,
  fastSearch,
  listings,
}: {
  /** `undefined` is "the binding has not answered", `null` is "no bucket". */
  storage: ConsoleStorage | null | undefined;
  /** `null` is "not asked, or not answered yet" — never an `off`. */
  fastSearch: FastSearchStatus | null;
  listings: Listings;
}): string {
  const binding =
    storage === undefined ? undefined : (storagePillLabel(storage) ?? "no bucket connected");
  return [binding, describeIndexProgress(fastSearch)?.label, loadedCounts(listings)]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
}
