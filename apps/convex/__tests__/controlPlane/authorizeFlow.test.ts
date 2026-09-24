import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  FAKE_STORAGE,
  TEST_GATEWAY_SECRET,
  asUser,
  captureError,
  errorCode,
  gatewayPost,
  responseFingerprint,
  type TestConvex,
} from "../fixtures.helpers";
import {
  token,
  ACCESS_A,
  CLIENT_A,
  CLIENT_A_SIBLING,
  REDIRECT_URI,
  registerClient,
  twoConnectedTenants,
  bodyOf,
  s256,
  VERIFIER,
  startAuthorization,
  startAndApprove,
  startAndApproveWith,
} from "./fixtures.helpers";

/* 6. The authorization flow                                                  */
/* -------------------------------------------------------------------------- */

const OTHER_VERIFIER = "b".repeat(64);

describe("/gateway/authorize/start", () => {
  test("parks a request and hands back a consent URL on an origin we own", async () => {
    const { t } = await twoConnectedTenants();
    const body = await bodyOf(await startAuthorization(t));
    expect(typeof body.requestId).toBe("string");
    const consent = new URL(body.consentUrl as string);
    expect(consent.protocol).toBe("https:");
    expect(consent.origin).toBe("https://app.context.invalid");
    expect(consent.searchParams.get("request_id")).toBe(body.requestId);
  });

  test("the consent URL carries no token, no secret, and no credential", async () => {
    const { t } = await twoConnectedTenants();
    const body = await bodyOf(await startAuthorization(t));
    const url = body.consentUrl as string;
    expect(url).not.toContain(TEST_GATEWAY_SECRET);
    expect(url).not.toContain(ACCESS_A);
    expect(url).not.toContain(FAKE_STORAGE.secretAccessKey);
  });

  test("refuses PKCE `plain`, and refuses no PKCE at all", async () => {
    const { t } = await twoConnectedTenants();
    expect(
      (
        await startAuthorization(t, {
          codeChallengeMethod: "plain",
          codeChallenge: VERIFIER,
        })
      ).status,
    ).toBe(400);
    expect((await startAuthorization(t, { codeChallenge: "" })).status).toBe(400);
    expect(
      (await startAuthorization(t, { codeChallenge: "too-short" })).status,
    ).toBe(400);
    expect(await t.run((ctx) => ctx.db.query("oauthAuthorizations").collect())).toEqual(
      [],
    );
  });

  test("the redirect URI must match exactly", async () => {
    const { t } = await twoConnectedTenants();
    for (const redirectUri of [
      "https://client.example/callback.evil", // suffixed
      "https://client.example/call", // truncated
      "https://client.example.evil/callback", // lookalike host
      "https://client.example/callback/", // trailing slash
      "http://client.example/callback", // downgraded scheme
      "https://client.example/callback?x=1", // extra query
    ]) {
      const response = await startAuthorization(t, { redirectUri });
      expect(response.status, `${redirectUri} was parked`).toBe(400);
    }
    expect((await startAuthorization(t)).status).toBe(200);
  });

  test("a loopback client's ephemeral port is ignored, and nothing else is", async () => {
    const { t } = await twoConnectedTenants();
    await registerClient(t, "mcp_cli", {
      redirectUris: ["http://127.0.0.1/callback"],
      applicationType: "native",
    });

    expect(
      (
        await startAuthorization(t, {
          clientId: "mcp_cli",
          redirectUri: "http://127.0.0.1:51763/callback",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await startAuthorization(t, {
          clientId: "mcp_cli",
          redirectUri: "http://127.0.0.1:51763/other",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await startAuthorization(t, {
          clientId: "mcp_cli",
          redirectUri: "https://127.0.0.1:51763/callback",
        })
      ).status,
    ).toBe(400);
  });

  test("refuses a client nobody registered", async () => {
    const { t } = await twoConnectedTenants();
    expect(
      (await startAuthorization(t, { clientId: "never-registered" })).status,
    ).toBe(400);
  });
});

describe("consent belongs to the person, not to the gateway", () => {
  test("the consent screen shows who is asking and where the code would go", async () => {
    const { t, alice } = await twoConnectedTenants();
    const started = await bodyOf(await startAuthorization(t));
    const request = await asUser(t, alice).query(
      api.functions.authorizations.getAuthorizationRequest,
      { requestId: started.requestId as string },
    );
    expect(request).toMatchObject({
      clientName: `Client ${CLIENT_A}`,
      redirectUri: REDIRECT_URI,
      scope: "context:read context:write",
      requestedWorkspaceSlug: "alfa",
    });
  });

  test("an unauthenticated caller learns nothing about a request id", async () => {
    const { t } = await twoConnectedTenants();
    const started = await bodyOf(await startAuthorization(t));
    expect(
      errorCode(
        await captureError(() =>
          t.query(api.functions.authorizations.getAuthorizationRequest, {
            requestId: started.requestId as string,
          }),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
  });

  test("nobody can approve into a workspace they do not belong to", async () => {
    const { t, bob, aliceWs } = await twoConnectedTenants();
    const started = await bodyOf(await startAuthorization(t));
    const error = await captureError(() =>
      asUser(t, bob).action(api.functions.authorizations.approveAuthorization, {
        requestId: started.requestId as string,
        workspaceId: aliceWs,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    // Nothing was armed.
    const row = await t.run((ctx) => ctx.db.query("oauthAuthorizations").first());
    expect(row?.status).toBe("pending");
    expect(row?.hashedCode).toBeUndefined();
  });

  test("the workspace comes from the approver, not from the parked request", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    // The request asked for bob's context by slug. It is a hint, nothing more.
    const { code } = await startAndApprove(
      t,
      { alice, aliceWs },
      { requestedWorkspaceSlug: "alphabet" },
    );
    const consumed = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    expect((consumed.authorization as { workspaceId: string }).workspaceId).toBe(
      aliceWs,
    );
  });

  test("a request can only be approved once", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { requestId } = await startAndApprove(t, { alice, aliceWs });
    const error = await captureError(() =>
      asUser(t, alice).action(api.functions.authorizations.approveAuthorization, {
        requestId,
        workspaceId: aliceWs,
      }),
    );
    expect(errorCode(error)).toBe("AUTHORIZATION_REQUEST_NOT_FOUND");
  });
});

describe("/gateway/codes/consume", () => {
  test("returns the authorization once, with the PKCE challenge carried forward unchanged", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    expect(body.authorization).toEqual({
      clientId: CLIENT_A,
      redirectUri: REDIRECT_URI,
      codeChallenge: await s256(VERIFIER),
      codeChallengeMethod: "S256",
      scope: "context:read context:write",
      resource: "https://mcp.context.test/mcp",
      workspaceId: aliceWs,
      userId: alice,
    });
    // The challenge that comes back is the one the client sent, and not the
    // one a different verifier would produce — the gateway's PKCE check is
    // only worth anything if this value survives the round trip untouched.
    expect((body.authorization as { codeChallenge: string }).codeChallenge).not.toBe(
      await s256(OTHER_VERIFIER),
    );
  });

  test("a replay a millisecond later sees what a code that never existed sees", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });
    await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A });

    const replay = await responseFingerprint(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    const neverExisted = await responseFingerprint(
      await gatewayPost(t, "/gateway/codes/consume", {
        code: "no-such-code",
        clientId: CLIENT_A,
      }),
    );
    expect(replay).toBe(neverExisted);
    expect(JSON.parse(replay.split("\n").pop() ?? "{}")).toEqual({
      authorization: null,
    });
  });

  /**
   * The atomicity claim, exercised rather than asserted. Both redemptions are
   * in flight at once; Convex mutations are serializable, so the second one
   * cannot see `approved`.
   */
  test("two concurrent redemptions of the same code: exactly one succeeds", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });

    const [first, second] = await Promise.all([
      gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
      gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    ]);
    const bodies = [await bodyOf(first), await bodyOf(second)];
    const winners = bodies.filter((body) => body.authorization !== null);
    expect(winners).toHaveLength(1);
    expect((winners[0].authorization as { workspaceId: string }).workspaceId).toBe(
      aliceWs,
    );
  });

  test("a code minted for another client is refused — and burned", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", {
          code,
          clientId: CLIENT_A_SIBLING,
        }),
      ),
    ).toEqual({ authorization: null });

    // A misused code is dead, not retryable: RFC 6749 §4.1.2. The rightful
    // client cannot spend it afterwards either.
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
      ),
    ).toEqual({ authorization: null });
  });

  test("an expired code is refused", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthAuthorizations").first();
      if (row !== null) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
      ),
    ).toEqual({ authorization: null });
  });

  test("a parked request that nobody approved cannot be spent", async () => {
    const { t } = await twoConnectedTenants();
    await startAuthorization(t);
    // There is no code to guess, but even the request id is not one.
    const row = await t.run((ctx) => ctx.db.query("oauthAuthorizations").first());
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", {
          code: row!.requestId,
          clientId: CLIENT_A,
        }),
      ),
    ).toEqual({ authorization: null });
  });
});

/* -------------------------------------------------------------------------- */
