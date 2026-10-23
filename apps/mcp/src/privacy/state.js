/**
 * The access rules a gateway request judges by, and recording or clearing one
 * note's exact visibility in them. The rules are the tree's access rows
 * (`store/privacyAuthority.js` renders them); nothing is read from a `privacy.md`.
 *
 * The decisions themselves are `engine.js`; this is the I/O around them.
 */

import {
  overrideFor,
  parsePrivacyManifest,
  PRIVACY_KEY,
  PRIVACY_RULES_BEGIN,
  PRIVACY_RULES_END,
  PrivacyOverrides,
} from "./engine.js";
import { PRE_PARSED_RULES } from "./engine.js";

/**
 * The rules a request judges by: the rows, rendered for the reader, which the store carries
 * (`PRE_PARSED_RULES`). A store without them judges nothing: everything is private (fail closed).
 */
export async function loadPrivacyState(store) {
  const object = await store.get(PRIVACY_KEY);
  const preParsed = object?.[PRE_PARSED_RULES];
  if (preParsed === undefined) {
    return { rules: [], overrides: new PrivacyOverrides(), text: "", etag: undefined, object: null, error: "access rules are not loaded" };
  }
  return { ...preParsed, text: "", etag: object.etag, object, legacy: false };
}

/**
 * A rows-mode write the control plane refused: `code` is the control plane's answer (`FORBIDDEN` for a
 * change this grant may not make; `CONFLICT`, `NOT_FOUND`, `NOT_ROWS_MODE` otherwise).
 */
export class RowsWriteRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RowsWriteRefused";
    this.code = code;
  }
}

/** The text a CONFLICT has always carried in file mode: the same words whichever authority answered. */
export const PRIVACY_CONCURRENT_ERROR = "privacy manifest changed concurrently; retry the operation";

/**
 * Rows mode (`store.rowAccess`): one row's tier through the control plane. The rows are the truth, so the
 * rules are never edited. `missingOk` is for a clear: a row that is gone (a note moved away) has nothing to clear.
 */
export async function setRowTier(store, path, tier, { folder = false, missingOk = false } = {}) {
  const answer = await store.rowAccess.setTier(path, tier, { folder });
  if (answer.ok === true) return true;
  if (answer.code === "NOT_FOUND" && missingOk) return false;
  if (answer.code === "CONFLICT") throw new Error(PRIVACY_CONCURRENT_ERROR);
  if (answer.code === "NOT_FOUND") throw new Error(`${path} has no access row yet; try again`);
  throw new RowsWriteRefused(answer.code ?? "FORBIDDEN", "privacy rows refused the change");
}

/**
 * Whether a note path can be written at all. The access rows take any path, but a path that cannot be read back
 * as itself through the retired rule grammar is refused here as before (`writesOneRule`, kept until the grammar is
 * decided away; see the report that added this).
 */
export const UNWRITABLE_PATH_REFUSAL =
  "that path cannot be recorded in privacy.md: a note path may not contain a character " +
  "the rule format uses. Rename the note and try again.";

/**
 * Would this path render as exactly one rule that reads back as itself?
 *
 * Nothing guarantees a key came through `normalizePath`: Obsidian's sync
 * plugin, rclone and the provider's own console all write keys directly, so a
 * note really can be called `2026: notes`. Rendering one rule and parsing it
 * back with the real parser is the only check that cannot drift from what the
 * parser actually does.
 */
export function writesOneRule(path, visibility = "private") {
  let parsed;
  try {
    parsed = parsePrivacyManifest(
      [
        PRIVACY_RULES_BEGIN,
        "",
        "```yaml",
        "default_visibility: private",
        "",
        "folder_defaults:",
        "  # none",
        "",
        "note_overrides:",
        `  ${path}: ${visibility}`,
        "```",
        "",
        PRIVACY_RULES_END,
      ].join("\n")
    );
  } catch {
    return false;
  }
  if (parsed.rules.length !== 0 || parsed.overrides.size !== 1) return false;
  // Through `overrideFor` like every other override read in this file. The map
  // here is a throwaway with one entry, so the fold cannot change the answer —
  // which is exactly why reaching past the helper would be a harmless-looking
  // exception, and `__tests__/privacyAccessors.test.ts` exists to have no
  // harmless-looking exceptions to point at.
  return overrideFor(parsed.overrides, path) === visibility;
}

/** Record one note's visibility on its row (`setRowTier`). The rows are the only access. */
export async function persistExactVisibility(store, path, visibility) {
  if (!store.rowAccess) throw new Error("access rows are not loaded");
  await setRowTier(store, path, visibility);
}

/** Clear one note's own visibility, so it inherits again. A row that is gone has nothing to clear. */
export async function clearExactVisibility(store, path) {
  if (!store.rowAccess) throw new Error("access rows are not loaded");
  await setRowTier(store, path, "inherit", { missingOk: true });
}
