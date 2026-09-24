/**
 * One connection, several contexts — and the clamps that make that safe.
 *
 * A grant covers every context its person is a live member of, so a client
 * connected once can address a workspace shared with its owner by passing
 * `context: "@name"` on a tool call. This suite is the half that says what that
 * must **not** buy, because reach and permission are different questions and
 * the widening only moved the first one.
 *
 * The arrangement is the one where a mistake actually leaks: two S3 tenants on
 * the same endpoint with adjacent bucket names, holding **identically named
 * notes**, one person who owns the first and is a plain `member` of the second,
 * and a third tenant they belong to not at all.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the counts as measured rather
 * than as expected:
 *
 * 1. **`sessionForContext` re-clamps the connection's already-clamped scopes**
 *    instead of the grant's own — 1 check failed, and it is the one the guest
 *    fixture exists for: a person who is a `member` where they connected lost
 *    the write they hold where they are an `editor`.
 * 2. **`sessionForContext` keeps the caller's `scope`** rather than re-reading
 *    the tier for the target's role — 2 checks failed, both of them a private
 *    note in somebody else's context reaching a member.
 * 3. **The binding answers with the session's default `workspaceId`** instead
 *    of the selected one — 8 checks failed, all on the gateway's "workspace
 *    mismatch" refusal, which is the direction that fault must fail in.
 * 4. **`sessionForContext` accepts a name outside the covered set**, forging an
 *    entry for it — only the two *shape* checks failed. The interesting half is
 *    why the rest did not: the control plane refuses to open a binding for a
 *    context that token's person is not a member of, so the gateway alone
 *    cannot reach one. Two-party, working.
 * 5. **The "present but unusable" guard is dropped**, so a `context` that is
 *    not a usable name falls through to the default — 6 checks failed, one per
 *    shape. That is the quiet version of writing into the wrong workspace.
 *
 * 6. **`surveyOtherContexts` reads each front page at the caller's own
 *    clearance** rather than at the one the addressed context's role earns —
 *    1 check failed, and it is the one that matters: a note its owner kept
 *    private appeared in somebody else's orientation. (The first attempt at
 *    this sabotage passed a `scope` that is not in that function's scope at
 *    all, so it threw and both checks failed for the wrong reason. Worth
 *    recording: a sabotage that breaks the code rather than the invariant
 *    proves nothing.)
 * 7. **The fan-out bound is raised to 50** — 2 checks failed: seven contexts
 *    were opened and the tail that says the list is short went missing.
 *
 * One thing is asserted structurally rather than behaviourally, and the reason
 * is that sabotaging it changes nothing observable: **the `context` argument is
 * stripped before the tool sees the arguments.** No tool reads it today, so a
 * leak would be invisible until one did.
 */

import { createCrossContextHarness } from "./crossContext/fixtures.mjs";
import { runCrossContextReachChecks } from "./crossContext/reach.test.mjs";
import { runCrossContextMoveNoteChecks } from "./crossContext/moveNote.test.mjs";
import { runCrossContextOrientationChecks } from "./crossContext/orientation.test.mjs";
import { runCrossContextModernEraChecks } from "./crossContext/modernEra.test.mjs";
import { runCrossContextAdvertisingChecks } from "./crossContext/advertising.test.mjs";
import { runCrossContextStoreIdentityChecks } from "./crossContext/storeIdentity.test.mjs";
import { runCrossContextChangeReportingChecks } from "./crossContext/changeReporting.test.mjs";

/**
 * The checks themselves live in `crossContext/*.test.mjs`, split by behaviour
 * and run here in their original order against one harness
 * (`createCrossContextHarness` in `crossContext/fixtures.mjs`).
 *
 * @param {(label: string, ok: boolean) => void} check
 */
export async function runCrossContextChecks(check) {
  const harness = await createCrossContextHarness();
  await runCrossContextReachChecks(check, harness);
  await runCrossContextMoveNoteChecks(check, harness);
  await runCrossContextOrientationChecks(check, harness);
  await runCrossContextModernEraChecks(check, harness);
  await runCrossContextAdvertisingChecks(check, harness);
  await runCrossContextStoreIdentityChecks(check, harness);
  await runCrossContextChangeReportingChecks(check, harness);

  const { restoreControlPlane, restoreS3 } = harness;
  restoreControlPlane();
  restoreS3();
}
