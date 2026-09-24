/** `set_visibility` and `set_folder_visibility` — the tools that write privacy.md. */

import { eligible as collaborationEligible, supported as collaborationSupported, readDocument as readCollaborationDocument } from "@context/collaboration";
import {
  effectiveVisibility,
  isPlumbing,
  PRIVACY_KEY,
  replacePrivacyRulesBlock,
  visibilityOf,
} from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { isEncryptedNote } from "../encryption.js";
import { listAllKeys } from "../notes/storage.js";
import {
  loadPrivacyState,
  persistExactVisibility,
  UNWRITABLE_PATH_REFUSAL,
  writesOneRule,
} from "../privacy/state.js";
import { normalizePath } from "../notes/paths.js";
import { normalizeVisibility } from "../notes/format.js";
import { recordChange } from "../activity/record.js";
import { toolError, toolText } from "./results.js";

export async function toolSetVisibility(store, scope, rules, overrides, args) {
  if (scope !== "private") {
    return toolError("permission denied: only a personal connection can change enforced visibility");
  }
  const path = normalizePath(args.path);
  if (!path || !path.endsWith(".md") || isPlumbing(path)) {
    return toolError("invalid path (must be a non-reserved .md note)");
  }
  const visibility = normalizeVisibility(args.visibility);
  if (!["private", "team"].includes(visibility)) {
    return toolError("visibility must be private or team");
  }
  if (!writesOneRule(path)) return toolError(UNWRITABLE_PATH_REFUSAL);
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
  await persistExactVisibility(store, path, visibility, rules);
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
  if (state.error) return toolError(`privacy manifest invalid: ${state.error}`);
  if (state.legacy || !state.object || typeof state.text !== "string") {
    return toolError("privacy.md is required before folder visibility can be changed");
  }

  const currentDirectRules = state.rules.filter((rule) => rule.prefix === path);
  const remainingRules = state.rules.filter((rule) => rule.prefix !== path);
  const nextRules = [...remainingRules];
  if (requested !== "inherit") nextRules.push({ prefix: path, vis: requested });

  const beforeDefault = visibilityOf(path, state.rules);
  const afterDefault = visibilityOf(path, nextRules);
  const noteObjects = (await listAllKeys(store, `${path}/`)).filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key)
  );
  const nextOverrides = new Map(state.overrides);
  const compacted = [];
  for (const [notePath, visibility] of nextOverrides) {
    // No `private` override is ever compacted away, however redundant it looks
    // for its own exact path. Since the fold, that one line is also the only
    // thing narrowing every path that folds onto it, and this loop cannot see
    // who those are: the impact report walks only `${path}/`, so a twin in a
    // differently-cased sibling folder is never scanned. Compacting it away
    // published a note the owner had marked private, said
    // `newly_team_visible_notes: 0`, and asked for no confirmation — content,
    // not existence, and the only place in this change that failed open.
    //
    // The first fix reasoned over folder rules instead: a twin is only widened,
    // it said, by a `team` rule governing the folded path but not the exact
    // one. That is false. `visibilityOf` is longest-prefix and the test was
    // any-prefix, so one `team` rule governing both the note and its twin —
    // out-ranked for the note by the longer `private` rule this very call adds
    // — widens the twin and passes the test. It needed no case-variant folder
    // rule and no hand-edited manifest, and it shipped. Deciding who a
    // narrowing protects means simulating the write, not reasoning about rules;
    // a weaker copy of that reasoning is worth less than a redundant line of
    // manifest.
    // `!== "team"` rather than `=== "private"`: a group override is a narrowing
    // too, and it is the only thing holding a note back from a folder this call
    // may be widening. Compacting one away is the same failure the paragraph
    // above describes, with a group in place of `private`.
    if (visibility !== "team") continue;
    if (notePath.startsWith(`${path}/`) && visibility === visibilityOf(notePath, nextRules)) {
      nextOverrides.delete(notePath);
      compacted.push(notePath);
    }
  }
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
    `privacy_etag: ${state.object.etag}`,
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
  if (args.expected_privacy_etag !== state.object.etag) {
    return toolError(
      `conflict: privacy.md changed since preflight (current etag ${state.object.etag}); run dry_run again`
    );
  }
  if (publicationConfirmationRequired && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: this folder rule would make existing or future notes team-visible. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }
  if (unchanged) return toolText(["unchanged", ...impact].join("\n"));

  const next = replacePrivacyRulesBlock(state.text, nextRules, nextOverrides);
  const put = await store.put(PRIVACY_KEY, next, {
    onlyIf: { etagMatches: state.object.etag },
  });
  if (!put) {
    return toolError("conflict: privacy.md changed while applying; run dry_run again");
  }
  await recordChange(store, "set_folder_visibility", scope, [path], {
    from: beforeDefault,
    to: afterDefault,
    requested,
    notes_scanned: noteObjects.length,
    newly_team_visible_notes: newlyTeamVisible.length,
    compacted_note_overrides: compacted.length,
    privacy_etag: put.etag,
    team_visible: false,
  });
  return toolText(["folder visibility changed", ...impact, `new_privacy_etag: ${put.etag}`].join("\n"));
}
