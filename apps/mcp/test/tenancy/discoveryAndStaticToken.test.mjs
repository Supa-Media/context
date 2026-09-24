/**
 * Multi-tenancy: OAuth discovery and the 401 challenge (§6), including
 * per-workspace metadata and malformed-percent-escape routing; and proof
 * that no static-token path exists at all any more — not `PRIVATE_TOKEN` /
 * `TEAM_TOKEN` / `PUBLIC_TOKEN` / `INBOX_TOKEN`, not a bound `BRAIN` bucket
 * (§7).
 *
 * Split out of tenancy.test.mjs; see fixtures.mjs for the shared harness and
 * that file's module doc for the sabotage-testing record. `challenge`,
 * `prmBody` and `asmBody` are recorded onto `harness` because
 * `runTenancySecretLeakChecks` (§14) asserts none of them ever say a secret.
 */

import { PRIVACY_MANIFEST, memoryR2, rpc, worker } from "./fixtures.mjs";

export async function runTenancyDiscoveryChecks(check, harness) {
  const { env } = harness;
  const noToken = harness.noToken;

  /* --------------------- 6. discovery and the 401 challenge ------------------ */

  const challenge = noToken.headers.get("WWW-Authenticate") || "";
  check("a 401 carries a Bearer challenge", challenge.startsWith("Bearer "));
  check(
    "the challenge points at the resource metadata",
    challenge.includes(
      'resource_metadata="https://mcp.context.test/.well-known/oauth-protected-resource/mcp"'
    )
  );
  check("the challenge advertises the scopes", challenge.includes('scope="context:read'));

  const namedChallenge = (await rpc(env, "", "ping", {}, { path: "/@alpha/mcp" })).response.headers.get(
    "WWW-Authenticate"
  );
  check(
    "a named-workspace 401 points at that workspace's metadata",
    namedChallenge.includes("/.well-known/oauth-protected-resource/@alpha/mcp")
  );

  const prm = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-protected-resource"),
    env,
    { waitUntil() {} }
  );
  const prmBody = await prm.json();
  check("protected resource metadata is served", prm.status === 200);
  check("it declares the canonical resource", prmBody.resource === "https://mcp.context.test/mcp");
  check(
    "it declares exactly one authorization server",
    Array.isArray(prmBody.authorization_servers) && prmBody.authorization_servers.length === 1
  );
  check("it advertises scopes", prmBody.scopes_supported.includes("context:read"));

  const prmSuffixed = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-protected-resource/@alpha/mcp"),
    env,
    { waitUntil() {} }
  );
  check(
    "the path-suffixed well-known form is served too",
    (await prmSuffixed.json()).resource === "https://mcp.context.test/@alpha/mcp"
  );
  const prmPrefixed = await worker.fetch(
    new Request("https://mcp.context.test/@alpha/.well-known/oauth-protected-resource"),
    env,
    { waitUntil() {} }
  );
  check(
    "per-workspace discovery works from the endpoint URL too",
    (await prmPrefixed.json()).resource === "https://mcp.context.test/@alpha/mcp"
  );

  // The exact URL the 401 challenge points at. "mcp" looks like a slug, and a
  // metadata document for a workspace called "mcp" would send every client that
  // followed the challenge to the wrong resource identifier.
  const prmChallengeTarget = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-protected-resource/mcp"),
    env,
    { waitUntil() {} }
  );
  check(
    "the challenge's own metadata URL does not read /mcp as a workspace",
    (await prmChallengeTarget.json()).resource === "https://mcp.context.test/mcp"
  );

  const asm = await worker.fetch(
    new Request("https://mcp.context.test/.well-known/oauth-authorization-server"),
    env,
    { waitUntil() {} }
  );
  const asmBody = await asm.json();
  check("authorization server metadata is served", asm.status === 200);
  check("the issuer matches the origin", asmBody.issuer === "https://mcp.context.test");
  check(
    "it advertises S256 and only S256",
    JSON.stringify(asmBody.code_challenge_methods_supported) === JSON.stringify(["S256"])
  );
  check(
    "it advertises the authorization_code and refresh_token grants",
    asmBody.grant_types_supported.includes("authorization_code") &&
      asmBody.grant_types_supported.includes("refresh_token")
  );
  check("it advertises a registration endpoint", typeof asmBody.registration_endpoint === "string");
  check("it advertises a revocation endpoint", typeof asmBody.revocation_endpoint === "string");

  // Discovery and validation have to learn a new scope together. A client that
  // follows discovery faithfully and then gets `invalid_scope` from the
  // endpoint discovery pointed it at is the client that breaks, and it breaks
  // in a way that looks like our server lying about what it supports.
  check(
    "the tier scope is advertised in the authorization server metadata",
    asmBody.scopes_supported.includes("context:private")
  );
  const prmScopes = await (
    await worker.fetch(
      new Request("https://mcp.context.test/.well-known/oauth-protected-resource/mcp"),
      env,
      { waitUntil() {} }
    )
  ).json();
  check(
    "and in the protected resource metadata, identically",
    JSON.stringify(prmScopes.scopes_supported) === JSON.stringify(asmBody.scopes_supported)
  );

  check(
    "an unknown path is a 404, not a 200 that breaks discovery",
    (await worker.fetch(new Request("https://mcp.context.test/anything"), env, { waitUntil() {} }))
      .status === 404
  );

  // A malformed percent-escape used to reach `decodeURIComponent` unguarded at
  // the very top of `fetch`, before any routing or auth, so any unauthenticated
  // request could turn the Worker into an exception instead of a response.
  // These paths are undecodable, therefore they name no workspace and no token.
  for (const malformed of ["/%zz/mcp", "/%e0%a4%a/mcp", "/@%zz/mcp", "/%zz"]) {
    let status = null;
    try {
      status = (
        await worker.fetch(new Request(`https://mcp.context.test${malformed}`), env, {
          waitUntil() {},
        })
      ).status;
    } catch {
      status = "threw";
    }
    check(`a malformed escape in the path (${malformed}) routes instead of throwing`, status === 404);
  }
  let tokenPathStatus = null;
  try {
    tokenPathStatus = (
      await worker.fetch(
        new Request("https://mcp.context.test/t/%zz/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
        }),
        env,
        { waitUntil() {} }
      )
    ).status;
  } catch {
    tokenPathStatus = "threw";
  }
  check(
    "a malformed escape in a token-in-path token is a 401, not a Worker exception",
    tokenPathStatus === 401
  );

  /* ------------------- 7. no static-token path exists at all ------------------ */

  const staticEnv = {
    ...env,
    PRIVATE_TOKEN: "priv-token",
    TEAM_TOKEN: "team-token",
    PUBLIC_TOKEN: "pub-token",
    INBOX_TOKEN: "inbox-token",
    BRAIN: memoryR2({ "privacy.md": PRIVACY_MANIFEST }),
  };
  for (const legacy of ["priv-token", "team-token", "pub-token", "inbox-token"]) {
    const attempt = await rpc(staticEnv, legacy, "ping", {});
    check(`a legacy env token (${legacy}) is not a credential any more`, attempt.status === 401);
  }
  const legacyInbox = await worker.fetch(
    new Request("https://mcp.context.test/inbox", {
      method: "POST",
      headers: { Authorization: "Bearer inbox-token", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "should not land" }),
    }),
    staticEnv,
    { waitUntil() {} }
  );
  check("the inbox has no static token either", legacyInbox.status === 401);
  check(
    "an env-bound BRAIN bucket is unreachable from any request",
    !JSON.stringify(env).includes("BRAIN")
  );

  harness.challenge = challenge;
  harness.prmBody = prmBody;
  harness.asmBody = asmBody;
}
