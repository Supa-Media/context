/**
 * The privacy engine, as the control plane needs it.
 *
 * `privacy.md` decides what a connected client — an AI client through the
 * gateway, or a person through the console — is allowed to see. It is
 * **folder defaults plus exact-note exceptions**, and it is authoritative: a
 * `visibility:` line in a note's own frontmatter is descriptive prose, not
 * access control. Changing it changes nothing.
 *
 * ## Why this is a port and not an import
 *
 * The brief for this module said "do not re-implement that logic: reuse it".
 * It could not be done, and the reason is worth writing down rather than
 * quietly working around.
 *
 * `apps/mcp/src/store/*.js` can be imported here — `functions/provisioning.ts`
 * imports `S3Store` and `probeStore` across the package boundary, because
 * those are real ESM exports. The privacy engine is not: `parsePrivacyManifest`,
 * `visibilityOf`, `effectiveVisibility` and `canSee` are **module-private
 * declarations inside `apps/mcp/src/index.js`**, whose only export is the
 * worker's `fetch`/`scheduled` handler object. There is no importable binding,
 * and `apps/mcp` was read-only for this change, so one could not be added.
 * `__tests__/gatewayFormat.helpers.ts` gets at them by loading the worker's
 * source as text and evaluating it — a test-time trick that has no runtime
 * equivalent inside a Convex action.
 *
 * So this is the same code, ported, with the same structure and the same edge
 * cases — and, crucially, it is **not trusted to be the same**. It is
 * differentially tested: `__tests__/privacyEngine.test.ts` extracts the
 * gateway's *actual* `parsePrivacyManifest`, `visibilityOf`, `isPlumbing` and
 * `canSee` and runs both implementations over a matrix of manifests, keys and
 * scopes, asserting identical output — including identical *rejections*. If
 * the two ever drift by so much as a thrown-versus-not, that test fails.
 *
 * That is the same treatment `functions/lib/scaffold.ts` already gives the
 * manifest *renderer*, for the same reason, and it is the strongest guarantee
 * available without editing `apps/mcp`. **If the gateway ever exports these
 * functions, delete this file and import them.**
 */

/**
 * The managed-block markers.
 *
 * On-bucket format, not vocabulary: they already sit inside every live
 * `privacy.md`, and the gateway locates its rules by string-searching for
 * them. Renaming them breaks existing buckets, so the legacy "BRAIN" wording
 * stays even though the product noun is "context".
 */
export const PRIVACY_RULES_BEGIN = "<!-- BEGIN BRAIN PRIVACY RULES -->";
export const PRIVACY_RULES_END = "<!-- END BRAIN PRIVACY RULES -->";

export const PRIVACY_KEY = "privacy.md";
/** The pre-`privacy.md` format. Read by the gateway, never written by us. */
export const LEGACY_SCOPES_KEY = "scopes.yml";

/** Visibility is `private` or `team`. There is no public tier — CLAUDE.md #5. */
export type Visibility = "private" | "team";

/**
 * What a caller is allowed to reach.
 *
 * The same two words as `Visibility`, but a different thing: this is the
 * caller's clearance, that is a note's classification. A `private` caller sees
 * everything; a `team` caller sees only what is `team`.
 */
export type Scope = "private" | "team";

export interface PrivacyRule {
  /** A folder path with no trailing slash. */
  prefix: string;
  vis: Visibility;
}

export interface PrivacyManifest {
  rules: PrivacyRule[];
  overrides: Map<string, Visibility>;
}

/* -------------------------------------------------------------------------- */
/*                                  parsing                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read the managed block out of a `privacy.md`.
 *
 * Strict on purpose, and the strictness is the security property: a manifest
 * this rejects makes the gateway fall back to "no rules", which means
 * everything is private. Silently skipping a line it did not understand would
 * instead mean a rule the owner wrote is not enforced — a note they marked
 * private staying team-readable. Throwing is the safe failure.
 */
