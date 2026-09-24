import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import {
  FAKE_D1,
  TEST_GATEWAY_SECRET,
  addMember,
  gatewayPost,
  seedAppSecret,
  seedStorageBinding,
  type TestConvex,
} from "../fixtures.helpers";
import {
  token,
  ACCESS_A,
  twoConnectedTenants,
  bodyOf,
} from "./fixtures";

/* 3b. /gateway/binding — the search-index credential beside it               */
/* -------------------------------------------------------------------------- */

/**
 * THE SECOND CREDENTIAL ON THE TWO-FACTOR ROUTE.
 *
 * Fast search provisions a D1 database per opted-in context and nothing was
 * copying notes into it — three databases in production, schema applied, zero
 * rows. The gateway is the only component in this system that reads note text,
 * so the projection has to be its job, and it needs two things it cannot get
 * anywhere else: a database to write into and a token that may write into it.
 *
 * They ride on `/gateway/binding` rather than a route of their own, and that is
 * the security decision rather than a convenience. A second route handing out a
 * credential is a third entry in `structure.test.ts`'s `CREDENTIAL_HTTP_ROUTES`
 * — whose comment says a second entry "means a second internet-facing path to
 * other people's bucket keys" and that a third needs the argument made again.
 * Here the argument does not have to be made: the same two proofs are spent,
 * the workspace is resolved once from the same grant, and there is no new door.
 *
 * So what these tests are about is that the *same* bound holds for the *new*
 * payload. In particular that a caller cannot name whose index it gets, which
 * is the property the whole route exists to have.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   the index lookup hoisted above the membership check, keyed on
 *     `args.expectedWorkspaceId`                                        5
 *   the index lookup left in place, keyed on `args.expectedWorkspaceId` 1
 *   the `apiToken`/`accountId` both-or-neither check dropped            1
 *   `searchProjectionState` accepting `failed` and `provisioning`       2
 *
 * The two-factor property here is **inherited rather than restated**, and the
 * two forms of the first sabotage are what measure the difference. Keying the
 * index query on the caller's own `expectedWorkspaceId` where it sits changes
 * no behaviour at all: `covered === undefined` has already returned `null` for
 * every id the token does not cover, so by the time the index is read the only
 * value that argument can hold is the one the grant resolved to. Exactly one
 * test reddens — `structure.test.ts`'s textual rule that the argument may never
 * select — which is that rule earning its place: it fails on the *shape* before
 * the shape becomes exploitable.
 *
 * Move the same lookup above the membership check and it becomes the real
 * thing: a compromised gateway holding one valid token reads any opted-in
 * context's database id and the account-wide write token, one id at a time.
 * Five tests redden, three of them in this block, and that is why the
 * cross-tenant test below asserts on the **bytes of the whole response** rather
 * than on `body.searchIndex` — under that mutant the binding half is still a
 * correct `null`, and everything that leaks leaks beside it.
 *
 * `searchProjectionState`'s own guards are unit-tested in `fastSearch.test.ts`,
 * which records why two of them measured zero from here.
 */
