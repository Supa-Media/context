import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  responseFingerprint,
  setupTest,
} from "./fixtures.helpers";
import type { TestConvex } from "./fixtures.helpers";
import { decryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";

/**
 * A PROVIDER KEY THAT NEVER APPEARS ANYWHERE BUT THE ONE PLACE IT MUST.
 *
 * The agent spends somebody's own Anthropic or OpenAI account, so the control
 * plane holds their API key. Non-negotiable #1 governs it exactly as it
 * governs a storage credential: encrypted at rest, never in Markdown, never in
 * a bucket, never in a log, never in a URL, never on a device.
 *
 * ## Why the error paths are tested harder than the happy path
 *
 * "Never in a log" is not hypothetical here — this repository shipped it.
 * #661 added a fourth key to `storageBindings.capabilities` while two routes
 * in `controlPlane.ts` restated the capability shape inline. `v.object` is
 * exact, so `openStorageBinding`'s own `returns` validator refused the answer
 * it had just built and Convex threw `ReturnsValidationError`.
 *
 * The outage was the headline and the fix was the shape. But look at what that
 * validator carries: `s3BindingValidator` has `secretAccessKey: v.string()`,
 * because the gateway signs with it. A validation error names the value it
 * rejected, so the object serialized into the production function logs
 * **with a live R2 secret and a D1 API token in it.**
 *
 * That is a whole class of bug — an error path that serializes the object it
 * is complaining about — and no happy-path test sees it. Every test below that
 * drives a failure exists because of it, and they all ask the same question:
 * with the key in hand and something going wrong, does the key get out?
 *
 * `SENTINEL` is searched for as a substring across everything reachable —
 * the thrown value, its message, its stack, the audit trail, every stored row,
 * and every client-callable answer. A fragment counts as a leak, which is why
 * it is a long distinctive string rather than a realistic-looking key.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `fingerprintOf` changed to `apiKey.slice(-8)` — the "show the last few
 *     characters" convention every provider's own console uses.
 *     → **2 fail**: `what is stored is an envelope and a hash, never the key`
 *     and `the key is not in what the console can read`. `appSecrets` already
 *     made this call — "a hash, not a prefix: what appears in a screenshot is
 *     not a fragment of the real value" — and this is that rule applied to a
 *     credential somebody else issued.
 *  2. `connectProvider` re-throwing as `new Error(\`bad key ${args.apiKey}\`)`,
 *     which is #661's mistake written by hand.
 *     → **1 fails**: `a failure with the key in hand does not carry it out`.
 *     Nothing else in the suite notices — the happy path still passes.
 *  3. The plaintext threaded into `writeCredential` and put in the audit row.
 *     → **1 fails**: `the audit trail records that it happened, not what it
 *     was`. Worth recording that this took three edits rather than one:
 *     `writeCredential` never receives the key at all — the action encrypts
 *     and passes an envelope — so the mutation that writes the audit row is
 *     structurally unable to log it. That is a better guarantee than the test,
 *     and the test is what stops somebody restoring the argument.
 *  4. `credentialRow` finding the row by provider alone, ignoring the
 *     workspace.
 *     → **1 fails**: `one workspace cannot open another's credential`.
 *  5. `encryptSecret` given `{ platform: "integration" }` instead of the
 *     workspace, so every envelope opens under one AAD.
 *     → **3 fail**: `the envelope really is the key, opened under its own
 *     workspace`, `the gateway's own route is the one place the key appears`
 *     and `connecting twice replaces rather than accumulates`.
 *
 *     The first draft of this entry claimed `an envelope does not open under
 *     another workspace` would fail, and it does not: that test calls
 *     `decryptSecret` directly, so it characterises the crypto module's AAD
 *     rather than anything this file decides. It is kept because the guarantee
 *     is worth stating where somebody will read it, but it is not evidence
 *     about this module and is no longer described as if it were.
 */

/**
 * Long, distinctive, and shaped like nothing else in the suite.
 *
 * A realistic `sk-ant-…` would share a prefix with fixtures elsewhere and a
 * substring search would go off on the wrong thing; this cannot collide.
 */
const SENTINEL = "zarquon-plumbago-9471-not-a-real-key-and-never-was";

/** Everything a thrown value can carry, flattened for one substring search. */
function spill(error: unknown): string {
  const parts = [String(error)];
  if (error instanceof Error) {
    parts.push(error.message, error.stack ?? "");
  }
  try {
    parts.push(JSON.stringify(error));
  } catch {
    // A value that will not serialize cannot carry the key into a log either.
  }
  try {
    parts.push(JSON.stringify(Object.getOwnPropertyNames(error).map((k) => (error as never)[k])));
  } catch {
    // Same.
  }
  return parts.join("\n");
}

async function connectedWorkspace(t: ReturnType<typeof setupTest>) {
  const ownerId = await createUser(t, "owner@example.com");
  const workspaceId = await createWorkspace(t, ownerId, "seyi");
  await asUser(t, ownerId).action(api.functions.providers.connectProvider, {
    workspaceId,
    provider: "anthropic",
    apiKey: SENTINEL,
  });
  return { ownerId, workspaceId };
}

/* -------------------------------------------------------------------------- */
/* The gateway's two proofs, seeded                                           */
/* -------------------------------------------------------------------------- */

/** A token long enough to be a real one, and obviously not one. */
function token(label: string): string {
  return `cat_${label}_${"0".repeat(Math.max(0, 34 - label.length))}`;
}

const CLIENT_ID = "mcp_client_agent";

/**
 * A live grant, inserted directly.
 *
 * The OAuth flow itself is `controlPlane.test.ts`'s subject; what matters here
 * is what a *live* token can and cannot open, so the grant is seeded and the
 * route is driven for real.
 */
async function seedLiveGrant(
  t: TestConvex,
  options: {
    workspaceId: Id<"workspaces">;
    userId: Id<"users">;
    accessToken: string;
    clientId?: string;
    scopes?: string[];
  },
): Promise<Id<"oauthGrants">> {
  const clientId = options.clientId ?? CLIENT_ID;
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    if (existing !== null) return;
    await ctx.db.insert("oauthClients", {
      clientId,
      clientName: `Client ${clientId}`,
      redirectUris: ["https://client.example/callback"],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      scope: "context:read context:write",
      applicationType: "web",
      createdAt: Date.now(),
    });
  });

  return await t.run(async (ctx) =>
    ctx.db.insert("oauthGrants", {
      workspaceId: options.workspaceId,
      userId: options.userId,
      clientId,
      scopes: options.scopes ?? ["context:read", "context:write"],
      hashedRefreshToken: await hashToken(`${options.accessToken}-refresh`),
      hashedAccessToken: await hashToken(options.accessToken),
      accessTokenExpiresAt: Date.now() + 3_600_000,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

/** One `/gateway/provider` call, exactly as the gateway makes it. */
async function openViaGateway(
  t: TestConvex,
  body: Record<string, unknown>,
  options: { secret?: string | null } = {},
): Promise<Response> {
  return await gatewayPost(t, "/gateway/provider", body, options);
}

async function credentialOf(response: Response): Promise<unknown> {
  return (JSON.parse(await response.text()) as { credential?: unknown }).credential;
}

describe("what is stored", () => {
  test("what is stored is an envelope and a hash, never the key", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);

    const rows = await t.run(async (ctx) => await ctx.db.query("providerCredentials").collect());
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    expect(row.encryptedApiKey).not.toContain(SENTINEL);
    // A hash of the whole key, so a screenshot of the console shows nothing
    // that is part of the real value — `appSecrets` makes the same call.
    expect(row.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(SENTINEL).not.toContain(row.fingerprint);
    expect(row.workspaceId).toBe(workspaceId);
  });

  test("the envelope really is the key, opened under its own workspace", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);

    const row = await t.run(
      async (ctx) => (await ctx.db.query("providerCredentials").collect())[0]!,
    );
    const opened = await decryptSecret(row.encryptedApiKey, requireKeyset(), { workspaceId });

    expect(opened).toBe(SENTINEL);
  });

  test("an envelope does not open under another workspace", async () => {
    /*
      The AAD is the whole of what makes a stolen envelope useless in another
      tenant, so it is asserted directly rather than inferred from the route
      that happens to use it today.
    */
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);
    const otherId = await createUser(t, "other@example.com");
    const otherWorkspace = await createWorkspace(t, otherId, "supa");

    const row = await t.run(
      async (ctx) => (await ctx.db.query("providerCredentials").collect())[0]!,
    );
    expect(row.workspaceId).toBe(workspaceId);

    await expect(
      decryptSecret(row.encryptedApiKey, requireKeyset(), { workspaceId: otherWorkspace }),
    ).rejects.toThrow();
  });
});

