/**
 * `move_folder`, and the logical folder move it starts for a large folder:
 * the privacy rules re-pointed first, the objects materialized after.
 */

import {
  canSee,
  effectiveVisibility,
  hasOverride,
  isPlumbing,
  narrowerVisibility,
  PRIVACY_KEY,
  PrivacyOverrides,
  replacePrivacyRulesBlock,
  visibilityOf,
} from "../../privacy/engine.js";
import { clearExactVisibility, loadPrivacyState, persistExactVisibility } from "../../privacy/state.js";
import {
  clearExactVisibilityIfAbsent,
  deleteCreatedDestination,
  moveSafetyRefusal,
  referencesLine,
  retireMovedSource,
} from "../../moves/objects.js";
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
import { LOGICAL_FOLDER_MOVE_THRESHOLD, MOVE_JOB_VERSION } from "../../moves/limits.js";
import { materializeMoveInBackground } from "./materialize.js";
import { moveJobKey, writeMoveSentinel } from "../../moves/jobs.js";
import { normalizePath } from "../../notes/paths.js";
import { pruneEmptyFolders } from "../../store/index.js";
import { recordChange } from "../../activity/record.js";
import { recordForwarding } from "../../forwarding.js";
import { recordPartialMove } from "./notes.js";
import { rewriteReferences } from "./references.js";
import { toolError, toolText, writePermissionError } from "../results.js";

async function persistPrivacyFolderMove(store, source, destination) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await loadPrivacyState(store);
    if (state.error) throw new Error(`privacy manifest invalid: ${state.error}`);
    if (state.legacy) {
      throw new Error("large folder moves require a current privacy.md manifest");
    }
    const movePrefix = (path) => {
      if (path === source) return destination;
      if (path.startsWith(`${source}/`)) return `${destination}/${path.slice(source.length + 1)}`;
      return path;
    };
    const rules = state.rules.filter(
      (rule) => !(rule.prefix === destination || rule.prefix.startsWith(`${destination}/`))
    );
    for (const rule of state.rules) {
      if (rule.prefix === source || rule.prefix.startsWith(`${source}/`)) {
        rules.push({ ...rule, prefix: movePrefix(rule.prefix) });
      }
    }
    /*
      The folder's own EFFECTIVE visibility, carried as one rule.

      Everything above moves what `privacy.md` NAMES — a rule on the source
      folder or inside it, an override on a note. That is complete for a folder
      that declares itself and for a note with its own exception, and it
      carries nothing at all for the ordinary case: `visibilityOf` is
      longest-prefix, so a folder private because an ANCESTOR says so is named
      nowhere, and neither are the notes under it.

      Without this, such a tree landed on the destination's rule and was
      published — the same defect the control plane's `movePath` had, where the
      exception half was carried and the inherited half was not. `toolMoveFolder`
      computes the narrower value per note and never reaches this function; a
      folder one object larger took this path instead and got a different
      answer for the same notes.

      One rule, not one exception per note: a folder operation should leave a
      folder-shaped manifest, and 500 generated lines would be unreadable to
      the owner who opens `privacy.md` in Obsidian. Per-note overrides still
      win over it, so a note the owner deliberately published travels as
      published — checked, because narrowing that would be this fix committing
      the opposite error.
    */
    const sourceVisibility = visibilityOf(source, state.rules);
    // Read AFTER the loop above, so a rule the source folder declared for
    // itself has already been carried here and is what this compares against.
    // That is also why no "did the folder declare itself?" guard is needed: in
    // that case the carried rule IS the destination's visibility, the two
    // values are equal, and the test below does not fire. An explicit guard
    // was written first and sabotage put it at 0 — correctly redundant rather
    // than unheld, so it is gone rather than shipped unchecked.
    const destinationVisibility = visibilityOf(destination, rules);
    const narrowed = narrowerVisibility(sourceVisibility, destinationVisibility);
    if (narrowed !== destinationVisibility) {
      rules.push({ prefix: destination, vis: narrowed });
    }
    const overrides = new PrivacyOverrides();
    for (const [path, visibility] of state.overrides.entries()) {
      if (path === destination || path.startsWith(`${destination}/`)) continue;
      overrides.set(path, visibility);
      if (path === source || path.startsWith(`${source}/`)) {
        overrides.set(movePrefix(path), visibility);
      }
    }
    const next = replacePrivacyRulesBlock(state.text, rules, overrides);
    const put = await store.put(PRIVACY_KEY, next, { onlyIf: { etagMatches: state.object.etag } });
    if (put) return;
  }
  throw new Error("privacy manifest changed concurrently; retry the operation");
}

