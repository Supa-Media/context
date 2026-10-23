/** `set_visibility` and `set_folder_visibility` — the tools that write a note's or a folder's access row, and name people on a note. */

import { eligible as collaborationEligible, supported as collaborationSupported, readDocument as readCollaborationDocument } from "@context/collaboration";
import { effectiveVisibility, isPlumbing, visibilityOf } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { isEncryptedNote } from "../encryption.js";
import { listAllKeys } from "../notes/storage.js";
import { servedListingStore, TreeUnavailable } from "../tree/served.js";
import {
  loadPrivacyState,
  persistExactVisibility,
  PRIVACY_CONCURRENT_ERROR,
  RowsWriteRefused,
  setRowTier,
} from "../privacy/state.js";
import { normalizePath } from "../notes/paths.js";
import { normalizeVisibility } from "../notes/format.js";
import { recordChange } from "../activity/record.js";
import { toolError, toolText, writePermissionError } from "./results.js";
import { addPeopleToNote } from "./notePeople.js";

/** A rows-mode refusal as the tool answers it: FORBIDDEN is the permission error; a CONFLICT is the file's own words. */
function rowsRefusal(error, operation) {
  if (error instanceof RowsWriteRefused) {
    return error.code === "FORBIDDEN" ? writePermissionError(operation) : toolError(error.message);
  }
  if (error instanceof Error && error.message === PRIVACY_CONCURRENT_ERROR) return toolError(error.message);
  throw error;
}

export async function toolSetVisibility(store, scope, rules, overrides, args) {
  if (scope !== "private") {
    return toolError("permission denied: only a personal connection can change enforced visibility");
  }
  const path = normalizePath(args.path);
  if (!path || !path.endsWith(".md") || isPlumbing(path)) {
    return toolError("invalid path (must be a non-reserved .md note)");
  }
  // `people` alone names who else may open the note and leaves its visibility as it is.
  if (args.visibility === undefined && args.people !== undefined) {
    if (!(await getWithLegacyFallback(store, path))) return toolError("not found");
    return await addPeopleToNote(store, path, args.people);
  }
  const visibility = normalizeVisibility(args.visibility);
  if (!["private", "team"].includes(visibility)) {
    return toolError("visibility must be private or team");
  }
  if (args.people !== undefined) {
    const changed = await toolSetVisibility(store, scope, rules, overrides, { ...args, people: undefined });
    if (changed.isError === true) return changed;
    const named = await addPeopleToNote(store, path, args.people);
    return named.isError === true ? named : toolText(`${changed.content[0].text}
${named.content[0].text}`);
  }
  const obj = await getWithLegacyFallback(store, path);
  if (!obj) return toolError("not found");
  let currentEtag = obj.etag;
  if (args.expected_etag && collaborationSupported(store)) {
    const stored = await obj.text();
    if (!isEncryptedNote(stored) && collaborationEligible(path, stored)) {
      try {
        currentEtag = (await readCollaborationDocument(store, path)).etag;
      } catch {
        return toolError("this note cannot be checked safely right now; re-read and retry");
      }
    }
  }
  if (args.expected_etag && currentEtag !== args.expected_etag) {
    return toolError(
      `conflict: note changed since you read it (current etag ${currentEtag}); re-read and retry`
    );
  }
  const current = effectiveVisibility(path, rules, overrides);
  if (current === visibility) {
    return toolText(`unchanged: ${path}\nvisibility: ${visibility}\netag: ${currentEtag}`);
  }
  if (visibility === "team") {
    if (args.confirm_team_publish !== true) {
      return toolError(
        "confirmation required: publishing this private note to team makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
      );
    }
  }
  try {
    await persistExactVisibility(store, path, visibility, rules);
  } catch (error) {
    return rowsRefusal(error, "note");
  }
  await recordChange(store, "set_visibility", scope, [path], {
    from: current,
    to: visibility,
    etag: currentEtag,
    // Do not reveal that a formerly private filename existed, even after an
    // explicitly confirmed publish.
    team_visible: current === "team" && visibility === "team",
  });
  return toolText(`visibility changed: ${path}\nfrom: ${current}\nto: ${visibility}\netag: ${currentEtag}`);
}

