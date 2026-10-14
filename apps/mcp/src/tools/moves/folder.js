/**
 * `move_folder`: queued in the control plane (`queuedFolder.js`), or, for a
 * folder of up to `LOGICAL_FOLDER_MOVE_THRESHOLD` objects the queue declines,
 * moved here in one go. A larger folder the queue declines is refused: the
 * old-style move job under `.context/moves/` that used to carry it is gone
 * (2026-10-13), so nothing reads move jobs on the way to a note any more.
 */

import { withActivityHint } from "../../live/activityHint.js";
import {
  canSee,
  effectiveVisibility,
  hasOverride,
  isPlumbing,
  narrowerVisibility,
  visibilityOf,
} from "../../privacy/engine.js";
import { clearExactVisibility, persistExactVisibility } from "../../privacy/state.js";
import {
  clearExactVisibilityIfAbsent,
  deleteCreatedDestination,
  moveSafetyRefusal,
  referencesLine,
  retireMovedSource,
} from "../../moves/objects.js";
import { nameTwinRefusal, protectedFolderRefusal } from "../../tree/twins.js";
import {
  eligible as collaborationEligible,
  supported as collaborationSupported,
  moveDocument as moveCollaborationDocument,
  readDocument as readCollaborationDocument,
} from "@context/collaboration";
import { collaborationHead } from "../../live/collaborationHttp.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { isEncryptedNote } from "../../encryption.js";
import { listAllKeys } from "../../notes/storage.js";
import { servedListingStore, TreeUnavailable } from "../../tree/served.js";
import { LOGICAL_FOLDER_MOVE_THRESHOLD } from "../../moves/limits.js";
import { startQueuedFolderMove } from "./queuedFolder.js";
import { normalizePath } from "../../notes/paths.js";
import { pruneEmptyFolders } from "../../store/index.js";
import { recordChange } from "../../activity/record.js";
import { recordForwarding } from "../../forwarding.js";
import { remapFolderIcons } from "../../../../../packages/shared/src/folderIcons.cjs";
import { recordPartialMove } from "./notes.js";
import { rewriteReferencesAfterMove } from "./references.js";
import { toolError, toolText, writePermissionError } from "../results.js";

