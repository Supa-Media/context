/**
 * When the tree has to ask the server for a folder, and when the device's copy
 * may draw over what the server said.
 *
 * Pure, so both rules are held by a test rather than by a hook
 * (`__tests__/liveListing.test.ts`).
 *
 * **A listing drawn from the device is not an answer from the server.** The
 * mirror's tree (`treeOf`) names every folder it has heard of, including the
 * ones a live root listing reported, and draws each with whatever notes the
 * device holds under it. When the device's whole-workspace walk stopped short,
 * that is none, and the folder reads "Empty". Expanding it used to ask the
 * server only when there was no listing at all, so it stayed "Empty" for as
 * long as the walk kept stopping (reported 2026-10-08, Inbox and Areas).
 */
import type { MirroredTree } from "../../../offline/mirror";
import type { Listings } from "./types";

/**
 * Should opening `folder` ask the server? **Online, always, unless the server
 * (or this console's own change) has already answered for it this session**
 * — `listedAt` holds those. The device's copy may draw the rows first so
 * nothing flickers, but it never stands in for the server's answer while
 * there is a connection (decided by the owner, 2026-10-08). Offline, the
 * device is all there is: a folder already drawn stays as it is.
 */
export function wantsLiveListing(
  folder: string,
  listings: Listings,
  listedAt: ReadonlyMap<string, number>,
  offline: boolean,
): boolean {
  if (listings[folder] === undefined) return true;
  if (offline) return false;
  return !listedAt.has(folder);
}

/**
 * Lay a tree read off the device over the listings.
 *
 * `fromDevice` is the tree as it was when this context was opened: it fills
 * only folders nothing has listed yet. Otherwise it is a walk the mirror just
 * committed. A **complete** walk replaces each folder whose live listing
 * started before it did, and drops folders it no longer names. An
 * **incomplete** walk is a floor, not a total — a folder in it may simply not
 * have been reached — so it never replaces a folder the server answered for;
 * it only fills folders nothing has drawn yet.
 */
export function adoptMirroredTree(
  current: Listings,
  tree: Pick<MirroredTree, "value" | "complete" | "listedAt">,
  listedAt: ReadonlyMap<string, number>,
  fromDevice: boolean,
): Listings {
  const newer = (folder: string) => (listedAt.get(folder) ?? -Infinity) >= tree.listedAt;
  const next: Listings = { ...current };
  for (const [folder, listing] of tree.value) {
    const skip = fromDevice
      ? current[folder] !== undefined || listedAt.has(folder)
      : tree.complete
        ? newer(folder)
        : listedAt.has(folder);
    if (skip) continue;
    next[folder] = listing;
  }
  if (!fromDevice && tree.complete) {
    for (const folder of Object.keys(current)) {
      if (!tree.value.has(folder) && !newer(folder)) delete next[folder];
    }
  }
  return next;
}

