/**
 * The seam to the control plane's ingestion-policy matcher.
 *
 * ============================================================================
 * THIS FILE DELIBERATELY DOES NOT IMPLEMENT SENDER MATCHING
 * ============================================================================
 *
 * `senderIsAllowed` lives in `apps/convex/functions/lib/ingestion.ts` and is a
 * pure function shared by the control plane (which validates and stores a
 * policy) and this Worker (which enforces it). One matcher, one set of tests,
 * one place where a subtle rule lives. This module is a re-export and nothing
 * else — there is no local definition here to drift from it.
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
 * Both are the kind of rule that gets "simplified" into a bypass. `./policy.test.ts`
 * runs the attack strings through *this* import path, so a future edit that
 * replaces the re-export with a local matcher fails there rather than in
 * production.
 *
 * ============================================================================
 * WHAT THE MATCHER IS NOT
 * ============================================================================
 *
 * It is not authentication, and it must never be reached as though it were.
 * `senderIsAllowed` is handed an address; whether the sender proved that
 * address is decided earlier, by `./auth.ts`, from `Authentication-Results`.
 * `./ingest.ts` calls `verifySender` first and passes `verdict.address` here —
 * never the raw `From:` header. An allow-list applied to an unproved claim is a
 * check an attacker satisfies by typing the name of someone trusted.
 */

/**
 * The policy the control plane stores for **one person's personal context** —
 * the only kind of context email can reach.
 *
 * That it is a per-person record is what makes the default coherent. The
 * sensible starting allow-list is "the address you signed up with", which is a
 * fact about a person; asked of a shared context it had no answer at all
 * ("whose email?"), and a policy whose default nobody can state is a policy
 * that gets set to allow-anything.
 *
 * Imported rather than re-declared, so the shape this Worker enforces and the
 * shape the control plane validates on write cannot diverge.
 */
export type { IngestionPolicy } from "../../../apps/convex/functions/lib/ingestion";

/**
 * The one matcher.
 *
 * Note what `allowAnySender: true` does *not* mean: it never bypasses
 * `verifySender`. An address that failed SPF/DKIM/DMARC alignment is refused
 * under that flag exactly as it is under a list, because it never reaches this
 * function at all. "Any sender" means any sender who is really who they say
 * they are.
 */
export { senderIsAllowed } from "../../../apps/convex/functions/lib/ingestion";

import type { IngestionPolicy } from "../../../apps/convex/functions/lib/ingestion";

export type SenderMatcher = (from: string, policy: IngestionPolicy) => boolean;
