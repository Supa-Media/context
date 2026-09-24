/**
 * Multi-tenancy: the storage credential is never cached — fetched afresh on
 * every request, and always keyed by the caller's own token rather than a
 * workspace id (§13); and the whole-suite adversarial rollup — no response
 * anywhere in this file ever said the gateway secret, a storage credential,
 * a Dropbox token, or the control plane's own origin (§14).
 *
 * Split out of tenancy.test.mjs; see fixtures.mjs for the shared harness and
 * that file's module doc for the sabotage-testing record. §14 is the reason
 * nearly every earlier section in this suite records its response onto
 * `harness` — this is where all of them are read back at once.
 */

import { CONTROL_PLANE_ORIGIN, DROPBOX_TOKEN_C, DROPBOX_TOKEN_D, GATEWAY_SECRET, TOKEN_A, callTool } from "./fixtures.mjs";

export async function runTenancyAuditAndSecretChecks(check, harness) {
  const { env, controlPlane } = harness;
  const { listA, listB, listC, tokenless, withRefresh, garbage, downstream, unbound, smuggled, mismatch, challenge, prmBody, asmBody, exchanged } = harness;

  /* ------------------- 13. the credential is never cached -------------------- */

  const before = controlPlane.calls.filter((c) => c.path === "/gateway/binding").length;
  await callTool(env, TOKEN_A, "read_note", { path: "1-projects/alpha.md" });
  await callTool(env, TOKEN_A, "read_note", { path: "1-projects/alpha.md" });
  const after = controlPlane.calls.filter((c) => c.path === "/gateway/binding").length;
  check("the storage binding is fetched afresh on every request", after - before === 2);
  check(
    "every binding fetch carries the caller's own token, not a workspace id",
    controlPlane.calls
      .filter((c) => c.path === "/gateway/binding")
      .every((c) => typeof c.body.accessToken === "string" && c.body.accessToken.length > 0)
  );

  /* ------------------------- 14. no secret ever escapes ---------------------- */

  const everythingSaid = [
    listA,
    listB,
    listC,
    tokenless.text,
    withRefresh.text,
    garbage.text,
    downstream.text,
    unbound.text,
    smuggled.text,
    mismatch.text,
    JSON.stringify(exchanged.body),
    challenge,
    JSON.stringify(prmBody),
    JSON.stringify(asmBody),
  ].join("\n");
  check(
    "no response ever contains the gateway secret",
    !everythingSaid.includes(GATEWAY_SECRET)
  );
  check(
    "no response ever contains a storage credential",
    !everythingSaid.includes("wJalrXUtnFEMI") && !everythingSaid.includes("AKIAEXAMPLE")
  );
  check(
    "and none contains a Dropbox token of either life",
    !everythingSaid.includes(DROPBOX_TOKEN_C) &&
      !everythingSaid.includes(DROPBOX_TOKEN_D) &&
      !everythingSaid.includes("rt.FAKE")
  );
  check(
    "no response names the control plane origin",
    !garbage.text.includes(CONTROL_PLANE_ORIGIN) && !downstream.text.includes(CONTROL_PLANE_ORIGIN)
  );
}