describe("what comes back out", () => {
  test("the key is not in what the console can read", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);

    const listed = await asUser(t, ownerId).query(api.functions.providers.listProviders, {
      workspaceId,
    });

    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provider).toBe("anthropic");
    expect(listed[0]!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the gateway's own route is the one place the key appears", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    const opened = await t.action(internal.functions.providers.openProviderForGateway, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: null,
      provider: "anthropic",
    });

    expect(opened?.apiKey).toBe(SENTINEL);
  });

  test("a token for one workspace cannot open another's credential", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);

    /*
      A second customer, fully connected, with a live token of their own. The
      attack is the one `openStorageBinding`'s header names: a gateway holding
      a valid token naming somebody else's workspace. `expectedWorkspaceId`
      selects *within* the token's own set, so an id outside it finds nothing —
      and the AAD on the envelope is the second lock behind that.
    */
    const otherId = await createUser(t, "other@example.invalid");
    const otherWorkspace = await createWorkspace(t, otherId, "supa");
    const otherToken = token("other");
    await seedLiveGrant(t, {
      workspaceId: otherWorkspace,
      userId: otherId,
      accessToken: otherToken,
      clientId: "mcp_client_other",
    });

    const opened = await t.action(internal.functions.providers.openProviderForGateway, {
      hashedAccessToken: await hashToken(otherToken),
      expectedWorkspaceId: workspaceId,
      provider: "anthropic",
    });

    expect(opened).toBeNull();
  });

  test("the audit trail records that it happened, not what it was", async () => {
    const t = setupTest();
    await connectedWorkspace(t);

    const events = await t.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(events.some((e) => e.action === "agent.provider.connected")).toBe(true);
  });
});

