/** `move_notes` — a batch of moves, and the audit entry for one that stops part-way. */

import {
  archiveRoots,
  canSee,
  effectiveVisibility,
  hasOverride,
  isPlumbing,
  narrowerVisibility,
  visibilityOf,
} from "../../privacy/engine.js";
import { BATCH_MOVE_CAP } from "../../moves/limits.js";
import { clearExactVisibility, persistExactVisibility } from "../../privacy/state.js";
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
import { normalizePath } from "../../notes/paths.js";
import { probeWithLegacyFallback } from "../../notes/storage.js";
import { recordChange } from "../../activity/record.js";
import { recordForwarding } from "../../forwarding.js";
import { rewriteReferences } from "./references.js";
import { toolError, toolText, writePermissionError } from "../results.js";

export async function toolMoveNotes(store, scope, rules, overrides, movesArg, dryRun) {
  if (!Array.isArray(movesArg) || movesArg.length < 1) return toolError("moves must be a non-empty array");
  if (movesArg.length > BATCH_MOVE_CAP) {
    return toolError(`batch has more than ${BATCH_MOVE_CAP} moves; split it into smaller batches`);
  }

  const moves = [];
  for (const raw of movesArg) {
    const source = normalizePath(raw?.source);
    const destination = normalizePath(raw?.destination);
    if (!source || !destination || !source.endsWith(".md") || !destination.endsWith(".md")) {
      return toolError("invalid path (every source and destination must end in .md)");
    }
    if (source === destination) return toolError(`source and destination are the same: ${source}`);
    if (isPlumbing(source) || isPlumbing(destination)) return toolError("that path is reserved");
    moves.push({ source, destination, expectedSourceEtag: raw.expected_source_etag });
  }

  const sources = new Set(moves.map((move) => move.source));
  const destinations = new Set(moves.map((move) => move.destination));
  if (sources.size !== moves.length) return toolError("batch contains a duplicate source");
  if (destinations.size !== moves.length) return toolError("batch contains a duplicate destination");
  if (moves.some((move) => sources.has(move.destination))) {
    return toolError("batch destinations cannot also be batch sources; split cycles or chains into separate moves");
  }
  if (!dryRun && moves.some((move) => !move.expectedSourceEtag)) {
    return toolError(
      "expected_source_etag is required for every applied batch move. Run with dry_run=true to obtain current etags."
    );
  }
  if (!dryRun) {
    const unsafeMove = moveSafetyRefusal(store);
    if (unsafeMove) return toolError(unsafeMove);
  }

  const preflight = [];
  for (const move of moves) {
    /*
      Both questions asked, then decided. The batch form carries its own copy
      of `move_note`'s decision, so it needs its own copy of the equalising or
      the door closed there stands open here — a second route to a decision is
      a second place to make it wrong. `toolReadNote` argues the shape in full.

      A metadata probe rather than reusing the `get` below: that `get` buffers
      the whole object on S3 and Dropbox, and a source this caller may not see
      must not have its body pulled into the worker to refuse them. The cost is
      one extra metadata round trip per move in the batch, paid deliberately.

      Ahead of the destination checks, like `move_note`: a source the caller
      cannot see is "not found" whatever they aimed it at.
    */
    const sourceSeen = canSee(move.source, scope, rules, overrides);
    const sourcePresent = await probeWithLegacyFallback(store, move.source);
    if (!sourceSeen || !sourcePresent) return toolError(`not found: ${move.source}`);
    if (scope !== "private" && visibilityOf(move.destination, rules) !== "team") {
      return writePermissionError(`move destination ${move.destination}`);
    }
    if (scope === "team" && hasOverride(overrides, move.destination)) {
      return writePermissionError("move destination");
    }
    const sourceObject = await getWithLegacyFallback(store, move.source);
    if (!sourceObject) return toolError(`not found: ${move.source}`);
    const sourceText = await sourceObject.text();
    let collaborationBase = null;
    if (collaborationSupported(store) && !isEncryptedNote(sourceText) &&
        collaborationEligible(move.source, sourceText)) {
      if (store.capabilities?.conditionalDelete !== true) {
        const head = await collaborationHead(store, move.source);
        if (head?.status !== undefined && head.status !== "deleted") {
          return toolError(`this storage cannot safely move a collaboratively edited note: ${move.source}`);
        }
      } else {
        try {
          collaborationBase = await readCollaborationDocument(store, move.source);
        } catch {
          return toolError(`this note cannot be moved safely right now: ${move.source}`);
        }
      }
    }
    if (move.expectedSourceEtag && sourceObject.etag !== move.expectedSourceEtag &&
        collaborationBase?.etag !== move.expectedSourceEtag) {
      return toolError(
        `conflict: ${move.source} changed since it was read (current etag ${collaborationBase?.etag ?? sourceObject.etag})`
      );
    }
    const sourceVisibility = effectiveVisibility(move.source, rules, overrides);
    const destinationFolderVisibility = visibilityOf(move.destination, rules);
    // See `toolMoveNote`: the narrower of the two, so a batched move cannot
    // widen a note the single-note path would have held back.
    const destinationVisibility = narrowerVisibility(
      sourceVisibility,
      destinationFolderVisibility
    );
    // Both ends inside the *same* archive. Two different archive roots is a
    // move between folders that may have different visibility, which is exactly
    // what the slow path is for.
    const batchArchiveRoots = archiveRoots(rules);
    const sharedArchiveRoot = batchArchiveRoots.find(
      (root) =>
        move.source.startsWith(`${root}/`) && move.destination.startsWith(`${root}/`)
    );
    const fastArchiveCandidate =
      !collaborationBase &&
      sharedArchiveRoot !== undefined &&
      !hasOverride(overrides, move.source) &&
      sourceVisibility === destinationFolderVisibility;
    const destinationObject = await getWithLegacyFallback(store, move.destination);
    let preloadedBody = null;
    if (destinationObject) {
      if (collaborationBase) {
        return toolError(`conflict: destination already exists: ${move.destination}`);
      }
      const destinationText = await destinationObject.text();
      if (destinationText !== sourceText) {
        return toolError(`conflict: destination already exists with different content: ${move.destination}`);
      }
      if (fastArchiveCandidate) preloadedBody = sourceText;
    } else if (fastArchiveCandidate) {
      preloadedBody = new TextEncoder().encode(sourceText);
    }
    preflight.push({
      ...move,
      etag: collaborationBase?.etag ?? sourceObject.etag,
      rawEtag: sourceObject.etag,
      collaborationBase,
      visibility: destinationVisibility,
      destinationExists: Boolean(destinationObject),
      fastArchiveCandidate,
      body: preloadedBody,
    });
  }

  const planText = preflight
    .map(
      (move) =>
        `- ${move.source} (etag ${move.etag}) → ${move.destination} [${move.visibility}]`
    )
    .join("\n");
  if (dryRun) return toolText(`preflight ok: ${preflight.length} moves\n${planText}`);

  const fastArchiveRelocation = preflight.every((move) => move.fastArchiveCandidate);
  if (!fastArchiveRelocation) {
    for (const move of preflight) {
      if (move.collaborationBase) continue;
      const sourceObject = await getWithLegacyFallback(store, move.source);
      if (!sourceObject || sourceObject.etag !== move.rawEtag) {
        return toolError(`conflict: source changed during batch preflight: ${move.source}`);
      }
      move.body = await sourceObject.arrayBuffer();
    }
  }

  const copied = [];
  const preparedAcls = [];
  try {
    for (const move of preflight) {
      // Any narrowing, installed before the bytes — see `move_note` on why
      // this is `!== "team"` and why it persists the computed value.
      const preinstalledNarrowAcl =
        !fastArchiveRelocation && !move.destinationExists && move.visibility !== "team";
      if (preinstalledNarrowAcl) {
        await persistExactVisibility(store, move.destination, move.visibility, rules);
        preparedAcls.push(move.destination);
      }
      if (!move.destinationExists && !move.collaborationBase) {
        const put = await store.put(move.destination, move.body, { onlyIf: { absent: true } });
        if (!put) {
          if (preinstalledNarrowAcl) await clearExactVisibilityIfAbsent(store, move.destination);
          throw new Error(`destination already exists: ${move.destination}`);
        }
        move.destinationEtag = put.etag;
        move.destinationCreated = true;
        // Recorded the moment it exists, and BEFORE the visibility write that
        // can throw. The other order makes the one destination whose persist
        // failed the one destination the rollback below cannot see — so the
        // abort message says "aborted before deleting sources" over a copy that
        // is still there. Only a CAS exhaustion reaches it — a folded-twin
        // backstop briefly made it caller-reachable, and that backstop is not
        // in this change. The ordering is kept anyway: it is correct either
        // way, and it is what the refusals will need when they return.
        copied.push(move.destination);
      }
      if (!fastArchiveRelocation && move.visibility !== "team" && !preinstalledNarrowAcl) {
        await persistExactVisibility(store, move.destination, move.visibility, rules);
        preparedAcls.push(move.destination);
      }
      if (!fastArchiveRelocation && move.visibility === "team") {
        await persistExactVisibility(store, move.destination, "team", rules);
        preparedAcls.push(move.destination);
      }
    }
  } catch (error) {
    for (const move of preflight.filter((entry) => entry.destinationEtag)) {
      await deleteCreatedDestination(store, move.destination, move.destinationEtag);
    }
    for (const key of preparedAcls) await clearExactVisibilityIfAbsent(store, key);
    return toolError(`batch move aborted before deleting sources: ${error.message}`);
  }

  const appliedMoves = [];
  try {
    for (const move of preflight) {
      if (move.collaborationBase) {
        const moved = await moveCollaborationDocument(store, move.source, move.destination, {
          expectedEtag: move.collaborationBase.etag,
        });
        move.destinationEtag = moved.etag;
        move.destinationCreated = true;
      } else {
        const retired = await retireMovedSource(store, move.source, move.rawEtag);
        if (retired !== "retired") throw new Error(`source changed during cleanup: ${move.source}`);
      }
      appliedMoves.push(move);
    }
  } catch (error) {
    const failed = preflight[appliedMoves.length];
    if (failed?.collaborationBase) {
      failed.destinationCreated = Boolean(await getWithLegacyFallback(store, failed.destination));
    }
    await recordPartialMove(store, "move_notes", scope, preflight, appliedMoves);
    return toolError(
      `batch move partially applied; source cleanup stopped before all sources were deleted: ${error.message}`
    );
  }

  if (!fastArchiveRelocation) {
    for (const move of preflight) await clearExactVisibility(store, move.source).catch(() => {});
  }

  await recordForwarding(
    store,
    preflight.map((move) => ({ from: move.source, to: move.destination, kind: "note" }))
  );
  const references = await rewriteReferences(
    store,
    scope,
    rules,
    overrides,
    new Map(preflight.map((move) => [move.source, move.destination]))
  );
  await recordChange(
    store,
    "move_notes",
    scope,
    preflight.flatMap((move) => [move.source, move.destination]),
    {
      count: preflight.length,
      visibilities: preflight.map((move) => ({ path: move.destination, visibility: move.visibility })),
      team_visible: preflight.every((move) => move.visibility === "team"),
      references: references.capped ? "not-rewritten" : references.links,
    }
  );
  return toolText(`moved notes: ${preflight.length}\n${planText}` + referencesLine(references));
}

export async function recordPartialMove(store, action, scope, planned, applied) {
  const appliedSources = new Set(applied.map((move) => move.source));
  const incomplete = planned.filter(
    (move) => !appliedSources.has(move.source) && move.destinationCreated,
  );
  const strandedCopies = incomplete.filter((move) => move.destinationCreated);
  await recordChange(
    store,
    action,
    scope,
    [
      ...applied.flatMap((move) => [move.source, move.destination]),
      ...incomplete.map((move) => move.destination),
    ],
    {
      partial: true,
      moved: applied.length,
      planned: planned.length,
      copies_without_source_removed: strandedCopies.length,
      team_visible: planned.every((move) => move.visibility === "team"),
    },
  );
}
