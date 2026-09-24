/**
 * Rewriting `privacy.md` safely when paths move, copy or disappear.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import {
  PRIVACY_KEY,
  type PrivacyRule,
  type Visibility,
  clearedOverrides,
  effectiveVisibility,
  narrowerVisibility,
  hasOverride,
  movedOverrides,
  nextOverrides,
  overrideFor,
  replacePrivacyRulesBlock,
  visibilityOf,
} from "../privacy";
import { MANIFEST_CAS_ATTEMPTS, type FileStore } from "./store";
import { FileOpError } from "./errors";
import { loadPrivacyState } from "./privacyState";
import { rulesSurvivorsRestOn, oneRulePerPrefix, rulesAfterFolderMove } from "./moveRules";

/* -------------------------------------------------------------------------- */
/*                          rewriting privacy.md safely                       */
/* -------------------------------------------------------------------------- */

/**
 * Read-modify-write the manifest under compare-and-swap.
 *
 * The manifest is the one file several actors edit concurrently — the console,
 * the gateway on behalf of an AI client, and the customer in Obsidian — and a
 * lost update here is not a lost paragraph, it is a note that was supposed to
 * be private and is not. So the write is conditional on the etag we read, and
 * a failed precondition re-reads and re-applies rather than retrying blind.
 *
 * The same five-attempt loop the gateway's `persistExactVisibility` uses.
 */
export async function mutateManifest(
  store: FileStore,
  change: (current: { rules: PrivacyRule[]; overrides: Map<string, Visibility> }) => {
    rules: PrivacyRule[];
    overrides: Map<string, Visibility>;
  },
): Promise<{ rules: PrivacyRule[]; overrides: Map<string, Visibility> }> {
  for (let attempt = 0; attempt < MANIFEST_CAS_ATTEMPTS; attempt += 1) {
    const state = await loadPrivacyState(store);
    if (state.text === null) {
      throw new FileOpError(
        "PRIVACY_MANIFEST_MISSING",
        "This bucket has no privacy.md, so there is nothing to record visibility in. Write one at the root of the bucket — everything stays private until you do.",
      );
    }
    if (state.invalid) {
      throw new FileOpError(
        "PRIVACY_MANIFEST_INVALID",
        "privacy.md could not be read. Fix or remove its managed rules block, then try again.",
      );
    }

    const next = change({ rules: state.rules, overrides: state.overrides });
    const text = replacePrivacyRulesBlock(state.text, next.rules, next.overrides);
    if (text === state.text) return next; // nothing changed; do not churn the file

    const put =
      store.capabilities?.conditionalWrite === true && state.etag !== null
        ? await store.put(PRIVACY_KEY, text, { onlyIf: { etagMatches: state.etag } })
        : await store.put(PRIVACY_KEY, text);
    if (put !== null) return next;
  }
  throw new FileOpError(
    "PRIVACY_MANIFEST_BUSY",
    "Your visibility settings are being changed somewhere else. Try again.",
  );
}

/** Carry exceptions across a move, including the folder's own default rule. */
export async function remapPrivacy(
  store: FileStore,
  change: {
    moves: { from: string; to: string }[];
    folderMove: { from: string; to: string } | null;
    /** Notes the walk could not see, which stayed where they were. */
    survivors: readonly string[];
  },
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return; // nothing to keep in sync

  const touchesOverride = change.moves.some(({ from }) => hasOverride(state.overrides, from));
  const touchesRule =
    change.folderMove !== null &&
    state.rules.some(
      (rule) =>
        rule.prefix === change.folderMove!.from ||
        rule.prefix.startsWith(`${change.folderMove!.from}/`),
    );
  /*
    What each moved note was actually visible as, which is a different question
    from whether it had an exception — and the difference is the whole of this
    block.

    A note is usually private because its FOLDER is, with nothing in the
    manifest naming the note at all. That fact does not travel with it: carry
    only the exceptions and the inherited case lands on the destination's rule,
    so dragging a note out of a private folder into a shared one published it,
    to exactly the people the folder was private from. `movePath`'s own header
    has always said this must not happen; it said it about the exception, which
    is the case that was handled.

    The gateway has narrowed a move against its destination since `move_note`
    was written — `narrowerVisibility(sourceVisibility, visibilityOf(destination))`
    — and this is that rule on this side of the platform split, computed from
    the manifest as it was BEFORE the move.
  */
  const wasVisibleAs = new Map<string, Visibility>();
  for (const move of change.moves) {
    wasVisibleAs.set(move.from, effectiveVisibility(move.from, state.rules, state.overrides));
  }
  const mayWiden = change.moves.some((move) => wasVisibleAs.get(move.from) === "private");
  if (!touchesOverride && !touchesRule && !mayWiden) return;

  await mutateManifest(store, (current) => {
    const rules = [...rulesAfterFolderMove(current.rules, change.folderMove)];
    // The renamed set describes where the moved notes went. Anything a note
    // left behind still depends on has to stay where that note is.
    if (change.folderMove !== null) {
      rules.push(
        ...rulesSurvivorsRestOn(
          current.rules,
          rules,
          current.overrides,
          change.survivors,
          change.folderMove.from,
        ),
      );
    }
    /*
      A folder that was private only because its parent was needs ONE rule at
      the destination, not an exception per note: a 500-note folder would
      otherwise write 500 lines into a customer's `privacy.md` to say what one
      line says. `rulesAfterFolderMove` has already carried a rule the folder
      owned itself, so this fires only where the folder owned none.
    */
    if (change.folderMove !== null) {
      const ownsRule = current.rules.some((rule) => rule.prefix === change.folderMove!.from);
      const inherited = visibilityOf(change.folderMove.from, current.rules);
      if (!ownsRule && inherited === "private" && visibilityOf(change.folderMove.to, rules) === "team") {
        rules.push({ prefix: change.folderMove.to, vis: inherited });
      }
    }
    const deduped = oneRulePerPrefix(rules);
    let overrides = current.overrides;
    for (const move of change.moves) {
      overrides = movedOverrides(move.from, move.to, deduped, overrides);
      // Only where the note had no exception of its own: `movedOverrides` has
      // already re-derived that case against the destination, and re-deriving
      // it a second time here would quietly retier an owner's deliberate
      // exception. `nextOverrides` writes nothing where the destination folder
      // already gives the note what it had, so a move that widens nothing
      // leaves the manifest untouched.
      if (hasOverride(current.overrides, move.from)) continue;
      const was = wasVisibleAs.get(move.from);
      if (was === undefined) continue;
      // `narrowerVisibility` is typed for two optional arguments, so it answers
      // optionally; both of these are present, and the guard says so rather
      // than asserting it.
      const carry = narrowerVisibility(was, visibilityOf(move.to, deduped));
      if (carry === undefined) continue;
      overrides = nextOverrides(move.to, carry, deduped, overrides);
    }
    return { rules: deduped, overrides };
  });
}