describe("the error paths, which are where #661 happened", () => {
  test("a failure with the key in hand does not carry it out", async () => {
    /*
      Every one of these reaches the action with the key already in `args` and
      then goes wrong. That is the shape of the production incident: not a
      route that returns a secret, but a route that *fails* while holding one
      and serializes what it was holding.
    */
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const strangerId = await createUser(t, "stranger@example.com");
    const memberId = await createUser(t, "member@example.com");
    await addMember(t, workspaceId, memberId, "member");

    const failures: Array<[string, () => Promise<unknown>]> = [
      [
        "a workspace the caller is not in",
        () =>
          asUser(t, strangerId).action(api.functions.providers.connectProvider, {
            workspaceId,
            provider: "anthropic",
            apiKey: SENTINEL,
          }),
      ],
      [
        "a role that may not write",
        () =>
          asUser(t, memberId).action(api.functions.providers.connectProvider, {
            workspaceId,
            provider: "anthropic",
            apiKey: SENTINEL,
          }),
      ],
      [
        "a provider this build does not know",
        () =>
          asUser(t, ownerId).action(api.functions.providers.connectProvider, {
            workspaceId,
            provider: "hal9000",
            apiKey: SENTINEL,
          }),
      ],
      [
        "nobody signed in",
        () =>
          t.action(api.functions.providers.connectProvider, {
            workspaceId,
            provider: "anthropic",
            apiKey: SENTINEL,
          }),
      ],
    ];

    for (const [name, run] of failures) {
      const error = await captureError(run);
      expect(error, `${name} should have failed`).toBeDefined();
      expect(spill(error), `${name} leaked the key`).not.toContain(SENTINEL);
    }
  });

  test("a refused key is refused without being quoted back", async () => {
    /*
      The most tempting place to print a secret is the message explaining why
      it was no good. "Expected a key starting with sk-, got <the key>" is how
      that gets written, and it is one careless line from the same outcome.
    */
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const error = await captureError(() =>
      asUser(t, ownerId).action(api.functions.providers.connectProvider, {
        workspaceId,
        provider: "anthropic",
        apiKey: `   ${SENTINEL}\n`,
      }),
    );

    expect(error).toBeDefined();
    expect(errorCode(error)).toBe("INVALID_PROVIDER_KEY");
    expect(spill(error)).not.toContain(SENTINEL);
  });

  test("nothing is stored when the key is refused", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    await captureError(() =>
      asUser(t, ownerId).action(api.functions.providers.connectProvider, {
        workspaceId,
        provider: "anthropic",
        apiKey: "",
      }),
    );

    const rows = await t.run(async (ctx) => await ctx.db.query("providerCredentials").collect());
    expect(rows).toHaveLength(0);
  });
});

