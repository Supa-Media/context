/**
 * Multi-tenancy: a resolution failure is a refusal (§2), the gateway secret
 * is not sufficient on its own — a user token is also required, and neither
 * proves a workspace it does not name (§3), per-grant scope enforcement
 * including the capture-only tier (§4), and revocation (§5).
 *
 * Split out of tenancy.test.mjs; see fixtures.mjs for the shared harness and
 * that file's module doc for the sabotage-testing record. `garbage`,
 * `downstream`, `unbound`, `smuggled`, `mismatch` and `noToken` are recorded
 * onto `harness` because `runTenancySecretLeakChecks` (§14) asserts none of
 * them ever say a secret, and `noToken`'s challenge header feeds
 * `runTenancyDiscoveryChecks` (§6).
 */

import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  S3_ENDPOINT,
  TOKEN_A,
  TOKEN_A_READONLY,
  TOKEN_A_SIBLING,
  callTool,
  createControlPlane,
  rpc,
  token,
  withControlPlaneOverride,
  worker,
} from "./fixtures.mjs";

export async function runTenancyResolutionChecks(check, harness) {
  const { env, controlPlane, bucketA, bucketB, grantAReadonly } = harness;

  /* ------------------- 2. a resolution failure is a refusal ------------------- */

  const garbage = await rpc(env, `${token("not_a_real_token")}`, "ping", {});
  check("an unknown token is refused", garbage.status === 401);
  check(
    "an unknown token's refusal names no workspace",
    !garbage.text.includes("ws_") && !garbage.text.includes("alpha")
  );

  const noToken = await worker.fetch(
    new Request("https://mcp.context.test/mcp", { method: "POST", body: "{}" }),
    env,
    { waitUntil() {} }
  );
  check("no token is refused", noToken.status === 401);

  // The control plane goes down mid-flight. The failure must be a refusal, not
  // a quiet fallback to some other store.
  const brokenPlane = {
    install() {
      const previous = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(CONTROL_PLANE_ORIGIN)) return new Response("boom", { status: 500 });
        return previous(input, init);
      };
      return () => {
        globalThis.fetch = previous;
      };
    },
  };
  let restoreBroken = brokenPlane.install();
  const downstream = await rpc(env, TOKEN_A, "ping", {});
  restoreBroken();
  check("a control plane outage refuses rather than falling back", downstream.status === 401);
  check("an outage refusal leaks no note content", !downstream.text.includes("alpha"));

  // A control plane that answers, but with a shape this gateway does not
  // recognise. Coercing it is how "undefined" becomes a workspace id.
  const restoreMalformed = withControlPlaneOverride((path) => {
    if (path === "/gateway/session") return { session: { grantId: "g", clientId: "c" } };
    return null;
  }, controlPlane);
  const malformed = await rpc(env, TOKEN_A, "ping", {});
  restoreMalformed();
  check("a malformed session payload is refused, not coerced", malformed.status === 401);

  // The binding call answers with a *different* workspace than the session
  // resolved to. The two independent resolutions disagree; refuse.
  const restoreMismatch = withControlPlaneOverride((path, body) => {
    if (path === "/gateway/binding") {
      return {
        binding: {
          workspaceId: "ws_b",
          provider: "s3",
          endpoint: S3_ENDPOINT,
          region: "auto",
          bucket: "tenant-ab",
          accessKeyId: "AKIAEXAMPLEEXAMPLEBB",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEBB",
          forcePathStyle: true,
          capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
          status: "active",
        },
      };
    }
    return null;
  }, controlPlane);
  const mismatch = await rpc(env, TOKEN_A, "tools/call", {
    name: "list_notes",
    arguments: {},
  });
  restoreMismatch();
  check(
    "a binding for the wrong workspace is refused, not served",
    mismatch.status === 503 && !mismatch.text.includes("beta-secret")
  );

  // A binding that names a Worker binding the operator never allowlisted.
  const restoreSmuggled = withControlPlaneOverride((path) => {
    if (path === "/gateway/binding") {
      return {
        binding: {
          workspaceId: "ws_a",
          provider: "r2-binding",
          bindingName: "LOCAL_CONTEXT_BUCKET",
          capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
          status: "active",
        },
      };
    }
    return null;
  }, controlPlane);
  const smuggled = await rpc(env, TOKEN_A, "tools/call", { name: "list_notes", arguments: {} });
  restoreSmuggled();
  check(
    "a control plane cannot point a tenant at a non-allowlisted worker binding",
    smuggled.status === 503 && !smuggled.text.includes("CRON-ONLY-MARKER")
  );

  const restoreUnbound = withControlPlaneOverride((path) => {
    if (path === "/gateway/binding") return { binding: null };
    return null;
  }, controlPlane);
  const unbound = await rpc(env, TOKEN_A, "tools/call", { name: "list_notes", arguments: {} });
  restoreUnbound();
  check("a workspace with no binding is refused", unbound.status === 503);
  check("an unbound workspace never falls through to another store", !unbound.text.includes("alpha's"));

  /* -------------- 3. the gateway secret is not sufficient on its own ---------- */

  // Proof #1 alone: the gateway secret, with a token that resolves to nothing.
  const secretOnly = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    body: JSON.stringify({ accessToken: "not-a-token", expectedWorkspaceId: "ws_a" }),
  });
  check(
    "the gateway secret alone opens no credential",
    (await secretOnly.json()).binding === null
  );

  // Proof #2 alone: a genuine user token, no gateway secret.
  const tokenOnly = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: {},
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: "ws_a" }),
  });
  check("a user token alone cannot reach the control plane", tokenOnly.status === 401);

  const wrongSecret = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: "Bearer not-the-gateway-secret" },
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: "ws_a" }),
  });
  check("a wrong gateway secret is refused", wrongSecret.status === 401);

  // Both proofs, but the gateway asks for a workspace the grant does not name.
  const crossAsk = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: "ws_b" }),
  });
  const crossAskBody = await crossAsk.text();
  const ghostAsk = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: "ws_does_not_exist" }),
  });
  check(
    "naming another tenant's workspace returns nothing, not that tenant's binding",
    JSON.parse(crossAskBody).binding === null
  );
  check(
    "a real-but-forbidden workspace is byte-identical to one that does not exist",
    crossAskBody === (await ghostAsk.text())
  );

  const grantScoped = await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
    body: JSON.stringify({ accessToken: TOKEN_A, expectedWorkspaceId: null }),
  });
  const grantScopedBody = await grantScoped.json();
  check(
    "with no workspace named, the grant decides which one comes back",
    grantScopedBody.binding.workspaceId === "ws_a" && grantScopedBody.binding.bucket === "tenant-a"
  );
  check(
    "a binding response carries exactly one workspace, never a list",
    !Array.isArray(grantScopedBody.binding) && typeof grantScopedBody.binding.bucket === "string"
  );
  // Structural, not behavioural: bulk extraction has to be impossible because
  // the contract has no shape for it, not because nobody has called it yet.
  const contractMethods = Object.keys(
    createControlPlane({ CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET })
  );
  /*
    ONE EXCEPTION, AND IT HAS TO EARN ITS NAME.

    `listLinks` enumerates — within **one** workspace, the one the presented
    access token resolves to. That is the same shape `getStorageBinding` has
    and is not what this rule is about: what it forbids is a call that can be
    made without naming a context, because that is the shape bulk extraction
    needs. So the exception is listed by name and is held to the stronger
    property below rather than being waved through by a prefix.
  */
  const singleContextListings = new Set(["listLinks"]);
  check(
    "the control-plane client exposes no bulk or enumerating call at all",
    contractMethods.every(
      (name) =>
        !/^(list|all|enumerate|search|find)/i.test(name) || singleContextListings.has(name)
    ) && contractMethods.includes("getStorageBinding")
  );
  const client = createControlPlane({
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
  });
  check(
    "and the one listing there is cannot be called without naming a context",
    // Two required arguments — the token and the workspace — exactly as
    // `getStorageBinding` takes them. A listing that could default its
    // workspace is the one that would have to be argued for again.
    client.listLinks.length === 2 && client.getStorageBinding.length >= 2
  );

  /* --------------------------- 4. scope enforcement -------------------------- */

  const readOnlyRead = await callTool(env, TOKEN_A_READONLY, "read_note", {
    path: "1-projects/alpha.md",
  });
  check("a read-only grant can read", !readOnlyRead.isError);

  const readOnlyWrite = await callTool(env, TOKEN_A_READONLY, "write_note", {
    path: "1-projects/alpha.md",
    content: "should not land",
    visibility: "team",
  });
  check("a read-only grant cannot write", readOnlyWrite.isError === true);
  check(
    "a refused write changed nothing",
    bucketA.get("context/1-projects/alpha.md").body === "alpha rewrote this"
  );

  const readOnlyMove = await callTool(env, TOKEN_A_READONLY, "move_note", {
    source: "1-projects/alpha.md",
    destination: "1-projects/moved.md",
  });
  check("a read-only grant cannot move either", readOnlyMove.isError === true);

  const readOnlyTools = (await rpc(env, TOKEN_A_READONLY, "tools/list")).body.result.tools;
  check(
    "a read-only grant is not shown write tools",
    readOnlyTools.every((tool) => tool.annotations?.readOnlyHint === true) &&
      readOnlyTools.some((tool) => tool.name === "read_note")
  );
  const fullTools = (await rpc(env, TOKEN_A, "tools/list")).body.result.tools;
  check("a full grant is shown every tool", fullTools.length > readOnlyTools.length);

  const captureToken = token("tenant_a_capture");
  await controlPlane.addGrant({
    accessToken: captureToken,
    workspaceId: "ws_a",
    role: "editor",
    scopes: ["context:capture"],
    clientId: "mcp_client_alpha_capture",
    userId: "user_automation",
  });
  const captureAtMcp = await rpc(env, captureToken, "ping", {});
  check("a capture-only grant cannot open an MCP session at all", captureAtMcp.status === 403);
  check(
    "the insufficient-scope refusal says so in the challenge",
    (captureAtMcp.response.headers.get("WWW-Authenticate") || "").includes(
      'error="insufficient_scope"'
    )
  );
  const captureAtInbox = await worker.fetch(
    new Request("https://mcp.context.test/inbox", {
      method: "POST",
      headers: { Authorization: `Bearer ${captureToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "auto", text: "captured" }),
    }),
    env,
    { waitUntil() {} }
  );
  check("but it can drop a capture in the inbox", captureAtInbox.status === 200);
  check(
    "and the capture landed in its own tenant's bucket",
    [...bucketA.keys()].some((key) => key.startsWith("context/0-inbox/")) &&
      ![...bucketB.keys()].some((key) => key.startsWith("0-inbox/"))
  );

  /* ------------------------------ 5. revocation ------------------------------ */

  check(
    "the sibling client works before revocation",
    !(await callTool(env, TOKEN_A_SIBLING, "read_note", { path: "1-projects/alpha.md" })).isError
  );
  controlPlane.revoke(grantAReadonly);
  const afterRevoke = await rpc(env, TOKEN_A_READONLY, "ping", {});
  check("a revoked grant fails closed immediately", afterRevoke.status === 401);
  check(
    "revoking one client leaves its siblings working",
    !(await callTool(env, TOKEN_A_SIBLING, "read_note", { path: "1-projects/alpha.md" })).isError &&
      !(await callTool(env, TOKEN_A, "read_note", { path: "1-projects/alpha.md" })).isError
  );
  check(
    "a revoked grant cannot fetch a storage credential either",
    (
      await (
        await controlPlane.handle(`${CONTROL_PLANE_ORIGIN}/gateway/binding`, {
          headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
          body: JSON.stringify({ accessToken: TOKEN_A_READONLY, expectedWorkspaceId: null }),
        })
      ).json()
    ).binding === null
  );

  harness.garbage = garbage;
  harness.noToken = noToken;
  harness.downstream = downstream;
  harness.unbound = unbound;
  harness.smuggled = smuggled;
  harness.mismatch = mismatch;
}