export async function toolSetFolderVisibility(store, scope, args) {
  if (scope !== "private") {
    return toolError("permission denied: only a personal connection can change folder visibility");
  }
  const normalized = normalizePath(args.path);
  const path = normalized?.replace(/\/+$/, "");
  if (
    !path ||
    path.endsWith(".md") ||
    path.split("/").some((part) => part.startsWith(".")) ||
    isPlumbing(path)
  ) {
    return toolError("invalid path (must be a non-reserved folder path)");
  }
  const requested = args.visibility;
  if (!["private", "team", "inherit"].includes(requested)) {
    return toolError("visibility must be private, team, or inherit");
  }

  const state = await loadPrivacyState(store);
  if (state.error) return toolError(`access rules unavailable: ${state.error}`);

  const currentDirectRules = state.rules.filter((rule) => rule.prefix === path);
  const remainingRules = state.rules.filter((rule) => rule.prefix !== path);
  const nextRules = [...remainingRules];
  if (requested !== "inherit") nextRules.push({ prefix: path, vis: requested });

  const beforeDefault = visibilityOf(path, state.rules);
  const afterDefault = visibilityOf(path, nextRules);
  // Which notes the rule reaches is a question about which notes exist, so
  // the Convex tree answers it, never a bucket listing (`tree/served.js`).
  // This tool is a private connection's, so the tree lists every note.
  let listed;
  try {
    listed = await listAllKeys(servedListingStore(store), `${path}/`);
  } catch (error) {
    if (error instanceof TreeUnavailable) return toolError(error.message);
    throw error;
  }
  const noteObjects = listed.filter(({ key }) => key.endsWith(".md") && !isPlumbing(key));
  // The rows hold every override: nothing is compacted, and the rules are not rewritten.
  const nextOverrides = state.overrides;
  const compacted = [];
  const newlyTeamVisible = noteObjects
    .map(({ key }) => key)
    .filter(
      (key) =>
        effectiveVisibility(key, state.rules, state.overrides) !== "team" &&
        effectiveVisibility(key, nextRules, nextOverrides) === "team"
    );
  // `!== "team"` on the before side: widening a group folder to team publishes
  // it to everybody on People just as widening a private one does, and asking
  // for no confirmation on that transition was the same hole as the compaction
  // above.
  const futureTeamExposure = beforeDefault !== "team" && afterDefault === "team";
  const publicationConfirmationRequired = futureTeamExposure || newlyTeamVisible.length > 0;
  const unchanged =
    currentDirectRules.length === (requested === "inherit" ? 0 : 1) &&
    (requested === "inherit" || currentDirectRules[0]?.vis === requested) &&
    compacted.length === 0;

  const impact = [
    `folder: ${path}`,
    `privacy_etag: ${state.etag}`,
    `current_default: ${beforeDefault}`,
    `resulting_default: ${afterDefault}`,
    `rule: ${requested === "inherit" ? "remove direct rule and inherit" : `set ${requested}`}`,
    `notes_scanned: ${noteObjects.length}`,
    `newly_team_visible_notes: ${newlyTeamVisible.length}`,
    `redundant_note_overrides_to_remove: ${compacted.length}`,
    `team_publication_confirmation_required: ${publicationConfirmationRequired}`,
  ];
  if (args.dry_run === true) return toolText(["dry run: no changes made", ...impact].join("\n"));

  if (!args.expected_privacy_etag) {
    return toolError(
      `expected_privacy_etag is required when applying. Run with dry_run=true first.\n${impact.join("\n")}`
    );
  }
  if (args.expected_privacy_etag !== state.etag) {
    return toolError(
      `conflict: the access rules changed since preflight (current etag ${state.etag}); run dry_run again`
    );
  }
  if (publicationConfirmationRequired && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: this folder rule would make existing or future notes team-visible. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }
  if (unchanged) return toolText(["unchanged", ...impact].join("\n"));

  // The folder's own row takes the tier; the rows are the only access (`setRowTier`).
  try {
    await setRowTier(store, path, requested, { folder: true });
  } catch (error) {
    return rowsRefusal(error, "folder");
  }
  const privacyEtag = state.etag;
  await recordChange(store, "set_folder_visibility", scope, [path], {
    from: beforeDefault,
    to: afterDefault,
    requested,
    notes_scanned: noteObjects.length,
    newly_team_visible_notes: newlyTeamVisible.length,
    compacted_note_overrides: compacted.length,
    privacy_etag: privacyEtag,
    team_visible: false,
  });
  return toolText(["folder visibility changed", ...impact, `new_privacy_etag: ${privacyEtag}`].join("\n"));
}
