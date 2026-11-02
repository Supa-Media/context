/**
 * The agent tools' listing (`tree/served.js` `store.treeManifest`), answered by the workspace's object where its notes
 * live there (`workspaceStore/manifest.js`), and by the control plane (`/gateway/tree/manifest`) for everything else.
 *
 * The control plane's answer took about 2.3 s a page in production (2026-11-02): it reads the grant, every live row and
 * the rules mirror in Convex on each call. The object holds the same rows and rules and judges with the same `canSee`,
 * so it answers in one call to the object.
 *
 * Which reader goes to the object, and when it may not, is the row lookup's own rule (`objectLookup.js`
 * `objectReader`): notes at home there, a known scope, and not behind. The per-call behind check runs beside the
 * object call, so a share just taken back is never listed from the object's older rows.
 *
 * The control plane still answers:
 * - a check-in's "what changed since" (`changedSince`), which reads its change index;
 * - a reader the object cannot judge (no rules held: `served: false`), a malformed answer, and any failure, logged.
 *
 * While this is new, every page the object answers is also asked of the control plane behind the response (`defer`,
 * after the answer has gone) and the two compared, counts only, never a path (`tree_manifest_parity`).
 */

import { objectReader } from "./objectLookup.js";

/** Whether an object's answer is a listing page the served listing can take. */
function wellFormed(answer) {
  return answer?.served === true && Array.isArray(answer.entries) && (answer.cursor === null || typeof answer.cursor === "string");
}

/**
 * How two answers for the same page differ: names only one side gave, and names both gave at different versions.
 * Counts only, so a log line never carries a path.
 */
export function manifestDifference(objectPage, controlPage) {
  const control = new Map((controlPage?.entries ?? []).map((entry) => [entry.path, entry]));
  let objectOnly = 0;
  let changed = 0;
  for (const entry of objectPage.entries) {
    const other = control.get(entry.path);
    if (other === undefined) objectOnly += 1;
    else if ((other.etag ?? null) !== (entry.etag ?? null) || (other.noteId ?? null) !== (entry.noteId ?? null)) changed += 1;
    control.delete(entry.path);
  }
  return { objectOnly, controlOnly: control.size, changed, cursorSame: (objectPage.cursor ?? null) === (controlPage?.cursor ?? null) };
}

/**
 * `store.treeManifest`, object first. `readControl(page, options)` is the control plane's.
 *
 * @param {(page?: object, options?: object) => Promise<object>} readControl
 * @param {Parameters<typeof objectReader>[0]} options
 * @param {{defer?: (() => ((work: () => Promise<void>) => void) | null) | null}} [extra] the request's `store.defer`, read when a page is answered
 */
export function objectFirstManifest(readControl, options, { defer = null } = {}) {
  const reader = objectReader(options);
  if (reader === null) return readControl;
  const { client, workspaceId, log, judged, askBehind, settledBehind } = reader;

  return async (page = {}, readOptions) => {
    const control = () => (readOptions === undefined ? readControl(page) : readControl(page, readOptions));
    if (Number.isFinite(page?.changedSince)) return await control();
    const started = Date.now();
    const pending = askBehind();
    let answer;
    try {
      answer = await client.rows.manifest({
        ...(typeof page?.folder === "string" ? { folder: page.folder } : {}),
        ...(typeof page?.cursor === "string" ? { cursor: page.cursor } : {}),
        ...judged,
      });
    } catch (error) {
      log("workspace_object_manifest_failed", { workspaceId, error: String(error?.message ?? error) });
      return await control();
    }
    if (await settledBehind(pending)) return await control();
    if (!wellFormed(answer)) {
      log("workspace_object_manifest_unserved", { workspaceId });
      return await control();
    }
    const result = { served: true, entries: answer.entries, cursor: answer.cursor };
    log("tree_manifest_object", { workspaceId, ms: Date.now() - started, entries: result.entries.length, paged: typeof page?.cursor === "string" });
    const later = typeof defer === "function" ? defer() : null;
    if (typeof later === "function") {
      later(async () => {
        const startedControl = Date.now();
        try {
          const other = await control();
          if (other?.served !== true) {
            log("tree_manifest_parity", { workspaceId, controlServed: false, controlMs: Date.now() - startedControl });
            return;
          }
          log("tree_manifest_parity", { workspaceId, entries: result.entries.length, controlMs: Date.now() - startedControl, ...manifestDifference(result, other) });
        } catch (error) {
          log("tree_manifest_parity", { workspaceId, controlFailed: String(error?.name ?? "error") });
        }
      });
    }
    return result;
  };
}