describe("who may change it", () => {
  test("a member may not connect a provider", async () => {
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");
    const memberId = await createUser(t, "member@example.com");
    await addMember(t, workspaceId, memberId, "member");

    const error = await captureError(() =>
      asUser(t, memberId).action(api.functions.providers.connectProvider, {
        workspaceId,
        provider: "anthropic",
        apiKey: SENTINEL,
      }),
    );

    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("an OpenAI-compatible endpoint is not connectable yet, and that is deliberate", async () => {
    /*
      `compatible` needs a customer-supplied base URL, and a URL the gateway
      attaches somebody's key to is an exfiltration route in a shared workspace
      and an SSRF everywhere else. `storage.ts` refuses loopback and
      private-network addresses for a bucket endpoint and those guards are
      private to it; borrowing them is a refactor of a security surface, and
      the request this URL would feed does not exist yet.

      So the provider is absent rather than half-validated, and this test is
      what makes adding it back a deliberate act with a diff to review.
    */
    const t = setupTest();
    const ownerId = await createUser(t, "owner@example.com");
    const workspaceId = await createWorkspace(t, ownerId, "seyi");

    const error = await captureError(() =>
      asUser(t, ownerId).action(api.functions.providers.connectProvider, {
        workspaceId,
        provider: "compatible",
        apiKey: SENTINEL,
      }),
    );

    expect(errorCode(error)).toBe("UNKNOWN_PROVIDER");
    expect(spill(error)).not.toContain(SENTINEL);
  });

  test("a stranger cannot read which providers are connected", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);
    const strangerId = await createUser(t, "stranger@example.com");

    const error = await captureError(() =>
      asUser(t, strangerId).query(api.functions.providers.listProviders, { workspaceId }),
    );

    expect(error).toBeDefined();
  });

  test("disconnecting removes the row and says so in the audit trail", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);

    await asUser(t, ownerId).mutation(api.functions.providers.disconnectProvider, {
      workspaceId,
      provider: "anthropic",
    });

    const rows = await t.run(async (ctx) => await ctx.db.query("providerCredentials").collect());
    expect(rows).toHaveLength(0);

    const events = await t.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(events.some((e) => e.action === "agent.provider.disconnected")).toBe(true);
  });

  test("connecting twice replaces rather than accumulates", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);

    await asUser(t, ownerId).action(api.functions.providers.connectProvider, {
      workspaceId,
      provider: "anthropic",
      apiKey: "a-second-key-entirely-different-from-the-first-one",
    });

    const rows = await t.run(async (ctx) => await ctx.db.query("providerCredentials").collect());
    expect(rows).toHaveLength(1);

    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });
    const opened = await t.action(internal.functions.providers.openProviderForGateway, {
      hashedAccessToken: await hashToken(accessToken),
      expectedWorkspaceId: null,
      provider: "anthropic",
    });
    expect(opened?.apiKey).toBe("a-second-key-entirely-different-from-the-first-one");
  });
});

