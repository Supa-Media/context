/** `move_note` from one context to another the caller can write. */

import {
  canSee,
  effectiveVisibility,
  hasOverride,
  isPlumbing,
  visibilityOf,
} from "../../privacy/engine.js";
import { clearExactVisibility, loadPrivacyState, persistExactVisibility } from "../../privacy/state.js";
import { clearExactVisibilityIfAbsent, deleteCreatedDestination, retireMovedSource } from "../../moves/objects.js";
import {
  eligible as collaborationEligible,
  supported as collaborationSupported,
  readDocument as readCollaborationDocument,
  tombstoneDocument as tombstoneCollaborationDocument,
} from "@context/collaboration";
import { collaborationHead } from "../../live/collaborationHttp.js";
import { contextNameFor } from "../../context/identity.js";
import { isEncryptedNote } from "../../encryption.js";
import { normalizePath } from "../../notes/paths.js";
import { recordChange } from "../../activity/record.js";
import { toolError, toolText, writePermissionError } from "../results.js";

export async function toolMoveNoteAcrossContexts(
  sourceStore,
  sourceSession,
  destinationStore,
  destinationSession,
  sourceArg,
  destinationArg,
  expectedSourceEtag,
  confirmTeamPublish
) {
  const source = normalizePath(sourceArg);
  const destination = normalizePath(destinationArg);
  if (!source || !destination || !source.endsWith(".md") || !destination.endsWith(".md")) {
    return toolError("invalid path (source and destination must end in .md)");
  }
  if (isPlumbing(source) || isPlumbing(destination)) return toolError("that path is reserved");

  const sourcePrivacy = await loadPrivacyState(sourceStore);
  if (sourcePrivacy.error) {
    return toolError(
      `source privacy manifest invalid; access failed closed without exposing content: ${sourcePrivacy.error}`
    );
  }
  const destinationPrivacy = await loadPrivacyState(destinationStore);
  if (destinationPrivacy.error) {
    return toolError(
      `destination privacy manifest invalid; access failed closed without exposing content: ${destinationPrivacy.error}`
    );
  }

  const sourceScope = sourceSession.scope;
  const destinationScope = destinationSession.scope;
  if (!canSee(source, sourceScope, sourcePrivacy.rules, sourcePrivacy.overrides)) {
    return toolError("not found");
  }
  if (destinationScope !== "private" && visibilityOf(destination, destinationPrivacy.rules) !== "team") {
    return writePermissionError("move destination");
  }
  if (destinationScope === "team" && hasOverride(destinationPrivacy.overrides, destination)) {
    return writePermissionError("move destination");
  }

  const sourceObject = await sourceStore.get(source);
  if (!sourceObject) return toolError("not found");
  const sourceText = await sourceObject.text();
  let collaborationBase = null;
  if (collaborationSupported(sourceStore) && !isEncryptedNote(sourceText) &&
      collaborationEligible(source, sourceText)) {
    if (sourceStore.capabilities?.conditionalDelete !== true) {
      const head = await collaborationHead(sourceStore, source);
      if (head?.status !== undefined && head.status !== "deleted") {
        return toolError("this storage cannot safely move a collaboratively edited note");
      }
    } else {
      try {
        collaborationBase = await readCollaborationDocument(sourceStore, source);
      } catch {
        return toolError("this note cannot be moved safely right now; re-read and retry");
      }
    }
  }
  if (expectedSourceEtag && sourceObject.etag !== expectedSourceEtag &&
      collaborationBase?.etag !== expectedSourceEtag) {
    return toolError(
      `conflict: source changed since you read it (current etag ${collaborationBase?.etag ?? sourceObject.etag}); re-read and retry`
    );
  }
  // The source's half of a cross-workspace move is retiring one object, so it
  // needs a guard for that and nothing else. `moveSafetyRefusal` would also
  // demand `conditionalCreate` here, which the source never uses — the trash
  // copy is written only-if-absent but is explicitly optional — and requiring
  // it would refuse a move for a capability that is not on this side's path.
  if (
    !sourceStore?.capabilities?.conditionalDelete &&
    !sourceStore?.capabilities?.conditionalWrite
  ) {
    return toolError(
      "move requires a source storage provider that supports conditional delete or conditional write"
    );
  }
  if (!destinationStore?.capabilities?.conditionalCreate) {
    return toolError("move requires a destination storage provider that supports conditional create");
  }
  // The destination's guard is about rolling *back*: an aborted move has to be
  // able to take its own half-written destination away again, or the note ends
  // up in two workspaces. Either conditional will do, exactly as on the source.
  if (
    !destinationStore?.capabilities?.conditionalDelete &&
    !destinationStore?.capabilities?.conditionalWrite
  ) {
    return toolError(
      "move requires a destination storage provider that supports conditional delete or conditional write"
    );
  }
  if (await destinationStore.get(destination)) {
    return toolError("conflict: destination already exists");
  }

  const sourceVisibility = effectiveVisibility(source, sourcePrivacy.rules, sourcePrivacy.overrides);
  const destinationFolderVisibility = visibilityOf(destination, destinationPrivacy.rules);
  const publishesPrivateToTeam =
    sourceVisibility === "private" && destinationFolderVisibility === "team";
  if (publishesPrivateToTeam && !confirmTeamPublish) {
    return toolError(
      "confirm_team_publish=true is required to move a private note into team-visible destination scope"
    );
  }
  // Cross-context, and a group name does not travel: `@supa-leads` means a
  // group in the SOURCE workspace, and the destination's control plane
  // resolves names in its own. Carrying the string over would write a rule the
  // destination cannot resolve — harmless today, since an unresolvable group
  // reaches nobody, and a trap the day the destination mints the same name.
  // So a group-scoped note lands `private`, which is what the old expression
  // already did by falling through; it is written down here rather than left
  // as an accident of two equality tests.
  const destinationVisibility =
    publishesPrivateToTeam || (sourceVisibility === "team" && destinationFolderVisibility === "team")
      ? "team"
      : "private";

  const body = new TextEncoder().encode(collaborationBase?.text ?? sourceText);
  const sourceEtag = sourceObject.etag;
  let put;
  if (destinationVisibility === "private") {
    try {
      await persistExactVisibility(destinationStore, destination, "private", destinationPrivacy.rules);
    } catch (error) {
      return toolError(`move aborted before creating private destination: ${error.message}`);
    }
  }
  try {
    put = await destinationStore.put(destination, body, { onlyIf: { absent: true } });
    if (!put) {
      if (destinationVisibility === "private") await clearExactVisibilityIfAbsent(destinationStore, destination);
      return toolError("conflict: destination already exists");
    }
    if (destinationVisibility === "team") {
      await persistExactVisibility(destinationStore, destination, "team", destinationPrivacy.rules);
    }
  } catch (error) {
    if (put?.etag) {
      await deleteCreatedDestination(destinationStore, destination, put.etag);
    }
    return toolError(`move aborted before deleting source: ${error.message}`);
  }

  try {
    if (collaborationBase) {
      // A cross-workspace destination intentionally starts a new identity in
      // its own customer's bucket. Tombstoning the source generation is what
      // prevents an offline update for the old identity from resurrecting it.
      await tombstoneCollaborationDocument(sourceStore, source, {
        expectedEtag: expectedSourceEtag || collaborationBase.etag,
      });
    } else {
      // `body` — the bytes just written to the other workspace — rather than a
      // re-read: this is the one move whose destination the owner may not always
      // reach, so their own bucket keeps a copy. See `TRASH_PREFIX`.
      const retired = await retireMovedSource(sourceStore, source, sourceEtag, body);
      if (retired !== "retired") throw new Error("source changed since it was copied");
    }
  } catch (error) {
    if (put?.etag) {
      await deleteCreatedDestination(destinationStore, destination, put.etag);
    }
    return toolError(`move rolled back after source-delete failure: ${error.message}`);
  }
  await clearExactVisibility(sourceStore, source).catch(() => {});

  const sourceContext = contextNameFor(sourceSession);
  const destinationContext = contextNameFor(destinationSession);
  await recordChange(sourceStore, "move_note", sourceScope, [source], {
    moved_to_context: destinationContext,
    destination,
    source_visibility: sourceVisibility,
  });
  await recordChange(destinationStore, "move_note", destinationScope, [destination], {
    moved_from_context: sourceContext,
    source,
    etag: put.etag,
    visibility: destinationVisibility,
    team_visible: destinationVisibility === "team",
  });
  return toolText(
    `moved: ${sourceContext}/${source} → ${destinationContext}/${destination} (etag ${put.etag})\n` +
      `visibility: ${destinationVisibility}\n` +
      "references: not rewritten across workspace boundaries"
  );
}