export async function toolMoveFolder(store, scope, rules, overrides, sourceArg, destinationArg, dryRun) {
  const source = normalizePath(sourceArg)?.replace(/\/+$/, "");
  const destination = normalizePath(destinationArg)?.replace(/\/+$/, "");
  if (!source || !destination) return toolError("invalid folder path");
  if (source === destination) return toolText("source and destination are the same");
  if (
    isPlumbing(source) ||
    isPlumbing(destination) ||
    source.startsWith(destination + "/") ||
    destination.startsWith(source + "/")
  ) {
    return toolError("source and destination folders must be separate, non-reserved trees");
  }
  // The folder playing a built-in role stays where every client expects it
  // (folderRoles.cjs); a duplicate of it is an ordinary folder, and the new
  // name may not twin a sibling (`tree/twins.js`). Both read the tree.
  const locked = await protectedFolderRefusal(store, scope, rules, overrides, source);
  if (locked) return toolError(locked);
  const twin = await nameTwinRefusal(store, scope, rules, overrides, destination, { kind: "folder", ignore: source });
  if (twin) return toolError(twin);

  // Queued where the control plane takes it: one step, however big the folder.
  if (!dryRun) {
    const queued = await startQueuedFolderMove(store, scope, source, destination);
    if (queued !== null) return queued;
  }

  const sourcePrefix = `${source}/`;
  const destinationPrefix = `${destination}/`;
  // Invisible content is filtered out, not refused on.
  //
  // Refusing the whole move because the tree contains something this
  // connection cannot see reports a fact about content the connection is not
  // allowed to know exists. With dry_run it costs nothing to ask, so a team
  // caller could walk the tree and separate "folder I can move" from "folder
  // with a private note in it" from "folder that does not exist" — localising
  // every private note to its containing folder without reading one. SECURITY.md
  // counts inference as a privacy-tier bypass in its own right.
  //
  // Filtering is also what `move_notes` already does with the same paths: a
  // team caller naming each visible note explicitly moves exactly these
  // objects and leaves the private ones behind. move_folder is the bulk
  // spelling of that operation, so it behaves the same way rather than
  // becoming the one tool that answers a question the others refuse.
  // A dry run answers from the Convex tree (`tree/served.js`), and says so
  // where the tree cannot answer yet; it never lists the bucket. A real move
  // in one go lists the bucket it is about to change: an agent's note written
  // a moment ago reaches the tree a second later, and a move that listed the
  // tree would leave it behind.
  const lister = dryRun ? servedListingStore(store) : store;
  let listed;
  try {
    listed = await listAllKeys(lister, sourcePrefix);
  } catch (error) {
    if (error instanceof TreeUnavailable) return toolError(error.message);
    throw error;
  }
  const allObjects = listed
    .filter(({ key }) => !isPlumbing(key))
    .filter(({ key }) => canSee(key, scope, rules, overrides));
  // A folder holding nothing this caller can see is "not found" — byte-identical
  // to a folder that was never there.
  if (!allObjects.length) return toolError("not found");
  if (allObjects.length > LOGICAL_FOLDER_MOVE_THRESHOLD) {
    if (scope !== "private") {
      return toolError(
        `folder has more than ${LOGICAL_FOLDER_MOVE_THRESHOLD} visible objects; large logical folder moves require owner access`
      );
    }
    if (dryRun) {
      const destinationObjects = await listAllKeys(lister, destinationPrefix);
      if (destinationObjects.some(({ key }) => !isPlumbing(key))) {
        return toolError(`conflict: destination already contains objects: ${destination}/`);
      }
      return toolText(
        `preflight ok: large folder ${source}/ → ${destination}/ (${allObjects.length} objects)\n` +
          "apply will queue the move: every app shows the folder at its new name at once, and storage copies behind"
      );
    }
    // The queue declined it above. A folder this large is never moved in one
    // go, so the answer is to wait, not a move job in the bucket.
    return toolError(
      `could not queue this move right now: a folder of more than ${LOGICAL_FOLDER_MOVE_THRESHOLD} objects moves ` +
        "through the queue, which did not take it (the workspace may still be loading, or another move is being set up). " +
        "Try again in a minute, or move it from the Context app."
    );
  }

  const moves = allObjects.map(({ key }) => {
    const destinationPath = destinationPrefix + key.slice(sourcePrefix.length);
    const sourceVisibility = effectiveVisibility(key, rules, overrides);
    // See `toolMoveNote`: the narrower of the two, so a folder move cannot
    // widen a note inside it.
    const destinationVisibility = narrowerVisibility(
      sourceVisibility,
      visibilityOf(destinationPath, rules)
    );
    return { source: key, destination: destinationPath, visibility: destinationVisibility };
  });
  if (
    scope !== "private" &&
    moves.some(({ destination: path }) => visibilityOf(path, rules) !== "team")
  ) {
    return writePermissionError("folder move destination");
  }
  if (scope === "team" && moves.some(({ destination: path }) => hasOverride(overrides, path))) {
    return writePermissionError("folder move destination");
  }
  if (!dryRun) {
    const unsafeMove = moveSafetyRefusal(store);
    if (unsafeMove) return toolError(unsafeMove);
  }
  for (const move of moves) {
    if (await getWithLegacyFallback(store, move.destination)) {
      return toolError(`conflict: destination already exists: ${move.destination}`);
    }
  }

  if (dryRun) {
    return toolText(
      `preflight ok: folder ${source}/ → ${destination}/ (${moves.length} objects)\n` +
        moves
          .map((move) => `- ${move.source} → ${move.destination} [${move.visibility}]`)
          .join("\n")
    );
  }

  // Capture every source before the first destination is created. Eligible
  // notes move through the collaboration lifecycle with the exact revision
  // this preflight read; binary, encrypted, and unsupported files retain the
  // existing raw copy/delete path.
  for (const move of moves) {
    const object = await getWithLegacyFallback(store, move.source);
    if (!object) return toolError(`source changed during move: ${move.source}`);
    move.rawEtag = object.etag;
    if (move.source.endsWith(".md")) {
      const sourceText = await object.text();
      if (collaborationSupported(store) && !isEncryptedNote(sourceText) &&
          collaborationEligible(move.source, sourceText)) {
        const head = await collaborationHead(store, move.source);
        if (head?.status && head.status !== "active") {
          return toolError(`this note cannot be moved safely right now: ${move.source}`);
        }
        if (head || store.capabilities?.conditionalDelete === true) {
          try {
            move.collaborationBase = await readCollaborationDocument(store, move.source);
          } catch {
            return toolError(`this note cannot be moved safely right now: ${move.source}`);
          }
        } else {
          move.body = new TextEncoder().encode(sourceText);
        }
      } else {
        move.body = new TextEncoder().encode(sourceText);
      }
    } else {
      move.body = await object.arrayBuffer();
    }
  }

  const copied = [];
  const preparedAcls = [];
  // Bodies are not retained. They were, to feed the `.history/` snapshot loop
  // that ran after this one, which meant a whole folder tree sat in a Worker's
  // 128MB heap at once. Sources are deleted only after every copy has landed,
  // so the rollback below deletes copies rather than restoring originals and
  // needs nothing kept.
  try {
    for (const move of moves) {
      if (!move.collaborationBase) {
        const object = await getWithLegacyFallback(store, move.source);
        if (!object || object.etag !== move.rawEtag) {
          throw new Error(`source changed during move: ${move.source}`);
        }
      }
      // See `move_note`: any narrowing, installed first, at its own value.
      const preinstalledNarrowAcl = move.visibility !== "team";
      if (preinstalledNarrowAcl) {
        await persistExactVisibility(store, move.destination, move.visibility, rules);
        preparedAcls.push(move.destination);
      }
      if (!move.collaborationBase) {
        const put = await store.put(move.destination, move.body, { onlyIf: { absent: true } });
        if (!put) {
          if (preinstalledNarrowAcl) await clearExactVisibilityIfAbsent(store, move.destination);
          throw new Error(`destination already exists: ${move.destination}`);
        }
        move.destinationEtag = put.etag;
        move.destinationCreated = true;
        // Before the visibility write that can throw — see `move_notes` above.
        copied.push(move.destination);
      }
      if (move.visibility === "team") {
        await persistExactVisibility(store, move.destination, "team", rules);
        preparedAcls.push(move.destination);
      }
    }
  } catch (error) {
    for (const move of moves.filter((entry) => entry.destinationEtag)) {
      await deleteCreatedDestination(store, move.destination, move.destinationEtag);
    }
    for (const key of preparedAcls) await clearExactVisibilityIfAbsent(store, key);
    return toolError(`move aborted before deleting sources: ${error.message}`);
  }

  const appliedFolderMoves = [];
  for (const move of moves) {
    try {
      if (move.collaborationBase) {
        const moved = await moveCollaborationDocument(store, move.source, move.destination, {
          expectedEtag: move.collaborationBase.etag,
        });
        move.destinationEtag = moved.etag;
        move.destinationCreated = true;
      } else {
        const retired = await retireMovedSource(store, move.source, move.rawEtag);
        if (retired !== "retired") throw new Error(`source changed before cleanup: ${move.source}`);
      }
      appliedFolderMoves.push(move);
    } catch {
      if (move.collaborationBase) {
        move.destinationCreated = Boolean(await getWithLegacyFallback(store, move.destination));
      }
      await recordPartialMove(store, "move_folder", scope, moves, appliedFolderMoves);
      return toolError(
        `folder move partially applied; source cleanup stopped before all sources were deleted: ${move.source}`
      );
    }
  }
  for (const { source: path } of moves) await clearExactVisibility(store, path).catch(() => {});
  /*
    The folder itself, on a backend that has one.

    Every other adapter here has no folders to remove — a prefix with no keys
    under it is gone — but Dropbox does, so the notes arrived at the new name
    and the old folder went on being listed beside them. That is a folder move
    that reads as a copy, and it read that way on exactly one backend.

    `destination` is kept explicitly: a move *into* a subfolder of the source's
    parent must not have its own destination tidied out from under it.
  */
  await pruneEmptyFolders(
    store,
    moves.map((move) => move.source),
    { roots: [source], keep: [destination] }
  );
  await recordForwarding(store, [{ from: source, to: destination, kind: "folder" }]);
  // A folder icon follows its folder (`folderIcons.cjs`); never fails the move.
  await remapFolderIcons(store, source, destination);
  const references = await rewriteReferencesAfterMove(
    store,
    scope,
    rules,
    overrides,
    new Map(moves.map((move) => [move.source, move.destination]))
  );
  await recordChange(store, "move_folder", scope, [source, destination], {
    count: moves.length,
    visibilities: moves.map((move) => ({ path: move.destination, visibility: move.visibility })),
    team_visible: moves.every((move) => move.visibility === "team"),
    references: references.capped ? "not-rewritten" : references.links,
  });
  return withActivityHint(toolText(
    `moved folder: ${source}/ → ${destination}/ (${moves.length} objects)` +
      referencesLine(references)
  ), { moves: moves.map((move) => ({ from: move.source, to: move.destination })) });
}
