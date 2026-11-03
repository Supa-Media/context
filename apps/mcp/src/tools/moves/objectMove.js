/**
 * An AI client's `move_note`, `move_folder` and `archive_note` made in the workspace's object (`ws.write.move`,
 * `workspaceStore/moveWrites.js`) for a workspace whose notes live there (home `object`, not behind): one object
 * transaction, with Convex mirrored behind it and never asked on the way
 * (`docs/decisions/storage-and-credentials/object-row-writes.md`, "Moves and renames in the object").
 *
 * `null` sends the move to the control plane exactly as before (`queuedFolder.js`): a workspace not served by its
 * object, a caller this request did not resolve (a system sweep that names its own scope), a move the object leaves
 * to the control plane (`DEFER`, `UNKEYED`), or an object that could not be reached or answered something unknown.
 * Nothing moved in any of those, so the control plane's answer is the only one.
 *
 * The caller is judged by the scope, groups and user id this request's session resolved (`store.objectReading`),
 * never by anything the tool call names. A refusal is worded the way the control plane's is, and a name the caller
 * cannot see is "not found" exactly like one that does not exist.
 *
 * What the control plane's row move did beside the rows is done here: each moved note's open editor is told where it
 * went, the change is recorded, and, behind the answer, the forwarding ledger and the folder icons follow. The links
 * follow in Convex when the mirror takes the move (`lib/nodes/mirrorTree.ts`).
 */

import { recordChange } from "../../activity/record.js";
import { recordForwarding } from "../../forwarding.js";
import { withActivityHint } from "../../live/activityHint.js";
import { announceMoves } from "../../moves/keyedCollaboration.js";
import { remapIcons } from "../../../../../packages/shared/src/folderIcons.cjs";
import { toolError, toolText } from "../results.js";

/** The object's refusals, in the words the control plane's move uses. */
const REFUSALS = new Map([
  ["NOT_FOUND", "not found"],
  ["HIDDEN", "not found"],
  ["CHANGED", "conflict: the note changed since you read it; re-read and retry"],
  ["TAKEN", "conflict: destination already exists"],
  ["ARCHIVE_STAYS", "that folder stays where it is"],
  ["BUILT_IN_ARCHIVED", "that folder stays where it is"],
  ["INVALID", "invalid path"],
]);

/** The line the keyed row move ends with: the links follow behind it. */
const FOLLOWING_LINE = "\nreferences: updated in the background (old links forward to the new path meanwhile)";

/** This request's object, when it serves moves for a caller of `scope`; otherwise null. */
function objectFor(store, scope) {
  const reading = store?.objectReading ?? null;
  if (reading === null || reading.client === null || typeof reading.client?.write?.move !== "function") return null;
  if (reading.home !== "object" || reading.behind === true || reading.canWrite !== true) return null;
  // A caller that names its own scope (a system sweep run as `private`) is not this session: the control plane decides.
  if (reading.scope !== scope) return null;
  return reading;
}

/** Work kept going behind the answer where the host allows it, and awaited where it does not. */
async function behind(store, work) {
  const running = work().catch(() => {});
  if (typeof store.defer === "function") {
    store.defer(running);
    return;
  }
  await running;
}

/**
 * Moves `source` to `destination` in the object. `kind` words the answer (`"note"` or `"folder"`), `action` is the
 * change's name in the activity record, and `privacy` (`{rules, overrides}`) says which rooms may hear the new name.
 *
 * @returns {Promise<object|null>} a tool result, or null to send the move to the control plane
 */
export async function startObjectMove(store, scope, source, destination, expectedEtag, { kind, action, privacy }) {
  const reading = objectFor(store, scope);
  if (reading === null) return null;
  let answer;
  try {
    answer = await reading.client.write.move({
      from: source,
      to: destination,
      ...(typeof expectedEtag === "string" && expectedEtag !== "" ? { expectedEtag } : {}),
      scope: reading.scope,
      // The session's names are a Set (`grantedGroupsOf`): sent as a list.
      groups: [...(reading.names ?? [])],
      userId: reading.userId ?? null,
    });
  } catch (error) {
    // The error's class only: a message can quote a path, and logs never carry note names.
    reading.log?.("workspace_object_move_failed", { workspaceId: reading.workspaceId, error: error?.name ?? "Error" });
    return null;
  }
  if (answer?.ok !== true) {
    const refusal = REFUSALS.get(answer?.code);
    if (refusal !== undefined) return toolError(refusal);
    // `DEFER`, `UNKEYED` and anything else the object did not decide: nothing moved, so the control plane decides.
    reading.log?.("workspace_object_move_passed", { workspaceId: reading.workspaceId, code: answer?.code ?? null });
    return null;
  }

  const files = Array.isArray(answer.files) ? answer.files : [{ from: source, to: destination }];
  await announceMoves(store, files, privacy);
  await recordChange(store, action, scope, [source, destination], { rowed: true, object: true, ...(kind === "folder" ? { count: files.length } : {}) });
  const pair = [{ from: source, to: destination }];
  await behind(store, async () => {
    await Promise.all([
      recordForwarding(store, [{ from: source, to: destination, kind }]),
      remapIcons(store, pair),
    ]);
  });
  const text =
    kind === "folder"
      ? `moved folder: ${source}/ → ${destination}/ (${files.length} objects)\nEvery app shows it at the new name now.`
      : `moved note: ${source} → ${destination}`;
  return withActivityHint(toolText(text + FOLLOWING_LINE), { moves: pair });
}
