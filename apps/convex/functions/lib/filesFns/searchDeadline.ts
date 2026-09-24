/**
 * The blended search's per-context deadline, and the answer shape it builds.
 *
 * Split out of `functions/files.ts`, which registers `searchContexts`.
 */

import type { Id } from "../../../_generated/dataModel";

/**
 * How long one context in a blended search may take before the page goes on
 * without it.
 *
 * Under the console's own ten-second client timeout, so a blended page ends as
 * a partial answer somebody can act on rather than as the spinner that cannot
 * stop — `useContextSearch` documents that failure at length and this is the
 * server-side half of not causing it. Comfortably above what a projection read
 * costs (one D1 round trip) and above the R2 fall-through a miss pays for,
 * which is what it is really bounding.
 */
export const SOURCE_DEADLINE_MS = 7_000;

/** What `searchContexts` answers. Mirrors `blendedResultsValidator` exactly. */
export type BlendedAnswer = {
  results: {
    workspaceId: Id<"workspaces">;
    slug: string;
    displayName: string;
    path: string;
    title: string;
    snippet: string;
  }[];
  matchCount: number;
  matchCountIsFloor: boolean;
  cursor: string | null;
  sources: {
    workspaceId: Id<"workspaces">;
    slug: string;
    displayName: string;
    state: "ok" | "indexing" | "failed";
    matchCount: number;
    matchCountIsFloor: boolean;
  }[];
  searchableCount: number;
};

/**
 * One source's answer, or `null` because it did not arrive in time or at all.
 *
 * Both halves matter. The timer is cleared in a `finally` so a page that ends
 * early does not leave one pending per context; and the work is wrapped in its
 * own `catch` **before** the race rather than after it, because a promise that
 * rejects after the timeout has already won is an unhandled rejection — which
 * in a Convex action is a log line about somebody's bucket, attached to no
 * request, in a deployment where the request it belonged to succeeded.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        (value) => value,
        () => null,
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
