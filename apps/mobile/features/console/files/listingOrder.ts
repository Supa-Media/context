import { useSyncExternalStore } from "react";

/**
 * Which way the file list is sorted, for every surface that draws one.
 *
 * ## Why this stopped being `useState` in `Explorer`
 *
 * The sort control lives in the file tree's header, and the direction it set
 * lived in that component — so it reordered the tree and nothing else. Open a
 * folder and the *same listing*, drawn as a page in the middle of the console,
 * came back A to Z however the sidebar was sorted. The folder page and the
 * tree are one listing shown twice, which is the sentence `FolderView.tsx`
 * opens with; a sort that reaches one of them and not the other is that claim
 * being false in the one place a person would check it.
 *
 * It is also the shape of the complaint this module came out of: things you
 * can do to a folder in the sidebar that you cannot do to it in the middle.
 * The other two were drag and the row menu, and those were fixed by pointing
 * the listing at the modules the tree already used. This one has nothing to
 * point at — the state is genuinely shared and had no home — so it gets one.
 *
 * ## Why a bus rather than a prop or a route parameter
 *
 * `Explorer` and `BrowsePane` are siblings with `ConsoleShell` between them,
 * and neither is a parent of the other. `readMode.ts` met the same problem and
 * its header carries the argument in full, including what routing it cost when
 * it was tried that way: the reader and the writer may not import each other,
 * both import a module that knows about neither, and it is deliberately the
 * smallest thing that works — synchronous, one value, no replay.
 *
 * ## What that costs, stated rather than discovered
 *
 * It is **not persisted and not in the URL**. A reload comes back A to Z, and
 * a link somebody sends does not carry how they were looking at their files.
 * Both are true of `readMode` for the same reason and neither is load-bearing:
 * this is a way to look at a list you already have, not a place. It is also
 * process-wide rather than per context, which is right for a preference about
 * reading and would be wrong for anything the bucket stores — nothing here
 * reaches storage, and `tree.ts`'s `orderedEntries` reverses a *presentation*
 * of the server's one order rather than inventing a second one.
 */

let descending = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sort Z to A, or back to A to Z. Silent when it is already that way. */
export function setListingOrder(next: boolean): void {
  if (descending === next) return;
  descending = next;
  for (const listener of [...listeners]) {
    // A throwing subscriber must not stop the rest being told — `readMode.ts`
    // and `bucketWrites.ts` both refuse that, and for the same reason.
    try {
      listener();
    } catch {
      // See above.
    }
  }
}

/** Is the file list currently drawn Z to A? */
export function useListingOrder(): boolean {
  /*
    The same function for both snapshots. There is no server here — this is a
    client-only console — and passing `getSnapshot` twice is how React is told
    that, rather than leaving the server argument off and having it warn about
    a hydration mismatch it cannot have.
  */
  return useSyncExternalStore(subscribe, () => descending, () => descending);
}

/** Back to A to Z, for a test that must not leak an order into the next one. */
export function resetListingOrder(): void {
  setListingOrder(false);
}
