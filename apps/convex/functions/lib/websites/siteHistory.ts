/**
 * `site: { action: "history" }` — the kept versions of a site, for an agent
 * on an owner's or editor's connection to roll back (`./history.ts` keeps
 * them; decided by the owner, 2026-10-03).
 *
 * Rolling back is not a second way to publish. The agent is handed an old
 * version's files and writes them into `website/` as any edit, so they become
 * the draft: `privacy.md` still decides what is published, and nothing goes
 * live until the same Publish everything else waits for.
 *
 * A page is handed back only if it is published to the workspace now, or is
 * gone from the bucket altogether (deleted or moved, and public when it was
 * published). A page that is in the bucket but held back or encrypted is
 * counted, never named or returned: its copies should already have been wiped,
 * and this is the second guard should a wipe have failed.
 */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { isEncryptedNote } from "../noteEncryption";
import { readBatches } from "./lists";
import { PUBLICATION_CLEARANCE } from "./publication";
import { READ_BATCH } from "./releases";
import { scanWebsiteRoutes } from "./routes";

/** Old words handed back in one answer; the rest are named, one `inspect` each. */
export const HISTORY_TEXT_BUDGET = 200_000;

export interface SiteHistory {
  versions: Array<{ revision: number; publishedAt: number; pages: number; live: boolean }>;
  version: null | {
    revision: number;
    publishedAt: number;
    files: Array<{ path: string; text: string }>;
    /** Kept, but past this answer's size: ask for each with `inspect`. */
    more: string[];
    /** Pages of this version held back or encrypted now, so not handed back. */
    withheld: number;
    /** Pages under `website/` now that this version did not have. */
    addedSince: string[];
  };
  message?: string;
}

export async function siteHistoryFor(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  request: { revision?: number; path?: string },
): Promise<SiteHistory> {
  const kept = await ctx.runQuery(internal.functions.websites.siteVersions, { workspaceId });
  const versions = kept.versions.map((row) => ({
    revision: row.revision,
    publishedAt: row.publishedAt,
    pages: row.pages.length,
    live: row.releaseId === kept.publishedReleaseId,
  }));
  if (request.revision === undefined) return { versions, version: null };
  const chosen = kept.versions.find((row) => row.revision === request.revision);
  if (chosen === undefined) {
    return {
      versions,
      version: null,
      message: `revision ${request.revision} is not one of the kept versions.`,
    };
  }
  const pages =
    request.path === undefined ? chosen.pages : chosen.pages.filter((page) => page.path === request.path);
  if (pages.length === 0) {
    return {
      versions,
      version: null,
      message: `revision ${chosen.revision} has no page ${request.path}.`,
    };
  }

  const paths = pages.map((page) => page.path);
  const published = await readBatches(ctx, workspaceId, PUBLICATION_CLEARANCE.scope, paths);
  const unpublished = paths.filter((path) => {
    const note = published.get(path);
    return note === undefined || isEncryptedNote(note.text);
  });
  // Private scope tells a page that is gone from one that is held back.
  const inBucket = await readBatches(ctx, workspaceId, "private", unpublished);
  const handable = pages.filter((page) => !inBucket.has(page.path));

  const copies = new Map<string, string>();
  for (let offset = 0; offset < handable.length; offset += READ_BATCH) {
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      grantedNames: [],
      operation: {
        kind: "readWebsiteRelease",
        pages: handable
          .slice(offset, offset + READ_BATCH)
          .map((page) => ({ releaseId: chosen.releaseId, pageId: page.pageId, path: page.path })),
      },
    });
    if (result.kind !== "websiteReleasePages") continue;
    for (const page of result.results) if (page.outcome === "read") copies.set(page.path, page.text);
  }

  const files: Array<{ path: string; text: string }> = [];
  const more: string[] = [];
  let spent = 0;
  for (const page of handable) {
    const text = copies.get(page.path);
    if (text === undefined) continue;
    if (spent + text.length > HISTORY_TEXT_BUDGET && files.length > 0) {
      more.push(page.path);
      continue;
    }
    spent += text.length;
    files.push({ path: page.path, text });
  }

  const had = new Set(chosen.pages.map((page) => page.path));
  const now =
    request.path === undefined
      ? (await scanWebsiteRoutes(ctx, workspaceId, PUBLICATION_CLEARANCE, { publication: true })).statuses
      : [];
  return {
    versions,
    version: {
      revision: chosen.revision,
      publishedAt: chosen.publishedAt,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      more: more.sort(),
      withheld: pages.length - handable.length,
      addedSince: now
        .map((status) => status.objectKey)
        .filter((key) => key.startsWith(`${DEFAULT_WEBSITE_ROOT}/`) && !had.has(key))
        .sort(),
    },
  };
}
