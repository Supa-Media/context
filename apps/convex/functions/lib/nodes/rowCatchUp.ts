/**
 * A keyed row's version caught up with its key, before a row move compares a
 * caller's version against it (`rowMove.ts`, `expectedEtag`).
 *
 * A reader is handed the key's etag (`idLayout.js`), and a row move compares
 * that with the row's. The two drift apart with no edit at all when a key is
 * rewritten and no row is told: the managed-encryption walk sealing a bucket
 * before its rows learned to follow it, or a write whose report was lost. A
 * row left behind refused every archive, trash and offline delete of its note
 * as "changed", for as long as it stayed behind.
 *
 * So when the caller's version is the key's own, and the row says otherwise,
 * the row takes the key's version first, through the diagnosis's own record
 * (`recordKeyedCheckPage`): a seam observation, only while the row still holds
 * the key and version it was read at. A caller whose version is not the key's
 * changes nothing here, and the row move refuses it as before.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";

/**
 * Catch up each asked row whose caller passed the key's own version. Never refuses anything itself: a HEAD
 * that cannot be read leaves the rows as they are, and the row move answers as it would have.
 */
export async function catchUpKeyedRows(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  asked: readonly { path: string; expectedEtag?: string }[],
): Promise<void> {
  const wanted = asked.filter((entry): entry is { path: string; expectedEtag: string } => entry.expectedEtag !== undefined);
  if (wanted.length === 0) return;
  const { keyed, notes } = await ctx.runQuery(internal.functions.noteIdsKeyed.notesFor, {
    workspaceId,
    paths: wanted.map((entry) => entry.path),
  });
  if (!keyed) return;
  const behind: { path: string; key: string; etag: string; expectedEtag: string }[] = [];
  for (const { path, expectedEtag } of wanted) {
    const note = notes.find((entry) => entry.path === path);
    if (note?.state !== "keyed" || note.etag === expectedEtag || note.legacyEtag === expectedEtag) continue;
    behind.push({ path, key: note.key, etag: note.etag, expectedEtag });
  }
  if (behind.length === 0) return;
  let heads: ({ etag?: string; size?: number } | null)[];
  try {
    // An id key is plumbing, so the operation's store answers it as the bucket holds it, sealed or not.
    heads = await Promise.all(behind.map((entry) => (typeof store.head === "function" ? store.head(entry.key) : store.get(entry.key))));
  } catch (error) {
    console.warn("rowCatchUp.head_failed", { workspaceId, error: error instanceof Error ? error.message : "unknown" });
    return;
  }
  const answers = behind.flatMap((entry, index) => {
    const head = heads[index];
    // Only the caller's own version is taken: a key that moved on again is a change, and refuses as one.
    if (head === null || head === undefined || head.etag !== entry.expectedEtag) return [];
    const size = head.size;
    return [{
      path: entry.path,
      key: entry.key,
      etag: entry.etag,
      headEtag: head.etag,
      ...(typeof size === "number" ? { headSize: size } : {}),
    }];
  });
  if (answers.length > 0) await ctx.runMutation(internal.functions.noteIdsCopy.recordKeyedCheck, { workspaceId, answers });
}