export function parsePrivacyManifest(text: string): PrivacyManifest {
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  const end = text.indexOf(PRIVACY_RULES_END);
  if (begin < 0 || end < begin) {
    throw new Error("privacy.md is missing its managed rules block");
  }
  const block = text.slice(begin + PRIVACY_RULES_BEGIN.length, end);
  const rules: PrivacyRule[] = [];
  const overrides = new Map<string, Visibility>();
  let section: "folders" | "notes" | null = null;
  let sawDefault = false;

  for (const raw of block.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line === "```yaml" || line === "```") continue;
    if (line === "default_visibility: private") {
      sawDefault = true;
      continue;
    }
    if (line === "folder_defaults:") {
      section = "folders";
      continue;
    }
    if (line === "note_overrides:") {
      section = "notes";
      continue;
    }
    const match = line.match(/^([^:]+?)\/?\s*:\s*(team|private)$/);
    if (!match || !section) throw new Error(`invalid privacy rule: ${line}`);
    const path = match[1].trim().replace(/^\/+/, "");
    if (!path || path.split("/").some((part) => part.startsWith("."))) {
      throw new Error(`invalid reserved privacy path: ${path}`);
    }
    if (section === "folders") {
      rules.push({ prefix: path, vis: match[2] as Visibility });
    } else {
      if (!path.endsWith(".md") || path === PRIVACY_KEY) {
        throw new Error(`invalid exact-note privacy path: ${path}`);
      }
      overrides.set(path, match[2] as Visibility);
    }
  }

  if (!sawDefault) {
    throw new Error("privacy.md must declare default_visibility: private");
  }
  return { rules, overrides };
}

/* -------------------------------------------------------------------------- */
/*                                 rendering                                  */
/* -------------------------------------------------------------------------- */

/**
 * Render the block the gateway parses.
 *
 * Byte-for-byte the shape `renderPrivacyRulesBlock` in `apps/mcp/src/index.js`
 * emits, so a manifest the console rewrites and a manifest the gateway
 * rewrites are the same file — no spurious diff in the customer's Obsidian
 * vault every time the two take turns.
 */
export function renderPrivacyRulesBlock(
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): string {
  const folderLines = [...rules]
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((rule) => `  ${rule.prefix}: ${rule.vis}`);
  const noteLines = [...overrides.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, visibility]) => `  ${path}: ${visibility}`);
  return [
    PRIVACY_RULES_BEGIN,
    "",
    "```yaml",
    "default_visibility: private",
    "",
    "folder_defaults:",
    ...(folderLines.length
      ? folderLines
      : ["  # No folder defaults. All content is private."]),
    "",
    "note_overrides:",
    ...(noteLines.length ? noteLines : ["  # No exact-note overrides."]),
    "```",
    "",
    PRIVACY_RULES_END,
  ].join("\n");
}

/**
 * Swap the managed block, leaving every other byte of the file alone.
 *
 * The prose above and below the markers is the customer's — they can rewrite
 * it, translate it, or add their own notes to it, and a visibility change from
 * the console must not eat that.
 */
export function replacePrivacyRulesBlock(
  text: string,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): string {
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  const end = text.indexOf(PRIVACY_RULES_END);
  if (begin < 0 || end < begin) {
    throw new Error("privacy.md is missing its managed rules block");
  }
  return (
    text.slice(0, begin) +
    renderPrivacyRulesBlock(rules, overrides) +
    text.slice(end + PRIVACY_RULES_END.length)
  );
}

/* -------------------------------------------------------------------------- */
/*                                 evaluating                                 */
/* -------------------------------------------------------------------------- */

/**
 * The folder default that applies to a key. Longest matching prefix wins; no
 * rule at all means private.
 *
 * Segment-aware: a rule for `2-areas` covers `2-areas/x.md` but not
 * `2-areas-public/x.md`.
 */
/**
 * One object, one privacy answer — even where two strings name one object.
 *
 * Every decision below is keyed on an exact path, which is sound on a keyspace
 * where one string is one object. R2 and S3 are that; Dropbox is not — the
 * gateway's `DropboxStore` header records that it "treats `Foo.md` and
 * `foo.md` as the same file and normalises Unicode", and deliberately does not
 * re-case a caller's key. Note paths reach both engines from outside (an AI
 * client's tool call here, a console request there), so on a Dropbox-backed
 * context the caller chooses which of two strings to send and therefore which
 * of two answers to be scored by.
 *
 * The fold is applied where the decision is made rather than where the bytes
 * are stored, and on every backend: a privacy answer that depends on which
 * adapter is underneath is an answer nobody can check. On a case-sensitive
 * store the cost is only ever restrictive — a note whose name differs from a
 * reserved key or a narrowing override by case alone is refused, never served.
 *
 * `visibilityOf`'s folder rules are deliberately NOT folded. Re-casing a folder
 * makes every prefix miss and the default `private` takes over, which already
 * fails closed; folding them would let a `team` rule match folders its author
 * did not name, which fails open.
 *
 * The gateway holds the same fold in `apps/mcp/src/index.js`, and
 * `__tests__/privacyEngine.test.ts` runs both over one matrix asserting
 * identical output — which is what stops the two copies drifting apart.
 */
export function foldPath(key: string): string {
  return key.normalize("NFC").toLowerCase();
}

