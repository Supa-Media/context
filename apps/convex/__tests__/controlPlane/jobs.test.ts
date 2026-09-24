import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { hashToken } from "../../functions/lib/crypto";
import {
  FAKE_D1,
  FAKE_STORAGE,
  TEST_GATEWAY_SECRET,
  addMember,
  asUser,
  createUser,
  gatewayPost,
  responseFingerprint,
  seedAppSecret,
  type TestConvex,
} from "../fixtures.helpers";
import {
  token,
  ACCESS_A,
  twoConnectedTenants,
  danglingWorkspaceId,
  bodyOf,
} from "./fixtures";

/* 3c. /gateway/jobs/* — queued gateway work                                  */
/* -------------------------------------------------------------------------- */

describe("/gateway/jobs/*", () => {
  test("an owner-private grant mints a hashed ticket and opens one queued move", async () => {
    const { t, alice, bob, aliceWs, grantA } = await twoConnectedTenants();
    await t.run((ctx) =>
      ctx.db.patch(grantA, { scopes: ["context:read", "context:write", "context:private"] }),
    );

    const created = await bodyOf(
      await gatewayPost(t, "/gateway/jobs/create", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        job: { kind: "materialize_move", moveId: "move-aaaaaaaaaaaa" },
      }),
    );
    const ticket = created.ticket as string;
    expect(typeof ticket).toBe("string");
    expect(ticket).not.toContain(ACCESS_A);

    const rows = await t.run((ctx) => ctx.db.query("gatewayJobs").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].hashedTicket).toBe(await hashToken(ticket));
    expect(JSON.stringify(rows[0])).not.toContain(ticket);

    const opened = await bodyOf(await gatewayPost(t, "/gateway/jobs/open", { ticket }));
    const job = opened.job as {
      job: { workspaceId: Id<"workspaces">; moveId: string };
      binding: { workspaceId: Id<"workspaces">; bucket: string };
    };
    expect(job.job.workspaceId).toBe(aliceWs);
    expect(job.job.moveId).toBe("move-aaaaaaaaaaaa");
    expect(job.binding.workspaceId).toBe(aliceWs);
    expect(job.binding.bucket).toBe("tenant-a");

    const replay = await bodyOf(await gatewayPost(t, "/gateway/jobs/open", { ticket }));
    expect(replay).toEqual({ job: null });

    await gatewayPost(t, "/gateway/jobs/report", {
      ticket,
      result: {
        status: "queued",
        progress: { phase: "copying", completed: 502, total: 501 },
      },
    });
    const invalidProgress = await t.run((ctx) => ctx.db.query("gatewayJobs").unique());
    expect(invalidProgress?.progressCompleted).toBeUndefined();

    const reopened = await bodyOf(await gatewayPost(t, "/gateway/jobs/open", { ticket }));
    expect(reopened.job).not.toBeNull();
    await gatewayPost(t, "/gateway/jobs/report", {
      ticket,
      result: {
        status: "queued",
        progress: { phase: "copying", completed: 100, total: 501 },
      },
    });
    const progressed = await t.run((ctx) => ctx.db.query("gatewayJobs").unique());
    expect(progressed).toMatchObject({
      status: "queued",
      progressPhase: "copying",
      progressCompleted: 100,
      progressTotal: 501,
    });

    const visible = await asUser(t, alice).query(api.functions.files.listDurableMoves, {
      workspaceId: aliceWs,
    });
    expect(visible).toEqual([
      expect.objectContaining({
        status: "queued",
        phase: "copying",
        completed: 100,
        total: 501,
      }),
    ]);
    expect(JSON.stringify(visible)).not.toContain("move-aaaaaaaaaaaa");
    const editor = await createUser(t, "move-editor@example.test");
    await addMember(t, aliceWs, editor, "editor", alice);
    await expect(
      asUser(t, editor).query(api.functions.files.listDurableMoves, { workspaceId: aliceWs }),
    ).rejects.toThrow();
    await expect(
      asUser(t, bob).query(api.functions.files.listDurableMoves, { workspaceId: aliceWs }),
    ).rejects.toThrow();
  });

  test("a job request cannot select a workspace outside the token's owner-private reach", async () => {
    const { t, aliceWs, bobWs, grantA } = await twoConnectedTenants();
    await t.run((ctx) =>
      ctx.db.patch(grantA, { scopes: ["context:read", "context:write", "context:private"] }),
    );

    const cross = await bodyOf(
      await gatewayPost(t, "/gateway/jobs/create", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: bobWs,
        job: { kind: "materialize_move", moveId: "move-bbbbbbbbbbbb" },
      }),
    );
    expect(cross).toEqual({ ticket: null });

    await t.run((ctx) => ctx.db.patch(grantA, { scopes: ["context:read", "context:write"] }));
    const teamTier = await bodyOf(
      await gatewayPost(t, "/gateway/jobs/create", {
        accessToken: ACCESS_A,
        expectedWorkspaceId: aliceWs,
        job: { kind: "materialize_move", moveId: "move-cccccccccccc" },
      }),
    );
    expect(teamTier).toEqual({ ticket: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 3d. /gateway/search-index/progress — the backfill reporting back          */
/* -------------------------------------------------------------------------- */

/**
 * THE ROUTE WITH ONE PROOF, AND WHY IT IS SAFE TO HAVE ONE.
 *
 * A backfill runs behind a response and outlives the request that started it,
 * so there is no user access token to present — the same reason the ingest
 * routes cannot present one. What a holder of the gateway secret can therefore
 * do here, for a workspace it names, is the whole of the residual risk: write
 * two integers onto a row, and move one that is already backfilling to `ready`.
 *
 * It cannot read anything. It cannot learn whether the id it named exists,
 * whether that context opted in, or whether the report was applied — **every
 * input is answered with the same bytes**, which is the property the first test
 * here is about and the reason `/gateway/usage` is shaped the same way.
 *
 * Everything else is the control plane owning its own row. The gateway knows
 * how many notes it wrote; it does not know whether the owner turned the
 * feature off while it was writing them, and a report that could re-open a row
 * somebody turned off would make the switch not work.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   `recordProjectionProgress` dropping the `searchProjectionState` gate    2
 *   `status` assigned `"ready"` unconditionally                             1
 *   a report without `state` demoting a `ready` row to `backfilling`        1
 *   the route answering `{ applied }` instead of one constant answer        1
 *   `countField` coercing rather than refusing a bad count                  2
 *
 * The gate row is **2, not 3**, and the missing one is worth naming. The mutant
 * run was `if (binding === null) return` in place of the composed gate, and a
 * context that never opted in has no row at all — so any implementation that
 * reads a row before writing to it refuses that case, and "a report for a
 * context that never opted in is refused" cannot separate them. It is still
 * written, because what it pins is the *product* property (no row means never
 * asked, so the count of customers we hold a copy for stays a count rather than
 * a filter) rather than that one line of the gate.
 *
 * The other two — opted out mid-release, and half-built — do separate, and they
 * are two tests rather than one because the states arrive by different routes
 * through the product and a future change could reopen either alone.
 *
 * `recordProjectionProgress` also re-validates the counts the route already
 * validated, and that guard measured **zero** from here for the reason
 * `fastSearch.test.ts` records: the door is one caller, and only a direct call
 * to the mutation can tell the two layers apart. The test that does is there.
 */
describe("/gateway/search-index/progress", () => {
  async function enabledIndex(t: TestConvex, workspaceId: Id<"workspaces">, owner: Id<"users">) {
    const now = Date.now();
    await t.run(async (ctx) => {
      const plan = await ctx.db
        .query("workspacePlans")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      if (plan === null) {
        await ctx.db.insert("workspacePlans", {
          workspaceId,
          managedStorage: false,
          fastSearch: true,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
      }
      await ctx.db.insert("searchIndexes", {
        workspaceId,
        generation: "premium-v1",
        optedIn: true,
        optedInBy: owner,
        optedInAt: now,
        status: "backfilling",
        databaseId: "db-progress",
        databaseName: "context-search-progress",
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  async function indexRow(t: TestConvex, workspaceId: Id<"workspaces">) {
    return await t.run((ctx) =>
      ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
  }

  async function report(
    t: TestConvex,
    body: unknown,
    options: { secret?: string | null } = {},
  ): Promise<Response> {
    return await gatewayPost(t, "/gateway/search-index/progress", body, options);
  }

  test("a report from the gateway moves the counters an owner reads", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);

    const response = await report(t, {
      workspaceId: aliceWs,
      notesIndexed: 41,
      notesPending: 7,
    });
    expect(response.status).toBe(200);

    const row = await indexRow(t, aliceWs);
    expect(row?.notesIndexed).toBe(41);
    expect(row?.notesPending).toBe(7);
    // Still backfilling: reporting progress is not declaring victory.
    expect(row?.status).toBe("backfilling");

    // And the owner's screen sees it, percentage and all.
    const status = await asUser(t, alice).query(api.functions.fastSearch.status, {
      workspaceId: aliceWs,
    });
    expect(status.notesIndexed).toBe(41);
    expect(status.notesPending).toBe(7);
    expect(status.percentIndexed).toBe(85);
    expect(status.state).toBe("preparing");
  });

  test("the gateway saying ready is what finishes the backfill", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);

    await report(t, {
      workspaceId: aliceWs,
      notesIndexed: 48,
      notesPending: 0,
      state: "ready",
    });
    expect((await indexRow(t, aliceWs))?.status).toBe("ready");
    const status = await asUser(t, alice).query(api.functions.fastSearch.status, {
      workspaceId: aliceWs,
    });
    expect(status.state).toBe("on");
    expect(status.percentIndexed).toBe(100);

    // A later report without `ready` must not restart the spinner: a gateway
    // that keeps projecting new notes after finishing is the ordinary case.
    await report(t, { workspaceId: aliceWs, notesIndexed: 50, notesPending: 2 });
    const row = await indexRow(t, aliceWs);
    expect(row?.status).toBe("ready");
    expect(row?.notesPending).toBe(2);
  });

  /**
   * A CONTEXT THAT IS NOT OPTED IN IS NOT A ROW TO WRITE TO.
   *
   * Three shapes, one gate, three tests — because they arrive by three routes
   * through the product and a change could reopen any of them alone.
   */
  test("a report for a context that never opted in is refused", async () => {
    const { t, aliceWs } = await twoConnectedTenants();

    const response = await report(t, {
      workspaceId: aliceWs,
      notesIndexed: 41,
      notesPending: 7,
    });
    expect(response.status).toBe(200);
    // No row was created. "No row means never asked" is how the count of
    // customers we hold a copy for stays a count rather than a filter.
    expect(await indexRow(t, aliceWs)).toBeNull();
    expect(
      await t.run(async (ctx) => (await ctx.db.query("searchIndexes").collect()).length),
    ).toBe(0);
  });

  test("a report cannot re-open a row somebody turned off", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);
    // The owner turns it off. The row survives as `releasing` so the delete can
    // still find its database.
    await asUser(t, alice).mutation(api.functions.fastSearch.disable, {
      workspaceId: aliceWs,
    });
    expect((await indexRow(t, aliceWs))?.status).toBe("releasing");

    // The backfill, which has been running all along, reports in and says it
    // finished. This is the late arrival that must change nothing.
    await report(t, {
      workspaceId: aliceWs,
      notesIndexed: 999,
      notesPending: 0,
      state: "ready",
    });

    const row = await indexRow(t, aliceWs);
    // Not `ready`: that would put a database mid-delete back into service.
    expect(row?.status).toBe("releasing");
    expect(row?.optedIn).toBe(false);
    // And not the counters either — a row nobody is serving from should not be
    // accumulating a census of somebody's notes.
    expect(row?.notesIndexed).toBeUndefined();
    expect(row?.notesPending).toBeUndefined();

    // The owner's screen still says off, which is what they pressed.
    const status = await asUser(t, alice).query(api.functions.fastSearch.status, {
      workspaceId: aliceWs,
    });
    expect(status.state).toBe("off");
  });

  test("a half-built index cannot be declared ready by a report", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);

    for (const status of ["provisioning", "failed"] as const) {
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("searchIndexes")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
          .unique();
        await ctx.db.patch(row!._id, { status });
      });

      await report(t, {
        workspaceId: aliceWs,
        notesIndexed: 12,
        notesPending: 0,
        state: "ready",
      });

      const row = await indexRow(t, aliceWs);
      expect(row?.status, `${status} was moved by a progress report`).toBe(status);
      expect(row?.notesIndexed).toBeUndefined();
    }
  });

  /**
   * EVERY INPUT IS ANSWERED IDENTICALLY.
   *
   * A holder of the gateway secret must not be able to use this route to learn
   * which contexts have opted in. An accepted report, a refused one, one for a
   * context that does not exist and one for an id that is not an id are the
   * same status, the same headers and the same bytes — the comparison
   * `isolation.test.ts` insists on, because "both returned 200" is not the
   * property that stops an oracle.
   */
  test("an accepted report and a refused one are byte-identical", async () => {
    const { t, alice, aliceWs, bobWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);
    const dangling = await danglingWorkspaceId(t);

    const fingerprints = await Promise.all(
      [
        // Accepted.
        { workspaceId: aliceWs, notesIndexed: 1, notesPending: 1 },
        // A real context that never opted in.
        { workspaceId: bobWs, notesIndexed: 1, notesPending: 1 },
        // A context that does not exist.
        { workspaceId: dangling, notesIndexed: 1, notesPending: 1 },
        // Not an id at all.
        { workspaceId: "not-even-an-id", notesIndexed: 1, notesPending: 1 },
        // Malformed in every other way.
        { workspaceId: aliceWs, notesIndexed: -1, notesPending: 1 },
        { workspaceId: aliceWs, notesIndexed: 1.5, notesPending: 1 },
        { workspaceId: aliceWs, notesIndexed: "12", notesPending: 1 },
        { workspaceId: aliceWs, notesIndexed: 1 },
        { workspaceId: aliceWs, notesIndexed: 1, notesPending: 1, state: "on" },
        {},
      ].map(async (body) => responseFingerprint(await report(t, body as unknown))),
    );
    for (const [index, fingerprint] of fingerprints.entries()) {
      expect(fingerprint, `case ${index} answered differently`).toBe(fingerprints[0]);
    }

    // Non-vacuity: the accepted one really was applied, so the sameness above is
    // not "nothing works".
    expect((await indexRow(t, aliceWs))?.notesIndexed).toBe(1);
    // ...and none of the refusals wrote anything.
    expect(await indexRow(t, bobWs)).toBeNull();
  });

  /**
   * A COUNT THAT IS NOT A COUNT IS REFUSED, NOT COERCED.
   *
   * These are rendered to an owner as a percentage. A negative makes a progress
   * bar run backwards; a stored `Infinity` makes the row unrenderable for good;
   * a fraction is a note count that is not a number of notes.
   */
  test("a malformed count writes nothing at all", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);
    await report(t, { workspaceId: aliceWs, notesIndexed: 10, notesPending: 5 });

    for (const bad of [
      { notesIndexed: -1, notesPending: 0 },
      { notesIndexed: 0, notesPending: -1 },
      { notesIndexed: 1.5, notesPending: 0 },
      { notesIndexed: Number.MAX_VALUE * 2, notesPending: 0 },
      { notesIndexed: "41", notesPending: 7 },
      { notesIndexed: null, notesPending: 7 },
      { notesIndexed: 41 },
    ]) {
      await report(t, { workspaceId: aliceWs, ...bad } as unknown);
      const row = await indexRow(t, aliceWs);
      expect(row?.notesIndexed, `${JSON.stringify(bad)} was written`).toBe(10);
      expect(row?.notesPending).toBe(5);
    }
  });

  test("the gateway secret is still necessary", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await enabledIndex(t, aliceWs, alice);

    for (const secret of [null, "wrong-secret", `${TEST_GATEWAY_SECRET}x`]) {
      const response = await report(
        t,
        { workspaceId: aliceWs, notesIndexed: 41, notesPending: 7 },
        { secret },
      );
      expect(response.status).toBe(401);
      expect((await indexRow(t, aliceWs))?.notesIndexed).toBeUndefined();
    }
  });

  /**
   * The route carries no credential and must never grow one. `structure.test.ts`
   * enforces the structural half — this is the behavioural one, in the same
   * spirit as the token sweep on `/gateway/binding`.
   */
  test("no answer here carries a credential of any kind", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
    await seedAppSecret(t, "SEARCH_D1_ACCOUNT_ID", FAKE_D1.accountId);
    await enabledIndex(t, aliceWs, alice);

    const text = await (
      await report(t, { workspaceId: aliceWs, notesIndexed: 41, notesPending: 7 })
    ).text();
    expect(text).not.toContain(FAKE_D1.apiToken);
    expect(text).not.toContain(FAKE_D1.accountId);
    expect(text).not.toContain("db-progress");
    expect(text).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(text).not.toContain(TEST_GATEWAY_SECRET);
  });
});

/* -------------------------------------------------------------------------- */
