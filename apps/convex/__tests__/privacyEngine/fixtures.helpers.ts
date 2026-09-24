/**
 * THE PRIVACY ENGINE, DIFFERENTIALLY TESTED AGAINST THE GATEWAY'S.
 *
 * `functions/lib/privacy.ts` is a port. The gateway's engine lives in
 * `apps/mcp/src/index.js` as module-private declarations with no exported
 * binding, so it cannot be imported into a Convex action — see that file's
 * header for the full reasoning and for the instruction to delete the port the
 * day it becomes importable.
 *
 * A port that is merely "carefully written" is worth nothing here. What makes
 * two visibility engines dangerous is not that one has a bug — it is that they
 * disagree, so a note the console shows as private is a note the gateway hands
 * to an AI client, or vice versa, and nothing anywhere throws.
 *
 * So this file does not test the port against expectations. It extracts the
 * gateway's **actual** functions (see `gatewayFormat.helpers.ts`) and runs both
 * implementations over the same matrix of manifests, keys, scopes and
 * malformed input, asserting identical results — including identical
 * *rejections*, since "one throws and the other returns empty rules" is the
 * most dangerous divergence of all: empty rules means everything is private,
 * which looks safe and silently empties the console.
 */

import { gatewayInternals, type PrivacyRule } from "../gatewayFormat.helpers";
import {
  PRIVACY_RULES_BEGIN,
  PRIVACY_RULES_END,
} from "../../functions/lib/privacy";

export const gateway = gatewayInternals();

/** Wrap a rules block in the prose a real `privacy.md` carries around it. */
export function manifest(block: string): string {
  return [
    "---",
    "role: privacy-manifest",
    "---",
    "",
    "# Access map",
    "",
    "Some prose the customer wrote and we must not eat.",
    "",
    block,
    "",
    "More prose, below the block.",
    "",
  ].join("\n");
}

export function block(lines: string[]): string {
  return [PRIVACY_RULES_BEGIN, "", "```yaml", ...lines, "```", "", PRIVACY_RULES_END].join(
    "\n",
  );
}

/* -------------------------------------------------------------------------- */
/*                             the manifest corpus                            */
/* -------------------------------------------------------------------------- */

/**
 * Every manifest below is a shape a real bucket can be in. The invalid ones
 * are not padding: a manifest that one engine rejects and the other accepts is
 * the divergence that matters most, because the two then disagree about
 * *every* note in the bucket at once.
 */
export const MANIFESTS: Record<string, string> = {
  "a fresh PARA scaffold": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  0-inbox: private",
      "  1-projects: private",
      "  2-areas: private",
      "  3-resources: private",
      "  4-archive: private",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a shared projects folder with a private exception": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "  1-projects/secret: private",
      "  2-areas: private",
      "",
      "note_overrides:",
      "  1-projects/pay.md: private",
      "  2-areas/team-handbook.md: team",
    ]),
  ),

  "a group rule on a folder and on one note": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "  2-areas/feedback: @supa-owners",
      "",
      "note_overrides:",
      "  1-projects/pay.md: @supa-leads",
      "  2-areas/team-handbook.md: team",
    ]),
  ),

  "a group named for one person, which is the same token": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "",
      "note_overrides:",
      "  1-projects/a.md: @kola",
    ]),
  ),

  // Invalid, and each for a different reason a name can be wrong. A manifest
  // either engine accepts here is a rule nothing can resolve being carried as
  // though it were a tier.
  "a group with no name": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a group with an uppercase name": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @Supa-Owners",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a group with an underscore in it": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @supa_owners",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a group name one character long": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @a",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a group name opening with a hyphen": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @-supa",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "no folder rules at all": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  # No folder defaults. All content is private.",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "trailing slashes and leading slashes": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  /1-projects/: team",
      "",
      "note_overrides:",
      "  /1-projects/a.md: private",
    ]),
  ),

  "the legacy `public` word is not accepted here": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: public",
      "",
      "note_overrides:",
    ]),
  ),

  "no managed block at all": "# Access map\n\nnothing to see here\n",

  "a block with no default_visibility": manifest(
    block(["folder_defaults:", "  1-projects: team", "", "note_overrides:"]),
  ),

  "a rule before any section header": manifest(
    block(["default_visibility: private", "  1-projects: team"]),
  ),

  "a reserved dot path as a folder rule": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  .history: team",
      "",
      "note_overrides:",
    ]),
  ),

  "a note override that is not markdown": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "",
      "note_overrides:",
      "  1-projects/notes.txt: team",
    ]),
  ),

  "a note override naming privacy.md itself": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "",
      "note_overrides:",
      "  privacy.md: team",
    ]),
  ),

  "an unparseable visibility word": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: sometimes",
      "",
      "note_overrides:",
    ]),
  ),
};

export const KEYS = [
  "index.md",
  "privacy.md",
  "scopes.yml",
  "0-inbox/thought.md",
  "1-projects/a.md",
  "1-projects/pay.md",
  "1-projects/secret/plan.md",
  "1-projects-other/a.md",
  "2-areas/team-handbook.md",
  "2-areas/health.md",
  "2-areas/feedback/q3.md",
  "4-archive/2026/old.md",
  ".history/1-projects/a.md.2026.md",
  ".obsidian/workspace.json",
  "deeply/nested/but/unruled.md",
];

export const SCOPES = ["private", "team"] as const;

/** Run a function and record either its value or the fact that it threw. */
export function outcome<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

/** Comparable form: Maps do not survive `toEqual` against a plain object. */
export function normalise<V extends string>(parsed: {
  rules: PrivacyRule[];
  // Generic in the value so the port's own `PrivacyManifest` (values typed
  // `Visibility`) and the gateway's extracted shape (plain strings, since the
  // extraction cannot know the union) both fit. A group value is a string
  // either way, and this function only sorts and compares.
  overrides: ReadonlyMap<string, V>;
}) {
  return {
    rules: [...parsed.rules].sort((a, b) => a.prefix.localeCompare(b.prefix)),
    overrides: [...parsed.overrides.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

/* -------------------------------------------------------------------------- */
