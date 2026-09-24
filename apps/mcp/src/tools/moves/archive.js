/** `archive_note` — a note moved into the context's archive root. */

import {
  archiveRoot,
  archiveRoots,
  canSee,
  visibilityOf,
} from "../../privacy/engine.js";
import { clearExactVisibility, persistExactVisibility } from "../../privacy/state.js";
import {
  clearExactVisibilityIfAbsent,
  deleteCreatedDestination,
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
import { deleteWithLegacyFallback, getWithLegacyFallback } from "../../storageLayout.js";
import { insideArchive } from "../sessionArchive.js";
import { isEncryptedNote } from "../../encryption.js";
import { normalizePath, timestampSlug } from "../../notes/paths.js";
import { probeWithLegacyFallback } from "../../notes/storage.js";
import { recordChange } from "../../activity/record.js";
import { recordForwarding } from "../../forwarding.js";
import { rewriteReferences } from "./references.js";
import { toolError, toolText, writePermissionError } from "../results.js";

export async function toolArchiveNote(store, scope, rules, overrides, pathArg, expectedEtag) {
  const path = normalizePath(pathArg);
  if (!path) return toolError("invalid path");
  // Both questions asked, then decided — `toolReadNote` argues it in full. It
  // stays ahead of the archive-root resolution below on purpose: a note this
  // caller may not see is "not found", never the sentence about whether this
  // context keeps an archive folder. The cost of saying so is now the same
  // either way, and a note that is simply absent is told it is absent rather
  // than told about the layout.
  const seen = canSee(path, scope, rules, overrides);
  const present = await probeWithLegacyFallback(store, path);
  if (!seen || !present) return toolError("not found");
  // The destination is this context's own archive, and that folder is the
  // owner's to have or not have. On a context whose manifest declares one —
  // every PARA scaffold, and every layout naming it `<n>-archive` — this works
  // as it always did. On a layout with no archive at all it used to invent
  // `4-archive`, which is the same assumption `save_context` and the connect
  // instructions were purged of: an agent "tidying up" would create a
  // top-level folder the owner deliberately did not choose, in a bucket they
  // also see in Obsidian. Refusing is honest and loses nothing: `move_note`
  // reaches whatever folder this context actually uses for inactive material,
  // and the front page says which that is.
  //
  // What was *not* honest was refusing a context that had one under another
  // number. `5-archive` is the `company` preset's, and the preset is the
  // default for a shared context, so the most common shared workspace we
  // create was told it had no archive while looking at its own.
  const roots = archiveRoots(rules);
  const root = archiveRoot(rules);
  if (!root) {
    return toolError(
      "this context has no archive folder — its layout is its owner's, and archiving must " +
        "not invent one. Use move_note to the folder this context keeps inactive material in " +
        "(orient and the front page state its conventions), or ask the owner to add an " +
        "archive rule to privacy.md (`archive` or `4-archive`, for example)."
    );
  }
  // Every archive it has, not the one we would write to: a note already sitting
  // in `5-archive/` must not be moved into `4-archive/` because the resolver
  // preferred the latter.
  if (insideArchive(path, roots)) return toolText("already archived");
  const obj = await getWithLegacyFallback(store, path);
  if (!obj) return toolError("not found");
  const sourceText = await obj.text();
  let collaborationBase = null;
  if (collaborationSupported(store) && !isEncryptedNote(sourceText) &&
      collaborationEligible(path, sourceText)) {
    if (store.capabilities?.conditionalDelete !== true) {
      const head = await collaborationHead(store, path);
      if (head?.status !== undefined && head.status !== "deleted") {
        return toolError("this storage cannot safely archive a collaboratively edited note");
      }
    } else {
      try {
        collaborationBase = await readCollaborationDocument(store, path);
      } catch {
        return toolError("this note cannot be archived safely right now; re-read and retry");
      }
    }
  }
  if (scope !== "private" && !expectedEtag) {
    return toolError("expected_etag is required when a team connection archives a note; read the note and retry");
  }
  const currentEtag = collaborationBase?.etag ?? obj.etag;
  if (expectedEtag && currentEtag !== expectedEtag) {
    return toolError(
      `conflict: note changed since you read it (current etag ${currentEtag}); re-read and retry`
    );
  }
  const stamp = timestampSlug();
  const dest = `${root}/${stamp}/${path}`;
  const destinationVisibility = scope === "private" ? "private" : "team";
  if (scope !== "private" && visibilityOf(dest, rules) !== "team") {
    return writePermissionError("archive destination");
  }
  if (await getWithLegacyFallback(store, dest)) return toolError("conflict: archive destination already exists");

  if (collaborationBase) {
    if (store.capabilities?.conditionalDelete !== true) {
      return toolError("this storage cannot safely archive a collaboratively edited note");
    }
    if (destinationVisibility === "private") {
      await persistExactVisibility(store, dest, "private", rules);
    }
    let moved;
    try {
      moved = await moveCollaborationDocument(store, path, dest, {
        expectedEtag: collaborationBase.etag,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (["CONFLICT", "BASE_MISSING", "GENERATION_MISMATCH", "DESTINATION_EXISTS"].includes(code)) {
        return toolError("conflict: note changed since it was read; re-read and retry");
      }
      return toolError("this note's archive transition could not finish safely; re-read it and retry");
    }
    if (destinationVisibility === "team") {
      try {
        await persistExactVisibility(store, dest, "team", rules);
      } catch {
        return toolError("archive completed, but its visibility could not be recorded; ask the owner to repair the archive rule");
      }
    }
    await clearExactVisibility(store, path);
    await recordForwarding(store, [{ from: path, to: dest, kind: "note" }]);
    const references = await rewriteReferences(store, scope, rules, overrides, new Map([[path, dest]]));
    await recordChange(store, "archive_note", scope, [path, dest], {
      visibility: destinationVisibility,
      team_visible: destinationVisibility === "team",
      references: references.capped ? "not-rewritten" : references.links,
    });
    return toolText(
      `archived: ${path} → ${dest}\nvisibility: ${destinationVisibility}` + referencesLine(references)
    );
  }
  const body = new TextEncoder().encode(sourceText);
  if (destinationVisibility === "private") {
    await persistExactVisibility(store, dest, "private", rules);
  }
  const archived = await store.put(dest, body, { onlyIf: { absent: true } });
  if (!archived) {
    if (destinationVisibility === "private") {
      await clearExactVisibilityIfAbsent(store, dest).catch(() => {});
    }
    return toolError("conflict: archive destination was created concurrently; re-read and retry");
  }
  if (destinationVisibility === "team") {
    await persistExactVisibility(store, dest, "team", rules);
  }
  /*
    Archiving is copy-then-delete, so it is a move and it had the move's
    hazard without the move's guard: this delete was unconditional, and an edit
    landing between the read above and here was destroyed with the archived
    copy holding the older text. `retireMovedSource` closes that wherever the
    bucket can enforce either conditional, and reports "unguarded" — rather
    than a conflict — where it cannot, so a backend that could always archive
    still can.
  */
  const retired = await retireMovedSource(store, path, obj.etag);
  if (retired === "conflict") {
    await deleteCreatedDestination(store, dest, archived?.etag);
    return toolError("conflict: note changed since it was read; re-read and retry");
  }
  if (retired === "unguarded") await deleteWithLegacyFallback(store, path);
  await clearExactVisibility(store, path);
  /*
    Archiving is a move, so its links follow it. Retiring a note is not the same
    as deleting one — the note is still there, still readable, and a link that
    now points into the archive is telling the truth about where the thing went.
    The alternative is a bucket where every archive silently breaks every link
    into it, which is how people learn not to archive.
  */
  await recordForwarding(store, [{ from: path, to: dest, kind: "note" }]);
  const references = await rewriteReferences(
    store,
    scope,
    rules,
    overrides,
    new Map([[path, dest]])
  );
  await recordChange(store, "archive_note", scope, [path, dest], {
    visibility: destinationVisibility,
    team_visible: destinationVisibility === "team",
    references: references.capped ? "not-rewritten" : references.links,
  });
  return toolText(
    `archived: ${path} → ${dest}\nvisibility: ${destinationVisibility}` + referencesLine(references)
  );
}
