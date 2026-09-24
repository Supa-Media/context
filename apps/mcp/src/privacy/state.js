/**
 * The privacy manifest as stored: loading it from a bucket (with the legacy
 * `scopes.yml` and `.note-acl` fallback), and recording or clearing one
 * note's exact visibility in it.
 *
 * The decisions themselves are `engine.js`; this is the I/O around them.
 */

import { deleteWithLegacyFallback, getWithLegacyFallback } from "../storageLayout.js";
import {
  LEGACY_SCOPES_KEY,
  overrideFor,
  parsePrivacyManifest,
  PRIVACY_KEY,
  PRIVACY_RULES_BEGIN,
  PRIVACY_RULES_END,
  PrivacyOverrides,
  replacePrivacyRulesBlock,
  visibilityOf,
} from "./engine.js";
import { listAllKeysWithLegacy } from "../notes/storage.js";
import { NOTE_ACL_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";

function parseLegacyScopeRules(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line === "rules:") continue;
    const mm = line.match(/^([^:]+?)\/?\s*:\s*(public|team|private)$/);
    if (mm) {
      rules.push({
        prefix: mm[1].trim().replace(/^\/+/, ""),
        // `public` was the old name for authenticated team access.
        vis: mm[2] === "public" ? "team" : mm[2],
      });
    }
  }
  return rules;
}

async function loadLegacyPrivacyState(store) {
  const scopeObject = await getWithLegacyFallback(store, LEGACY_SCOPES_KEY);
  const rules = scopeObject ? parseLegacyScopeRules(await scopeObject.text()) : [];
  const overrides = new PrivacyOverrides();
  const keys = await listAllKeysWithLegacy(store, NOTE_ACL_PREFIX);
  for (const { key } of keys) {
    const path = key.slice(NOTE_ACL_PREFIX.length).replace(/\.json$/, "");
    if (path && key.endsWith(".json")) overrides.set(path, "private");
  }
  return { rules, overrides, legacy: true, object: scopeObject };
}

export async function loadPrivacyState(store) {
  const object = await getWithLegacyFallback(store, PRIVACY_KEY);
  if (!object) return loadLegacyPrivacyState(store);
  try {
    const text = await object.text();
    return { ...parsePrivacyManifest(text), text, object, legacy: false };
  } catch (error) {
    return { rules: [], overrides: new PrivacyOverrides(), text: "", object, legacy: false, error: error.message };
  }
}

export async function loadScopeRules(store) {
  return (await loadPrivacyState(store)).rules;
}

function noteAclKey(path) {
  return `${NOTE_ACL_PREFIX}${path}.json`;
}

async function loadNoteVisibilityOverrides(store) {
  return (await loadPrivacyState(store)).overrides;
}

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

export async function persistExactVisibility(store, path, visibility, rules) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await loadPrivacyState(store);
    if (state.error) throw new Error(`privacy manifest invalid: ${state.error}`);
    if (state.legacy) {
      const inherited = visibilityOf(path, rules);
      if (visibility === "private" && inherited === "team") {
        await store.put(
          noteAclKey(path),
          JSON.stringify({ path, visibility: "private", updated_at: new Date().toISOString() })
        );
      } else {
        await deleteWithLegacyFallback(store, noteAclKey(path));
      }
      return;
    }
    const inherited = visibilityOf(path, state.rules);
    // Belt to `normalizePath`'s brace, and the same technique the control
    // plane's `writableAsRule` uses: render the rule this write would add and
    // parse it back with the REAL parser, accepting it only if exactly one rule
    // comes out naming exactly this path. A character blacklist is a guess
    // about a parser that has a comment stripper, a trailing-slash tolerance
    // and a dot-segment rule; a round trip is not a guess.
    if (visibility !== inherited && !writesOneRule(path, visibility)) {
      throw new Error("that path cannot be written as a privacy rule");
    }
    if (visibility === inherited) state.overrides.delete(path);
    else state.overrides.set(path, visibility);
    const next = replacePrivacyRulesBlock(state.text, state.rules, state.overrides);
    const put = await store.put(PRIVACY_KEY, next, { onlyIf: { etagMatches: state.object.etag } });
    if (put) return;
  }
  throw new Error("privacy manifest changed concurrently; retry the operation");
}

export async function clearExactVisibility(store, path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await loadPrivacyState(store);
    if (state.error) throw new Error(`privacy manifest invalid: ${state.error}`);
    if (state.legacy) {
      await deleteWithLegacyFallback(store, noteAclKey(path));
      return;
    }
    // Exact on purpose, and asked through `delete`'s own answer so the two
    // cannot drift apart: a fold reads across case, it never writes across it.
    // Clearing `a/Foo.md` must not remove the override on `a/foo.md`.
    if (!state.overrides.delete(path)) return;
    const next = replacePrivacyRulesBlock(state.text, state.rules, state.overrides);
    const put = await store.put(PRIVACY_KEY, next, { onlyIf: { etagMatches: state.object.etag } });
    if (put) return;
  }
  throw new Error("privacy manifest changed concurrently; retry the operation");
}