async function createLogicalFolderMove(store, scope, source, destination, objects) {
  if (scope !== "private") {
    return toolError(
      `folder has more than ${LOGICAL_FOLDER_MOVE_THRESHOLD} visible objects; large logical folder moves require owner access`
    );
  }
  const unsafeMove = moveSafetyRefusal(store);
  if (unsafeMove) return toolError(unsafeMove);
  const destinationPrefix = `${destination}/`;
  const destinationObjects = await listAllKeys(store, destinationPrefix);
  const visibleConflicts = destinationObjects.filter(({ key }) => !isPlumbing(key));
  if (visibleConflicts.length) {
    return toolError(`conflict: destination already contains objects: ${destination}/`);
  }
  await persistPrivacyFolderMove(store, source, destination);
  // At the logical cutover, not when the copy finishes: the folder reads as
  // moved from here on, so a link that arrives in between must forward too.
  // One folder entry covers every object under it — see `forwarding.js`.
  await recordForwarding(store, [{ from: source, to: destination, kind: "folder" }]);
  const now = new Date().toISOString();
  const id = `move-${crypto.randomUUID()}`;
  const job = {
    version: MOVE_JOB_VERSION,
    id,
    status: "logical_active",
    source,
    destination,
    created_at: now,
    updated_at: now,
    total_objects: objects.length,
    copied_objects: 0,
    deleted_objects: 0,
    copied: [],
    objects: objects.map(({ key, etag, size }) => ({
      source: key,
      destination: `${destination}/${key.slice(source.length + 1)}`,
      etag,
      size,
    })),
    error: null,
  };
  await store.put(moveJobKey(id), JSON.stringify(job, null, 2));
  await writeMoveSentinel(store);
  if (typeof store.enqueueGatewayJob === "function") {
    try {
      await store.enqueueGatewayJob({ kind: "materialize_move", moveId: id });
    } catch {
      // The on-bucket marker is the source of truth. Queueing is what makes the
      // move autonomous, but a control-plane blip must not roll back the
      // logical cutover; the owner can still resume with `materialize_move`.
    }
  }
  if (typeof store.defer === "function") {
    try {
      store.defer(() => materializeMoveInBackground(store, scope, id));
    } catch {
      // The logical marker is the durable handoff. A host that cannot keep
      // background work alive leaves the move resumable by `materialize_move`.
    }
  }
  await recordChange(store, "move_folder", scope, [source, destination], {
    count: objects.length,
    logical_move: id,
    status: "logical_active",
    references: "pending",
  });
  return toolText(
    `logical move active: ${source}/ → ${destination}/ (${objects.length} objects)\n` +
      `move_id: ${id}\nphysical storage sync: pending\nreferences: pending`
  );
}

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
  const allObjects = (await listAllKeys(store, sourcePrefix))
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
    const destinationObjects = await listAllKeys(store, destinationPrefix);
    if (destinationObjects.some(({ key }) => !isPlumbing(key))) {
      return toolError(`conflict: destination already contains objects: ${destination}/`);
    }
    if (collaborationSupported(store)) {
      for (const { key } of allObjects) {
        if (key.endsWith(".md") && await collaborationHead(store, key)) {
          return toolError(
            "large logical folder move is unavailable while the folder contains an active collaborative note; move it in smaller batches",
          );
        }
      }
    }
    if (dryRun) {
      return toolText(
        `preflight ok: large folder ${source}/ → ${destination}/ (${allObjects.length} objects)\n` +
          "apply will create a logical move immediately; physical storage sync remains pending"
      );
    }
    return createLogicalFolderMove(store, scope, source, destination, allObjects);
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
        if (store.capabilities?.conditionalDelete !== true) {
          const head = await collaborationHead(store, move.source);
          if (head?.status !== undefined && head.status !== "deleted") {
            return toolError(`this storage cannot safely move a collaboratively edited note: ${move.source}`);
          }
          move.body = new TextEncoder().encode(sourceText);
        } else {
          try {
            move.collaborationBase = await readCollaborationDocument(store, move.source);
          } catch {
            return toolError(`this note cannot be moved safely right now: ${move.source}`);
          }
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
  const references = await rewriteReferences(
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
  return toolText(
    `moved folder: ${source}/ → ${destination}/ (${moves.length} objects)` +
      referencesLine(references)
  );
}
