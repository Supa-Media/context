import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { hashToken } from "../../functions/lib/crypto";
import {
  FAKE_STORAGE,
  addMember,
  createUser,
  createWorkspace,
  gatewayPost,
  responseFingerprint,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  token,
  ACCESS_A,
  ACCESS_B,
  CLIENT_A,
  registerClient,
  seedConnectedClient,
  twoConnectedTenants,
  danglingWorkspaceId,
  removeMembership,
  bodyOf,
} from "./fixtures";

/* -------------------------------------------------------------------------- */
/* 3. /gateway/binding — the two-factor route                                 */
/* -------------------------------------------------------------------------- */

describe("/gateway/binding", () => {
  test("returns the grant's own workspace's binding, with the secret opened", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    expect(body.binding).toEqual({
      workspaceId: aliceWs,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: "tenant-a",
      accessKeyId: FAKE_STORAGE.accessKeyId,
      secretAccessKey: FAKE_STORAGE.secretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "active",
    });
  });

  test("with no workspace named, the grant decides which one comes back", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      }),
    );
    const binding = body.binding as Record<string, unknown>;
    expect(binding.workspaceId).toBe(aliceWs);
    expect(binding.bucket).toBe("tenant-a");
  });

  test("a rootPrefix is carried through when the customer set one", async () => {
    const t = setupTest();
    const user = await createUser(t, "prefix@example.invalid");
    const workspaceId = await createWorkspace(t, user, "prefixed");
    await seedStorageBinding(t, {
      workspaceId,
      boundBy: user,
      rootPrefix: "context/",
    });
    await registerClient(t, CLIENT_A);
    const accessToken = token("prefixed_owner");
    await seedConnectedClient(t, {
      workspaceId,
      userId: user,
      clientId: CLIENT_A,
      accessToken,
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken,
        expectedWorkspaceId: null,
      }),
    );
    expect((body.binding as { rootPrefix: string }).rootPrefix).toBe("context/");
  });

  /**
   * A context the caller was invited into opens; one they were not does not.
   *
   * These two are one test in two halves and must stay together. A grant covers
   * every context its person is a live member of, so the id the gateway names
   * *selects* now instead of only vetoing — and a selection that stopped being
   * bounded by membership is the catastrophe `openStorageBinding`'s own header
   * describes: a compromised gateway holding one valid token walking the
   * customer list one id at a time. The negative half is what says the bound is
   * still there.
   */
  test("a workspace the caller is a member of opens when the gateway names it", async () => {
    const { t, alice, bobWs } = await twoConnectedTenants();
    await addMember(t, bobWs, alice, "member");

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    const binding = body.binding as Record<string, unknown>;
    // The context that was asked for, and its own bucket — not the default's.
    // Answering with the grant's own id here makes the gateway refuse every
    // cross-context call as a disagreement about which tenant it is.
    expect(binding.workspaceId).toBe(bobWs);
    expect(binding.bucket).toBe("tenant-ab");
  });

  test("and stops opening the moment that membership is gone", async () => {
    const { t, alice, bobWs } = await twoConnectedTenants();
    await addMember(t, bobWs, alice, "member");
    const membership = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", bobWs).eq("userId", alice),
        )
        .unique(),
    );
    await t.run((ctx) => ctx.db.delete(membership!._id));

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    // Not "on the next token refresh": the set is re-read on every request, so
    // removing somebody cuts off the clients they already had.
    expect(body).toEqual({ binding: null });
  });

  test("naming another tenant's workspace returns nothing, never that tenant's binding", async () => {
    const { t, bobWs } = await twoConnectedTenants();
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    expect(body).toEqual({ binding: null });
  });

  test("a real-but-forbidden workspace is byte-identical to one that never existed", async () => {
    const { t, bobWs } = await twoConnectedTenants();
    const dangling = await danglingWorkspaceId(t);

    const forbidden = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    const nonexistent = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: dangling,
      }),
    );
    const nonsense = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: "not-even-an-id",
      }),
    );

    expect(forbidden).toBe(nonexistent);
    expect(forbidden).toBe(nonsense);
  });

  /**
   * The list from the contract, all at once. Distinguishing any pair of these
   * turns the route into an oracle for whoever holds the gateway secret and one
   * valid token.
   */
  test("mismatch, unknown, expired, revoked, unbound and unverified are one answer", async () => {
    const { t, alice, aliceWs, bobWs, bob, grantB } = await twoConnectedTenants();

    // A third tenant, bound but never verified.
    const carol = await createUser(t, "carol@example.invalid");
    const carolWs = await createWorkspace(t, carol, "carol-context");
    await seedStorageBinding(t, {
      workspaceId: carolWs,
      boundBy: carol,
      bucket: "tenant-c",
      status: "unverified",
    });
    const carolToken = token("tenant_c_owner");
    await seedConnectedClient(t, {
      workspaceId: carolWs,
      userId: carol,
      clientId: CLIENT_A,
      accessToken: carolToken,
      refreshToken: "crt_tenant_c_000000000000000000",
    });

    // A fourth, with no storage at all.
    const dave = await createUser(t, "dave@example.invalid");
    const daveWs = await createWorkspace(t, dave, "dave-context");
    const daveToken = token("tenant_d_owner");
    await seedConnectedClient(t, {
      workspaceId: daveWs,
      userId: dave,
      clientId: CLIENT_A,
      accessToken: daveToken,
      refreshToken: "crt_tenant_d_000000000000000000",
    });

    const expiredToken = token("expired3");
    await seedConnectedClient(t, {
      workspaceId: aliceWs,
      userId: alice,
      clientId: CLIENT_A,
      accessToken: expiredToken,
      refreshToken: "crt_expired3_00000000000000000000",
      expiresAt: Date.now() - 1,
    });
    await t.run((ctx) => ctx.db.patch(grantB, { status: "revoked" }));

    const dangling = await danglingWorkspaceId(t);
    const cases: { accessToken: unknown; expectedWorkspaceId: unknown }[] = [
      { accessToken: ACCESS_A, expectedWorkspaceId: bobWs }, // mismatch
      { accessToken: ACCESS_A, expectedWorkspaceId: dangling }, // nonexistent
      { accessToken: "unknown-token", expectedWorkspaceId: null }, // unknown
      { accessToken: expiredToken, expectedWorkspaceId: null }, // expired
      { accessToken: ACCESS_B, expectedWorkspaceId: null }, // revoked
      { accessToken: carolToken, expectedWorkspaceId: null }, // unverified storage
      { accessToken: daveToken, expectedWorkspaceId: null }, // never bound
      { accessToken: await hashToken(ACCESS_A), expectedWorkspaceId: null }, // stored hash
    ];

    const fingerprints = await Promise.all(
      cases.map(async (body) =>
        responseFingerprint(await gatewayPost(t, "/gateway/binding", body)),
      ),
    );
    for (const [index, fingerprint] of fingerprints.entries()) {
      expect(fingerprint, `case ${index} answered differently`).toBe(fingerprints[0]);
    }
    expect(JSON.parse(fingerprints[0].split("\n").pop() ?? "{}")).toEqual({
      binding: null,
    });

    // Non-vacuity: bob's own live token still gets bob's own binding, so the
    // sameness above is not "everything is broken".
    await t.run((ctx) => ctx.db.patch(grantB, { status: "active" }));
    const bobsOwn = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_B,
        expectedWorkspaceId: null,
      }),
    );
    expect((bobsOwn.binding as { bucket: string }).bucket).toBe("tenant-ab");
    expect(bob).toBeDefined();
  });

  test("a removed member's client cannot fetch a credential either", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await removeMembership(t, aliceWs, alice);
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/binding", {
          accessToken: ACCESS_A,
          expectedWorkspaceId: null,
        }),
      ),
    ).toEqual({ binding: null });
  });

  test("no call shape returns more than one workspace's binding", async () => {
    const { t, bobWs } = await twoConnectedTenants();
    // Every way of asking that could plausibly be read as "give me a list", or
    // as "give me that other one".
    for (const body of [
      { accessToken: ACCESS_A, expectedWorkspaceId: null },
      { accessToken: ACCESS_A, expectedWorkspaceId: bobWs },
      { accessToken: ACCESS_A },
      { accessToken: ACCESS_A, expectedWorkspaceId: [bobWs] },
      { accessToken: [ACCESS_A, ACCESS_B], expectedWorkspaceId: null },
    ] as unknown[]) {
      const parsed = await bodyOf(await gatewayPost(t, "/gateway/binding", body));
      expect(Array.isArray(parsed.binding)).toBe(false);
      const text = JSON.stringify(parsed);
      // Never the other tenant's bucket or key, under any shape.
      expect(text).not.toContain("tenant-ab");
      expect(text).not.toContain("EXAMPLEACCESSKEYID11");
      expect(text).not.toContain("111111");
    }
  });

  test("a credential is fetched afresh; the row is the only place it lives", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const first = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    // Disconnect underneath, and the very next call has nothing to serve. No
    // memo, no cache, no module-level state carrying one tenant's credential
    // into the next request.
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique();
      if (binding !== null) await ctx.db.delete(binding._id);
    });
    const second = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );

    expect((first.binding as { bucket: string }).bucket).toBe("tenant-a");
    expect(second).toEqual({ binding: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 3b-ii. /gateway/binding — the encryption key                              */
/* -------------------------------------------------------------------------- */

/**
 * THE THIRD SIBLING, AND THE ONE THAT OPENS NOTE CONTENT.
 *
 * `docs/decisions/encryption.md`. The workspace data key travels beside the
 * binding, on the route that was already enumerated as an internet-facing path
 * to a credential — so this adds no new door, and `structure.test.ts` is what
 * says so.
 *
 * Three properties, and the first two are the ones a "simplification" would
 * take:
 *
 *  - **Absent for a context that has never encrypted anything**, which is every
 *    context today. Not a `null` and not an empty object: the key is missing
 *    from the response entirely, exactly as `searchIndex` is, so nothing is
 *    created as a side effect of somebody reading their own notes.
 *  - **Never another tenant's.** Naming somebody else's workspace answers the
 *    same `{binding: null}` as it always did, and the assertion is on the bytes
 *    of the whole response rather than on one field, for the reason the index
 *    block's cross-tenant test gives: the mutant that matters leaves the
 *    binding half correct and rides the other tenant's key out beside it.
 *  - **Present for a context that has one**, so the two refusals above are not
 *    passing because the feature never returns anything.
 */
async function seedDataKey(t: TestConvex, workspaceId: Id<"workspaces">) {
  const opened = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, {
    workspaceId,
    create: true,
  });
  return opened!.keys[opened!.current]!;
}

describe("/gateway/binding — the encryption key", () => {

  test("a context that has never encrypted anything has no encryptionKey key at all", async () => {
    const { t, aliceWs } = await twoConnectedTenants();

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("encryptionKey");
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual(["binding"]);
  });

  test("...and asking for the binding did not create one", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });

    // The check the test above cannot make: no row, in the database, after a
    // read. A read that quietly minted a key would still answer without the
    // sibling on the *first* request and would be a row this control plane is
    // now holding for somebody who never asked.
    const rows = await t.run((ctx) => ctx.db.query("workspaceDataKeys").collect());
    expect(rows).toEqual([]);
  });

  test("a context that has a key gets it beside its binding", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const dataKey = await seedDataKey(t, aliceWs);

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    // The binding is untouched by any of this, the same way the index is an
    // upgrade beside it rather than a condition of it.
    expect((body.binding as { bucket: string }).bucket).toBe("tenant-a");
    expect(body.encryptionKey).toEqual({ current: "k1", keys: { k1: dataKey } });
  });

  test("a caller cannot obtain another tenant's encryption key by naming it", async () => {
    const { t, alice, aliceWs, bobWs } = await twoConnectedTenants();
    const aliceKey = await seedDataKey(t, aliceWs);
    const bobKey = await seedDataKey(t, bobWs);
    expect(aliceKey).not.toBe(bobKey);

    const text = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      })
    ).text();
    expect(JSON.parse(text)).toEqual({ binding: null });
    // The bytes, not the field. A key selected by the caller's own argument
    // instead of by the id the grant resolved to leaves the binding half a
    // correct `null` and leaks beside it.
    expect(text).not.toContain(bobKey);
    expect(text).not.toContain("encryptionKey");

    // Non-vacuity, and the membership half in one: alice joining bob's context
    // is answered with bob's key, because the key belongs to the context and
    // not to the caller's role in it — the same as the bucket credential.
    await addMember(t, bobWs, alice, "member");
    const joined = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    const joinedKey = joined.encryptionKey as { current: string; keys: Record<string, string> };
    expect(joinedKey.keys[joinedKey.current]).toBe(bobKey);
  });

  test("...and the refusal is byte-identical to a context that never existed", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    // Both tenants hold a key. The block above compares a forbidden answer
    // against a parsed shape, which a response carrying a *shorter* or
    // *longer* body would still satisfy; and the byte-identical test in the
    // binding block runs over a world where no key exists at all, so it cannot
    // see a length that moves only when one does. This is the composition of
    // the two, and it is the one an owner of a real context would attack.
    await seedDataKey(t, aliceWs);
    await seedDataKey(t, bobWs);
    const dangling = await danglingWorkspaceId(t);

    const forbidden = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    const nonexistent = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: dangling,
      }),
    );
    const nonsense = await responseFingerprint(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: "not-even-an-id",
      }),
    );

    expect(forbidden).toBe(nonexistent);
    expect(forbidden).toBe(nonsense);
  });

  test("a key this deployment cannot open costs the sibling, never the binding", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await seedDataKey(t, aliceWs);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceDataKeys")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique();
      await ctx.db.patch(row!._id, { encryptedDataKey: "v2:k1:AAAAAAAAAAAAAAAA:AAAA" });
    });

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    const text = await response.text();
    // The notes are what the request is waiting on; the key is what decides
    // whether the encrypted ones among them are readable. A key we cannot open
    // must cost a locked note, never somebody's whole context.
    expect(response.status).toBe(200);
    expect((JSON.parse(text).binding as { bucket: string }).bucket).toBe("tenant-a");
    expect(text).not.toContain("encryptionKey");
  });
});