/* -------------------------------------------------------------------------- */
/* /gateway/provider — the fourth door, and why there is one at all           */
/* -------------------------------------------------------------------------- */

/**
 * THE ROUTE THAT HANDS THE GATEWAY A MODEL KEY, AND EVERYTHING IT REFUSES.
 *
 * ## Why a route rather than a field on `/gateway/binding`
 *
 * `/gateway/binding` grew `searchIndex`, `encryptionKey` and `rotation` as
 * *siblings* precisely to avoid a new entry in `CREDENTIAL_HTTP_ROUTES`, and
 * that reasoning is written into `http.ts`. It does not carry here, for one
 * reason: #661 was a **returns validator** accident. `v.object` is exact, a
 * field drifted, and the error serialized the object it had just refused —
 * with `secretAccessKey` inside it. Folding a model key into that same
 * validator makes one error path able to spill a storage secret *and* a model
 * key, where today it can spill one.
 *
 * So the model key gets a validator of its own, two flat fields wide, with
 * nothing nested in it to drift. That is a smaller blast radius than the
 * sibling, bought with a door — and the door is the same door: the same
 * factory, the same gateway secret, the same access token, the same
 * `expectedWorkspaceId`-is-compared-never-looked-up rule, and `null` for
 * everything that is not a hit.
 *
 * ## Why no scope beyond a live grant
 *
 * A token that can open this can already open the workspace's *storage*
 * credential through `/gateway/binding` — the whole bucket, read and write.
 * A model key that bills the owner's Anthropic account is strictly less than
 * that, so requiring more here would be theatre. What bounds it is what bounds
 * the binding: the grant is live, revocable, and named in the audit trail.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  7. The membership selection replaced by the caller's argument taken on
 *     trust — `const covered = { workspaceId: args.expectedWorkspaceId ??
 *     session.workspaceId }` — which is the "compromised gateway names the
 *     workspace" attack `openStorageBinding`'s header describes.
 *     → **3 fail**: `a token for one workspace cannot open another's
 *     credential`, `/gateway/provider > a token cannot name a workspace
 *     outside its own set`, and `structure.test.ts`'s `expectedWorkspaceId is
 *     never used as a lookup key`. One tenant's live token really does open
 *     another tenant's provider key under it.
 *
 *     **The first draft of this entry described a different, narrower edit** —
 *     `credentialRow` keyed on `args.expectedWorkspaceId` rather than on
 *     `covered.workspaceId` — and claimed these behavioural tests would catch
 *     it. They do not. Only the structural one fails, because the membership
 *     compare runs first and `find` guarantees the two values are equal, so
 *     that edit is behaviour-preserving *today*. Which is exactly the case the
 *     mechanical rule exists for: it fails on the shape, before some later
 *     reorder makes the shape matter. Both results are kept, because the
 *     surprising one is the more useful.
 *  8. The unknown-provider check deleted, so `credentialRow` is reached with an
 *     arbitrary string.
 *     → **2 fail**: `an unknown provider is answered exactly like an unknown
 *     token` and `no refusal this route can give carries the key`. Neither
 *     fails because a key escaped. The second fails because the request stops
 *     producing a response at all — Convex refuses `credentialRow`'s argument
 *     validator and the error escapes instead of the route answering — and
 *     that is the point. The refusal has to be ours, in the handler, where it
 *     is one uniform `null`. A validator refusing out of band is both a
 *     different answer a caller can count (so, an oracle for the provider set)
 *     and an error path that names the value it rejected, which is #661's
 *     shape with a different value in it.
 *  9. The route returning `{ credential, workspaceId: expected.value }` — the
 *     field a debugging session adds and forgets.
 *     → **4 fail**: `a hit names the provider and the key, and nothing else`,
 *     and the three fingerprint comparisons — `a token cannot name a workspace
 *     outside its own set`, `a malformed request is answered exactly like an
 *     unknown token`, and `an omitted expectedWorkspaceId means the grant's own
 *     context`. The fingerprints are the ones that matter: a field that echoes
 *     the request makes two refusals distinguishable, which is how a uniform
 *     `null` quietly stops being uniform.
 */
