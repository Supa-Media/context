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
import { phase, phaseTook } from "../../mcp/phase.js";
import { recordForwarding } from "../../forwarding.js";
import { withActivityHint } from "../../live/activityHint.js";
import { announceMoves } from "../../moves/keyedCollaboration.js";
import { remapIcons } from "../../../../../packages/shared/src/folderIcons.cjs";
import { toolError, toolText } from "../results.js";

/** A destination something already holds, in the control plane's words; `archive.js` asks the next numbered name. */
export const TAKEN_REFUSAL = "conflict: destination already exists";

/** The object's refusals, in the words the control plane's move uses. */
const REFUSALS = new Map([
  ["NOT_FOUND", "not found"],
  ["HIDDEN", "not found"],
  ["CHANGED", "conflict: the note changed since you read it; re-read and retry"],
  ["TAKEN", TAKEN_REFUSAL],
  ["ARCHIVE_STAYS", "that folder stays where it is"],
  ["BUILT_IN_ARCHIVED", "that folder stays where it is"],
  ["INVALID", "invalid path"],
]);

/** The line the keyed row move ends with: the links follow behind it. */
const FOLLOWING_LINE = "\nreferences: updated in the background (old links forward to the new path meanwhile)";

/** Whether this request's object would be asked a move for a caller of `scope` (it may still leave it to Convex). */
export function objectServesMoves(store, scope) {
  return objectFor(store, scope) !== null;
}

/** This request's object, when it serves moves for a caller of `scope`; otherwise null. */
function objectFor(store, scope) {
  const reading = store?.objectReading ?? null;
  if (reading === null || reading.client === null || typeof reading.client?.write?.move !== "function") return null;
  if (reading.home !== "object" || reading.behind === true || reading.canWrite !== true) return null;
  // A caller that names its own scope (a system sweep run as `private`) is not this session: the control plane decides.
  if (reading.scope !== scope) return null;
  return reading;
}

/**
 * Where a move's trip went outside the object's op (2026-11-04: the trip ran 30 to 60 ms past the op's own time):
 * - `move_before`: in the object, from the call beginning to the op starting (the object's clock alone);
 * - `move_legs`: the trip less the object's whole span, both ways on the wire and any wait before the object began
 *   the call: the gateway's clock minus the object's, so no clock skew enters it;
 * - `move_out` and `move_back`: each way alone, across the two machines' clocks, so a skew shifts time between them
 *   (their sum is `move_legs`); a negative one is a skew, not a time, and is not recorded;
 * - `move_legs_cold` and `move_legs_alarm`: `move_legs` again when the object was woken by this call or its alarm was
 *   running, so their counts say how often and their times what it cost.
 */
function tripTimes(store, answer, sentAt, receivedAt) {
  const { arrived, answered } = answer;
  if (typeof arrived !== "number" || typeof answered !== "number" || !(answered >= arrived)) return;
  phaseTook(store, "move_before", answer.before);
  const legs = receivedAt - sentAt - (answered - arrived);
  phaseTook(store, "move_legs", legs);
  phaseTook(store, "move_out", arrived - sentAt);
  phaseTook(store, "move_back", receivedAt - answered);
  if (answer.cold === true) phaseTook(store, "move_legs_cold", legs);
  if (answer.alarm === true) phaseTook(store, "move_legs_alarm", legs);
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
 * `archive` (`{root, roots}`) in place of a destination asks the object to archive `source` where it decides, and
 * `onCode(code)` words a refusal only the caller can (`undefined` leaves it to the usual words).
 *
 * @returns {Promise<object|null>} a tool result, or null to send the move to the control plane
 */
export async function startObjectMove(store, scope, source, destination, expectedEtag, { kind, action, privacy, archive, onCode }) {
  const reading = objectFor(store, scope);
  if (reading === null) return null;
  let answer;
  // The gateway's clock either side of the trip, beside the object's own (`tripTimes`).
  const sentAt = Date.now();
  let receivedAt = sentAt;
  try {
    answer = await reading.client.write.move({
      from: source,
      // An archive names no destination: the object names it (`moveWrites.js` `archiveTo`) and answers it as `to`.
      ...(archive === undefined ? { to: destination } : { archive }),
      ...(typeof expectedEtag === "string" && expectedEtag !== "" ? { expectedEtag } : {}),
      scope: reading.scope,
      // The session's names are a Set (`grantedGroupsOf`): sent as a list.
      groups: [...(reading.names ?? [])],
      userId: reading.userId ?? null,
    });
    receivedAt = Date.now();
  } catch (error) {
    // The error's class only: a message can quote a path, and logs never carry note names.
    reading.log?.("workspace_object_move_failed", { workspaceId: reading.workspaceId, error: error?.name ?? "Error" });
    return null;
  }
  if (answer?.ok !== true) {
    // A code only the caller can word (an archive's `NO_ARCHIVE`, `ARCHIVED`, `HIDDEN_DESTINATION`).
    const worded = typeof onCode === "function" ? onCode(answer?.code) : undefined;
    if (worded !== undefined) return worded;
    const refusal = REFUSALS.get(answer?.code);
    if (refusal !== undefined) return toolError(refusal);
    // `DEFER`, `UNKEYED` and anything else the object did not decide: nothing moved, so the control plane decides.
    reading.log?.("workspace_object_move_passed", { workspaceId: reading.workspaceId, code: answer?.code ?? null });
    return null;
  }

  // The object's own time on the move and, of that, its wait for durable writes (`serveWrites.js`), beside the call's
  // whole trip (`obj:ws.write.move`), so a slow move says whether the time is the object's or the trip's.
  phaseTook(store, "move", answer.took);
  phaseTook(store, "move_commit", answer.commit);
  tripTimes(store, answer, sentAt, receivedAt);
  // The object's answer names where the move went (an archive's own choice); a move it made is never sent on.
  if (typeof answer.to === "string" && answer.to !== "") destination = answer.to;
  const files = Array.isArray(answer.files) ? answer.files : [{ from: source, to: destination }];
  // Each step after the object's answer is timed on its own (`phase:move_*`), so a move over 0.1 s says where.
  await phase(store, "move_announce", () => announceMoves(store, files, privacy));
  await phase(store, "move_record", () =>
    recordChange(store, action, scope, [source, destination], { rowed: true, object: true, ...(kind === "folder" ? { count: files.length } : {}) }),
  );
  const pair = [{ from: source, to: destination }];
  await phase(store, "move_behind", () => behind(store, async () => {
    await Promise.all([
      recordForwarding(store, [{ from: source, to: destination, kind }]),
      remapIcons(store, pair),
    ]);
  }));
  const text =
    kind === "folder"
      ? `moved folder: ${source}/ → ${destination}/ (${files.length} objects)\nEvery app shows it at the new name now.`
      : action === "archive_note"
      ? `archived: ${source} → ${destination}`
      : `moved note: ${source} → ${destination}`;
  return withActivityHint(toolText(text + FOLLOWING_LINE), { moves: pair });
}
