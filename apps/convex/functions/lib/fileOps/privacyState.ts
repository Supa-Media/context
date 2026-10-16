/**
 * The privacy state an operation is decided against, read from `privacy.md`.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { PRE_PARSED_RULES } from "../../../../mcp/src/privacy/engine.js";
import { PRIVACY_KEY, type PrivacyRule, type Visibility, parsePrivacyManifest } from "../privacy";
import type { FileStore } from "./store";

/* -------------------------------------------------------------------------- */
/*                              the privacy state                             */
/* -------------------------------------------------------------------------- */

export interface PrivacyState {
  rules: PrivacyRule[];
  overrides: Map<string, Visibility>;
  /** The manifest's full text, when there is a parseable one to rewrite. */
  text: string | null;
  etag: string | null;
  /** Set when a manifest exists but does not parse. */
  invalid: boolean;
}

/**
 * Read `privacy.md`.
 *
 * Three outcomes, and the fallbacks are chosen to fail *closed*:
 *  - parsed → its rules apply.
 *  - absent (a legacy `scopes.yml` bucket, or one we never scaffolded) → no
 *    rules, which means everything is private.
 *  - present but unparseable → no rules, same as absent. The gateway degrades
 *    the same way, and the alternative — guessing at half a file — is how a
 *    note the owner marked private becomes team-readable.
 */
export async function loadPrivacyState(store: FileStore): Promise<PrivacyState> {
  const object = await store.get(PRIVACY_KEY);
  if (object === null) {
    return { rules: [], overrides: new Map(), text: null, etag: null, invalid: false };
  }
  // Rules the rows (or the authority) hold parsed, with row tokens in them: taken as they are. File text cannot
  // carry a token, so this is the only way rows-mode rules reach `canSee` (`lib/nodes/privacyMirror.ts`).
  const preParsed = (object as { [PRE_PARSED_RULES]?: { rules: PrivacyRule[]; overrides: Iterable<[string, Visibility]> } })[
    PRE_PARSED_RULES
  ];
  if (preParsed !== undefined) {
    return { rules: preParsed.rules, overrides: new Map(preParsed.overrides), text: null, etag: object.etag, invalid: false };
  }
  const text = await object.text();
  try {
    const parsed = parsePrivacyManifest(text);
    return {
      rules: parsed.rules,
      overrides: parsed.overrides,
      text,
      etag: object.etag,
      invalid: false,
    };
  } catch {
    // The message is deliberately dropped: it echoes the offending line of the
    // customer's file, and a manifest line can name a private folder.
    return { rules: [], overrides: new Map(), text, etag: object.etag, invalid: true };
  }
}