describe("/gateway/binding — the search index", () => {
  /**
   * An opted-in, provisioned index row, inserted directly.
   *
   * `fastSearch.enable` would schedule a real provision, which in a test
   * reaches for a Cloudflare token that is not there and flips the row to
   * `failed` partway through whatever the test was about — the same fixture
   * race `seedStorageBinding` exists to avoid.
   */
  async function seedSearchIndex(
    t: TestConvex,
    options: {
      workspaceId: Id<"workspaces">;
      optedInBy: Id<"users">;
      status?: "provisioning" | "backfilling" | "ready" | "failed" | "releasing";
      optedIn?: boolean;
      databaseId?: string;
    },
  ): Promise<void> {
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("workspacePlans", {
        workspaceId: options.workspaceId,
        managedStorage: false,
        fastSearch: true,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("searchIndexes", {
        workspaceId: options.workspaceId,
        generation: "premium-v1",
        optedIn: options.optedIn ?? true,
        optedInBy: options.optedInBy,
        optedInAt: now,
        status: options.status ?? "ready",
        databaseId: options.databaseId,
        databaseName:
          options.databaseId === undefined ? undefined : `context-search-${options.databaseId}`,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  /** The deployment configured with both halves of the platform's credential. */
  async function configureD1(t: TestConvex): Promise<void> {
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
    await seedAppSecret(t, "SEARCH_D1_ACCOUNT_ID", FAKE_D1.accountId);
  }

  test("an opted-in, provisioned context gets a write credential beside its binding", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      status: "backfilling",
      databaseId: "db-alice-0000",
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    // The binding is untouched by any of this — the fast path is an upgrade,
    // and a context whose index broke must still be able to read its bucket.
    expect((body.binding as { bucket: string }).bucket).toBe("tenant-a");
    expect(body.searchIndex).toEqual({
      databaseId: "db-alice-0000",
      accountId: FAKE_D1.accountId,
      apiToken: FAKE_D1.apiToken,
      state: "backfilling",
    });
  });

  /**
   * THE HOP, END TO END — REAL RESPONSE BYTES THROUGH REAL GATEWAY CODE.
   *
   * Every check above asserts what this route *sends*. `apps/mcp`'s suite
   * asserts what the gateway does with a descriptor it is *given*. Between
   * them sat the thing neither looked at: whether the gateway can read what
   * this route sends. It could not, for the entire life of the feature.
   *
   * The route answers `{binding, searchIndex}` as siblings.
   * `getStorageBinding` returned `parsed.binding` alone and `storeForSession`
   * then read `binding.searchIndex` — a key this route has never sent. So
   * `store.searchIndex` was `null` on every request in production,
   * `fastSearchAnswer` returned on its first line, and fast search served not
   * one search after its reader shipped. Both files documented their own shape
   * correctly; neither described the other's.
   *
   * Nothing here is hand-built, and that is the whole design of the check. The
   * bytes are this route's real response, and they are handed to the gateway's
   * REAL control-plane client and its REAL `storeForSession` — the two
   * functions the request actually passes through. A fixture cannot restate
   * one side's assumption to the other, because there is no fixture: the only
   * stub is the transport.
   *
   * Sabotage, measured: reverting either half of the fix — `getStorageBinding`
   * dropping the sibling, or `storeForSession` reading `binding.searchIndex` —
   * fails this test and 11 checks in the gateway's own suite. Before the
   * fixtures were corrected, the same two mutants failed **nothing anywhere**.
   */
  test("the gateway reads the descriptor out of the response this route really sends", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      status: "ready",
      databaseId: "db-alice-contract",
    });

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    const wire = await response.text();

    // The gateway's own modules, evaluated here for the same reason
    // `gatewayFormat.helpers.ts` evaluates `index.js`: a ported copy of either
    // would be a third opinion about the contract, and three opinions is how
    // this bug survived two of them.
    const { createControlPlane } = await import("../../../mcp/src/controlPlane.js");
    const { storeForSession } = await import("../../../mcp/src/session.js");

    // The only stub is the transport. Everything it carries is this route's
    // real bytes, parsed by the gateway's real client.
    const controlPlane = createControlPlane(
      { CONTROL_PLANE_URL: "https://control-plane.test", GATEWAY_SECRET: TEST_GATEWAY_SECRET },
      {
        fetchImpl: async () =>
          new Response(wire, { status: 200, headers: { "Content-Type": "application/json" } }),
      },
    );

    // `ContextStore` is deliberately the smallest surface the worker uses —
    // get/put/delete/list and a capability descriptor — so none of what the
    // REQUEST layer attaches to a store (`actor`, `provider`, `defer`, and
    // this) is on it. Narrowed here rather than widened there: the adapter
    // seam staying minimal is the point of that typedef.
    const store = (await storeForSession(
      { workspaceId: aliceWs, accessToken: ACCESS_A },
      {},
      controlPlane,
    )) as unknown as {
      bucket: string;
      searchIndex: { databaseId: string; accountId: string; state: string } | null;
    };

    expect(store.searchIndex).not.toBeNull();
    expect(store.searchIndex?.databaseId).toBe("db-alice-contract");
    expect(store.searchIndex?.accountId).toBe(FAKE_D1.accountId);
    expect(store.searchIndex?.state).toBe("ready");
    // And the binding half still arrives, because the fix must not have been
    // "read the other key instead".
    expect(store.bucket).toBe("tenant-a");
  });

  test("a ready index reports ready, so the gateway knows it is not backfilling", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      status: "ready",
      databaseId: "db-alice-ready",
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      }),
    );
    expect((body.searchIndex as { state: string }).state).toBe("ready");
  });

  /**
   * THE NORMAL CASE, AND IT MUST NOT BE AN ERROR.
   *
   * Almost every context has never opted in. The key is absent — not present
   * and null — so a gateway on a build that predates this reads the same bytes
   * it always did.
   */
  test("a context that never opted in has no searchIndex key at all", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await configureD1(t);

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("searchIndex");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["binding"]);
    expect((body.binding as { bucket: string }).bucket).toBe("tenant-a");
  });

  /**
   * OFF DELETES IT, SO OFF MUST STOP HANDING OUT THE KEY TO IT.
   *
   * `disable` sets `optedIn: false` and leaves the row `releasing` until
   * Cloudflare confirms the delete — deliberately, so the database can still be
   * found. A projection credential served during that window would keep writing
   * a copy of somebody's notes into a database they asked us to destroy, which
   * is the switch not working.
   */
  test("a releasing context is handed nothing, even though the row still names a database", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      optedIn: false,
      status: "releasing",
      databaseId: "db-being-deleted",
    });

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    const text = await response.text();
    expect(text).not.toContain("searchIndex");
    expect(text).not.toContain("db-being-deleted");
    expect(text).not.toContain(FAKE_D1.apiToken);
  });

  test("a half-built index is handed nothing either", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await configureD1(t);

    // Provisioning: the database may exist but the schema is not on it yet.
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      status: "provisioning",
      databaseId: "db-no-schema-yet",
    });
    let text = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      })
    ).text();
    expect(text).not.toContain("searchIndex");
    expect(text).not.toContain("db-no-schema-yet");

    // Failed, with a database recorded: a projection into a half-built database
    // is how a failure becomes data.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique();
      await ctx.db.patch(row!._id, { status: "failed" });
    });
    text = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      })
    ).text();
    expect(text).not.toContain("searchIndex");

    // Opted in and provisioned with no database id recorded — nothing to write
    // into, and naming no database is not the same as naming none of them.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique();
      await ctx.db.patch(row!._id, { status: "ready", databaseId: undefined });
    });
    text = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: null,
      })
    ).text();
    expect(text).not.toContain("searchIndex");
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * Both tenants have an index. Alice names bob's workspace, exactly as a
   * compromised gateway holding one valid token would. She is not a member of
   * it, so the binding half already answers `null` — and the assertion is on the
   * **bytes of the whole response**, not on `body.searchIndex`, because the
   * mutant this exists to catch (the index query keyed on the caller's own
   * `expectedWorkspaceId` rather than on the id the grant resolved to) leaves
   * the binding half correct and rides bob's database id and the account-wide
   * write token out beside it.
   */
  test("a caller cannot obtain another tenant's index credential by naming it", async () => {
    const { t, alice, aliceWs, bob, bobWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      databaseId: "db-alice-0000",
    });
    await seedSearchIndex(t, {
      workspaceId: bobWs,
      optedInBy: bob,
      databaseId: "db-bob-1111",
    });

    const response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: bobWs,
    });
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ binding: null });
    expect(text).not.toContain("db-bob-1111");
    expect(text).not.toContain(FAKE_D1.apiToken);
    expect(text).not.toContain(FAKE_D1.accountId);

    // Non-vacuity: alice's own call gets alice's own database, so the refusal
    // above is not "the feature is off".
    const own = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      }),
    );
    expect((own.searchIndex as { databaseId: string }).databaseId).toBe("db-alice-0000");
  });

  /**
   * The other half of that pair, kept beside it for the reason the binding
   * tests keep theirs together: a context alice really is a member of opens.
   *
   * The credential belongs to the *context*, not to the caller's role in it —
   * the same as the bucket key beside it. A member searching bob's workspace is
   * answered from bob's database, filtered by `canSee` at read time, so the
   * gateway needs the projection for whichever context the call addressed.
   */
  test("a context the caller is a member of opens, index and all", async () => {
    const { t, alice, bob, bobWs } = await twoConnectedTenants();
    await configureD1(t);
    await addMember(t, bobWs, alice, "member");
    await seedSearchIndex(t, {
      workspaceId: bobWs,
      optedInBy: bob,
      databaseId: "db-bob-1111",
    });

    const body = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      }),
    );
    expect((body.binding as { workspaceId: string }).workspaceId).toBe(bobWs);
    expect((body.searchIndex as { databaseId: string }).databaseId).toBe("db-bob-1111");

    // And the moment that membership goes, so does the reach — the set is
    // re-read on every request.
    const membership = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", bobWs).eq("userId", alice),
        )
        .unique(),
    );
    await t.run((ctx) => ctx.db.delete(membership!._id));
    const after = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
      })
    ).text();
    expect(JSON.parse(after)).toEqual({ binding: null });
    expect(after).not.toContain("db-bob-1111");
  });

  /**
   * A deployment nobody has configured is an ordinary state, not a crash — the
   * same rule `fastSearchProvision` states for the provisioner. A self-hoster
   * who never pasted a D1 token gets a working binding and no fast search.
   *
   * Half-configured reads exactly like unconfigured, because there is one cure.
   */
  test("an unconfigured deployment serves the binding and no index", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      databaseId: "db-alice-0000",
    });

    // Neither half set.
    let response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    let text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("searchIndex");
    expect((JSON.parse(text).binding as { bucket: string }).bucket).toBe("tenant-a");

    // The token but not the account id.
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
    response = await gatewayPost(t, "/gateway/binding", {
      accessToken: ACCESS_A,
      expectedWorkspaceId: aliceWs,
    });
    text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("searchIndex");
    expect(text).not.toContain(FAKE_D1.apiToken);
  });

  /**
   * THE TOKEN IS IN NO REFUSAL, ON ANY SHAPE OF THE REQUEST.
   *
   * A credential that reaches an error body reaches a log, a bug report and a
   * screenshot. Every negative this route can produce is checked against the
   * configured token in one sweep, including the refusals that happen before
   * the two proofs are even read.
   */
  test("the write token never appears in a refusal", async () => {
    const { t, alice, aliceWs, bobWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedSearchIndex(t, {
      workspaceId: aliceWs,
      optedInBy: alice,
      databaseId: "db-alice-0000",
    });

    const attempts: { body: unknown; secret?: string | null }[] = [
      { body: { accessToken: ACCESS_A, expectedWorkspaceId: bobWs } },
      { body: { accessToken: "unknown-token", expectedWorkspaceId: null } },
      { body: { accessToken: ACCESS_A, expectedWorkspaceId: "not-even-an-id" } },
      { body: { accessToken: ACCESS_A, expectedWorkspaceId: [bobWs] } },
      { body: {} },
      { body: "not-an-object" },
      { body: { accessToken: ACCESS_A }, secret: "wrong-secret" },
      { body: { accessToken: ACCESS_A }, secret: null },
    ];

    for (const [index, attempt] of attempts.entries()) {
      const text = await (
        await gatewayPost(t, "/gateway/binding", attempt.body, {
          secret: attempt.secret,
        })
      ).text();
      expect(text, `attempt ${index} leaked the token`).not.toContain(
        FAKE_D1.apiToken,
      );
      expect(text, `attempt ${index} leaked the account id`).not.toContain(
        FAKE_D1.accountId,
      );
      expect(text, `attempt ${index} leaked a database id`).not.toContain(
        "db-alice-0000",
      );
    }

    // Non-vacuity: the happy path really does carry all three, so the sweep
    // above is not passing because nothing is ever returned.
    const ok = await (
      await gatewayPost(t, "/gateway/binding", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
      })
    ).text();
    expect(ok).toContain(FAKE_D1.apiToken);
    expect(ok).toContain("db-alice-0000");
  });
});

/* -------------------------------------------------------------------------- */
