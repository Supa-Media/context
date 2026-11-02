/**
 * The id layer's row questions, answered by the workspace's object where its notes live there
 * (`workspaceStore/api.js` `rows.lookup` / `rows.resolve`), and by the control plane for everything the object
 * cannot answer alone.
 *
 * The object judges each path with the same `canSee` and the reader's own scope and row tokens, and answers only
 * what the reader may see. The control plane's answer is wider (a built-in folder's default name, a move in flight,
 * a Tex home for a new note, a gone row, a note the reader may not see), so every path the object does not find is
 * asked there, in one call, as before. A note the reader sees is the common case and costs one call to the object.
 *
 * Only a member's own reading goes to the object. A guest's or a Tex guest chat's reading (`READS_AS_GUEST`,
 * `READS_AS_CHAT` in the session's names) is judged by rules rendered for that reader, which the control plane keeps; it is asked there.
 * Any failure of the object falls back to the control plane for the whole question, and is logged.
 *
 * Whether the object is behind (a change committed in the control plane and not yet pushed, such as a share just
 * taken back): either the binding's `notesBehind`, read once when the store was built, or `checkBehind`, one small
 * control-plane question asked beside every object call, so a read that skips the binding still never serves a
 * revoked share. A check that fails counts as behind.
 */

import { narrowNote } from "../controlPlane/noteIds.js";
import { isPlumbing, READS_AS_CHAT, READS_AS_GUEST } from "../privacy/engine.js";
import { HOMES } from "../workspaceStore/api.js";

/** Whether a session's names read the workspace as a member: no guest or chat marker (row tokens are a member's). */
export function readsAsMember(names) {
  for (const name of names ?? []) if (name === READS_AS_GUEST || name === READS_AS_CHAT) return false;
  return true;
}

/**
 * One object row as the id layer takes a control-plane entry, through the same check (`narrowNote`): a key that is
 * not a note's id key (a Tex note's, say) is not taken here, and the control plane answers for it.
 */
function entryOf(row) {
  if (row.kind === "folder") return { state: "folder" };
  return narrowNote({ state: "keyed", key: row.key, etag: row.etag, ...(typeof row.noteId === "string" ? { noteId: row.noteId } : {}) });
}

/**
 * The `lookup` and `resolve` hooks for `withIdLayout`, object first. `hooks` are the control plane's.
 *
 * @param {{lookup: (paths: string[]) => Promise<object>, resolve?: (ids: string[]) => Promise<object>}} hooks
 * @param {{client: object|null, home?: string|null, behind?: boolean, checkBehind?: () => Promise<boolean>, scope: string, names: Iterable<string>, userId?: string|null, log?: (event: string, fields: object) => void}} options
 */
export function objectFirstHooks(hooks, { client, home, behind = false, checkBehind = null, scope, names, workspaceId, userId = null, log = () => {} }) {
  const groups = [...(names ?? [])];
  if (!client || home !== HOMES.OBJECT || (scope !== "private" && scope !== "team") || !readsAsMember(groups)) return hooks;
  // A change the object has not taken yet (the binding's `notesBehind`): a share just taken back by a mutation that
  // could not wait for the push must not be served from the object's older rows, so the whole request asks the
  // control plane, which already has it.
  if (behind === true) {
    log("workspace_object_behind", { workspaceId });
    return hooks;
  }
  // `userId`: who is reading, for an object that decides access from its own members (`workspaceStore/members.js`).
  const judged = { scope, groups, audience: "member", ...(typeof userId === "string" ? { userId } : {}) };
  // Asked at the same time as the object, never before it: the read costs the slower of the two, not both.
  const askBehind = () =>
    typeof checkBehind === "function"
      ? Promise.resolve()
          .then(checkBehind)
          .then((answer) => answer !== false)
          .catch(() => true)
      : Promise.resolve(false);
  const settledBehind = async (pending) => {
    if (!(await pending)) return false;
    log("workspace_object_behind", { workspaceId });
    return true;
  };

  const lookup = async (paths) => {
    const pending = askBehind();
    let answer;
    try {
      answer = await client.rows.lookup({ paths, ...judged });
    } catch (error) {
      log("workspace_object_lookup_failed", { workspaceId, error: String(error?.message ?? error) });
      return await hooks.lookup(paths);
    }
    if (await settledBehind(pending)) return await hooks.lookup(paths);
    const notes = {};
    const missing = [];
    paths.forEach((path, at) => {
      const row = answer?.rows?.[at];
      const entry = row?.found === true && row.path === path ? entryOf(row) : null;
      if (entry === null) missing.push(path);
      else notes[path] = entry;
    });
    if (missing.length === 0) return { keyed: true, notes, texHomes: {} };
    const rest = await hooks.lookup(missing);
    return { keyed: rest.keyed === true, notes: { ...rest.notes, ...notes }, texHomes: rest.texHomes ?? {} };
  };

  if (typeof hooks.resolve !== "function") return { ...hooks, lookup };
  const resolve = async (noteIds) => {
    const pending = askBehind();
    let answer;
    try {
      answer = await client.rows.resolve({ noteIds, ...judged });
    } catch (error) {
      log("workspace_object_resolve_failed", { workspaceId, error: String(error?.message ?? error) });
      return await hooks.resolve(noteIds);
    }
    if (await settledBehind(pending)) return await hooks.resolve(noteIds);
    const paths = {};
    const missing = [];
    noteIds.forEach((noteId, at) => {
      const row = answer?.rows?.[at];
      // A path under a dot folder is not a note a person names: the control plane answers it (as `null`).
      if (row?.found === true && row.noteId === noteId && typeof row.path === "string" && row.kind !== "folder" && !isPlumbing(row.path)) paths[noteId] = row.path;
      else missing.push(noteId);
    });
    if (missing.length === 0) return { paths };
    const rest = await hooks.resolve(missing);
    return { paths: { ...rest.paths, ...paths } };
  };
  return { ...hooks, lookup, resolve };
}
