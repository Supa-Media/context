/**
 * What a move may do to visibility: destination checks, and the privacy rules
 * that survive a folder moving.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import {
  type PrivacyRule,
  type Visibility,
  effectiveVisibility,
  narrowerVisibility,
  hasOverride,
  visibilityOf,
} from "../privacy";
import { type Clearance } from "../clearance";
import { notFound } from "./errors";
import type { PrivacyState } from "./privacyState";

/**
 * May this caller write here, and be told what is already here?
 *
 * The gateway's `move_note` asks exactly this, in exactly this way, and three
 * earlier answers on this branch were wrong in three different directions:
 *
 *  - `canSee(destination)` alone. A move carries the source's exception onto
 *    the destination so the note keeps its visibility, which made the check
 *    true for ANY destination — a note the owner had shared out of a private
 *    folder was a key that opened every folder.
 *  - `canSee` plus `folderVisibleAtScope(parentOf(destination))`.
 *    `folderVisibleAtScope` answers "should this folder appear in the tree",
 *    and it says yes when ANY `team` exception exists anywhere beneath it —
 *    that is its documented job, so a folder is reachable in the tree the
 *    moment one note in it is shared. Reusing it as a write predicate reopened
 *    the whole subtree: one shared note under `2-areas/deep/sub/` made every
 *    path under `2-areas/` probeable again.
 *  - And it skipped the bucket root entirely, because `parentOf` returns `""`
 *    there and the check was guarded on that. The root is where `index.md`,
 *    `privacy.md` and `todo.md` live; a team caller could probe them and, on a
 *    bucket without one, create `index.md` — the front page the product says it
 *    never generates.
 *
 * So the question is asked of the destination path itself, against the folder
 * defaults as they will stand, and it has one answer at the root as everywhere
 * else: no rule reaches it, so it is private, so a team caller may not land
 * there. `visibilityOf` rather than `effectiveVisibility` because an exception
 * is about one note and this is about a place — and a destination that already
 * carries an exception is refused outright, so a caller can never land on a
 * note whose visibility is unusual, nor learn from the attempt that it is.
 *
 * The cost, which is a real behaviour change: a team caller can no longer move
 * or rename a shared note that lives inside a private folder, because the place
 * it would land is private even though the note is not. The gateway has always
 * refused that, and every time this branch has diverged from the gateway it has
 * been the branch that was wrong.
 */
export function assertDestinationsVisible(
  destinations: readonly string[],
  clearance: Clearance,
  rules: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
): void {
  for (const destination of destinations) {
    if (clearance.scope === "private") continue;
    // The place, then the note that may already be in it.
    //
    // `visibilityOf` and not `effectiveVisibility`: they differ only when the
    // destination carries an exception, and the line below refuses that case
    // outright — so swapping them changes no outcome, which is measured rather
    // than assumed. They are kept apart because they answer different
    // questions, and the second is what stops a caller landing on a note whose
    // visibility is unusual.
    //
    // It does NOT stop them learning that one is there. A refusal where a free
    // name would have succeeded says an exception exists at that path, and that
    // is inherent to per-note exceptions rather than a hole here: `writeFile`
    // has the same shape and says so, and the gateway's `move_note` has it too.
    // An earlier version of this comment claimed otherwise. What is bounded is
    // the folder: the line above means a caller can only learn this about
    // places they may already write.
    //
    // No plumbing check: `assertWritablePath` has already refused a reserved
    // `to`, and every destination is `to` plus a suffix taken from a source key
    // the walk kept, which filtered plumbing out. A dot segment cannot appear.
    // Instrumented before this was written, rather than after.
    if (visibilityOf(destination, rules) !== "team") throw notFound();
    if (hasOverride(overrides, destination)) throw notFound();
  }
}

/**
 * The same question, asked of the manifest as it stands.
 *
 * This used to be asked of the rules the move would LEAVE BEHIND, so that a
 * folder carrying its own `team` rule could be renamed inside a private parent
 * — the rule travels, so the caller can still see the result. That reasoning is
 * wrong in the one way this file has now been wrong four times: the predicate
 * was satisfied by the rule the move itself installs. A guard that reads its
 * own seeding answers on the strength of the thing being asked about, which is
 * exactly what the comment on `assertDestinationsVisible` said had been
 * eliminated — for the overrides, while the rules kept doing it.
 *
 * What it cost: a team caller holding one shared folder could move it at any
 * hidden path and read the answer. An existing folder they could not see
 * refused; a free name succeeded. One guess at a time over the owner's entire
 * hidden namespace — and on success the move landed, `remapPrivacy` wrote
 * `<their guess>: team` into `privacy.md`, and an EDITOR had thereby set folder
 * visibility inside the owner's private tree, which `setFolderVisibility`
 * reserves to the owner.
 *
 * The benign rename and the hostile probe are the same operation with a
 * different name typed into it, so no predicate separates them. The rename goes.
 * The gateway's `move_folder` has always judged the destination against current
 * rules and has never renamed a folder rule.
 */
export function assertMoveDestinationsVisible(
  pairs: readonly { source: string; destination: string }[],
  clearance: Clearance,
  state: PrivacyState,
): void {
  assertDestinationsVisible(
    pairs.map((pair) => pair.destination),
    clearance,
    state.rules,
    state.overrides,
  );
}