describe("/gateway/provider", () => {
  test("the gateway secret is necessary", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    const response = await openViaGateway(
      t,
      { accessToken, expectedWorkspaceId: null, provider: "anthropic" },
      { secret: null },
    );

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(SENTINEL);
  });

  test("the gateway secret is never sufficient", async () => {
    const t = setupTest();
    await connectedWorkspace(t);

    const response = await openViaGateway(t, {
      accessToken: "not-a-token",
      expectedWorkspaceId: null,
      provider: "anthropic",
    });

    expect(response.status).toBe(200);
    expect(await credentialOf(response)).toBeNull();
  });

  test("a hit names the provider and the key, and nothing else", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    const response = await openViaGateway(t, {
      accessToken,
      expectedWorkspaceId: null,
      provider: "anthropic",
    });

    /*
      `toEqual` on the whole body rather than on one field. The point of this
      route's shape is that there is nothing else in it — a workspace id, a
      fingerprint or a grant id added here for debugging is a fact about a
      customer travelling beside a credential, and #661 is what happens when
      something travels beside a credential unnoticed.
    */
    expect(JSON.parse(await response.text())).toEqual({
      credential: { provider: "anthropic", apiKey: SENTINEL },
    });
  });

  test("a token cannot name a workspace outside its own set", async () => {
    const t = setupTest();
    const { workspaceId } = await connectedWorkspace(t);

    const otherId = await createUser(t, "other@example.invalid");
    const otherWorkspace = await createWorkspace(t, otherId, "supa");
    const otherToken = token("other");
    await seedLiveGrant(t, {
      workspaceId: otherWorkspace,
      userId: otherId,
      accessToken: otherToken,
      clientId: "mcp_client_other",
    });

    const response = await openViaGateway(t, {
      accessToken: otherToken,
      expectedWorkspaceId: workspaceId,
      provider: "anthropic",
    });

    const unknownToken = await openViaGateway(t, {
      accessToken: "not-a-token",
      expectedWorkspaceId: null,
      provider: "anthropic",
    });
    expect(await responseFingerprint(response)).toBe(
      await responseFingerprint(unknownToken),
    );
  });

  test("a member of the workspace opens it, because membership is the rule", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const mateId = await createUser(t, "mate@example.invalid");
    await addMember(t, workspaceId, mateId, "member");

    const mateToken = token("mate");
    await seedLiveGrant(t, {
      workspaceId,
      userId: mateId,
      accessToken: mateToken,
      clientId: "mcp_client_mate",
    });

    /*
      Recorded rather than asserted quietly: a *member* of a shared context can
      spend its owner's model account. That is the same answer `/gateway/binding`
      gives — a member's token opens the storage credential too — and changing it
      here without changing it there would mean a member who can rewrite every
      note but not ask a question about one.
    */
    const response = await openViaGateway(t, {
      accessToken: mateToken,
      expectedWorkspaceId: workspaceId,
      provider: "anthropic",
    });

    expect(await credentialOf(response)).toEqual({
      provider: "anthropic",
      apiKey: SENTINEL,
    });
  });

  test("a revoked grant opens nothing", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    const grantId = await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    await t.run(async (ctx) => await ctx.db.patch(grantId, { status: "revoked" }));

    const response = await openViaGateway(t, {
      accessToken,
      expectedWorkspaceId: null,
      provider: "anthropic",
    });

    expect(await credentialOf(response)).toBeNull();
  });

  test("an unconnected provider is answered exactly like an unknown token", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    const unconnected = await openViaGateway(t, {
      accessToken,
      expectedWorkspaceId: null,
      provider: "openai",
    });
    const unknownToken = await openViaGateway(t, {
      accessToken: "not-a-token",
      expectedWorkspaceId: null,
      provider: "openai",
    });

    expect(await responseFingerprint(unconnected)).toBe(
      await responseFingerprint(unknownToken),
    );
  });

  test("an unknown provider is answered exactly like an unknown token", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    for (const provider of ["ollama", "", "anthropic ", "../anthropic"]) {
      const response = await openViaGateway(t, {
        accessToken,
        expectedWorkspaceId: null,
        provider,
      });
      expect(response.status, `provider ${JSON.stringify(provider)}`).toBe(200);
      expect(await credentialOf(response), `provider ${JSON.stringify(provider)}`).toBeNull();
    }
  });

  test("a malformed request is answered exactly like an unknown token", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    const baseline = await responseFingerprint(
      await openViaGateway(t, {
        accessToken: "not-a-token",
        expectedWorkspaceId: null,
        provider: "anthropic",
      }),
    );

    const malformed: Array<Record<string, unknown>> = [
      {},
      { accessToken },
      { accessToken, expectedWorkspaceId: 7, provider: "anthropic" },
      { accessToken, expectedWorkspaceId: "", provider: "anthropic" },
      { accessToken, expectedWorkspaceId: null, provider: 7 },
      { accessToken: 7, expectedWorkspaceId: null, provider: "anthropic" },
      { accessToken: "", expectedWorkspaceId: null, provider: "anthropic" },
    ];
    for (const body of malformed) {
      const response = await openViaGateway(t, body);
      expect(await responseFingerprint(response), JSON.stringify(body)).toBe(baseline);
    }
  });

  /**
   * An absent `expectedWorkspaceId` is not malformed — it is the request the
   * gateway makes when a tool call named no context.
   *
   * Drafting this suite I had it in the malformed list, and the run said
   * otherwise: `nullableStringField` reads absent and explicit `null`
   * identically, and `/gateway/binding` has meant "the grant's own context" by
   * both since it was written. Two routes that spend the same two proofs must
   * not disagree about what an omitted field means, so the test now pins the
   * agreement rather than asserting my first guess at it.
   */
  test("an omitted expectedWorkspaceId means the grant's own context, exactly as the binding route reads it", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    const omitted = await openViaGateway(t, { accessToken, provider: "anthropic" });
    const explicit = await openViaGateway(t, {
      accessToken,
      expectedWorkspaceId: null,
      provider: "anthropic",
    });

    expect(await responseFingerprint(omitted)).toBe(
      await responseFingerprint(explicit),
    );
    expect(JSON.parse(await (await openViaGateway(t, { accessToken, provider: "anthropic" })).text())).toEqual({
      credential: { provider: "anthropic", apiKey: SENTINEL },
    });
  });

  test("no refusal this route can give carries the key", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await connectedWorkspace(t);
    const accessToken = token("owner");
    await seedLiveGrant(t, { workspaceId, userId: ownerId, accessToken });

    const refusals: Array<[Record<string, unknown>, { secret?: string | null }]> = [
      [{ accessToken: "not-a-token", expectedWorkspaceId: null, provider: "anthropic" }, {}],
      [{ accessToken, expectedWorkspaceId: null, provider: "ollama" }, {}],
      [{ accessToken, expectedWorkspaceId: null, provider: "openai" }, {}],
      [{}, {}],
      [{ accessToken, expectedWorkspaceId: null, provider: "anthropic" }, { secret: null }],
      [{ accessToken, expectedWorkspaceId: null, provider: "anthropic" }, { secret: "wrong" }],
    ];

    for (const [body, options] of refusals) {
      const text = await (await openViaGateway(t, body, options)).text();
      expect(text, JSON.stringify(body)).not.toContain(SENTINEL);
    }
  });
});
