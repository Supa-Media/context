/**
 * One page of the old-copy cleanup, run next to the bucket (owner, 2026-10-15:
 * "Old keys are deleted seven days after the owner confirms the switch").
 *
 * Two kinds, both handed out by the control plane's tickets
 * (`apps/convex/functions/lib/cleanup/`):
 *
 * - `cleanupList`: one page of the bucket's keys, from a cursor. Keys only:
 *   no body is read. The control plane decides which keys are old copies.
 * - `cleanupDelete`: delete the keys the control plane approved for this page,
 *   after its own re-check that no live row still reads each one. Each key
 *   gets its own answer; a failure is a fixed reason, never the provider's
 *   text, since a key can name a note's title.
 *
 * The bare adapter (`sealedObjects`), as every other mover page: a managed
 * bucket's keys are the same whether the bodies are sealed or not, and the
 * cleanup never reads a body.
 */

import { storeForBinding } from "../store/factory.js";
import { cleanupKey } from "./cleanupKeys.js";

/** Keys one list page returns at most. */
export const CLEANUP_LIST_LIMIT = 500;
/** Keys one delete page may name, as many as the control plane plans. */
export const CLEANUP_DELETE_MAX = 500;

/**
 * A key the page may name at all: non-empty, no leading slash, no empty or
 * `..` segment. A key that fails this fails the whole page, before anything is
 * deleted. A key that is well formed but must be kept is answered `kept`.
 */
export function wellFormedKey(key) {
  if (typeof key !== "string" || key === "" || key.length > 1024 || key.startsWith("/")) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * @param {{ workspaceId: string, source: object, cursor?: string, limit?: number }} page
 * @param {{ buildStore?: typeof storeForBinding }} [deps] seam for tests
 * @returns {Promise<{ keys: string[], nextCursor: string | null }>}
 */
export async function runCleanupListPage(page, { buildStore = storeForBinding } = {}) {
  const store = buildStore(page.source, undefined, { sealedObjects: true });
  const limit = Math.min(page.limit ?? CLEANUP_LIST_LIMIT, CLEANUP_LIST_LIMIT);
  const listed = await store.list({ cursor: page.cursor, limit });
  const objects = Array.isArray(listed?.objects) ? listed.objects : [];
  const nextCursor = listed?.truncated === true && typeof listed.cursor === "string" && listed.cursor !== "" ? listed.cursor : null;
  return { keys: objects.map((object) => object.key).filter((key) => typeof key === "string"), nextCursor };
}

/**
 * Delete each approved key that the cleanup owns; answer every key. A key the
 * cleanup does not own is `kept` and is not touched. A delete that throws is
 * `delete_failed` for that key alone.
 *
 * @param {{ workspaceId: string, source: object, keys: string[] }} page
 * @param {{ buildStore?: typeof storeForBinding }} [deps]
 * @returns {Promise<{ results: { key: string, ok: boolean, reason?: string }[] }>}
 */
export async function runCleanupDeletePage(page, { buildStore = storeForBinding } = {}) {
  const store = buildStore(page.source, undefined, { sealedObjects: true });
  const results = [];
  for (const key of page.keys) {
    if (!cleanupKey(key)) {
      results.push({ key, ok: false, reason: "kept" });
      continue;
    }
    try {
      await store.delete(key);
      results.push({ key, ok: true });
    } catch {
      // The key and the workspace only in the log below; never the provider's text.
      results.push({ key, ok: false, reason: "delete_failed" });
    }
  }
  const failed = results.filter((result) => !result.ok && result.reason === "delete_failed").length;
  if (failed > 0) console.error("mover.cleanup_delete_failed", { workspaceId: page.workspaceId, failed });
  return { results };
}
