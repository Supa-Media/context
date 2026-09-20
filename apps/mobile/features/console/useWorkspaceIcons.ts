import { useCallback, useSyncExternalStore } from "react";

import { dataUrlFor } from "./files/imageBytes";
import type { ConsoleContext } from "./types";

/**
 * The mark a workspace draws, resolved to something that can be rendered.
 *
 * `WorkspaceMark` stays a drawing: it takes this and paints it, and it never
 * fetches. An emoji needs nothing resolved; a photo is a leaf on the row and
 * has to become a `src`, which is an action call.
 */
export type MarkIcon =
  | { kind: "emoji"; emoji: string }
  | { kind: "photo"; uri: string };

/**
 * ## Reading is separate from fetching, and that split is the point
 *
 * The obvious shape — one hook that calls `useAction` and returns the icons —
 * was written first and is wrong, for a reason that is a **product** bug rather
 * than a testing inconvenience: `useAction` throws outside a `ConvexProvider`,
 * and three of the four surfaces that draw a mark are mounted without one. The
 * landing page mounts a picture of the console; the demo console runs off
 * `useDemoConsoleData` and has no backend at all. A mark that needs a Convex
 * client to render is a mark that crashes the marketing page.
 *
 * So: **`useWorkspaceIcons` touches no Convex** and only reads the cache below.
 * The fetching is `prefetchWorkspacePhotos`, called from `useLiveConsoleData` —
 * the one place a provider is guaranteed, because it is the hook that runs the
 * queries. A surface with no backend therefore draws emoji and letters
 * correctly and never asks for a photo, which is exactly right: it has no real
 * workspace to ask about.
 */

/**
 * Every photo this session has already fetched, at module scope.
 *
 * **Keyed on the leaf, and cached forever, and both of those are load-bearing
 * rather than convenient.** The leaf is a content hash, so the same key is the
 * same bytes in this session and every other — the same argument
 * `useFileBrowser`'s image cache makes, and what makes "forever" correct rather
 * than stale. Changing a workspace's icon changes its leaf, so the new photo is
 * a cache miss and the old entry is never asked for again.
 *
 * At module scope rather than in state because the rail unmounts: the file
 * panel's foot row, the title bar's chip, the settings panel and the switcher
 * menu each mount a mark for the same workspace, and the menu mounts and
 * unmounts on every open. Per-component state would make that a fetch per
 * mount of a picture that cannot have changed.
 */
const photos = new Map<string, string>();

/** In flight, so four marks for one workspace make one request. */
const pending = new Set<string>();

/**
 * Leaves this session asked for and did not get.
 *
 * Remembered so a workspace whose photo cannot be read — a bucket that is down,
 * a credential revoked, an object deleted out of the customer's own bucket —
 * costs one failed request rather than one per render for as long as the app is
 * open. The mark falls back to the letter, which is what it drew before anybody
 * chose a photo, so the failure is invisible and must therefore be cheap.
 */
const missing = new Set<string>();

const cacheKey = (workspaceId: string, leaf: string) => `${workspaceId}|${leaf}`;

/* -------------------------------------------------------------------------- */
/*                         the store, without Convex                           */
/* -------------------------------------------------------------------------- */

let version = 0;
const listeners = new Set<() => void>();

function announce(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fetch any photo these contexts name and this session has not got.
 *
 * Called from `useLiveConsoleData`, which holds the Convex client. `read` is
 * passed in rather than bound here so this module imports nothing from Convex
 * at all — which is what lets every drawing surface import it safely.
 *
 * Safe to call on every render of the caller: everything already held, already
 * in flight, or already known to be missing is skipped, so a steady state costs
 * one `Map` lookup per workspace.
 */
export function prefetchWorkspacePhotos(
  contexts: readonly ConsoleContext[],
  read: (args: { workspaceId: string }) => Promise<{ bytes: ArrayBuffer; contentType: string }>,
): void {
  for (const context of contexts) {
    if (context.icon?.kind !== "photo") continue;
    const key = cacheKey(context.id, context.icon.leaf);
    if (photos.has(key) || pending.has(key) || missing.has(key)) continue;
    pending.add(key);
    void read({ workspaceId: context.id })
      .then((result) => {
        photos.set(key, dataUrlFor(result.bytes, result.contentType));
      })
      .catch(() => {
        /*
          Every failure is the same absence, deliberately: a workspace with no
          photo, a bucket that is down and an object somebody removed all draw
          the letter. There is nothing useful to say about any of them in an
          18pt square, and a broken-image mark in the rail would be a defect
          report for something the person may well have done on purpose.
        */
        missing.add(key);
      })
      .finally(() => {
        pending.delete(key);
        announce();
      });
  }
}

/**
 * What each context draws in its mark.
 *
 * Contexts with no icon, and photos that have not arrived, resolve to
 * `undefined` — which is the letter. That is right while a photo is loading as
 * well as when there is none: the alternative is a blank square that fills in a
 * beat later, and a rail that flickers on every mount is worse than one that
 * occasionally shows a letter for 100ms.
 */
export function useWorkspaceIcons(): (context: ConsoleContext) => MarkIcon | undefined {
  /*
    Subscribed rather than polled, so a mark redraws when the photo behind it
    arrives. The snapshot is a counter because the cache is a mutable `Map` —
    `useSyncExternalStore` compares snapshots with `Object.is`, and a `Map`
    never changes identity when something is put in it.
  */
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return useCallback((context: ConsoleContext) => {
    const icon = context.icon;
    if (icon === undefined) return undefined;
    if (icon.kind === "emoji") return { kind: "emoji", emoji: icon.emoji };
    const uri = photos.get(cacheKey(context.id, icon.leaf));
    return uri === undefined ? undefined : { kind: "photo", uri };
  }, []);
}
