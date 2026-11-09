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

import { versionMatches } from "../../notes/version.js";
import { withActivityHint } from "../../live/activityHint.js";
import { recordChange } from "../../activity/record.js";
import { canSee, effectiveVisibility, hasOverride, narrowerVisibility, visibilityOf } from "../../privacy/engine.js";
import { probeWithLegacyFallback } from "../../notes/storage.js";
import { toolError, toolText, writePermissionError } from "../results.js";
import { announceMoves } from "../../moves/keyedCollaboration.js";
import { readDocument as readCollaborationDocument } from "@context/collaboration";
import { afterObjectMoves, objectServesMoves, startObjectMove } from "./objectMove.js";

/**
 * A keyed row move's open editors: each moved note's room is told where it went (`keyedCollaboration.js`).
 * The history is filed by note id, so nothing is carried. An answer that names no files (an older control
 * plane) tells only the root's room.
 */
async function announceRowedMoves(store, answer, source, destination, privacy) {
  if (answer.rowed !== true) return;
  const moved = Array.isArray(answer.moved) ? answer.moved : [{ from: source, to: destination }];
  await announceMoves(store, moved, privacy);
}

/**
 * A keyed row move's links: the control plane queues them when the rows move
 * (`apps/convex/functions/linkRepairs.ts`) and rewrites every link to a moved
 * note, and every relative link inside one, behind the move, as the owner. The
 * move does no per-note link work, and the forwarding record sends an old link
 * on until the rewrite lands.
 */
const FOLLOWING_LINE = "\nreferences: updated in the background (old links forward to the new path meanwhile)";

