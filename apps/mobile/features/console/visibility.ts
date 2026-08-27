/**
 * How much of the selected context the person at the keyboard can actually see
 * — and the words the console is allowed to use about it.
 *
 * ## The fact this module renders
 *
 * A context has exactly one owner. Everybody else is there because that owner
 * put them there, which is `team` (CLAUDE.md #5), and `team` is all they get:
 * a note the owner marked private is not dimmed, not locked, not listed — it
 * fails to read byte-identically to a note that never existed. Two independent
 * places enforce that and neither consults a scope first:
 *
 *   - `scopeForRole` in `apps/convex/functions/files.ts`, for the console;
 *   - `visibilityTierForGrant` in `apps/mcp/src/session.js`, for the gateway,
 *     which answers `team` for any non-owner *before* it reads the grant.
 *
 * So the guarantee already holds. It was simply invisible: nothing in the
 * interface ever said "you are looking at a filtered view of somebody else's
 * notes", which leaves an editor to conclude from an empty folder that the
 * folder is empty.
 *
 * ## Why this file stores nothing
 *
 * The tier is **derived from `role` at render time and never written down.**
 * CLAUDE.md is explicit that a tier stored twice is a tier that can disagree
 * with itself, and that the direction it fails is "an AI client reads more than
 * the person allowed". A cached copy of this answer would be exactly that
 * second representation, so there is none: every function here is pure, takes
 * the role, and returns strings.
 *
 * It is also not the same question as `features/consent/scopes.ts` answers.
 * `tierCeilingForRole` says what a person may *hand over* to an AI client;
 * this says what they can *see themselves*. The two tables agree today because
 * you cannot delegate what you cannot read, but they are different questions
 * and collapsing them is how the consent screen's old bug came back.
 *
 * ## Why an unrecognised role says nothing
 *
 * `undefined` means the first Convex round-trip has not landed. There is a
 * tempting shortcut — "not `owner`, therefore `team`" — which is what the
 * backend does, and it would be *safe* in the sense that it never over-promises
 * access. It is still wrong here, because a chip is a claim about a named
 * context and we do not yet know which context or which role. Telling somebody
 * their own notes are filtered, for the half second before the query lands, is
 * a reassurance that is false. Silence is the only answer that cannot be wrong.
 */

/** What a role can see. `unknown` is a state, not a tier a person can hold. */
export type VisibilityTier = "private" | "team" | "unknown";

/** Every role this module recognises, spelled as the control plane spells it. */
const KNOWN_ROLES: ReadonlySet<string> = new Set(["owner", "editor", "member"]);

/**
 * The tier this role reads at.
 *
 * Mirrors `scopeForRole` in `apps/convex/functions/files.ts` for every role
 * that function accepts — `__tests__/consoleVisibility.test.ts` imports it and
 * asserts the agreement rather than claiming it here. The one difference is
 * deliberate and is at the edge the backend does not have: a role we do not
 * recognise, including the `undefined` of a context that has not loaded, is
 * `unknown` and gets said nothing about.
 */
export function visibilityTierForRole(role: string | null | undefined): VisibilityTier {
  if (role === "owner") return "private";
  if (typeof role === "string" && KNOWN_ROLES.has(role)) return "team";
  return "unknown";
}

/** True when this role is looking at somebody else's context through a filter. */
export function isFilteredView(role: string | null | undefined): boolean {
  return visibilityTierForRole(role) === "team";
}

/**
 * The pill's copy, or `null` when the console should draw no pill.
 *
 * Lower case, like `no bucket connected` and `4 active` — every chip in this
 * console is a label, not a sentence.
 */
export function tierChipLabel(role: string | null | undefined): string | null {
  return isFilteredView(role) ? "team level only" : null;
}

/**
 * What the pill means, spelled out, or `null` when there is nothing to explain.
 *
 * An `owner` gets `null`: they are not limited, and a line reassuring them that
 * they can see their own notes is noise that makes the non-owner line easier to
 * miss. The two limited roles get different sentences because the surprising
 * part is different. A `member` needs to know the view is filtered at all; an
 * `editor` needs to know that being trusted to *write* did not come with
 * seeing what the owner marked private — the exact conflation the module
 * comment in `functions/files.ts` exists to prevent.
 *
 * Voice matched to `ConsentScreen`'s `tierStatement`, which is the only other
 * place in the product that states a tier consequence to a person.
 */
export function tierSentence(role: string | null | undefined): string | null {
  if (role === "member") {
    return (
      "Team notes only — anything the owner marked private is invisible here, not hidden " +
      "behind a control you could ask for. Only a context's owner sees their private notes."
    );
  }
  if (role === "editor") {
    return (
      "Team notes only — you can edit this context, but anything the owner marked private " +
      "is invisible here. Being trusted to write is a separate thing from seeing what " +
      "somebody marked private."
    );
  }
  return null;
}

/**
 * The owner's side of the same fact: what having members does and does not
 * hand over. `null` for anybody who is not the owner, because it is a
 * statement about a decision only the owner made.
 *
 * It states the **rule**, not a count. Saying "12 of your 340 notes are visible
 * to these three people" would be better, and the console cannot honestly say
 * it: `ConsoleData` carries no note census, and the listings it does carry are
 * the caller's own filtered view loaded one folder at a time. A number derived
 * from those would be a guess drawn as a fact, which is the failure this
 * codebase already has a name for.
 */
export function memberReachSentence(role: string | null | undefined): string | null {
  if (role !== "owner") return null;
  return (
    "Everybody here reads this context at team level. Anything you marked private is yours " +
    "alone — no role, no invitation and no AI client of theirs reaches it — and the only way " +
    "to hand a private note over is to mark it team."
  );
}