/** The override for this note, or for any note whose path folds onto it. */
export function overrideFor(
  overrides: ReadonlyMap<string, Visibility> | undefined,
  key: string,
): Visibility | undefined {
  if (!overrides) return undefined;
  const exact = overrides.get(key);
  if (exact !== undefined) return exact;
  const folded = foldPath(key);
  for (const [existing, visibility] of overrides) {
    if (foldPath(existing) === folded) return visibility;
  }
  return undefined;
}

/** Whether any override names this note, under any casing. */
export function hasOverride(
  overrides: ReadonlyMap<string, Visibility> | undefined,
  key: string,
): boolean {
  return overrideFor(overrides, key) !== undefined;
}

/**
 * Drop this note's override, and any that folds onto it.
 *
 * The copies below are built with `new Map(overrides)`, so a folding Map
 * subclass would be silently downgraded to a plain one on every copy. Deleting
 * through a helper is what survives that idiom.
 */
export function deleteOverride(next: Map<string, Visibility>, key: string): void {
  next.delete(key);
  const folded = foldPath(key);
  for (const existing of [...next.keys()]) {
    if (foldPath(existing) === folded) next.delete(existing);
  }
}

export function visibilityOf(
  key: string,
  rules: readonly PrivacyRule[],
): Visibility {
  let best: PrivacyRule | null = null;
  for (const rule of rules) {
    if (key === rule.prefix || key.startsWith(rule.prefix + "/")) {
      if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
  }
  return best ? best.vis : "private";
}

/** The folder default, unless this exact note has an exception. */
export function effectiveVisibility(
  key: string,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility> | undefined,
): Visibility {
  return overrideFor(overrides, key) || visibilityOf(key, rules);
}

/**
 * Dot-prefixed segments (`.history/`, `.audit/`, `.obsidian/`) are plumbing,
 * never notes — and neither is the manifest itself or its legacy predecessor.
 */
export function isPlumbing(key: string): boolean {
  const folded = foldPath(key);
  return (
    folded === PRIVACY_KEY ||
    folded === LEGACY_SCOPES_KEY ||
    key.split("/").some((segment) => segment.startsWith("."))
  );
}

/**
 * The one question that matters: may this caller see this key at all?
 *
 * `privacy.md` is visible only at `private` scope — it is the access map, and
 * handing it to a team-scoped caller would enumerate every private folder by
 * name. Everything else dot-prefixed is invisible to everybody.
 */
export function canSee(
  key: string,
  scope: Scope,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility> | undefined,
): boolean {
  if (foldPath(key) === PRIVACY_KEY) return scope === "private";
  if (isPlumbing(key)) return false;
  if (scope === "private") return true;
  return effectiveVisibility(key, rules, overrides) === "team";
}

/* -------------------------------------------------------------------------- */
/*                              changing a rule                               */
/* -------------------------------------------------------------------------- */

/**
 * The exception set after setting one note's visibility.
 *
 * **A value equal to the folder default removes the exception rather than
 * writing a redundant one.** That is not tidiness — it is what keeps the file
 * a readable statement of intent. A manifest where every note is listed
 * explicitly says nothing about which notes are unusual, which is the only
 * thing the exception list is for, and it is what the console's UI reads to
 * decide whether to mark a row at all.
 */
export function nextOverrides(
  path: string,
  visibility: Visibility,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): Map<string, Visibility> {
  const next = new Map(overrides);
  if (visibility === visibilityOf(path, rules)) deleteOverride(next, path);
  else {
    deleteOverride(next, path);
    next.set(path, visibility);
  }
  return next;
}

/**
 * Carry a note's exception with it when the note moves.
 *
 * Without this, moving a private note into a `team` folder silently publishes
 * it to everyone the owner has granted team access — the manifest still names
 * the old path, which no longer exists. Re-evaluated against the destination,
 * so a note moved into a folder that already defaults to its visibility loses
 * a now-redundant exception instead of accumulating one.
 */
export function movedOverrides(
  from: string,
  to: string,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): Map<string, Visibility> {
  const existing = overrideFor(overrides, from);
  const next = new Map(overrides);
  deleteOverride(next, from);
  if (existing === undefined) return next;
  // The note kept its *effective* visibility, so re-derive whether that is
  // still an exception at the destination.
  return nextOverrides(to, existing, rules, next);
}

/** Drop a note's exception. Used when the note itself is gone. */
export function clearedOverrides(
  path: string,
  overrides: ReadonlyMap<string, Visibility>,
): Map<string, Visibility> {
  const next = new Map(overrides);
  deleteOverride(next, path);
  return next;
}
