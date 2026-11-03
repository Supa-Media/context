/**
 * `trash_note`: an AI client moves one note or folder to the workspace's Trash, the same Trash the app's Delete puts
 * things in (`ws.write.trash`, `workspaceStore/treeWrites.js`). It can be restored from the app for 30 days and is
 * then erased; there is no "delete forever" (`docs/decisions/storage-and-credentials/notes-by-id.md`, Trash).
 *
 * Asked for by the owner on 2026-11-03, after a benchmark that had to delete 100 notes it had written and found no
 * tool for it (archive moves a note, it does not take it away).
 *
 * Only a workspace whose notes live in its object (home `object`, not behind) trashes here, in one object
 * transaction with Convex mirrored behind it. Any other is told to archive instead: nothing is sent to the control
 * plane's trash from a tool call. The caller is judged by the scope, groups and user id this request's session
 * resolved (`store.objectReading`), never by anything the call names, and a path the caller cannot see is "not found"
 * exactly like one that does not exist.
 */

import { recordChange } from "../../activity/record.js";
import { normalizePath } from "../../notes/paths.js";
import { isPlumbing } from "../../privacy/engine.js";
import { toolError, toolText } from "../results.js";

/** The object's refusals, worded as the other tools that move notes word theirs (`objectMove.js`). */
const REFUSALS = new Map([
  ["NOT_FOUND", "not found"],
  ["HIDDEN", "not found"],
  ["CHANGED", "conflict: the note changed since you read it; re-read and retry"],
  ["ARCHIVE_STAYS", "that folder stays where it is"],
  ["BUILT_IN_ARCHIVED", "that folder stays where it is"],
  ["INVALID", "invalid path"],
]);

const NOT_HERE =
  "Trash from an AI tool needs a workspace whose notes live in its own store, and this one is not moved there yet. " +
  "Archive the note instead (manage archive), or delete it in the app.";

/** This request's object, when it may trash for a caller of `scope`; otherwise null. */
function objectFor(store, scope) {
  const reading = store?.objectReading ?? null;
  if (reading === null || reading.client === null || typeof reading.client?.write?.trash !== "function") return null;
  if (reading.home !== "object" || reading.behind === true || reading.canWrite !== true) return null;
  // A caller that names its own scope (a system sweep) is not this session.
  if (reading.scope !== scope) return null;
  return reading;
}

export async function toolTrashNote(store, scope, pathArg, expectedEtag) {
  const path = normalizePath(pathArg);
  // Plumbing (`.context/…`, the trash itself) is never a note a tool may name.
  if (!path || isPlumbing(path)) return toolError("invalid path");
  const reading = objectFor(store, scope);
  if (reading === null) return toolError(NOT_HERE);
  let answer;
  try {
    answer = await reading.client.write.trash({
      path,
      ...(typeof expectedEtag === "string" && expectedEtag !== "" ? { expectedEtag } : {}),
      scope: reading.scope,
      // The session's names are a Set (`grantedGroupsOf`): sent as a list.
      groups: [...(reading.names ?? [])],
      userId: reading.userId ?? null,
    });
  } catch (error) {
    // The error's class only: a message can quote a path, and logs never carry note names.
    reading.log?.("workspace_object_trash_failed", { workspaceId: reading.workspaceId, error: error?.name ?? "Error" });
    return toolError("could not reach the workspace right now; nothing was moved, try again");
  }
  // Committed in the object, the mirror still catching up (`serveWrites.js`): it is in the Trash.
  const pending = answer?.ok !== true && answer?.code === "MIRROR_PENDING";
  if (answer?.ok !== true && !pending) {
    const refusal = REFUSALS.get(answer?.code);
    if (refusal !== undefined) return toolError(refusal);
    reading.log?.("workspace_object_trash_refused", { workspaceId: reading.workspaceId, code: answer?.code ?? null });
    return toolError("could not move that to the Trash right now; nothing was moved, try again");
  }
  const done = pending ? answer.answer ?? {} : answer;
  const count = Number.isInteger(done.count) ? done.count : 1;
  // The trash name is plumbing (`.context/trash/…`): the change names only what left the tree.
  await recordChange(store, "trash_note", scope, [path], { rowed: true, object: true, count });
  return toolText(
    `trashed: ${path}${count > 1 ? ` (${count} notes)` : ""}\n` +
      "It is in the Trash: it can be restored from the app for 30 days, then it is erased."
  );
}