/**
 * The rules a rewrite must put back, because a survivor's visibility rests on
 * them.
 *
 * A bulk operation at team scope leaves the notes it could not see behind, and
 * the rules under that folder then describe two places at once. Both blunt
 * answers are wrong: rewriting them all stops a nested rule protecting the note
 * it was written for — and because `visibilityOf` takes the longest matching
 * prefix, that does not demote the note to the default, it PROMOTES it to the
 * nearest surviving ancestor, which is the `team` folder the caller is standing
 * in. Keeping them all makes the kept rule its own disclosure.
 *
 * So: a rule comes back only where a survivor actually needs it, and "needs"
 * is asked of the REWRITE, not of the rule.
 *
 * The first version asked it of the rule — "would removing *this one* change a
 * survivor?" — one rule at a time. That is a different question and it fails
 * whenever two rules cover a survivor redundantly (`…/hr: private` and
 * `…/hr/comp: private`, which is what an owner who tightened a folder and then
 * a subfolder has). Removing either alone changes nothing, so neither was
 * needed, so BOTH were dropped and the note went to the team ancestor. A
 * per-element counterfactual cannot see a set effect; this compares the whole
 * before against the whole after, and repairs what actually moved.
 *
 * One pass suffices. A survivor whose visibility changed is repaired by the
 * rule that decided it *before* — the longest prefix matching it — and nothing
 * in the rewritten set can outrank that, because the rewritten rules live under
 * the destination and everything else covering a survivor is an ancestor, which
 * is shorter. Ties go to the first rule, matching `visibilityOf`.
 */
export function rulesSurvivorsRestOn(
  before: readonly PrivacyRule[],
  after: readonly PrivacyRule[],
  overrides: ReadonlyMap<string, Visibility>,
  survivors: readonly string[],
  folder: string,
): PrivacyRule[] {
  if (survivors.length === 0) return [];
  // Narrowing, not a check. A rule outside this folder is already in `after`
  // untouched, so it can never be the one a survivor lost — dropping this
  // filter changes no outcome, which is measured rather than assumed. It stays
  // because it bounds the search to the rules this rewrite could have moved.
  const candidates = before.filter(
    (rule) => rule.prefix === folder || rule.prefix.startsWith(`${folder}/`),
  );
  if (candidates.length === 0) return [];

  const kept: PrivacyRule[] = [];
  for (const key of survivors) {
    if (
      effectiveVisibility(key, before, overrides) ===
      effectiveVisibility(key, [...after, ...kept], overrides)
    ) {
      continue;
    }
    let determining: PrivacyRule | null = null;
    for (const rule of candidates) {
      if (key !== rule.prefix && !key.startsWith(`${rule.prefix}/`)) continue;
      if (determining === null || rule.prefix.length > determining.prefix.length) {
        determining = rule;
      }
    }
    // Either of these alone is redundant given the other, and they are
    // load-bearing as a pair: the comparison above stops a second survivor
    // re-pushing a rule the first restored, and this stops a repeat when that
    // comparison is bypassed. Remove BOTH and the delete path emits the same
    // rule twice, because `forgetPrivacy` does not run `oneRulePerPrefix` and
    // nothing downstream tidies it. Measured both ways — do not read "each is
    // redundant" as "either may go".
    if (determining !== null && !kept.includes(determining)) kept.push(determining);
  }
  return kept;
}

/**
 * One rule per prefix, and the more private of a pair wins.
 *
 * A rename can land a rule on a prefix that already had one - move `src` onto
 * `dst` when `src/hr` and `dst/hr` both carry rules - and the manifest then
 * holds two lines for the same folder with opposite visibility. `visibilityOf`
 * takes the first of equal length and `renderPrivacyRulesBlock`'s sort is
 * stable, so whichever it is survives the round trip and the file says two
 * things at once. Measured: `1-projects/dst/hr` emitted as both `team` and
 * `private`.
 *
 * The collision has no right answer - the arriving folder and the one already
 * there both have a claim - so it is resolved in the only direction that
 * cannot leak: the narrower of the two survives.
 *
 * That used to be spelled `existing.vis === "team" && rule.vis === "private"`,
 * which was the same thing while there were two values and stopped being it
 * the day a rule could name a group. Nothing in that test narrows `team` to a
 * group, and nothing narrows a group to `private`, so renaming a folder whose
 * subfolder was held back to `@supa-leads` over one whose matching subfolder
 * was `team` kept `team` - every note under it readable by the whole
 * workspace, from a rename. `narrowerVisibility` is the engine's own order and
 * is identical to the old test on the two tiers.
 */
export function oneRulePerPrefix(rules: readonly PrivacyRule[]): PrivacyRule[] {
  const byPrefix = new Map<string, PrivacyRule>();
  for (const rule of rules) {
    const existing = byPrefix.get(rule.prefix);
    if (existing === undefined) {
      byPrefix.set(rule.prefix, rule);
      continue;
    }
    const narrower = narrowerVisibility(existing.vis, rule.vis);
    // Keep the rule object whose value won, and prefer the incumbent on a tie
    // so the pass stays stable. Two different groups narrow to `private`, which
    // is neither rule's object - it is written as a fresh one rather than
    // dropped, because "neither claim survives" must still leave a rule.
    if (narrower === existing.vis) continue;
    byPrefix.set(rule.prefix, narrower === rule.vis ? rule : { prefix: rule.prefix, vis: narrower as Visibility });
  }
  return [...byPrefix.values()];
}

/** The folder rules a folder move leaves behind. `remapPrivacy` applies this. */
export function rulesAfterFolderMove(
  rules: readonly PrivacyRule[],
  folderMove: { from: string; to: string } | null,
): readonly PrivacyRule[] {
  if (folderMove === null) return rules;
  const { from, to } = folderMove;
  return rules.map((rule) =>
    rule.prefix === from || rule.prefix.startsWith(`${from}/`)
      ? { prefix: `${to}${rule.prefix.slice(from.length)}`, vis: rule.vis }
      : rule,
  );
}
