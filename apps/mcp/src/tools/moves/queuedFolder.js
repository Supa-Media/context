/**
 * `move_folder` as one step, however big the folder (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * Where the control plane's tree serves this workspace, the move is queued
 * there exactly as the console queues one: every screen draws the folder at
 * its new name at once, and the bucket catches up behind it. The control
 * plane decides everything the console's move decides (who may move what,
 * whether the destination exists, what the moved notes may be seen as), so
 * this file only asks and words the answer.
 *
 * `null` means the queue did not take it: the tree does not serve this
 * workspace yet, the storage cannot move an object safely, or the folder
 * holds something this caller cannot see. `move_folder` then moves a folder
 * of up to `LOGICAL_FOLDER_MOVE_THRESHOLD` objects in one go, which leaves
 * what the caller cannot see behind as it always has, and refuses a larger one.
 */

import { withActivityHint } from "../../live/activityHint.js";
import { recordChange } from "../../activity/record.js";
import { canSee, hasOverride, visibilityOf } from "../../privacy/engine.js";
import { probeWithLegacyFallback } from "../../notes/storage.js";
import { toolError, toolText, writePermissionError } from "../results.js";
import { renameCollaboration } from "../../moves/keyedCollaboration.js";
import { readDocument as readCollaborationDocument } from "@context/collaboration";
import { loadPrivacyState } from "../../privacy/state.js";
import { referencesLine } from "../../moves/objects.js";
import { rewriteReferencesAfterMove } from "./references.js";

/**
 * A keyed row move's collaboration half: each note the row move renamed carries
 * its history to the new name (`keyedCollaboration.js`). The answer names those
 * files; an answer without them (an older control plane) carries only the root.
 */
async function carryRowedCollaboration(store, answer, source, destination, privacy) {
  if (answer.rowed !== true) return;
  const moved = Array.isArray(answer.moved) ? answer.moved : [{ from: source, to: destination }];
  await renameCollaboration(store, moved, privacy, { carried: answer.historyCarried === true });
}

/**
 * A keyed row move's links: every link to a moved note, and every relative
 * link inside one, pointed at where it is now (`references.js`), as a move
 * the old way does. Run after the collaboration half, so a rewrite lands on
 * each note's history at its new name. The rules are read again, since the
 * row move carried them; where they cannot be, the caller's are used. A
 * rewrite that cannot run is reported as not done, never as a failed move:
 * the rows have moved, and the forwarding record still sends old links on.
 *
 * `pairs` are the notes and files that moved, each `{from, to}`; `null` (an
 * older control plane, which named only a folder's root) is not rewritten.
 */
async function rewriteRowedLinks(store, scope, privacy, pairs) {
  if (!Array.isArray(pairs)) return { notes: 0, links: 0, capped: false };
  let { rules, overrides } = privacy ?? {};
  try {
    const fresh = await loadPrivacyState(store);
    if (fresh.error === undefined) ({ rules, overrides } = fresh);
  } catch {
    // The caller's rules, read before the move, are what this request was judged by.
  }
  try {
    return await rewriteReferencesAfterMove(store, scope, rules ?? [], overrides ?? new Map(), new Map(pairs.map((pair) => [pair.from, pair.to])));
  } catch {
    return { notes: 0, links: 0, capped: true };
  }
}