/**
 * Give a copy what its original had — its exception where it had one, and
 * otherwise the visibility its folder gave it.
 *
 * The second half is the same fact `remapPrivacy` turns on, and it is not the
 * rarer half: a note is usually private because its FOLDER is, with nothing in
 * the manifest naming the note. Carrying only exceptions meant a copy taken
 * into a shared folder arrived readable by every member, and the copy is the
 * operation where that is hardest to notice — the original is still sitting
 * where it was, still private, so nothing the owner is looking at changed.
 *
 * Narrowed against the destination, never widened, exactly as a move is.
 */
export async function copyPrivacy(
  store: FileStore,
  pairs: { from: string; to: string }[],
  folderCopy: { from: string; to: string } | null = null,
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;
  const wasVisibleAs = new Map<string, Visibility>();
  for (const pair of pairs) {
    wasVisibleAs.set(pair.from, effectiveVisibility(pair.from, state.rules, state.overrides));
  }
  const carriesSomething = pairs.some(
    ({ from }) => hasOverride(state.overrides, from) || wasVisibleAs.get(from) === "private",
  );
  if (!carriesSomething) return;

  await mutateManifest(store, (current) => {
    // One rule for a copied folder that was private only because its parent
    // was, for `remapPrivacy`'s reason: an exception per note turns a
    // customer's `privacy.md` into a list of everything they ever copied.
    const rules = [...current.rules];
    if (folderCopy !== null) {
      const inherited = visibilityOf(folderCopy.from, current.rules);
      if (inherited === "private" && visibilityOf(folderCopy.to, current.rules) === "team") {
        rules.push({ prefix: folderCopy.to, vis: inherited });
      }
    }
    const deduped = oneRulePerPrefix(rules);
    let overrides = current.overrides;
    for (const pair of pairs) {
      const existing = overrideFor(current.overrides, pair.from);
      const was = wasVisibleAs.get(pair.from);
      // An exception is carried as it stands — the owner chose it, and
      // re-deriving it here would retier that choice. Only the inherited case
      // is computed, and `nextOverrides` writes nothing where the destination
      // folder already gives the copy what the original had.
      const carry =
        existing ?? (was === undefined ? undefined : narrowerVisibility(was, visibilityOf(pair.to, deduped)));
      if (carry === undefined) continue;
      overrides = nextOverrides(pair.to, carry, deduped, overrides);
    }
    return { rules: deduped, overrides };
  });
}

/** Drop rules for things that no longer exist. */
export async function forgetPrivacy(
  store: FileStore,
  keys: string[],
  deletedFolder: string | null,
  /** Notes the walk could not see, which were not deleted. */
  survivors: readonly string[],
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;

  const keyHasOverride = keys.some((key) => hasOverride(state.overrides, key));
  const hasRule =
    deletedFolder !== null &&
    state.rules.some(
      (rule) => rule.prefix === deletedFolder || rule.prefix.startsWith(`${deletedFolder}/`),
    );
  if (!keyHasOverride && !hasRule) return;

  await mutateManifest(store, (current) => {
    let overrides = current.overrides;
    for (const key of keys) overrides = clearedOverrides(key, overrides);
    let rules = current.rules;
    if (deletedFolder !== null) {
      const dropped = current.rules.filter(
        (rule) =>
          rule.prefix !== deletedFolder && !rule.prefix.startsWith(`${deletedFolder}/`),
      );
      // A rule a surviving note's visibility rests on is not this folder's to
      // forget — the note is still here and still needs it.
      rules = dropped.concat(
        rulesSurvivorsRestOn(current.rules, dropped, current.overrides, survivors, deletedFolder),
      );
    }
    return { rules, overrides };
  });
}