/** Whether a folder named `a` and one named `b` are the same or one holds the other. */
function nested(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
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
export async function rowVersionOf(store, path, expected) {
  if (typeof expected !== "string" || !expected.startsWith(COLLABORATION_ETAG)) return { etag: expected };
  let current;
  try {
    current = await readCollaborationDocument(store, path);
  } catch {
    return { conflict: true };
  }
  if (!current || !versionMatches(expected, { document: current, rawEtag: null })) return { conflict: true };
  const stored = await store.head(path);
  return typeof stored?.etag === "string" && stored.etag !== "" ? { etag: stored.etag } : { conflict: true };
}

/**
 * A note moved in a keyed workspace as a row change (`rowMoveStart.ts`): the
 * control plane moves the row and says so; nothing is copied here. `null`
 * means the workspace is not keyed yet, and the note moves the old way. A
 * keyed refusal is an answer, never `null`, because the old way would move
 * the frozen copies the bucket still holds. `objectAsked` says the caller
 * already asked the object (`archive.js`), so it is not asked twice.
 */
export async function startKeyedNoteMove(store, scope, source, destination, expectedEtag, privacy, { objectAsked = false } = {}) {
  if (store?.keyedLayout !== true || typeof store.startQueuedMove !== "function") return null;
  const version = await rowVersionOf(store, source, expectedEtag);
  if (version.conflict) return toolError("conflict: the note changed since you read it; re-read and retry");
  // A workspace whose notes live in its object moves the row there, in one transaction (`objectMove.js`).
  const inObject = objectAsked
    ? null
    : await startObjectMove(store, scope, source, destination, version.etag, { kind: "note", action: "move_note", privacy });
  if (inObject !== null) return inObject;
  let answer;
  try {
    answer = await store.startQueuedMove(source, destination, version.etag);
  } catch (error) {
    // A move the gateway gave up waiting on may still land: the caller looks before sending it again.
    if (error?.reason === "timed out") {
      return toolError(`the move is taking longer than expected and may still finish; check whether ${destination} exists before sending it again`);
    }
    return toolError("could not start the move right now; try again in a moment");
  }
  if (!answer || answer.queued !== true) {
    if (typeof answer?.error !== "string") return null;
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the move was refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  await announceRowedMoves(store, answer, source, destination, privacy);
  await recordChange(store, "move_note", scope, [source, destination], { rowed: true });
  return withActivityHint(toolText(`moved note: ${source} → ${destination}` + FOLLOWING_LINE), {
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
/**
 * Each move's lookups run this many at a time. A hundred one after another
 * (a tree lookup and a storage probe each) took most of a minute, and a
 * housekeeping run's batch of 100 was cut off at its limit (2026-10-26).
 */
const CHECK_LANES = 10;

/** `work` over every item, `CHECK_LANES` at a time, answers in the items' order. */
async function inLanes(items, work) {
  const answers = [];
  for (let start = 0; start < items.length; start += CHECK_LANES) {
    answers.push(...(await Promise.all(items.slice(start, start + CHECK_LANES).map(work))));
  }
  return answers;
}

/**
 * The checks `toolMoveNote` makes for one note, made for each move of a keyed
 * batch: a source the caller may not see is "not found" whatever it aimed at.
 * The first refusal in the batch's order, or null.
 */
async function keyedBatchRefusal(store, scope, rules, overrides, moves) {
  const present = await inLanes(moves, (move) => probeWithLegacyFallback(store, move.source));
  for (const [index, move] of moves.entries()) {
    if (!canSee(move.source, scope, rules, overrides) || !present[index]) return toolError(`not found: ${move.source}`);
    if (scope !== "private" && visibilityOf(move.destination, rules) !== "team") {
      return writePermissionError(`move destination ${move.destination}`);
    }
    if (scope === "team" && hasOverride(overrides, move.destination)) return writePermissionError("move destination");
  }
  return null;
}

/**
 * A keyed batch's dry run: the same checks, each source's stored version (what
 * the control plane compares the move against) and a destination already
 * taken, in the old preflight's words. Nothing here reads a note's body or its
 * editing history, so a dry run of 100 costs what the move itself does, where
 * the old preflight read every body and timed out (2026-10-26).
 */
export async function planKeyedBatchMove(store, scope, rules, overrides, moves) {
  const refusal = await keyedBatchRefusal(store, scope, rules, overrides, moves);
  if (refusal) return refusal;
  const looked = await inLanes(moves, async (move) => ({
    head: await store.head(move.source),
    taken: await probeWithLegacyFallback(store, move.destination),
  }));
  const lines = [];
  for (const [index, move] of moves.entries()) {
    const { head, taken } = looked[index];
    if (typeof head?.etag !== "string" || head.etag === "") return toolError(`not found: ${move.source}`);
    if (taken) return toolError(`conflict: destination already exists: ${move.destination}`);
    const visibility = narrowerVisibility(effectiveVisibility(move.source, rules, overrides), visibilityOf(move.destination, rules));
    lines.push(`- ${move.source} (etag ${head.etag}) → ${move.destination} [${visibility}]`);
  }
  return toolText(`preflight ok: ${moves.length} moves\n${lines.join("\n")}`);
}

/**
 * A keyed batch in a workspace whose notes live in its object: each note moved there, one object transaction
 * each, as `move_note` moves one (`objectMove.js`). The control plane's batch compares each version with its
 * own row, which carries the bucket's etag, while a listing or a dry run here hands out the object's
 * (`workspaceStore/rowVersions.js`), so every versioned batch it was sent answered "changed": @seyi's daily
 * housekeeping moved 0 of 105 notes that way, run after run (2026-11-04 to 2026-11-08).
 *
 * `null` sends the whole batch to the control plane as before: the object does not serve this caller, or it
 * left the first move to the control plane (`DEFER`), so nothing moved. Past the first, a move it refuses or
 * leaves stops the batch, and the answer names every move that landed, so nothing moved goes unsaid.
 */
async function objectBatchMove(store, scope, moves, versions, privacy) {
  if (!objectServesMoves(store, scope)) return null;
  const made = [];
  const files = [];
  // What landed is said once, however the batch ended (`afterObjectMoves`).
  const settle = async () => {
    if (made.length > 0) await afterObjectMoves(store, scope, { action: "move_notes", kind: "note", privacy, pairs: made, files });
  };
  for (const [index, move] of moves.entries()) {
    const result = await startObjectMove(store, scope, move.source, move.destination, versions[index], {
      kind: "note",
      action: "move_notes",
      privacy,
      quiet: true,
    });
    if (result === null && made.length === 0) return null;
    if (result === null || result.isError === true) {
      const why = result === null ? "that note has to move on its own; move it with move_note" : textOf(result).split("\n")[0];
      if (made.length === 0) return result;
      await settle();
      return toolError(
        `batch move partially applied: moved ${made.length} of ${moves.length}, then stopped at ${move.source}: ${why}\n` +
          made.map((pair) => `- ${pair.from} → ${pair.to}`).join("\n"),
      );
    }
    made.push({ from: result.from, to: result.to });
    files.push(...result.files);
  }
  await settle();
  return withActivityHint(
    toolText(`moved notes: ${made.length}\n` + made.map((pair) => `- ${pair.from} → ${pair.to}`).join("\n") + FOLLOWING_LINE),
    { moves: made },
  );
}

const textOf = (result) => (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");

export async function startKeyedBatchMove(store, scope, rules, overrides, moves) {
  if (typeof store.startMoveBatch !== "function") {
    return toolError("moving several notes in one call is not available in this workspace yet; move them one at a time");
  }
  const refusal = await keyedBatchRefusal(store, scope, rules, overrides, moves);
  if (refusal) return refusal;
  const versions = [];
  const checked = await inLanes(moves, (move) => rowVersionOf(store, move.source, move.expectedSourceEtag || undefined));
  for (const [index, move] of moves.entries()) {
    if (checked[index].conflict) return toolError(`conflict: ${move.source} changed since you read it; re-read and retry`);
    versions.push(checked[index].etag);
  }
  const inObject = await objectBatchMove(store, scope, moves, versions, { rules, overrides });
  if (inObject !== null) return inObject;
  let answer;
  try {
    answer = await store.startMoveBatch(
      moves.map((move, index) => ({
        from: move.source,
        to: move.destination,
        ...(versions[index] ? { expectedEtag: versions[index] } : {}),
      })),
    );
  } catch (error) {
    // A batch the gateway gave up waiting on may still land: the caller re-reads before sending it again.
    if (error?.reason === "timed out") {
      return toolError("the moves are taking longer than expected and may still finish; list the folder before sending any of them again");
    }
    return toolError("could not start the moves right now; try again in a moment");
  }
  if (!answer || answer.ok !== true) {
    if (typeof answer?.error !== "string") return toolError("could not start the moves right now; try again in a moment");
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the moves were refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  const pairs = moves.map((move) => ({ from: move.source, to: move.destination }));
  // Each moved note's open editor is told where it went (`keyedCollaboration.js`).
  await announceMoves(store, Array.isArray(answer.moves) ? answer.moves : pairs, { rules, overrides });
  await recordChange(store, "move_notes", scope, pairs.flatMap((pair) => [pair.from, pair.to]), { count: pairs.length, rowed: true });
  return withActivityHint(
    toolText(`moved notes: ${pairs.length}\n` + pairs.map((pair) => `- ${pair.from} → ${pair.to}`).join("\n") + FOLLOWING_LINE),
    { moves: pairs },
  );
}

export async function startQueuedFolderMove(store, scope, source, destination, privacy, { beforeControlPlane = null } = {}) {
  const inObject = await startObjectMove(store, scope, source, destination, undefined, { kind: "folder", action: "move_folder", privacy });
  if (inObject !== null) return inObject;
  // A check the caller left until the object had passed the move on (`keyedFolder.js`, the full twin check).
  if (typeof beforeControlPlane === "function") {
    const refusal = await beforeControlPlane();
    if (refusal) return toolError(refusal);
  }
  if (typeof store?.startQueuedMove !== "function") return null;
  let answer;
  try {
    answer = await store.startQueuedMove(source, destination);
  } catch (error) {
    // A folder move the gateway gave up waiting on may still be moving every note (93 notes took 9.2 s,
    // 2026-11-03): saying "nothing was changed", or moving it the old way on top, would both be wrong.
    if (error?.reason === "timed out") {
      return toolError(`the folder move is taking longer than expected and may still finish; list ${destination}/ before sending it again`);
    }
    // The control plane is out of reach: the caller decides what the old way does.
    return null;
  }
  if (!answer || answer.queued !== true) {
    if (typeof answer?.error !== "string") return null;
    if (answer.error === "FILE_NOT_FOUND") return toolError("not found");
    const message = typeof answer.message === "string" ? answer.message : "the move was refused";
    return toolError(answer.error === "DESTINATION_EXISTS" || answer.error === "CONFLICT" ? `conflict: ${message}` : message);
  }
  const count = Number.isInteger(answer.count) ? answer.count : 0;
  await announceRowedMoves(store, answer, source, destination, privacy);
  await recordChange(store, "move_folder", scope, [source, destination], { count, queued: true });
  // A keyed row move copies nothing, so there is no storage catching up to say.
  const note = answer.rowed === true
    ? "Every app shows it at the new name now." + FOLLOWING_LINE
    : "Every app shows it at the new name now; storage finishes copying in the background, and links to it are rewritten when that is done.";
  return withActivityHint(
    toolText(`moved folder: ${source}/ → ${destination}/ (${count} objects)\n` + note),
    { moves: [{ from: source, to: destination }] }
  );
}
