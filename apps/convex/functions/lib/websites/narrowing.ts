/**
 * The index may lag on widening; it must never lag on narrowing.
 *
 * A rebuild that finds a broken page anywhere in the site publishes nothing
 * new, so a half-typed autosave cannot take the site down. That rule used to
 * freeze the whole index, restrictions included: a page withdrawn, encrypted,
 * deleted or held back by `privacy.md` kept its menu entry and its release
 * copy for as long as some other page stayed broken. Now a refused rebuild
 * still applies the narrowing half of what it read — rows for pages that
 * asked to stop being published are dropped and their release copies deleted
 * — while anything that would newly publish waits for a clean scan.
 *
 * A clean rebuild replaces the index anyway, but the release it retires is
 * kept one generation as grace. The same rule decides which of that
 * release's copies are deleted at once rather than a generation later.
 */

import type { WebsiteRouteStatus } from "@context/shared";

/** The fields of an index row the rule reads; stored rows carry more. */
export type IndexedRouteRow = Pick<
  WebsiteRouteStatus,
  "objectKey" | "routePath" | "status" | "audience"
> & {
  releaseId?: string;
  releasePageId?: string;
};

/**
 * The live rows whose pages the snapshot shows have narrowed.
 *
 * `restricted` holds the keys whose bytes ask for something narrower than
 * "serve this to anyone" even where the status cannot say so (a malformed
 * page with `draft: true` in it). A page absent from the snapshot is narrowed:
 * deleted, moved, encrypted or held back by `privacy.md` are one answer.
 */
export function narrowedRows<Row extends IndexedRouteRow>(
  existing: readonly Row[],
  snapshot: readonly IndexedRouteRow[],
  restricted: ReadonlySet<string>,
): Row[] {
  const next = new Map(snapshot.map((route) => [route.objectKey, route]));
  return existing.filter((row) => {
    if (row.status !== "live") return false;
    const now = next.get(row.objectKey);
    if (now === undefined || now.status === "draft") return true;
    if (now.status === "live") {
      return (
        now.routePath !== row.routePath ||
        (row.audience === "public" && now.audience !== "public")
      );
    }
    // A problem page keeps its last good release unless its bytes restrict.
    // A members page reached its release through the membership gate, so
    // only ciphertext (already absent from the snapshot) narrows it further.
    return row.audience === "public" && restricted.has(row.objectKey);
  });
}
