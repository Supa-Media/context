/**
 * Serving a page straight from its bucket file, for an address the route
 * index has no live claimant for.
 *
 * The index is a derivative: it feeds the menu and catches clashes across the
 * whole folder, and it lags the bucket by a rebuild. A page is a file, so an
 * address the index does not know yet is looked up where the page actually
 * lives — the one or two object keys that could claim it — and judged from
 * those bytes by the same rules the index applies. Nothing here widens what
 * is published: the keys are derived from an already-normalised route under
 * the website root, the same statuses decide draft, problem and audience, and
 * a clash between the two file forms is caught because both are read.
 */

import {
  DEFAULT_WEBSITE_ROOT,
  buildWebsiteRouteStatuses,
  websiteRouteLookupKey,
  type WebsiteRouteStatus,
} from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { isEncryptedNote } from "../noteEncryption";
import { PUBLICATION_CLEARANCE } from "./publication";

/** The files that could hold `routePath`: `about.md` or `about/index.md`. */
export function websiteCandidateKeys(routePath: string): string[] {
  if (routePath === "/") return [`${DEFAULT_WEBSITE_ROOT}/index.md`];
  const base = `${DEFAULT_WEBSITE_ROOT}${routePath}`;
  return [`${base}.md`, `${base}/index.md`];
}

export type ProbedPage = {
  objectKey: string;
  text: string;
  status: WebsiteRouteStatus & { routePath: string; title: string };
};

/**
 * The one live page the bucket holds for `routePath`, or null. Null covers
 * absent, draft, problem, encrypted, clashing and unreadable alike, so the
 * caller answers all of them with the same "Nothing here".
 */
export async function probeWebsitePage(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; routePath: string },
): Promise<ProbedPage | null> {
  const keys = websiteCandidateKeys(args.routePath);
  const read = await ctx
    .runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      // What `privacy.md` does not publish is absent here, exactly as it is
      // absent from the index; see `publication.ts`.
      ...PUBLICATION_CLEARANCE,
      operation: { kind: "readMany", paths: keys },
    })
    .catch(() => null);
  if (read?.kind !== "notes") return null;

  const found: { objectKey: string; markdown: string }[] = [];
  for (const result of read.results) {
    if (result.outcome === "read") {
      found.push({ objectKey: result.path, markdown: result.note.text });
    } else if (result.outcome !== "error" || result.code !== "FILE_NOT_FOUND") {
      // A deferred read or a refusal other than absence leaves a possible
      // clash unseen, so nothing is served.
      return null;
    }
  }
  // Both forms present is a clash even when one of them is a draft.
  if (found.length !== 1) return null;
  const page = found[0]!;
  if (isEncryptedNote(page.markdown)) return null;

  const status = buildWebsiteRouteStatuses([page])[0];
  if (
    status?.status !== "live" ||
    status.routePath === null ||
    status.title === null ||
    websiteRouteLookupKey(status.routePath) !== websiteRouteLookupKey(args.routePath)
  ) {
    return null;
  }
  return {
    objectKey: page.objectKey,
    text: page.markdown,
    status: status as ProbedPage["status"],
  };
}
