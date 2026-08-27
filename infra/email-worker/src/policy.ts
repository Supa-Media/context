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
 * WHAT THE MATCHER IS NOT — AND THIS IS NOW THE IMPORTANT PART
 * ============================================================================
 *
 * **It filters. It does not authenticate.**
 *
 * This block used to say that `./ingest.ts` establishes the sender's identity
 * before any address reaches this matcher, so the list only ever ran against
 * something the sender had proved. That is no longer true, and leaving it
 * standing would make this the most dangerous stale comment in the Worker.
 *
 * `./auth.ts` still evaluates SPF/DKIM/DMARC in full, but its verdict is now a
 * **label written into the capture note**, not a gate — see the block at the
 * top of that file for the two real deliveries that settled the decision and
 * the reasoning behind it. So the address handed to `senderIsAllowed` is, when
 * nothing authenticated, the `From:` addr-spec: a string the sender typed.
 *
 * The consequence, stated rather than implied:
 *
 *  - A sender who knows one address on somebody's list can put that address in
 *    `From:` and be captured. This list does not stop them.
 *  - What it *does* do is keep the ordinary internet out: someone who does not
 *    know the capture address, or does not know who is on the list, gets
 *    nothing. That is real, and it is worth having.
 *  - `allowAnySender: true` means literally any sender. It never meant "any
 *    sender who is really who they say they are" — that sentence belonged to
 *    the gate — and it now means less than it did.
 *  - What protects the reader is the note, not this function.
 *    `renderCaptureNote` marks an unverified capture as unverified, names no
 *    authentication method it did not observe, and says in prose that the
 *    sender address may be spoofed.
 *
 * Two things follow for anyone editing here. Do not describe this list as a
 * security boundary anywhere — not in this file, and not in the console copy in
 * `apps/mobile/features/console/ingestion/`, which had to be rewritten for the
 * same reason. And do not "restore" the gate in `./ingest.ts` on the strength
 * of this paragraph: the gate refused ordinary forwarded mail, which is the
 * product.
 *
 * One thing it still does that is worth keeping: `senderIsAllowed` returns
 * false for an unparseable address *before* it consults `allowAnySender`, so a
 * message with no usable `From:` is refused even under "anyone".
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
 * `allowAnySender: true` means any sender at all: a message whose SPF, DKIM and
 * DMARC all failed reaches this function exactly as one that passed does, and
 * under that flag it is admitted. The capture note is where the difference is
 * recorded. See the block above.
 */
export { senderIsAllowed } from "../../../apps/convex/functions/lib/ingestion";

import type { IngestionPolicy } from "../../../apps/convex/functions/lib/ingestion";

export type SenderMatcher = (from: string, policy: IngestionPolicy) => boolean;
