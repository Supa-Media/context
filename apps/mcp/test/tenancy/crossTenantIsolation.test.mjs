/**
 * Multi-tenancy: cross-tenant isolation on the S3 pair (§1) and the same
 * property on the Dropbox pair, a harder case since nothing but the access
 * token tells two Dropbox tenants apart (§1b).
 *
 * Split out of tenancy.test.mjs; see fixtures.mjs for the shared harness and
 * that file's module doc for the sabotage-testing record. `listA`, `listB`,
 * `listC`, `tokenless` and `withRefresh` are recorded onto `harness` because
 * `runTenancySecretLeakChecks` (§14) asserts none of them ever say a secret.
 */

import { DROPBOX_TOKEN_C, TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D, callTool, rpc, withControlPlaneOverride } from "./fixtures.mjs";

export async function runTenancyCrossTenantIsolationChecks(check, harness) {
  const { env, controlPlane, bucketA, bucketB, folderC, folderD } = harness;

  /* ------------------------- 1. cross-tenant isolation ------------------------ */

  const listA = (await callTool(env, TOKEN_A, "list_notes"))?.content?.[0]?.text || "";
  check("tenant A lists its own notes", listA.includes("1-projects/alpha.md"));
  check(
    "tenant A's listing never names tenant B's notes",
    !listA.includes("beta-secret") && !listA.includes("BETA-ONLY")
  );
  check("tenant A's listing is not rootPrefix-decorated", !listA.includes("context/1-projects"));

  const listB = (await callTool(env, TOKEN_B, "list_notes"))?.content?.[0]?.text || "";
  check("tenant B lists its own notes", listB.includes("1-projects/beta-secret.md"));
  check("tenant B's listing never names tenant A's notes", !listB.includes("alpha's project"));

  const aReadsBSecret = await callTool(env, TOKEN_A, "read_note", {
    path: "1-projects/beta-secret.md",
  });
  check(
    "tenant A cannot read a path that exists only in tenant B",
    aReadsBSecret?.isError === true && !aReadsBSecret.content[0].text.includes("BETA-ONLY")
  );

  // The same key exists in both buckets with different content: the single
  // most direct test that the credential, not the key, decides the bucket.
  const aReadsShared = await callTool(env, TOKEN_A, "read_note", { path: "1-projects/alpha.md" });
  const bReadsShared = await callTool(env, TOKEN_B, "read_note", { path: "1-projects/alpha.md" });
  check(
    "the same key in two tenants resolves to two different objects",
    aReadsShared.content[0].text.includes("alpha's project") &&
      bReadsShared.content[0].text.includes("beta's own file")
  );

  const aSearch = (await callTool(env, TOKEN_A, "search_notes", { query: "BETA-ONLY-MARKER" }))
    ?.content?.[0]?.text;
  check("tenant A's search cannot reach tenant B's content", !aSearch.includes("beta-secret"));

  const beforeWrite = bucketB.get("1-projects/alpha.md").body;
  await callTool(env, TOKEN_A, "write_note", {
    path: "1-projects/alpha.md",
    content: "alpha rewrote this",
    visibility: "team",
    confirm_team_publish: true,
    expected_etag: aReadsShared.content[0].text.match(/^etag: (\S+)/)?.[1],
  });
  check(
    "a write by tenant A lands in tenant A's bucket",
    bucketA.get("context/1-projects/alpha.md").body === "alpha rewrote this"
  );
  check(
    "a write by tenant A leaves tenant B's identically-keyed object untouched",
    bucketB.get("1-projects/alpha.md").body === beforeWrite
  );

  const aCreates = await callTool(env, TOKEN_A, "write_note", {
    path: "1-projects/brand-new.md",
    content: "new",
    visibility: "team",
    confirm_team_publish: true,
  });
  check("tenant A can create a new note", !aCreates.isError);
  check(
    "tenant A's new note does not appear in tenant B's bucket",
    !bucketB.has("1-projects/brand-new.md") && bucketA.has("context/1-projects/brand-new.md")
  );

  // Existence inference through the workspace selector.
  const aSelectsB = await rpc(env, TOKEN_A, "ping", {}, { path: "/@alphabet/mcp" });
  const aSelectsNothing = await rpc(env, TOKEN_A, "ping", {}, { path: "/@nosuchworkspace/mcp" });
  check("selecting another tenant's workspace is refused", aSelectsB.status === 403);
  check(
    "a real workspace you cannot reach is byte-identical to one that does not exist",
    aSelectsB.status === aSelectsNothing.status &&
      aSelectsB.text === aSelectsNothing.text &&
      aSelectsB.response.headers.get("WWW-Authenticate") ===
        aSelectsNothing.response.headers.get("WWW-Authenticate")
  );
  const aSelectsSelf = await rpc(env, TOKEN_A, "ping", {}, { path: "/@alpha/mcp" });
  const aSelectsSelfBare = await rpc(env, TOKEN_A, "ping", {}, { path: "/alpha/mcp" });
  check("naming your own workspace in the URL works", aSelectsSelf.body?.result !== undefined);
  check("the @ is cosmetic and normalised away", aSelectsSelfBare.body?.result !== undefined);

  /* ------------- 1b. the same, for a workspace backed by Dropbox ------------- */

  /**
   * Tenancy has to hold on the one-click tier too, and it is a *harder* case
   * than S3, not an easier one. Two S3 tenants at least differ by bucket name;
   * two Dropbox tenants are the same two hostnames, the same paths, and the
   * same customer-chosen folder — separated by the access token in the binding
   * and by nothing else at all. The store the factory built is the only thing
   * standing between them.
   */
  const listC = (await callTool(env, TOKEN_C, "list_notes"))?.content?.[0]?.text || "";
  check(
    "a dropbox-backed workspace serves its own notes end to end",
    listC.includes("1-projects/alpha.md") && listC.includes("1-projects/gamma-secret.md")
  );
  check(
    "a dropbox listing is not rootPrefix-decorated either",
    !listC.includes("context/1-projects") && !listC.includes("/context/")
  );
  check(
    "a dropbox tenant's listing never names the other dropbox tenant's notes",
    !listC.includes("delta-secret") && !listC.includes("DELTA-ONLY")
  );
  check(
    "nor any S3 tenant's",
    !listC.includes("beta-secret") && !listC.includes("brand-new")
  );

  const cReadsD = await callTool(env, TOKEN_C, "read_note", {
    path: "1-projects/delta-secret.md",
  });
  check(
    "one dropbox tenant cannot read a path that exists only in the other",
    cReadsD?.isError === true && !cReadsD.content[0].text.includes("DELTA-ONLY")
  );
  const dReadsC = await callTool(env, TOKEN_D, "read_note", {
    path: "1-projects/gamma-secret.md",
  });
  check(
    "and the refusal runs in both directions",
    dReadsC?.isError === true && !dReadsC.content[0].text.includes("GAMMA-ONLY")
  );

  // Four tenants, one key, four different objects — and two of those four are
  // told apart by nothing but a bearer token.
  const cReadsShared = await callTool(env, TOKEN_C, "read_note", { path: "1-projects/alpha.md" });
  const dReadsShared = await callTool(env, TOKEN_D, "read_note", { path: "1-projects/alpha.md" });
  check(
    "two dropbox tenants sharing a folder name are separated by the access token alone",
    cReadsShared.content[0].text.includes("gamma's own file") &&
      dReadsShared.content[0].text.includes("delta's own file")
  );
  check(
    "and a dropbox tenant's copy is not an S3 tenant's copy",
    !cReadsShared.content[0].text.includes("alpha rewrote this") &&
      !cReadsShared.content[0].text.includes("beta's own file")
  );

  const aReadsGamma = await callTool(env, TOKEN_A, "read_note", {
    path: "1-projects/gamma-secret.md",
  });
  check(
    "an S3 tenant cannot reach a dropbox tenant's notes",
    aReadsGamma?.isError === true && !aReadsGamma.content[0].text.includes("GAMMA-ONLY")
  );
  const cSearch =
    (await callTool(env, TOKEN_C, "search_notes", { query: "BETA-ONLY-MARKER" }))?.content?.[0]
      ?.text || "";
  check(
    "and a dropbox tenant's search cannot reach an S3 tenant's content",
    !cSearch.includes("beta-secret") && !cSearch.includes("BETA-ONLY-MARKER\n")
  );

  const deltaBeforeWrite = folderD.get("/context/1-projects/alpha.md").body;
  const cWrites = await callTool(env, TOKEN_C, "write_note", {
    path: "1-projects/alpha.md",
    content: "gamma rewrote this",
    visibility: "team",
    confirm_team_publish: true,
    expected_etag: cReadsShared.content[0].text.match(/^etag: (\S+)/)?.[1],
  });
  check("a dropbox-backed workspace can write", !cWrites.isError);
  check(
    "the write landed in that customer's own Dropbox folder",
    folderC.get("/context/1-projects/alpha.md").body === "gamma rewrote this"
  );
  check(
    "and left the other dropbox tenant's identically-pathed file untouched",
    folderD.get("/context/1-projects/alpha.md").body === deltaBeforeWrite
  );
  check(
    "and never reached an S3 tenant's bucket",
    bucketA.get("context/1-projects/alpha.md").body === "alpha rewrote this" &&
      bucketB.get("1-projects/alpha.md").body === beforeWrite
  );

  // The factory's refusals, reached the way a real request reaches them: the
  // control plane, not a unit test, is where a half-built binding comes from.
  //
  /**
   * A refusal has to arrive as a *response*.
   *
   * A binding the factory will not build throws, and if that throw is not the
   * one `index.js` catches it escapes `worker.fetch` — a 500 in production, and
   * here an exception that would take every later check in this file with it
   * and report as a crash rather than a failure. So it is caught and reported
   * as a status, the same way the malformed-escape checks below do.
   */
  const listNotesOrThrow = async (tokenValue) => {
    try {
      return await rpc(env, tokenValue, "tools/call", { name: "list_notes", arguments: {} });
    } catch (error) {
      return { status: "threw", text: String(error?.message || error), body: null };
    }
  };

  const restoreTokenless = withControlPlaneOverride((path) => {
    if (path === "/gateway/binding") {
      return {
        binding: {
          workspaceId: "ws_c",
          provider: "dropbox",
          rootPrefix: "context/",
          capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
          status: "active",
        },
      };
    }
    return null;
  }, controlPlane);
  const tokenless = await listNotesOrThrow(TOKEN_C);
  restoreTokenless();
  check(
    "a dropbox binding with no access token is a refusal, not a store",
    tokenless.status === 503
  );
  check(
    "and it does not fall through to anybody else's storage",
    !tokenless.text.includes("gamma") && !tokenless.text.includes("alpha")
  );

  // The one thing the control plane must never send. A binding that worked
  // while carrying it is how the bug would reach production unnoticed.
  const restoreRefresh = withControlPlaneOverride((path) => {
    if (path === "/gateway/binding") {
      return {
        binding: {
          workspaceId: "ws_c",
          provider: "dropbox",
          accessToken: DROPBOX_TOKEN_C,
          refreshToken: "rt.FAKE-long-lived-must-never-arrive",
          rootPrefix: "context/",
          capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
          status: "active",
        },
      };
    }
    return null;
  }, controlPlane);
  const withRefresh = await listNotesOrThrow(TOKEN_C);
  restoreRefresh();
  check(
    "a binding carrying a refresh token is refused even though its access token works",
    withRefresh.status === 503 && !withRefresh.text.includes("gamma-secret")
  );

  harness.listA = listA;
  harness.listB = listB;
  harness.listC = listC;
  harness.tokenless = tokenless;
  harness.withRefresh = withRefresh;
}
