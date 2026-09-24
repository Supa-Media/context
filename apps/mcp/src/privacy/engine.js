/**
 * The privacy engine: `privacy.md`'s managed block, parsed and rendered, and
 * the decisions made from it — `visibilityOf`, `effectiveVisibility` (folder
 * defaults with exact-note overrides, folded), `isPlumbing`, `canSee`, and
 * where archiving lands.
 *
 * Pure and dependency-free on purpose: it imports nothing, reads no store, and
 * the control plane's contract tests evaluate THIS FILE'S TEXT
 * (`apps/convex/__tests__/gatewayFormat.helpers.ts`) to check that its own
 * port agrees with it. Anything that needs I/O lives in `state.js` beside it.
 *
 * Its semantics are load-bearing (see CLAUDE.md): it was moved here verbatim
 * out of `index.js`, and changing what it decides is a decision for
 * docs/decisions/privacy-and-sharing.md, not a refactor.
 */

export const PRIVACY_KEY = "privacy.md";
export const LEGACY_SCOPES_KEY = "scopes.yml";
// These two markers are on-bucket format, not vocabulary. They already sit
// inside every live privacy.md, so renaming them would break existing buckets —
// which is why they keep a word the product's copy retired in 2026-09.
export const PRIVACY_RULES_BEGIN = "<!-- BEGIN BRAIN PRIVACY RULES -->";
export const PRIVACY_RULES_END = "<!-- END BRAIN PRIVACY RULES -->";

/**
 * What a privacy rule may name besides the two tiers.
 *
 * `@` plus a name from the one global namespace usernames and workspace slugs
 * already share, so `@kola` (a person) and `@supa-leads` (a group) are one
 * token here and deliberately so — sharing a note with one person needs no
 * second mechanism. `[a-z0-9-]` is `ALLOWED_CHARS` in the control plane's
 * `names.ts`, and the length spans a slug-prefixed name. This engine never
 * resolves the name: it carries it, orders it against the two tiers, and hands
 * it to `canSee`, which asks whether the caller's grant was issued with it.
 */
export const GROUP_SCOPE_PATTERN = /^@[a-z0-9][a-z0-9-]{1,64}$/;

/** Whether a visibility is a group rule rather than one of the two tiers. */
function isGroupScope(visibility) {
  return visibility !== "private" && visibility !== "team";
}

/**
 * How wide each visibility is, for the one comparison this engine makes.
 *
 * `private` (owners) is inside every group and every group is inside `team`,
 * so the three are ordered by reach with groups sharing a rank. Two *different*
 * groups at that rank are not comparable, and `narrowerVisibility` resolves
 * that the only way that cannot leak.
 */
function visibilityReach(visibility) {
  if (visibility === "private") return 0;
  if (visibility === "team") return 2;
  return 1;
}

/**
 * The narrower of two visibilities, tolerating `undefined` as "no opinion".
 *
 * Two distinct groups answer `private` — the same rule the case-fold has
 * always followed, that two entries folding onto one object are a
 * contradiction the owner never resolved and `private` is the only resolution
 * that cannot hand a note to somebody who was not named. Reachable only from a
 * hand-edited manifest; nothing in the product writes two case-variant rules.
 */
export function narrowerVisibility(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === b) return a;
  const ra = visibilityReach(a);
  const rb = visibilityReach(b);
  if (ra !== rb) return ra < rb ? a : b;
  return "private";
}

export function parsePrivacyManifest(text) {
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  const end = text.indexOf(PRIVACY_RULES_END);
  if (begin < 0 || end < begin) throw new Error("privacy.md is missing its managed rules block");
  const block = text.slice(begin + PRIVACY_RULES_BEGIN.length, end);
  const rules = [];
  const overrides = new PrivacyOverrides();
  let section = null;
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
    const match = line.match(/^([^:]+?)\/?\s*:\s*(team|private|@[^\s:]+)$/);
    if (!match || !section) throw new Error(`invalid privacy rule: ${line}`);
    // A group rule is validated here rather than waved through, for the reason
    // the whole parser throws: an unusable manifest makes everything private,
    // and a malformed name accepted as a scope is a rule nothing can resolve
    // being carried as though it were a tier.
    if (match[2].startsWith("@") && !GROUP_SCOPE_PATTERN.test(match[2])) {
      throw new Error(`invalid privacy group: ${match[2]}`);
    }
    const path = match[1].trim().replace(/^\/+/, "");
    if (!path || path.split("/").some((part) => part.startsWith("."))) {
      throw new Error(`invalid reserved privacy path: ${path}`);
    }
    if (section === "folders") {
      rules.push({ prefix: path, vis: match[2] });
    } else {
      if (!path.endsWith(".md") || foldPath(path) === PRIVACY_KEY) {
        throw new Error(`invalid exact-note privacy path: ${path}`);
      }
      overrides.set(path, match[2]);
    }
  }
  if (!sawDefault) throw new Error("privacy.md must declare default_visibility: private");
  return { rules, overrides };
}

