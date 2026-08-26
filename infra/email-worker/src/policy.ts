/**
 * The seam to the control plane's ingestion-policy matcher.
 *
 * ============================================================================
 * THIS FILE DELIBERATELY DOES NOT IMPLEMENT SENDER MATCHING
 * ============================================================================
 *
 * `senderIsAllowed` lives in `apps/convex/functions/lib/` and is a pure
 * function shared by the control plane (which validates and stores a policy)
 * and this Worker (which enforces it). One matcher, one set of tests, one place
 * where a subtle rule lives.
 *
 * The rules that make a second implementation dangerous, and which this Worker
 * therefore must not restate:
 *
 * - **A domain entry is exact equality, never a suffix test.** `example.com`
 *   admits `example.com` and nothing else — not `mail.example.com`, and
 *   emphatically not `evil-example.com` or `example.com.evil.test`, which a
 *   `endsWith` check happily admits. Subdomains are listed individually.
 * - **Sub-address tags are stripped for matching, asymmetrically.** A bare
 *   entry (`alice@example.com`) admits any tag (`alice+notes@example.com`); an
 *   entry that names a tag (`alice+notes@example.com`) is literal and admits
 *   only that tag.
 *
 * Both are the kind of rule that gets "simplified" into a bypass. Call the
 * function.
 *
 * ============================================================================
 * WIRING STATUS — READ BEFORE DEPLOYING
 * ============================================================================
 *
 * As of this package's first commit, `apps/convex/functions/lib/` does not yet
 * export `senderIsAllowed`; it is being written in parallel. Rather than
 * inline a placeholder matcher that would look like the real thing and could
 * survive review, this module exports a matcher that **denies everything** and
 * a flag saying so.
 *
 * The consequence is deliberate: until the real matcher is imported here, this
 * Worker refuses every message. That is the correct fail-closed posture for an
 * ingestion path whose only protection is a policy check, and it makes the
 * missing wiring impossible to miss — an unwired deployment ingests nothing at
 * all rather than ingesting everything.
 *
 * **To wire it**, replace the body of this module with:
 *
 *     export { senderIsAllowed } from "../../../apps/convex/functions/lib/<module>";
 *     export const SENDER_MATCHER_WIRED = true;
 *
 * keeping `IngestionPolicy` in agreement with what that module exports, and
 * delete `denyEverything`. Nothing else in this package changes: `ingest.ts`
 * takes the matcher as an argument and its tests inject their own.
 */

/**
 * The policy the control plane stores **per user**, governing that person's own
 * personal context — the only kind email can reach.
 *
 * That it is a user-level record is what makes the default coherent. The
 * sensible starting allow-list is "the address you signed up with", which is a
 * fact about a person; asked of a shared context it had no answer at all
 * ("whose email?"), and a policy whose default nobody can state is a policy
 * that gets set to allow-anything.
 *
 * Structurally identical to what `senderIsAllowed` expects. Declared here (and
 * re-declared, not imported, while the seam is unwired) so this package
 * typechecks on its own; once wired, prefer importing the type from the same
 * module as the function so the two cannot drift.
 */
export interface IngestionPolicy {
  /** Full addresses. Sub-address matching per the rules above. */
  allowedSenders: readonly string[];
  /** Bare domains. Exact equality only. */
  allowedDomains: readonly string[];
  /**
   * When true, any *authenticated* sender is accepted.
   *
   * Note what it does not mean: it never bypasses `verifySender`. An address
   * that failed SPF/DKIM/DMARC alignment is refused under this flag exactly as
   * it is under a list. "Any sender" means any sender who is really who they
   * say they are.
   */
  allowAnySender: boolean;
}

export type SenderMatcher = (from: string, policy: IngestionPolicy) => boolean;

/**
 * The unwired matcher. Refuses everything, unconditionally.
 *
 * Not exported as `senderIsAllowed` by accident: the name is deliberately not
 * the real one, so a grep for the real name finds the import that should be
 * here and not a local definition pretending to be it.
 */
const denyEverything: SenderMatcher = () => false;

/** False until the real matcher is imported. See the block comment above. */
export const SENDER_MATCHER_WIRED = false;

export const senderIsAllowed: SenderMatcher = denyEverything;
