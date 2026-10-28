/**
 * Multi-tenancy: redirect URI validation is exact-match, with the one carved-
 * out exception (a native client's loopback port) proven to ignore the port
 * and nothing else (§9); the token endpoint, PKCE verification, confidential-
 * client secret authentication (POST body and HTTP Basic), single-use codes,
 * redirect/client/resource re-checks at exchange time (§10); the newly-
 * minted grant actually reaching its own workspace and refresh rotation
 * (§11); and revocation, including RFC 7009's unhinted-lookup requirement in
 * both directions (§12).
 *
 * Split out of tenancy.test.mjs; see fixtures.mjs for the shared harness and
 * that file's module doc for the sabotage-testing record. Continues the
 * authorization flow §8 (registrationAndPkce.test.mjs) started, reading
 * `harness.registered`/`clientId`/`verifier`/`challengeValue`/`authorizeUrl`
 * from it. `exchanged` is recorded onto `harness` because
 * `runTenancySecretLeakChecks` (§14) asserts its body never says a secret.
 */

import { TOKEN_A, TOKEN_A_SIBLING, callTool, createControlPlaneStub, postForm, rpc, token, worker } from "./fixtures.mjs";

export async function runTenancyRedirectAndTokenChecks(check, harness) {
  const { env, controlPlane } = harness;
  const { clientId, verifier, challengeValue, authorizeUrl } = harness;

  /* ----------------- 9. redirect URI validation is exact-match --------------- */

  const prefixAttack = await worker.fetch(
    new Request(authorizeUrl({ redirect_uri: "https://client.test/callback.evil" })),
    env,
    { waitUntil() {} }
  );
  check("a suffixed redirect URI does not match", prefixAttack.status === 400);
  const substringAttack = await worker.fetch(
    new Request(authorizeUrl({ redirect_uri: "https://client.test/call" })),
    env,
    { waitUntil() {} }
  );
  check("a truncated redirect URI does not match", substringAttack.status === 400);
  const hostAttack = await worker.fetch(
    new Request(authorizeUrl({ redirect_uri: "https://client.test.evil.test/callback" })),
    env,
    { waitUntil() {} }
  );
  check("a lookalike host does not match", hostAttack.status === 400);
  check(
    "an unmatched redirect URI is refused without redirecting anywhere",
    prefixAttack.headers.get("Location") === null
  );

  // RFC 8252 §7.3: a native client's loopback port is unknowable at
  // registration time, so the port — and only the port — is ignored.
  const nativeRegistration = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "CLI",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  const nativeClient = await nativeRegistration.json();
  const ephemeral = await worker.fetch(
    new Request(
      `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${nativeClient.client_id}` +
        `&redirect_uri=${encodeURIComponent("http://127.0.0.1:51763/callback")}` +
        `&code_challenge=${challengeValue}&code_challenge_method=S256`
    ),
    env,
    { waitUntil() {} }
  );
  check("a loopback client's ephemeral port is accepted", ephemeral.status === 302);
  const loopbackPathAttack = await worker.fetch(
    new Request(
      `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${nativeClient.client_id}` +
        `&redirect_uri=${encodeURIComponent("http://127.0.0.1:51763/other")}` +
        `&code_challenge=${challengeValue}&code_challenge_method=S256`
    ),
    env,
    { waitUntil() {} }
  );
  check(
    "the loopback exception ignores the port and nothing else",
    loopbackPathAttack.status === 400
  );

  /*
    "…and nothing else" is a claim about three fields and the check above tests
    one of them. Measured: deleting `a.hostname !== b.hostname` from
    `redirectUriMatches` reddened **nothing**, and so did deleting the protocol
    comparison. Both are load-bearing.

    The host one is the serious half. The loopback branch is reached whenever
    the *registered* URI is loopback — which is every CLI client — and with the
    equality gone the *presented* host is unconstrained, so
    `http://127.0.0.1/callback` matches `http://evil.test/callback` and the
    authorization code is handed to whoever owns that name. Verified directly
    against the weakened function before this was written, rather than reasoned
    about.

    The protocol one admits a scheme registration would never have stored:
    `redirectUriIsAcceptable` allows only https and loopback http, but it runs
    at registration and says nothing about what is presented later.
  */
  const loopbackHostAttack = await worker.fetch(
    new Request(
      `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${nativeClient.client_id}` +
        `&redirect_uri=${encodeURIComponent("http://evil.test:51763/callback")}` +
        `&code_challenge=${challengeValue}&code_challenge_method=S256`
    ),
    env,
    { waitUntil() {} }
  );
  check(
    "the loopback exception does not let the host be substituted",
    loopbackHostAttack.status === 400
  );
  const loopbackSchemeAttack = await worker.fetch(
    new Request(
      `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${nativeClient.client_id}` +
        `&redirect_uri=${encodeURIComponent("https://127.0.0.1:51763/callback")}` +
        `&code_challenge=${challengeValue}&code_challenge_method=S256`
    ),
    env,
    { waitUntil() {} }
  );
  check(
    "...nor the scheme, even to a stricter-looking one",
    loopbackSchemeAttack.status === 400
  );

  /*
    THE GUARDS AFTER THE REDIRECT CHECK, WHICH REFUSE BY REDIRECTING.

    Everything above this point answers with a 400, because the redirect URI is
    not yet proven and there is nowhere safe to send an error. Once it matches,
    `handleAuthorize` switches to `fail()` — a 302 back to the client carrying
    `error=`. That ordering is the whole confused-deputy defence and it is worth
    asserting from the outside: these checks pin both the refusal *and* that it
    arrives as a redirect to the client's own URI rather than as a 400.

    Measured before writing them, each guard removed on its own:

      code_challenge required          -> ALL PASS   (the shape check caught it)
      code_challenge shape             -> ALL PASS   (the required check caught it)
      BOTH, together                   -> ALL PASS   (nothing at all)
      resource indicator must match us -> ALL PASS
      unknown scope refused            -> 1 FAILURES (already held)

    The first three are the interesting result. Either guard alone covers a
    missing `code_challenge`, because `test(null)` stringifies to `"null"` and
    fails the pattern — so removing one is masked by the other and only removing
    both shows that **nothing pinned PKCE being mandatory at the authorize
    endpoint**. Fail-closed either way: a code minted without a challenge can
    never be exchanged, because `verifyPkce` reads `codeChallenge.length` and
    the control plane's validator refuses a null. No bypass — but the headline
    protection for public clients deserves better than an accident.
  */
  const authorizeWithout = (name) => {
    const url = new URL(authorizeUrl());
    url.searchParams.delete(name);
    return url.toString();
  };
  const noChallenge = await worker.fetch(
    new Request(authorizeWithout("code_challenge")),
    env,
    { waitUntil() {} }
  );
  const noChallengeLocation = noChallenge.headers.get("Location") || "";
  check(
    "PKCE is mandatory: an authorize request with no code_challenge is refused",
    noChallenge.status === 302 &&
      noChallengeLocation.startsWith("https://client.test/callback?") &&
      noChallengeLocation.includes("error=invalid_request")
  );
  const shortChallenge = await worker.fetch(
    new Request(authorizeUrl({ code_challenge: "too-short" })),
    env,
    { waitUntil() {} }
  );
  check(
    "...and a code_challenge that is not a 43-128 character unreserved string is refused",
    shortChallenge.status === 302 &&
      (shortChallenge.headers.get("Location") || "").includes("error=invalid_request")
  );
  const foreignResource = await worker.fetch(
    new Request(authorizeUrl({ resource: "https://mcp.somebody-else.test/mcp" })),
    env,
    { waitUntil() {} }
  );
  check(
    "a resource indicator naming another server is refused (RFC 8707 §2)",
    foreignResource.status === 302 &&
      (foreignResource.headers.get("Location") || "").includes("error=invalid_target")
  );

  /*
    THE CONSENT URL MUST BE https, OR LOOPBACK.

    This is the guard that stops the authorize redirect becoming a confused
    deputy with our name on it, and it exists *because a defect was found*: it
    previously exempted `control-plane.test` so this very suite could use a
    plain-http double, which `oauth.js` calls "a permanent cleartext carve-out
    in a production code path — one that widens the moment anything can
    influence the consent hostname, and that no deployment can turn off."

    Nothing pinned the fix. Removing the check reddened nothing, because every
    stub in this file serves https and so never exercised it. The stub now takes
    a `consentOrigin` separate from the origin it intercepts, which is what lets
    a test hand the gateway a consent URL it must refuse without also stopping
    the stub answering the gateway's own calls.

    Both halves, because a carve-out needs its own assertion and not the trust
    of the rule it was carved out of — the lesson the loopback *redirect*
    exception taught two hours earlier in this same file.
  */
  const consentProbe = async (consentOrigin) => {
    const plane = createControlPlaneStub({ consentOrigin });
    const restore = plane.install();
    try {
      const registration = await worker.fetch(
        new Request("https://mcp.context.test/oauth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Consent probe",
            redirect_uris: ["https://client.test/callback"],
            token_endpoint_auth_method: "none",
          }),
        }),
        env,
        { waitUntil() {} }
      );
      const probeClient = await registration.json();
      return await worker.fetch(
        new Request(
          `https://mcp.context.test/oauth/authorize?response_type=code&client_id=${probeClient.client_id}` +
            `&redirect_uri=${encodeURIComponent("https://client.test/callback")}` +
            `&code_challenge=${challengeValue}&code_challenge_method=S256`
        ),
        env,
        { waitUntil() {} }
      );
    } finally {
      restore();
    }
  };

  const cleartextConsent = await consentProbe("http://consent.test");
  const cleartextLocation = cleartextConsent.headers.get("Location") || "";
  check(
    "a consent URL that is neither https nor loopback is refused",
    cleartextConsent.status === 302 &&
      cleartextLocation.startsWith("https://client.test/callback?") &&
      cleartextLocation.includes("error=server_error")
  );
  check(
    "...and the refusal does not name the host it rejected",
    !cleartextLocation.includes("consent.test")
  );
  const loopbackConsent = await consentProbe("http://127.0.0.1:8788");
  check(
    "...while a loopback consent URL is still allowed, which is the carve-out",
    loopbackConsent.status === 302 &&
      (loopbackConsent.headers.get("Location") || "").startsWith("http://127.0.0.1:8788/")
  );

  /* ---------------------- 10. the token endpoint and PKCE -------------------- */

  const authorizationRecord = {
    clientId,
    redirectUri: "https://client.test/callback",
    codeChallenge: challengeValue,
    codeChallengeMethod: "S256",
    scope: "context:read context:write",
    resource: "https://mcp.context.test/mcp",
    workspaceId: "ws_a",
    userId: "user_a",
  };

  controlPlane.issueCode("code-wrong-verifier", authorizationRecord);
  const wrongVerifier = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-wrong-verifier",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: "b".repeat(64),
    resource: "https://mcp.context.test/mcp",
  });
  check(
    "a wrong PKCE verifier is rejected",
    wrongVerifier.status === 400 && wrongVerifier.body.error === "invalid_grant"
  );
  const burned = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-wrong-verifier",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
  });
  check("a code presented with a wrong verifier is burned, not retryable", burned.status === 400);

  controlPlane.issueCode("code-good", authorizationRecord);
  const exchanged = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-good",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
    resource: "https://mcp.context.test/mcp",
  });
  check("a correct verifier exchanges the code", exchanged.status === 200);
  check("the token response carries a bearer access token", exchanged.body.token_type === "Bearer");
  check("the token response carries a refresh token", typeof exchanged.body.refresh_token === "string");
  check("the token response declares an expiry", exchanged.body.expires_in > 0);
  // RFC 6749 §5.1 makes this a MUST, and it is the only thing between an
  // access token and a shared cache holding it. `oauth.js` sets it on every
  // response it builds; nothing asserted it, so deleting the header — or
  // worse, changing it to `public, max-age=3600` — passed the whole suite.
  // Asserted on the *successful* exchange because that is the response that
  // actually carries a token.
  check(
    "a token response is never storable by a shared cache",
    exchanged.response.headers.get("Cache-Control") === "no-store"
  );

  /*
    A CONFIDENTIAL CLIENT, BECAUSE NOTHING ABOVE IS ONE.

    Every exchange above uses the public client registered in section 8, whose
    `token_endpoint_auth_method` is `"none"` — so `authenticateClient` returns
    `true` on its first line and the entire secret comparison below it is
    unreached. MEASURED: replacing that function's body with
    `if (true) return true;` reddened **0 of 1,713 checks**. The constant-time
    compare, the HTTP Basic fallback, and the refusal of a wrong secret were
    the authentication on `/oauth/token` and `/oauth/revoke` and no test
    presented a secret to either one, right or wrong.

    The code was correct. It was simply not a guard, by this repository's own
    definition of one.
  */
  const confidentialRegistration = await worker.fetch(
    new Request("https://mcp.context.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Hosted Client",
        redirect_uris: ["https://hosted.test/callback"],
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
      }),
    }),
    env,
    { waitUntil() {} }
  );
  const confidential = await confidentialRegistration.json();
  check("a confidential client is issued a secret", typeof confidential.client_secret === "string");

  const confidentialRecord = {
    ...authorizationRecord,
    clientId: confidential.client_id,
    redirectUri: "https://hosted.test/callback",
  };
  const spend = async (code, extra, init) => {
    controlPlane.issueCode(code, confidentialRecord);
    return postForm(
      env,
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://hosted.test/callback",
        client_id: confidential.client_id,
        code_verifier: verifier,
        ...extra,
      },
      init
    );
  };

  const noSecret = await spend("conf-none", {});
  check(
    "a confidential client presenting no secret is refused",
    noSecret.status === 401 && noSecret.body.error === "invalid_client"
  );
  const wrongClientSecret = await spend("conf-wrong", { client_secret: `${confidential.client_secret}x` });
  check(
    "...and a wrong one is refused, not merely a missing one",
    wrongClientSecret.status === 401 && wrongClientSecret.body.error === "invalid_client"
  );
  /*
    The positive twin, and the reason the two refusals above prove anything: a
    check that only ever asserts "no" passes just as happily on a function that
    always says no.
  */
  const rightSecret = await spend("conf-right", { client_secret: confidential.client_secret });
  check("...and the correct secret exchanges the code", rightSecret.status === 200);

  /*
    THERE IS NO SAME-LENGTH CASE TO WRITE, and the first version of this block
    wrote one anyway with a false reason attached: "the compare short-circuits
    on length before the constant-time loop, so a longer string proves only
    that branch." Both operands of that comparison are `sha256Hex` output —
    64 characters for any plaintext whatsoever — so the length of the secret
    somebody presents never reaches it. MEASURED: inverting
    `if (hashed.length !== …) return false;` to `return true` **reddens
    nothing** — no denominator, deliberately. The claim is that no check
    anywhere goes red, which says strictly more than a fraction of a total
    that every unrelated commit moves; a count in prose is the tripwire this
    branch has already tripped four times, and it tripped again on the first
    draft of this very sentence, which said "0 of 1,720" in the commit that
    made the suite 1,719. The branch is unreachable, `conf-wrong` above
    already goes through
    the constant-time loop, and the extra check proved nothing it did not.

    Recorded rather than quietly deleted, because the next person to read that
    line will have the same idea. The guard itself stays: it costs nothing and
    a stored value that is not a 64-character hash is a thing to refuse rather
    than to compare.
  */

  /*
    HTTP Basic, which `authenticateClient` accepts as a fallback for clients
    that send it despite registering `client_secret_post`. A whole branch, and
    the only reason to have written it is clients that use it.
  */
  const basic = (secret) => ({
    headers: {
      Authorization: `Basic ${btoa(`${confidential.client_id}:${secret}`)}`,
    },
  });
  const basicRight = await spend("conf-basic", {}, basic(confidential.client_secret));
  check("a secret presented over HTTP Basic is accepted", basicRight.status === 200);
  const basicWrong = await spend("conf-basic-bad", {}, basic("not-the-secret"));
  check("...and a wrong one over HTTP Basic is refused", basicWrong.status === 401);

  const replay = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-good",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
  });
  check(
    "an authorization code is single-use",
    replay.status === 400 && replay.body.error === "invalid_grant"
  );

  controlPlane.issueCode("code-redirect-swap", authorizationRecord);
  const redirectSwap = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-redirect-swap",
    redirect_uri: "https://client.test/other",
    client_id: clientId,
    code_verifier: verifier,
  });
  check("the token exchange re-checks the redirect URI", redirectSwap.status === 400);

  controlPlane.issueCode("code-other-client", { ...authorizationRecord, clientId: "someone_else" });
  const clientSwap = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-other-client",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
  });
  check("a code minted for another client cannot be spent", clientSwap.status === 400);

  const wrongAudience = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "irrelevant",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
    resource: "https://someone-elses-mcp.test/mcp",
  });
  check(
    "a token request for another resource is rejected",
    wrongAudience.status === 400 && wrongAudience.body.error === "invalid_target"
  );

  // A client handed `/@alpha/mcp` builds its token request from the workspace-
  // free metadata endpoint but still sends the per-workspace resource. Rejecting
  // that would break every real named-workspace connection at the last step.
  controlPlane.issueCode("code-named-resource", {
    ...authorizationRecord,
    resource: "https://mcp.context.test/@alpha/mcp",
  });
  const namedResource = await postForm(env, "/oauth/token", {
    grant_type: "authorization_code",
    code: "code-named-resource",
    redirect_uri: "https://client.test/callback",
    client_id: clientId,
    code_verifier: verifier,
    resource: "https://mcp.context.test/@alpha/mcp",
  });
  check("a per-workspace resource indicator is accepted", namedResource.status === 200);

  const jsonToken = await worker.fetch(
    new Request("https://mcp.context.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    }),
    env,
    { waitUntil() {} }
  );
  check("the token endpoint insists on form encoding", jsonToken.status === 400);

  /* --------------------- 11. the new grant actually works -------------------- */

  const newToken = exchanged.body.access_token;
  const newSession = await callTool(env, newToken, "read_note", { path: "1-projects/alpha.md" });
  check("a token minted by the flow reaches its workspace", !newSession.isError);
  check(
    "and reaches only its workspace",
    (await callTool(env, newToken, "read_note", { path: "1-projects/beta-secret.md" })).isError ===
      true
  );

  const refreshed = await postForm(env, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: exchanged.body.refresh_token,
    client_id: clientId,
    resource: "https://mcp.context.test/mcp",
  });
  check("refresh returns a new access token", refreshed.status === 200);
  check(
    "refresh rotates the refresh token",
    refreshed.body.refresh_token !== exchanged.body.refresh_token
  );
  const reusedRefresh = await postForm(env, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: exchanged.body.refresh_token,
    client_id: clientId,
  });
  check(
    "a reused refresh token is invalid_grant",
    reusedRefresh.status === 400 && reusedRefresh.body.error === "invalid_grant"
  );
  check(
    "reusing a rotated refresh token kills the whole grant",
    (await rpc(env, refreshed.body.access_token, "ping", {})).status === 401
  );

  /* ------------------------------ 12. revocation ----------------------------- */

  const revoke = await postForm(env, "/oauth/revoke", {
    token: TOKEN_A_SIBLING,
    token_type_hint: "access_token",
    client_id: "mcp_client_alpha_sibling",
  });
  check("revocation answers 200", revoke.status === 200);
  check(
    "the revoked client is cut off immediately",
    (await rpc(env, TOKEN_A_SIBLING, "ping", {})).status === 401
  );
  check(
    "its sibling on the same workspace is untouched",
    (await rpc(env, TOKEN_A, "ping", {})).body?.result !== undefined
  );
  check(
    "revocation of an unknown token still answers 200",
    (
      await postForm(env, "/oauth/revoke", {
        token: "not-a-token",
        client_id: "mcp_client_alpha_sibling",
      })
    ).status === 200
  );

  /*
    RFC 7009 §2.1: `token_type_hint` is an OPTIMISATION, and if the server
    cannot find the token under the hinted type it **MUST extend its search
    across all of its supported token types**. A client is entitled to send no
    hint at all.

    The check above this one, and every other revocation check in this file,
    passes `token_type_hint: "access_token"`. So the hinted path was covered and
    the unhinted path was not — and unhinted defaults to `"refresh"`, which
    looks in `by_refresh_token` and stops. An access token presented without a
    hint was therefore looked up among refresh tokens, missed, and left live.

    **Behind the 200 that §2.2 mandates**, which is exactly the answer that
    cannot tell the caller their revocation did nothing. `CLAUDE.md` makes
    per-client revocability the reason MCP access is OAuth rather than a shared
    token, so a revoke that silently no-ops is that promise failing quietly.
  */
  const TOKEN_A_UNHINTED = token("tenant_a_unhinted");
  await controlPlane.addGrant({
    accessToken: TOKEN_A_UNHINTED,
    workspaceId: "ws_a",
    role: "owner",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_alpha_sibling",
    userId: "user_a",
  });
  check(
    "the unhinted grant works before it is revoked",
    (await rpc(env, TOKEN_A_UNHINTED, "ping", {})).body?.result !== undefined
  );
  const unhinted = await postForm(env, "/oauth/revoke", {
    token: TOKEN_A_UNHINTED,
    client_id: "mcp_client_alpha_sibling",
  });
  check("an unhinted revocation answers 200", unhinted.status === 200);
  check(
    "...and actually revokes, because the hint is an optimisation and not the lookup",
    (await rpc(env, TOKEN_A_UNHINTED, "ping", {})).status === 401
  );

  // The mirror, so the MUST is pinned in both directions rather than for the
  // one type that happened to be the default. A refresh token presented under
  // the *wrong* hint has to be found too — and with the fallback in place the
  // default stops mattering at all, which is the point of it.
  const TOKEN_A_MISHINTED = token("tenant_a_mishinted");
  const REFRESH_A_MISHINTED = token("tenant_a_mishinted_refresh");
  await controlPlane.addGrant({
    accessToken: TOKEN_A_MISHINTED,
    refreshToken: REFRESH_A_MISHINTED,
    workspaceId: "ws_a",
    role: "owner",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_alpha_sibling",
    userId: "user_a",
  });
  check(
    "the mis-hinted grant works before it is revoked",
    (await rpc(env, TOKEN_A_MISHINTED, "ping", {})).body?.result !== undefined
  );
  const mishinted = await postForm(env, "/oauth/revoke", {
    token: REFRESH_A_MISHINTED,
    token_type_hint: "access_token",
    client_id: "mcp_client_alpha_sibling",
  });
  check("a refresh token revoked under the wrong hint answers 200", mishinted.status === 200);
  check(
    "...and is revoked anyway, which is the other half of RFC 7009 §2.1",
    (await rpc(env, TOKEN_A_MISHINTED, "ping", {})).status === 401
  );

  harness.exchanged = exchanged;
}
