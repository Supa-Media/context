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
 * - a reader the object cannot judge (no rules held: `served: false`) and a malformed answer, logged.
 *
 * A failure of the object, or an object still behind after its wait, is `WorkspaceBusy` (decided by the owner,
 * 2026-11-06): the control plane's walk read the same busy object through its door, at about 2.3 s a page.
 *
 * A page the object serves is never asked of the control plane again. The parity check that compared the two answers
 * behind every object page (`tree_manifest_parity`) is retired (2026-11-03): the object's manifest is proven equal to
 * Convex's (`apps/convex/__tests__/workspaceObjectManifest.test.ts`), and the check cost a control-plane walk per page.
 */

import { objectReader, WorkspaceBusy } from "./objectLookup.js";

/** Whether an object's answer is a listing page the served listing can take. */
function wellFormed(answer) {
  return answer?.served === true && Array.isArray(answer.entries) && (answer.cursor === null || typeof answer.cursor === "string");
}

/**
 * `store.treeManifest`, object first. `readControl(page, options)` is the control plane's.
 *
 * @param {(page?: object, options?: object) => Promise<object>} readControl
 * @param {Parameters<typeof objectReader>[0]} options
 */
export function objectFirstManifest(readControl, options) {
  const reader = objectReader(options);
  if (reader === null) return readControl;
  const { client, workspaceId, log, judged, settledBehind } = reader;

  return async (page = {}, readOptions) => {
    const control = () => (readOptions === undefined ? readControl(page) : readControl(page, readOptions));
    if (Number.isFinite(page?.changedSince)) return await control();
    const started = Date.now();
    let answer;
    try {
      answer = await client.rows.manifest({
        ...(typeof page?.folder === "string" ? { folder: page.folder } : {}),
        ...(typeof page?.cursor === "string" ? { cursor: page.cursor } : {}),
        ...judged,
      });
    } catch (error) {
      log("workspace_object_manifest_failed", { workspaceId, error: String(error?.message ?? error) });
      throw new WorkspaceBusy("manifest failed");
    }
    if (settledBehind(answer)) throw new WorkspaceBusy("manifest behind");
    if (!wellFormed(answer)) {
      log("workspace_object_manifest_unserved", { workspaceId });
      return await control();
    }
    log("tree_manifest_object", { workspaceId, ms: Date.now() - started, entries: answer.entries.length, paged: typeof page?.cursor === "string" });
    return { served: true, entries: answer.entries, cursor: answer.cursor };
  };
}

/**
 * `store.treeChildren(folders)`: the name guards' one-level question (`tree/twins.js`), asked of the object
 * (`workspaceStore/manifest.js` `childrenPage`): for each folder, one key per immediate child the reader may see.
 * `null` where this session does not read the object; else a function answering `{[folder]: string[]}`, or `null`
 * when the object did not serve it (no rules held, malformed), and the guards list as before. Failing or behind is
 * `WorkspaceBusy`.
 *
 * Without it a new note's name check read the subtree it lands in and, for a new top-level name, the whole tree:
 * about 0.6 s of manifest pages from the object on each write under load (2026-11-03), 2.3 s a page from the control
 * plane.
 *
 * @param {Parameters<typeof objectReader>[0]} options
 * @returns {((folders: string[]) => Promise<Record<string, string[]> | null>) | null}
 */
export function objectFirstChildren(options) {
  const reader = objectReader(options);
  if (reader === null || typeof reader.client.rows?.children !== "function") return null;
  const { client, workspaceId, log, judged, settledBehind } = reader;
  return async (folders) => {
    let answer;
    try {
      answer = await client.rows.children({ folders, ...judged });
    } catch (error) {
      log("workspace_object_children_failed", { workspaceId, error: String(error?.message ?? error) });
      throw new WorkspaceBusy("children failed");
    }
    if (settledBehind(answer)) throw new WorkspaceBusy("children behind");
    const served = answer?.served === true && answer.folders !== null && typeof answer.folders === "object";
    if (!served || !folders.every((folder) => Array.isArray(answer.folders[folder]) && answer.folders[folder].every((key) => typeof key === "string"))) {
      log("workspace_object_children_unserved", { workspaceId });
      return null;
    }
    return Object.fromEntries(folders.map((folder) => [folder, answer.folders[folder]]));
  };
}