/** Whether a folder named `a` and one named `b` are the same or one holds the other. */
function nested(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Whether a pending move's old or new name overlaps the move being asked for. */
function crossesPendingMove(moves, source, destination) {
  if (!Array.isArray(moves)) return false;
  return moves.some(
    (move) =>
      typeof move?.from === "string" &&
      typeof move?.to === "string" &&
      [source, destination].some((path) => nested(path, move.from) || nested(path, move.to)),
  );
}

/** The etag `read_note` answers for a note with editing history: its collaboration revision, not a storage version. */
const COLLABORATION_ETAG = "c2.";

/**
 * The version the control plane compares a row move against. `read_note`
 * hands out a note's collaboration etag (`c2.…`) where it has editing history,
 * and the row holds the stored object's etag, so the two never matched and
 * every move or archive of such a note was refused as changed. A collaboration
 * etag is checked here against the document, then exchanged for the stored
 * version; any other etag passes as it is.
 *
 * @returns {Promise<{etag?: string, conflict?: true}>}
 */
async function rowVersionOf(store, path, expected) {
  if (typeof expected !== "string" || !expected.startsWith(COLLABORATION_ETAG)) return { etag: expected };
  let current;
  try {
    current = await readCollaborationDocument(store, path);
  } catch {
    return { conflict: true };
  }
  if (current?.etag !== expected) return { conflict: true };
  const stored = await store.head(path);
  return typeof stored?.etag === "string" && stored.etag !== "" ? { etag: stored.etag } : { conflict: true };
}

/**
 * A note moved in a keyed workspace as a row change (`rowMoveStart.ts`): the
 * control plane moves the row and says so; nothing is copied here. `null`
 * means the workspace is not keyed yet, and the note moves the old way. A
 * keyed refusal is an answer, never `null`, because the old way would move
 * the frozen copies the bucket still holds.
 */
export async function startKeyedNoteMove(store, scope, source, destination, expectedEtag, privacy) {
  if (store?.keyedLayout !== true || typeof store.startQueuedMove !== "function") return null;
  const version = await rowVersionOf(store, source, expectedEtag);
  if (version.conflict) return toolError("conflict: the note changed since you read it; re-read and retry");
  let answer;
  try {
    answer = await store.startQueuedMove(source, destination, version.etag);
  } catch {
    return toolError("could not start the move right now; try again in a moment");
  }
  if (!answer || answer.queued !== true) {
    if (typeof answer?.error !== "string") return null;
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the move was refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  await carryRowedCollaboration(store, answer, source, destination, privacy);
  const references = await rewriteRowedLinks(store, scope, privacy, [{ from: source, to: destination }]);
  await recordChange(store, "move_note", scope, [source, destination], { rowed: true });
  return withActivityHint(toolText(`moved note: ${source} → ${destination}` + referencesLine(references)), {
    moves: [{ from: source, to: destination }],
  });
}

/**
 * A batch of notes moved in a keyed workspace as one control-plane call, made
 * whole or not at all (`/gateway/moves/batch`). The caller's checks are made
 * here first, as `toolMoveNote` makes them for one note, so a source it may not
 * see is "not found" whatever it aimed at. A refusal names nothing the caller
 * cannot see, and the control plane writes every row or none.
 */
export async function startKeyedBatchMove(store, scope, rules, overrides, moves) {
  if (typeof store.startMoveBatch !== "function") {
    return toolError("moving several notes in one call is not available in this workspace yet; move them one at a time");
  }
  for (const move of moves) {
    const seen = canSee(move.source, scope, rules, overrides);
    const present = await probeWithLegacyFallback(store, move.source);
    if (!seen || !present) return toolError(`not found: ${move.source}`);
    if (scope !== "private" && visibilityOf(move.destination, rules) !== "team") {
      return writePermissionError(`move destination ${move.destination}`);
    }
    if (scope === "team" && hasOverride(overrides, move.destination)) return writePermissionError("move destination");
  }
  const versions = [];
  for (const move of moves) {
    const version = await rowVersionOf(store, move.source, move.expectedSourceEtag || undefined);
    if (version.conflict) return toolError(`conflict: ${move.source} changed since you read it; re-read and retry`);
    versions.push(version.etag);
  }
  let answer;
  try {
    answer = await store.startMoveBatch(
      moves.map((move, index) => ({
        from: move.source,
        to: move.destination,
        ...(versions[index] ? { expectedEtag: versions[index] } : {}),
      })),
    );
  } catch {
    return toolError("could not start the moves right now; try again in a moment");
  }
  if (!answer || answer.ok !== true) {
    if (typeof answer?.error !== "string") return toolError("could not start the moves right now; try again in a moment");
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the moves were refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  const pairs = moves.map((move) => ({ from: move.source, to: move.destination }));
  // Each moved note's collaboration history follows it (`keyedCollaboration.js`).
  await renameCollaboration(store, Array.isArray(answer.moves) ? answer.moves : pairs, { rules, overrides });
  const references = await rewriteRowedLinks(store, scope, { rules, overrides }, pairs);
  await recordChange(store, "move_notes", scope, pairs.flatMap((pair) => [pair.from, pair.to]), { count: pairs.length, rowed: true });
  return withActivityHint(
    toolText(`moved notes: ${pairs.length}\n` + pairs.map((pair) => `- ${pair.from} → ${pair.to}`).join("\n") + referencesLine(references)),
    { moves: pairs },
  );
}

export async function startQueuedFolderMove(store, scope, source, destination, privacy) {
  if (typeof store?.startQueuedMove !== "function") return null;
  let answer;
  try {
    answer = await store.startQueuedMove(source, destination);
  } catch {
    // With a move already running, the old way could act on names that are still
    // moving. Without one, the old way is exactly what this did before.
    if (Array.isArray(store.pendingMoves) && store.pendingMoves.length > 0) {
      return toolError("could not start the move right now; try again in a moment");
    }
    return null;
  }
  if (!answer || answer.queued !== true) {
    if (typeof answer?.error !== "string") {
      // The old way lists the bucket, which still holds a moving folder at its
      // old name: moving the copied half now and letting the worker bring the
      // rest to the old destination would split the folder.
      if (crossesPendingMove(store.pendingMoves, source, destination)) {
        return toolError("could not move that folder while part of it is still moving; try again once that move finishes");
      }
      return null;
    }
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the move was refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  const count = Number.isInteger(answer.count) ? answer.count : 0;
  await carryRowedCollaboration(store, answer, source, destination, privacy);
  // A keyed row move names the notes and files it moved; their links follow here. A queued copy rewrites its own when done.
  const references = answer.rowed === true ? await rewriteRowedLinks(store, scope, privacy, Array.isArray(answer.moved) ? answer.moved : null) : null;
  await recordChange(store, "move_folder", scope, [source, destination], { count, queued: true });
  // A keyed row move copies nothing, so there is no storage catching up to say.
  const note = answer.rowed === true
    ? "Every app shows it at the new name now." + referencesLine(references)
    : "Every app shows it at the new name now; storage finishes copying in the background, and links to it are rewritten when that is done.";
  return withActivityHint(
    toolText(`moved folder: ${source}/ → ${destination}/ (${count} objects)\n` + note),
    { moves: [{ from: source, to: destination }] }
  );
}