function renderPrivacyRulesBlock(rules, overrides) {
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
    ...(folderLines.length ? folderLines : ["  # No folder defaults. All content is private."]),
    "",
    "note_overrides:",
    ...(noteLines.length ? noteLines : ["  # No exact-note overrides."]),
    "```",
    "",
    PRIVACY_RULES_END,
  ].join("\n");
}

export function replacePrivacyRulesBlock(text, rules, overrides) {
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  const end = text.indexOf(PRIVACY_RULES_END);
  if (begin < 0 || end < begin) throw new Error("privacy.md is missing its managed rules block");
  return (
    text.slice(0, begin) +
    renderPrivacyRulesBlock(rules, overrides) +
    text.slice(end + PRIVACY_RULES_END.length)
  );
}

/** Longest matching prefix rule wins; no rule → private. Segment-aware. */
export function visibilityOf(key, rules) {
  let best = null;
  for (const r of rules) {
    if (key === r.prefix || key.startsWith(r.prefix + "/")) {
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
  }
  return best ? best.vis : "private";
}

export function effectiveVisibility(key, rules, overrides) {
  return overrideFor(overrides, key) || visibilityOf(key, rules);
}

/**
 * One object, one privacy answer — even where two strings name one object.
 *
 * Every decision in this engine is keyed on an exact path: `isPlumbing` opens
 * with `key === PRIVACY_KEY`, and `effectiveVisibility` is an exact `Map.get`
 * against the exact-note overrides. That is sound on a keyspace where one
 * string is one object, which is what R2 and S3 are — and `DropboxStore` is
 * not. Its own header lists the difference: Dropbox "treats `Foo.md` and
 * `foo.md` as the same file and normalises Unicode", and it deliberately does
 * not re-case a caller's key, because a store that silently rewrote one would
 * be worse than one that returns what Dropbox actually has.
 *
 * That is the right call for the adapter and it leaves the question here. Every
 * note path in this gateway arrives from a connected AI client, so on a
 * Dropbox-backed context an attacker picks which of two strings to send and
 * therefore which of two answers to be scored by: `Privacy.md` is not
 * `privacy.md`, so nothing reserved it, and Dropbox wrote the manifest anyway.
 *
 * So the fold happens where the decision is made rather than where the bytes
 * are stored, and on **every** backend: a privacy answer that depends on which
 * adapter is underneath is an answer nobody can check. What makes that safe
 * everywhere is that the fold only ever NARROWS — a `private` override travels
 * to every path folding onto it, a `team` one travels nowhere. Folding a
 * widening was the first version of this and was a new hole on the majority
 * backend, where `a/Foo.md` really is a different file from the `a/foo.md` its
 * owner published. A fold reads across case; it never writes across one.
 *
 * `visibilityOf`'s folder rules are deliberately NOT folded. Re-casing a folder
 * makes every prefix miss and the default `private` takes over, which already
 * fails closed; folding them would make a `team` rule match folders its author
 * did not name, which fails open. The two halves differ in direction, not in rigour.
 */
function foldPath(key) {
  return key.normalize("NFC").toLowerCase();
}

/** Dot-prefixed segments (.history, .obsidian, …) are plumbing, never notes. */
export function isPlumbing(key) {
  const folded = foldPath(key);
  return (
    folded === PRIVACY_KEY ||
    folded === LEGACY_SCOPES_KEY ||
    key.split("/").some((s) => s.startsWith("."))
  );
}

/**
 * The overrides map, with the folded lookup precomputed.
 *
 * `overrideFor` has to answer "is there a private override folding onto this
 * key", and the honest way to do that with a plain `Map` is to scan it. That is
 * per-note work on the search hot path: measured over 8,000 documents with 200
 * private overrides, `canSee` went from 6.1ms to 214.1ms — which hands back a
 * large slice of the 1,439ms → 670ms this project banked in "A search is paced".
 *
 * So the folded set is built once and thrown away on any write. Rebuilt on
 * read rather than maintained incrementally, because an index kept in step by
 * arithmetic is an index that can drift, and the direction it would drift is a
 * narrowing that stops being found.
 *
 * It is an accelerator and never the authority: `overrideFor` falls back to the
 * scan for a plain `Map`, so the ANSWER never depends on which container a
 * caller happens to hold — the differential test passes plain maps, and the
 * control plane's `new Map(overrides)` copies are plain by construction. A
 * container that changed the answer is the bug that shipped in this PR's first
 * version.
 */
export class PrivacyOverrides extends Map {
  set(key, value) {
    this.folds = null;
    return super.set(key, value);
  }

  delete(key) {
    this.folds = null;
    return super.delete(key);
  }

  // No caller today, and that is exactly why it is here: it is the one
  // remaining mutation that would leave the index standing over an empty map.
  clear() {
    this.folds = null;
    return super.clear();
  }

  /**
   * The narrowest narrowing override at each folded path.
   *
   * Was `privateFolds`, a `Set` of the paths carrying `private`. A group is a
   * narrowing too — a `team` folder with one note held back to `@supa-leads`
   * is exactly the shape the fold exists for — so the index has to carry
   * *which* narrowing rather than merely that there is one, and a `Map`
   * replaces the `Set`. `team` is still the one value that never travels.
   */
  narrowingFolds() {
    if (!this.folds) {
      // Built whole, then published — never filled in place. A throw partway
      // through would otherwise cache a SHORT index, and a short index answers
      // "no private fold" where there is one, which is the one direction this
      // must never fail in. `foldPath` cannot throw on a string today; the
      // control plane's copy is written the same way, and two copies of one
      // rule are held here by being identical rather than by a comment.
      const folds = new Map();
      for (const [key, visibility] of this) {
        if (visibility === "team") continue;
        const folded = foldPath(key);
        folds.set(folded, narrowerVisibility(folds.get(folded), visibility));
      }
      this.folds = folds;
    }
    return this.folds;
  }
}

/**
 * The exact-note overrides, looked up so the fold cannot be left out.
 *
 * A `Map` subclass that folded inside `get`/`has` was the first shape of this
 * and was wrong: it folds only for maps this module built, so a caller holding
 * a plain `Map` — `__tests__/privacyEngine.test.ts` passes one, and the control
 * plane's `nextOverrides` copies with `new Map(overrides)` — silently got the
 * unfolded answer, and the two engines then disagreed about a live note. Which
 * is the one failure that whole test file exists to prevent.
 *
 * So the fold lives in this helper, over any map, and `PrivacyOverrides` below
 * only makes it fast. The container may change the speed; it may never change
 * the answer.
 */
export function overrideFor(overrides, key) {
  if (!overrides) return undefined;
  const exact = overrides.get(key);
  if (exact === "private") return "private";
  // Only a NARROWING travels by fold. A `team` override reaching a note the
  // owner did not name is the same failure that keeps folder rules unfolded,
  // and on a case-sensitive store — R2, S3, every context deployed today —
  // `a/Foo.md` really is a different file from the `a/foo.md` that was
  // published. Two entries that fold together are one file on Dropbox and a
  // contradiction the owner never resolved; `private` is the answer that
  // cannot leak. `foldPath` runs only over private entries for the same
  // reason it runs at all.
  const folded = foldPath(key);
  let narrow;
  // `instanceof`, not a duck-typed `typeof … === "function"`. The port uses
  // `instanceof PrivacyOverrides` and the two must not differ in what they
  // TRUST: a duck-typed check hands the privacy answer to any object carrying
  // a method of that name, and the accelerator may never be the authority.
  if (overrides instanceof PrivacyOverrides) {
    narrow = overrides.narrowingFolds().get(folded);
  } else {
    for (const [existing, visibility] of overrides) {
      if (visibility === "team") continue;
      if (foldPath(existing) === folded) narrow = narrowerVisibility(narrow, visibility);
    }
  }
  if (narrow === undefined) return exact;
  return narrowerVisibility(narrow, exact);
}

/**
 * Whether any override names this note, under any casing.
 *
 * Deliberately wider than `overrideFor`: it folds a `team` override too. Every
 * caller either REFUSES when an override exists, or — at `fastArchiveCandidate`
 * — takes a slower path that re-reads through `overrideFor`, so a folded twin
 * of either visibility only ever refuses more or works harder. It is not a
 * visibility answer and must not be used as one; that is what would put the
 * widening back.
 */
export function hasOverride(overrides, key) {
  if (!overrides) return false;
  if (overrides.has(key)) return true;
  const folded = foldPath(key);
  for (const existing of overrides.keys()) {
    if (foldPath(existing) === folded) return true;
  }
  return false;
}

/**
 * May this caller see this key at all?
 *
 * ## A group is reached by the grant, never by the role
 *
 * `grantedGroups` is the set of group names the caller's grant was **issued
 * with**, and it defaults to none. A connection somebody added at team tier
 * therefore cannot see, search or list a note scoped to a group *even when the
 * person holding it is in that group*: to that connection the note is private,
 * which is the answer somebody expects from a client they deliberately gave
 * the narrower tier. Widening one client is a deliberate act that lands in the
 * grant and in the audit trail — the rule `visibilityTierForGrant` already
 * follows, applied to the third kind of audience — rather than an inference
 * from a role, which is the read-time check nothing records.
 */
export function canSee(key, scope, rules, overrides, grantedGroups) {
  if (foldPath(key) === PRIVACY_KEY) return scope === "private";
  if (isPlumbing(key)) return false; // plumbing is not part of the note surface for any tool
  if (scope === "private") return true;
  const visibility = effectiveVisibility(key, rules, overrides);
  if (visibility === "team") return true;
  if (visibility === "private") return false;
  return grantedGroups !== undefined && grantedGroups.has(visibility);
}

/**
 * Where a saved session goes, and who decides.
 *
 * It used to be `4-archive/chat-history/<platform>/`, hardcoded, which assumes
 * a folder the customer may never have made — PARA is a suggestion, not a
 * schema, and a context with a custom layout got its sessions filed into a
 * folder that existed for no other reason. Worse, it named the thing after what
 * we do with it rather than what the person wants done: "archive" is where
 * things go to stop mattering.
 *
 * So the destination is the user's, declared in `index.md` (see
 * `readSaveProcedure`), and this is only what happens when they have not said.
 *
 * The fallback asks the privacy manifest rather than the bucket. A folder does
 * not exist in object storage until something is in it, so listing `4-archive/`
 * answers "has anything been archived yet", which is a different question and
 * gets a new context's first session wrong. `folder_defaults` is where the
 * scaffold declares the layout the person actually chose, so a rule naming an
 * archive means they have one and a custom layout without one means they do
 * not — and every context created before this decision has that rule, which is
 * what keeps their sessions where they have always been.
 *
 * **Which folder counts is `archiveRoot`, not the literal `4-archive`**, and
 * widening it moves this fallback for one population: a context declaring an
 * archive under another number — today, anything built from the `company`
 * preset — filed its sessions into `0-inbox/sessions` and now files them
 * beside its archive. That is the behaviour this function always described,
 * reaching contexts it had been failing to recognise; sessions already written
 * stay where they are and are still read, and an owner who stated a
 * destination in `index.md` was never affected either way.
 */
/**
 * A root folder this product recognises as an archive: `archive`, or a PARA-ish
 * `<number>-archive`.
 *
 * It was the literal `4-archive` and that was a layout assumption wearing the
 * clothes of a constant. The product itself ships two: the PARA scaffold's
 * `4-archive` and the `company` workspace preset's `5-archive` — which is the
 * *default* for a shared context — so every workspace created from the default
 * preset had a folder plainly named the archive, sitting in its own root
 * listing, that `archive_note` refused to use and `save_context` declined to
 * see. A customer archived into it by hand and was told the context had no
 * archive.
 *
 * Deliberately a shape and not a list. A list would be the same assumption with
 * one more entry, and the next preset would reintroduce the bug; `9-archive`,
 * `archive` and `2-Archive` are all the owner unmistakably naming the thing.
 * What it will still not do is guess: `retired`, `old` and `cold-storage` are
 * words for the same idea that this cannot read off a folder name, and inventing
 * a destination in somebody's bucket is what the original refusal was right
 * about.
 */
const ARCHIVE_FOLDER_PATTERN = /^(?:\d+-)?archive$/i;

/**
 * Every archive root this context declares, deduplicated and ordered.
 *
 * A rule may name the folder (`4-archive`) or something inside it
 * (`4-archive/chat-history`); both say the folder exists, so the root segment
 * is what is matched. More than one is not hypothetical — a PARA context whose
 * owner adds `5-archive`, or the reverse — which is why "already archived"
 * asks about all of them and not only the one we would write to.
 */
export function archiveRoots(rules) {
  const roots = new Set();
  for (const rule of rules || []) {
    const root = String(rule?.prefix ?? "").split("/")[0];
    if (ARCHIVE_FOLDER_PATTERN.test(root)) roots.add(root);
  }
  return [...roots].sort();
}

/**
 * The one this context archives into, or `null` when it has none.
 *
 * **`4-archive` wins whenever it is declared at all**, so no context that
 * already had one can have its archive moved by this change — a PARA workspace
 * that later gains a `5-archive` keeps filing where its history already is.
 * Everything else takes the first in sorted order, which is a rule about the
 * set rather than about the order somebody's manifest happens to be in: an
 * owner reordering `privacy.md` must not silently repoint archiving.
 */
export function archiveRoot(rules) {
  const roots = archiveRoots(rules);
  if (roots.length === 0) return null;
  return roots.includes("4-archive") ? "4-archive" : roots[0];
}

export function defaultSessionFolder(rules) {
  const root = archiveRoot(rules);
  return root ? `${root}/chat-history` : "0-inbox/sessions";
}