/* -------------------------------------------------------------------------- */
/* 3b-iii. /gateway/binding — workspace-key rotation                        */
/* -------------------------------------------------------------------------- */

/**
 * ROTATION, DRIVEN ENTIRELY THROUGH THE ROUTE THAT WAS ALREADY ENUMERATED.
 *
 * `startEncryptionRotation` and `completeEncryptionRotation` are two more
 * optional fields on the same request `/gateway/binding` already answers, not
 * a second door — `structure.test.ts`'s `CREDENTIAL_HTTP_ROUTES` stays exactly
 * two members. See "Rotation" in `docs/decisions/encryption.md`.
 */
describe("/gateway/binding — workspace-key rotation", () => {
  test("starting a rotation mints a new generation and both keys open", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const oldKey = await seedDataKey(t, aliceWs);

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        startEncryptionRotation: true,
      }),
    );
    const key = body.encryptionKey as { current: string; keys: Record<string, string> };
    expect(key.current).toBe("k2");
    expect(key.keys.k1).toBe(oldKey);
    expect(key.keys.k2).toBeDefined();
    expect(key.keys.k2).not.toBe(oldKey);

    const rotation = body.rotation as { fromGeneration: string; toGeneration: string };
    expect(rotation).toEqual({ fromGeneration: "k1", toGeneration: "k2" });
  });

  test("a plain read reports the rotation too, without being asked to start one", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await seedDataKey(t, aliceWs);
    await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
      startEncryptionRotation: true,
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    expect(body.rotation).toEqual({ fromGeneration: "k1", toGeneration: "k2" });
  });

  test("starting a rotation twice does not mint a third generation", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await seedDataKey(t, aliceWs);

    const first = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        startEncryptionRotation: true,
      }),
    );
    const second = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        startEncryptionRotation: true,
      }),
    );
    expect(second.rotation).toEqual(first.rotation);
    expect(second.encryptionKey).toEqual(first.encryptionKey);

    const rows = await t.run((ctx) => ctx.db.query("workspaceDataKeys").collect());
    expect(rows).toHaveLength(2);
  });

  test("completing a rotation clears it, and a later rotation starts a fresh one", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await seedDataKey(t, aliceWs);
    await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
      startEncryptionRotation: true,
    });

    const completed = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        completeEncryptionRotation: "k2",
      }),
    );
    expect(completed.rotation).toBeUndefined();
    expect((completed.encryptionKey as { current: string }).current).toBe("k2");

    const next = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        startEncryptionRotation: true,
      }),
    );
    expect(next.rotation).toEqual({ fromGeneration: "k2", toGeneration: "k3" });
  });

  test("completing with the wrong target does nothing — a stale call cannot finish the next rotation", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await seedDataKey(t, aliceWs);
    await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
      startEncryptionRotation: true,
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        completeEncryptionRotation: "k9",
      }),
    );
    expect(body.rotation).toEqual({ fromGeneration: "k1", toGeneration: "k2" });
  });

  test("a rotation on one tenant never appears on another's response, and old and new material stay isolated", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    await seedDataKey(t, aliceWs);
    await seedDataKey(t, bobWs);
    await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
      startEncryptionRotation: true,
    });

    const bobBody = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_B,
        expectedWorkspaceId: bobWs,
      }),
    );
    expect(bobBody.rotation).toBeUndefined();
    expect(Object.keys((bobBody.encryptionKey as { keys: Record<string, string> }).keys)).toEqual([
      "k1",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
