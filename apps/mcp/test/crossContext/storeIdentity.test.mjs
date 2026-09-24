/**
 * The store-identity check fails closed: a control plane that resolves the
 * wrong tenant, or stops sending the field, is refused on the cross-context hop.
 *
 * Split out of crossContext.test.mjs; see fixtures.mjs for the shared harness.
 */

import {
  callTool,
  textOf,
  TOKEN_OWNER,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runCrossContextStoreIdentityChecks(check, harness) {
  const { controlPlane, env } = harness;
  /*
    THE STORE-IDENTITY CHECK FAILS CLOSED ON A MISSING FIELD.

    `storeForSession` compares the binding's own `workspaceId` against the one
    this request resolved to, and its comment calls a disagreement about which
    tenant this is "the one bug that must never be papered over". The comparison
    was guarded by `typeof binding.workspaceId === "string"`, so a control plane
    that stopped sending the field skipped the check rather than failing it.

    That was defensible while a grant covered one context: the field confirmed
    something the grant had already fixed. It is not defensible now. This is the
    gateway's only local confirmation of *which of N* covered contexts the store
    it just built belongs to, and a check that a missing field turns off is a
    check an upstream change can remove without touching this file.

    Measured before the fix, with the stub handing back the wrong context's
    binding: with the field present, 13 checks fail and every cross-context call
    is refused; with it omitted, 9 fail and all nine are *content* assertions —
    "it is that context's file", "it landed in that bucket rather than this one".
    The guard never fired.
  */
  /*
    `1-projects/shared-name.md` exists in both buckets with different bodies,
    which is what makes this readable as a cross-wiring probe rather than as a
    refusal that could have come from anywhere: MINE-MARKER coming back for
    `@theirs` is the store belonging to the wrong tenant.
  */
  const readTheirs = async () =>
    textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        context: "@theirs",
        path: "1-projects/shared-name.md",
      })
    );

  // The control plane has resolved the WRONG tenant. This is the only shape in
  // which the identity check does any work; a test of that check that does not
  // set this watches a correct binding go past and calls it a pass. (It did:
  // the first version of this test passed against the fail-open guard.)
  controlPlane.flags.bindingWorkspaceId = "ws_own";

  controlPlane.flags.omitBindingWorkspaceId = false;
  const wrongWithId = await readTheirs();
  check(
    "a binding for the wrong workspace is refused when it names itself",
    !wrongWithId.includes("MINE-MARKER")
  );

  controlPlane.flags.omitBindingWorkspaceId = true;
  const wrongWithoutId = await readTheirs();
  check(
    "and refused just the same when it names nothing at all",
    !wrongWithoutId.includes("MINE-MARKER")
  );

  /*
    AND THE REFUSAL DOES NOT NAME THE GATEWAY'S OWN REASON.

    `StorageUnavailable`'s doc comment says `reason` "is for this gateway's own
    structured logs. It never reaches a caller: `index.js` answers every one of
    these with the same 503." The cross-context tool path interpolated
    `error.message`, which is `storage unavailable: ${reason}` — the doubled
    phrase in the output was the tell.

    `workspace mismatch` is the reason that matters: it is the two-party
    disagreement signal, exactly what somebody probing for a tenancy bug would
    poll for. The others are plumbing state a member has no business reading —
    `no proof of authorization`, `refresh token in binding`,
    `cross-provider credential`, `binding not allowed`, `unknown provider`.
  */
  // Field back, wrong workspace still served: the refusal now happens on the
  // cross-context hop, where `callToolForSession` catches it, rather than at
  // session setup, where the whole request 503s before any tool runs.
  controlPlane.flags.omitBindingWorkspaceId = false;
  const mismatched = await readTheirs();
  check(
    "a storage refusal does not name the gateway's internal reason",
    !mismatched.includes("workspace mismatch") && !mismatched.includes("storage unavailable")
  );
  check(
    "and still says the one thing the person can act on",
    /no reachable storage/i.test(mismatched)
  );

  controlPlane.flags.bindingWorkspaceId = null;
  controlPlane.flags.omitBindingWorkspaceId = false;
  check("and the right binding still serves its own context", (await readTheirs()).includes("THEIRS-MARKER"));
}
