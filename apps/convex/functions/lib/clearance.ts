/**
 * What one caller is cleared to see, as a single value.
 *
 * ## Why this exists rather than a second parameter beside `scope`
 *
 * `canSee` has taken a fifth argument — the set of `@name` rules the caller
 * reaches — since the group namespace existed, and **nothing ever passed it**.
 * A search for a five-argument call matched the function's own definition and
 * nothing else. So `2-areas/hr: @atlas-leads` was a rule with no read path:
 * readable by owners, who read at `private` scope and see everything anyway,
 * and by nobody else on earth, the people in the group included.
 *
 * Wiring it up meant reaching about twenty-five `canSee` sites in `fileOps.ts`,
 * and the failure mode of threading a parameter through twenty-five sites is
 * missing one. Every miss here fails *closed* — somebody sees less than they
 * were granted — which is the right direction and still a bug nobody would
 * notice for months.
 *
 * So the clearance is **one value that replaced `scope`**, rather than a
 * parameter added beside it. A site that was not updated does not compile,
 * because `options.scope` no longer exists. The compiler is the completeness
 * check, which is what this repo asks for when it says a guard nobody has
 * checked is not a guard.
 *
 * ## Why the engines' own signature did not change
 *
 * `canSee`'s fifth parameter stays optional in both copies.
 * `__tests__/privacyEngine.test.ts` runs the gateway's *actual* functions beside
 * this port over one matrix, and a port whose signature diverges from the
 * original is the divergence rather than the repair. The threading is this
 * layer's business; the engines are untouched.
 *
 * ## A name is not a tier
 *
 * `Scope` stays two-valued, in both engines and in every grant. A granted name
 * widens what a `team` caller may reach, one rule at a time; it never becomes a
 * third clearance. That is the same shape the unlisted share took — a row
 * beside the manifest, never a third word in it — and it is what keeps a
 * rollback to an older deployment a lost feature rather than a bucket that
 * reads private.
 */

import type { Scope } from "./privacy";

/**
 * A caller's clearance: their tier, and the names they answer to.
 *
 * `names` are `@`-prefixed exactly as `privacy.md` carries them, because that
 * is what `effectiveVisibility` returns and what `canSee` compares against.
 * Normalising on one side only is how a set lookup silently never matches.
 */
export interface Clearance {
  scope: Scope;
  names: ReadonlySet<string>;
}

/** No names at all. The honest default everywhere one has not been resolved. */
export const NO_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * An owner's clearance, or any caller who reaches everything.
 *
 * `private` scope short-circuits `canSee` before any rule is consulted, so the
 * name set is irrelevant — and it is empty rather than "everything" to keep
 * that true if the short-circuit ever moves.
 */
export function privateClearance(): Clearance {
  return { scope: "private", names: NO_NAMES };
}

/**
 * Build a clearance from a tier and whatever names were resolved for it.
 *
 * Names are normalised to the `@`-prefixed form here, tolerating a bare one on
 * the way in, for the reason `setNoteGroup` tolerates it: the console renders
 * what the manifest shows and a caller passing what they see should not be a
 * silent miss. Empty and whitespace-only entries are dropped rather than
 * stored — `@` on its own is not a name, and a set holding it would match a
 * malformed rule.
 */
export function clearanceOf(scope: Scope, names: Iterable<string> = []): Clearance {
  const resolved = new Set<string>();
  for (const raw of names) {
    const trimmed = raw.trim().replace(/^@+/, "");
    if (trimmed === "") continue;
    resolved.add(`@${trimmed.toLowerCase()}`);
  }
  return { scope, names: resolved };
}
