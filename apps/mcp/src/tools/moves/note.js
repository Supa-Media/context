/** `move_note` within one context. */

import { versionMatches } from "../../notes/version.js";
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
import { remapIcons } from "../../../../../packages/shared/src/folderIcons.cjs";
import { rewriteReferencesAfterMove } from "./references.js";
import { destinationRefusal } from "./destination.js";
import { nameTwinRefusal } from "../../tree/twins.js";
import { toolError, toolText, writePermissionError } from "../results.js";
import { startKeyedNoteMove } from "./queuedFolder.js";

export async function toolMoveNote(store, scope, rules, overrides, sourceArg, destinationArg, expectedSourceEtag) {
  const source = normalizePath(sourceArg);
  const destination = normalizePath(destinationArg);
  if (!source || !destination || !source.endsWith(".md") || !destination.endsWith(".md")) {
    return toolError("invalid path (source and destination must end in .md)");
  }
  if (source === destination) return toolText("source and destination are the same");
  if (isPlumbing(source) || isPlumbing(destination)) return toolError("that path is reserved");
  // Both questions asked, then decided, so refusing a source this caller may
  // not see costs what refusing an absent one costs; on metadata, so no
  // unreadable body is pulled in to refuse. `toolReadNote` argues it in full.
  // It stays ahead of the destination checks: a source the caller cannot see
  // is "not found" whatever they aimed it at.
  const sourceSeen = canSee(source, scope, rules, overrides);
  const sourcePresent = await probeWithLegacyFallback(store, source);
  if (!sourceSeen || !sourcePresent) return toolError("not found");
  if (scope !== "private" && visibilityOf(destination, rules) !== "team") {
    return writePermissionError("move destination");
  }
  if (scope === "team" && hasOverride(overrides, destination)) {
    return writePermissionError("move destination");
  }

  // A keyed workspace moves the note's row and never its bytes (`queuedFolder.js`): asked of the control plane first.
  const keyedMove = await startKeyedNoteMove(store, scope, source, destination, expectedSourceEtag, { rules, overrides });
  if (keyedMove !== null) return keyedMove;
  const sourceObject = await getWithLegacyFallback(store, source);
  if (!sourceObject) return toolError("not found");
  const sourceText = await sourceObject.text();
  let collaborationBase = null;
  if (collaborationSupported(store) && !isEncryptedNote(sourceText) &&
      collaborationEligible(source, sourceText)) {
    const head = await collaborationHead(store, source);
    if (head?.status && head.status !== "active") {
      return toolError("this note cannot be moved safely right now; re-read and retry");
    }
    if (head || store.capabilities?.conditionalDelete === true) {
      try {
        collaborationBase = await readCollaborationDocument(store, source);
      } catch {
        return toolError("this note cannot be moved safely right now; re-read and retry");
      }
    }
  }
  const currentSourceEtag = collaborationBase?.etag ?? sourceObject.etag;
  if (expectedSourceEtag && !versionMatches(expectedSourceEtag, { document: collaborationBase, rawEtag: sourceObject.etag })) {
    return toolError(
      `conflict: source changed since you read it (current etag ${currentSourceEtag}); re-read and retry`
    );
  }
  const unsafeMove = moveSafetyRefusal(store);
  if (unsafeMove) return toolError(unsafeMove);
  // Asked of the Convex tree (`tree/names.js`); the put below is
  // `onlyIf: { absent: true }`, the truth for a note the tree has not heard of yet.
  const destinationTaken = await destinationRefusal(store, destination);
  if (destinationTaken) return destinationTaken;
  const twin = await nameTwinRefusal(store, scope, rules, overrides, destination, { ignore: source });
  if (twin) return toolError(twin);

  const body = new TextEncoder().encode(sourceText);
  const sourceEtag = sourceObject.etag;
  const sourceVisibility = effectiveVisibility(source, rules, overrides);
  // The narrower of what the note is and what the destination folder grants.
  // Identical to the old "private if either is private, else team" on the two
  // tiers, and it is what stops a move *widening*: a note held back to a group
  // that lands in a team folder used to come out `team`, which published it.
  const destinationVisibility = narrowerVisibility(
    sourceVisibility,
    visibilityOf(destination, rules)
  );

  if (collaborationBase) {
    if (destinationVisibility !== "team") {
      try {
        await persistExactVisibility(store, destination, destinationVisibility, rules);
      } catch (error) {
        return toolError(`move aborted before tightening destination: ${error.message}`);
      }
    }
    let moved;
    try {
      moved = await moveCollaborationDocument(store, source, destination, {
        expectedEtag: collaborationBase.etag,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      // A destination the tree had not heard of yet, refused by the conditional write.
      if (code === "DESTINATION_EXISTS") return toolError("conflict: destination already exists");
      if (["CONFLICT", "BASE_MISSING", "GENERATION_MISMATCH"].includes(code)) {
        return toolError("conflict: source changed since it was read; re-read and retry");
      }
      return toolError("this note's move transition could not finish safely; re-read it and retry");
    }
    if (destinationVisibility === "team") {
      try {
        await persistExactVisibility(store, destination, "team", rules);
      } catch {
        return toolError("move completed, but its visibility could not be recorded; ask the owner to repair the destination rule");
      }
    }
    await clearExactVisibility(store, source);
    await recordForwarding(store, [{ from: source, to: destination, kind: "note" }]);
    // A note's icon follows it (`folderIcons.cjs`); never fails the move.
    await remapIcons(store, [{ from: source, to: destination }]);
    const references = await rewriteReferencesAfterMove(store, scope, rules, overrides, new Map([[source, destination]]));
    await recordChange(store, "move_note", scope, [source, destination], {
      etag: moved.etag,
      visibility: destinationVisibility,
      team_visible: sourceVisibility === "team" && destinationVisibility === "team",
      source_visibility: sourceVisibility,
      references: references.capped ? "not-rewritten" : references.links,
    });
    return withActivityHint(toolText(
      `moved: ${source} → ${destination} (etag ${moved.etag})\nvisibility: ${destinationVisibility}` +
        referencesLine(references)
    ), { moves: [{ from: source, to: destination }] });
  }

  // `!== "team"` rather than `=== "private"`, and the computed value rather
  // than the literal. Both halves matter: a group destination is a narrowing,
  // so it must be installed BEFORE the bytes land like any other narrowing —
  // and writing `"private"` here would silently retier the owner's group rule
  // on every move. Neither branch firing at all was the first version of this
  // and left the note on its new folder's default, which is exactly the
  // publication the narrowing was computed to prevent.
  if (destinationVisibility !== "team") {
    try {
      await persistExactVisibility(store, destination, destinationVisibility, rules);
    } catch (error) {
      return toolError(`move aborted before tightening destination: ${error.message}`);
    }
  }
  const put = await store.put(destination, body, { onlyIf: { absent: true } });
  if (!put && destinationVisibility !== "team") await clearExactVisibilityIfAbsent(store, destination);
  if (!put) return toolError("conflict: destination already exists");
  try {
    if (destinationVisibility === "team") {
      await persistExactVisibility(store, destination, "team", rules);
    }
  } catch (error) {
    await deleteCreatedDestination(store, destination, put.etag);
    return toolError(`move aborted before deleting source: ${error.message}`);
  }
  const retired = await retireMovedSource(store, source, sourceEtag);
  if (retired !== "retired") {
    await deleteCreatedDestination(store, destination, put.etag);
    return toolError("conflict: source changed since it was copied");
  }
  await clearExactVisibility(store, source);
  await recordForwarding(store, [{ from: source, to: destination, kind: "note" }]);
  // A note's icon follows it (`folderIcons.cjs`); never fails the move.
  await remapIcons(store, [{ from: source, to: destination }]);
  const references = await rewriteReferencesAfterMove(
    store,
    scope,
    rules,
    overrides,
    new Map([[source, destination]])
  );
  await recordChange(store, "move_note", scope, [source, destination], {
    etag: put.etag,
    visibility: destinationVisibility,
    team_visible: sourceVisibility === "team" && destinationVisibility === "team",
    source_visibility: sourceVisibility,
    references: references.capped ? "not-rewritten" : references.links,
  });
  return withActivityHint(toolText(
    `moved: ${source} → ${destination} (etag ${put.etag})\nvisibility: ${destinationVisibility}` +
      referencesLine(references)
  ), { moves: [{ from: source, to: destination }] });
}
