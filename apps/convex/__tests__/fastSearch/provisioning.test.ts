import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import {
  asUser,
  errorCode,
  seedAppSecret,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  FAST_SEARCH_GENERATION,
} from "../../functions/lib/fastSearch";
import {
  context,
  bindingRow,
} from "./fixtures";

describe("opting out while provisioning is in flight", () => {
  test("a result for an opted-out row does not start it serving", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "raced");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-3" });
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });

    // The provisioner finishes and reports success, after the opt-out.
    const applied = await t.mutation(
      internal.functions.fastSearch.recordProvisionResult,
      { workspaceId, status: "ready", databaseId: "db-3" },
    );
    expect(applied.applied).toBe(false);

    const row = await bindingRow(t, workspaceId);
    // Resurrecting a database somebody asked us to delete is the failure this
    // guard exists for.
    expect(row?.status).toBe("releasing");
    expect(row?.optedIn).toBe(false);
  });

  test("but a database id learned late is still recorded, so the release can find it", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "late-id");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    // Opt out before the provisioner has told anyone what it created.
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    // The row is gone, because there was no database to release...
    expect(await bindingRow(t, workspaceId)).toBeNull();

    // ...and a late result for a forgotten row applies to nothing rather than
    // recreating one.
    const applied = await t.mutation(
      internal.functions.fastSearch.recordProvisionResult,
      { workspaceId, status: "ready", databaseId: "db-4" },
    );
    expect(applied.applied).toBe(false);
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  /**
   * THE MUTATION IS THE INVARIANT, NOT THE ROUTE.
   *
   * `/gateway/search-index/progress` refuses a malformed count with
   * `countField` before this is ever called, so every route test passes with
   * this guard deleted. That is the shape this repository keeps finding: a
   * green suite over an unchecked guard, and the second caller — a cron, a
   * console repair, whatever needs to reconcile a stuck backfill — is the one
   * that will not have the door's validation in front of it.
   *
   * Called directly, which is the only way to tell the two layers apart.
   *
   * SABOTAGE: delete the integer check from `recordProjectionProgress` and this
   * fails (1); every route test stays green.
   */
  test("the progress mutation refuses a malformed count on its own", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "progress-direct");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    const row = await bindingRow(t, workspaceId);
    await t.run(async (ctx) => {
      await ctx.db.patch(row!._id, {
        status: "backfilling",
        databaseId: "db-direct",
        notesIndexed: 10,
        notesPending: 5,
      });
    });

    for (const counts of [
      { notesIndexed: -1, notesPending: 0 },
      { notesIndexed: 0, notesPending: -1 },
      { notesIndexed: 1.5, notesPending: 0 },
      { notesIndexed: 0, notesPending: 0.25 },
    ]) {
      const result = await t.mutation(
        internal.functions.fastSearch.recordProjectionProgress,
        { workspaceId, ready: false, ...counts },
      );
      expect(result.applied, `${JSON.stringify(counts)} was applied`).toBe(false);
      const after = await bindingRow(t, workspaceId);
      expect(after?.notesIndexed).toBe(10);
      expect(after?.notesPending).toBe(5);
    }

    // Non-vacuity: a well-formed report on the same row is applied.
    const ok = await t.mutation(
      internal.functions.fastSearch.recordProjectionProgress,
      { workspaceId, notesIndexed: 12, notesPending: 3, ready: false },
    );
    expect(ok.applied).toBe(true);
    expect((await bindingRow(t, workspaceId))?.notesIndexed).toBe(12);
  });

  test("forgetIndex refuses a row that was re-enabled", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "re-enabled");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-5", status: "ready" });
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    // Changed their mind while the delete was in flight.
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    const forgotten = await t.mutation(
      internal.functions.fastSearch.forgetIndex,
      { workspaceId },
    );
    // Forgetting here would strand the database the provisioner is now
    // building for the re-enabled row.
    expect(forgotten.forgotten).toBe(false);
    expect(await bindingRow(t, workspaceId)).not.toBeNull();
  });
});

describe("a search database this deployment just created is given time to settle", () => {
  /*
    THE THIRD INSTANCE OF THE UPGRADE RACE, FOUND BY LOOKING FOR IT.

    `provisionIndex` creates a D1 database and applies its schema in the next
    breath, and the `catch` around both wrote `status: "failed"` on the first
    error of any kind. A database that is not routable for a moment after
    creation — or one rate-limited request, or one 5xx — therefore parked fast
    search in a failed state that nothing recovers: `sweepStalledBackfills`
    only picks up rows that reached `backfilling`, so the sole cure was the
    owner noticing and toggling the switch again.

    Same shape as the managed copy, same fix: retry what a retry can fix, for a
    bounded window, and keep a permanent failure for what will answer the same
    way forever.
  */
  async function configured(t: TestConvex) {
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", "d1_operator_obviously_fake");
    await seedAppSecret(t, "SEARCH_D1_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
  }

  /** A D1 that answers `status` to everything. 404 is a database not yet routable. */
  function stubD1(status: number) {
    vi.stubGlobal("fetch", async () => ({
      ok: status < 400,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () =>
        JSON.stringify(
          status < 400
            ? { success: true, errors: [], result: { uuid: "db-uuid", name: "ctx-db" } }
            : { success: false, errors: [{ code: 7404, message: "not found" }] },
        ),
    }));
  }

  async function optedIn(t: TestConvex, slug: string) {
    const { owner, workspaceId } = await context(t, slug);
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, { workspaceId });
    return { owner, workspaceId };
  }

  test("a database that is not routable yet is retried, not failed", async () => {
    const t = setupTest();
    await configured(t);
    stubD1(404);
    try {
      const { workspaceId } = await optedIn(t, "d1-settling");

      await t.action(internal.functions.fastSearchProvision.provisionIndex, {
        workspaceId,
        generation: FAST_SEARCH_GENERATION,
      });

      const row = await bindingRow(t, workspaceId);
      // Still on its way, not broken. `failed` here is a claim we have not
      // earned and, worse, one nothing sweeps back up.
      expect(row?.status).not.toBe("failed");
      const scheduled = await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      );
      expect(
        scheduled.some((job) => job.name.includes("provisionIndex")),
      ).toBe(true);
      await t.run(async (ctx) => {
        for (const job of scheduled) {
          if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
        }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("but one that outlasts the window is recorded as failed", async () => {
    const t = setupTest();
    await configured(t);
    stubD1(404);
    try {
      const { workspaceId } = await optedIn(t, "d1-outlasts");

      await t.action(internal.functions.fastSearchProvision.provisionIndex, {
        workspaceId,
        generation: FAST_SEARCH_GENERATION,
        retryUntil: Date.now() - 1,
      });

      expect((await bindingRow(t, workspaceId))?.status).toBe("failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a refused credential is not retried into the deadline", async () => {
    /*
      The operator token is not newly minted — it is standing configuration —
      so a 403 is a deployment that is misconfigured and will answer the same
      way in two minutes. Retrying it just delays the message a staffer needs.
    */
    const t = setupTest();
    await configured(t);
    stubD1(403);
    try {
      const { workspaceId } = await optedIn(t, "d1-refused");

      await t.action(internal.functions.fastSearchProvision.provisionIndex, {
        workspaceId,
        generation: FAST_SEARCH_GENERATION,
      });

      const row = await bindingRow(t, workspaceId);
      expect(row?.status).toBe("failed");
      expect(row?.errorCode).toBe("UNAUTHORIZED");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a name already taken in our own account is this context's database", () => {
  /*
    THE DEAD END A PERSON ACTUALLY HIT, AND WHY "TRY AGAIN" COULD NOT CLEAR IT.

    `databaseNameFor` is deterministic, so every attempt for one workspace asks
    Cloudflare for the same name. Four ordinary things make that name already
    exist with no `databaseId` on the row to show for it: a create whose answer
    was lost, two schedules racing, a release that deleted the row and not the
    database, and a database migrated into this account ahead of the provision
    that will ask for it. Cloudflare answers a taken name outside the four
    statuses `classify` names, so it landed on `REFUSED` — which this file's
    own settling tests prove is terminal, correctly, because a malformed
    request does not become well-formed by waiting.

    The result was a context parked on "The index could not be prepared" with
    six words of explanation, a "Try again" that ran the identical create, and
    no way out at all: `disable` on a row with no `databaseId` deletes the row
    outright, so even off-and-on-again came back to the same create.

    `managedProvisioning.ts` had already argued this through for buckets —
    "a bucket that already exists for this workspace **is** this workspace's,
    and the run adopts it" — and D1 is the same argument with a sharper safety
    margin, because a search database is a disposable derivative and a bucket
    is the customer's only copy.

    SABOTAGE, measured rather than assumed. Replacing `ensureDatabase` with the
    old bare `createDatabase` reddens the first two here and nothing else;
    dropping `RESET_STATEMENTS` from the adopt branch reddens the second alone;
    running the reset unconditionally reddens the third alone; dropping the
    exact-name check in `findDatabaseByName` reddens the fifth alone.
  */
  async function configured(t: TestConvex) {
    await seedAppSecret(t, "SEARCH_D1_API_TOKEN", "d1_operator_obviously_fake");
    await seedAppSecret(t, "SEARCH_D1_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
  }

  /**
   * A Cloudflare that refuses the create and answers the lookup however the
   * test says, recording every statement that reaches the query endpoint.
   *
   * The create's shape is the real one: HTTP 400 with a `success: false`
   * envelope, which is neither of the statuses that retry and is exactly why
   * the old code called it permanent.
   */
  function stubD1({ existing }: { existing: { uuid: string; name: string }[] }) {
    const sql: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
      const json = (status: number, body: unknown) => ({
        ok: status < 400,
        status,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
      });
      if (url.includes("/query")) {
        sql.push(JSON.parse(String((init as { body?: string })?.body ?? "{}")).sql);
        return json(200, { success: true, errors: [], result: [{ results: [] }] });
      }
      if (init?.method === "GET") {
        return json(200, { success: true, errors: [], result: existing });
      }
      return json(400, {
        success: false,
        errors: [{ code: 7502, message: "database already exists" }],
      });
    });
    return sql;
  }

  async function optedIn(t: TestConvex, slug: string) {
    const { owner, workspaceId } = await context(t, slug);
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, { workspaceId });
    return { owner, workspaceId };
  }

  test("the database already sitting there is adopted, not refused forever", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await optedIn(t, "d1-adopt");
    const sql = stubD1({
      existing: [{ uuid: "db-orphaned", name: `context-search-${workspaceId}` }],
    });
    try {
      await t.action(internal.functions.fastSearchProvision.provisionIndex, {
        workspaceId,
        generation: FAST_SEARCH_GENERATION,
      });

      const row = await bindingRow(t, workspaceId);
      // It got somewhere, rather than back to the card it started on.
      expect(row?.status).toBe("backfilling");
      expect(row?.databaseId).toBe("db-orphaned");
      expect(row?.errorCode).toBeUndefined();
      // And it really did apply the schema to the adopted one.
      expect(sql.some((statement) => statement.includes("notes_team_fts"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("and it is emptied first, so the backfill cannot resume past notes it never wrote", async () => {
    /*
      The invariant, not the field. An adopted database can carry the previous
      life's cursor in `index_state`, and the backfill reads that cursor to
      decide where to start. Adopt without dropping it and the pass resumes
      past every note before that point — which are then never projected, while
      the counters report a finished index. A hole in the front of somebody's
      search that nothing ever reports.
    */
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await optedIn(t, "d1-adopt-reset");
    const sql = stubD1({
      existing: [{ uuid: "db-with-a-cursor", name: `context-search-${workspaceId}` }],
    });
    try {
      await t.action(internal.functions.fastSearchProvision.provisionIndex, {
        workspaceId,
        generation: FAST_SEARCH_GENERATION,
      });

      const dropped = sql.findIndex((statement) =>
        statement.includes("DROP TABLE IF EXISTS index_state"),
      );
      const created = sql.findIndex((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS index_state"),
      );
      expect(dropped).toBeGreaterThanOrEqual(0);
      // Dropped BEFORE the schema goes back on, or the drop takes the schema
      // with it and leaves a database with no tables at all.
      expect(created).toBeGreaterThan(dropped);
      for (const table of ["notes", "notes_private_fts", "notes_team_fts"]) {
        expect(sql).toContain(`DROP TABLE IF EXISTS ${table}`);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a freshly created database is not emptied, because there is nothing to empty", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await optedIn(t, "d1-fresh");
    const sql: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
      const ok = (body: unknown) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
      });
      if (url.includes("/query")) {
        sql.push(JSON.parse(String(init?.body ?? "{}")).sql);
        return ok({ success: true, errors: [], result: [{ results: [] }] });
      }
      return ok({
        success: true,
        errors: [],
        result: { uuid: "db-new", name: `context-search-${workspaceId}` },
      });
    });
    try {
      await t.action(internal.functions.fastSearchProvision.provisionIndex, {
        workspaceId,
        generation: FAST_SEARCH_GENERATION,
      });

      expect((await bindingRow(t, workspaceId))?.databaseId).toBe("db-new");
      expect(sql.some((statement) => statement.startsWith("DROP TABLE"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a refusal with nothing there to adopt is still a refusal", async () => {
    // Adoption must not turn every refused create into a silent success. An
    // account out of D1 databases, or a token that may not create one, is a
    // deployment somebody has to fix, and the row has to say so.
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await optedIn(t, "d1-nothing-to-adopt");
    stubD1({ existing: [] });
    try {
      await t.action(internal.functions.fastSearchProvision.provisionIndex, {
        workspaceId,
        generation: FAST_SEARCH_GENERATION,
      });

      const row = await bindingRow(t, workspaceId);
      expect(row?.status).toBe("failed");
      expect(row?.errorCode).toBe("REFUSED");
      expect(row?.databaseId).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a database whose name merely resembles this one is never adopted", async () => {
    /*
      Cloudflare's `name` filter is a match, not an identity, and
      `databaseNameFor` is a shared prefix plus a workspace id. A lookup that
      trusted the filter would adopt whatever came back first — another
      context's database — and then drop its tables and project this
      context's notes into it. One tenant's search answered out of another
      tenant's storage is the isolation failure this repo tests for, arrived
      at through a convenience.
    */
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await optedIn(t, "d1-near-miss");
    stubD1({
      existing: [{ uuid: "db-someone-else", name: `context-search-${workspaceId}-old` }],
    });
    try {
      await t.action(internal.functions.fastSearchProvision.provisionIndex, {
        workspaceId,
        generation: FAST_SEARCH_GENERATION,
      });

      const row = await bindingRow(t, workspaceId);
      expect(row?.status).toBe("failed");
      expect(row?.databaseId).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a plan sync must not strand the database it is forgetting", () => {
  /*
    THE HANDLE ON A LIVE DATABASE IS THE ONLY THING THAT CAN DELETE IT.

    `enable` gets this right: it clears `databaseId` only when the generation
    changed, because old coordinates belong to a retired account, and it keeps
    them otherwise so a retry reuses what it already made. The test above
    pins that.

    `syncPremiumSelection` — the same decision, reached from billing instead of
    from the owner's switch — cleared them unconditionally. Both of the states
    that reach its `else` branch on the CURRENT generation hold a live D1
    database:

      - a `failed` row, which records `databaseId` before applying the schema
        precisely so a schema failure knows what it created; and
      - a `releasing` row, which exists for no other purpose than to be deleted.

    Clearing there is not a cosmetic loss. `releaseIndex` reaches a database
    only through `binding.databaseId`, and with it gone it calls `forgetIndex`
    and reports `released: true` having deleted nothing — so "off actually
    deletes it", which `fastSearchProvision`'s header states as the point of
    the release path, silently stops being true and a derived copy of somebody's
    notes outlives the context that asked for it.

    Not a race, either, for the failed row: it sits in that state until somebody
    acts, and the trigger is any ordinary billing event — a renewal webhook, a
    plan change, an owner re-selecting their entitlements.
  */
  async function payingWithDatabase(
    t: TestConvex,
    slug: string,
    fields: Partial<Doc<"searchIndexes">>,
  ) {
    const { owner, workspaceId } = await context(t, slug);
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, { workspaceId });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, fields);
    });
    return { owner, workspaceId };
  }

  test("a failed row keeps the database it created", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await payingWithDatabase(t, "sync-keeps-failed", {
      status: "failed",
      databaseId: "db-live-with-notes",
      databaseName: "context-search-live",
      errorCode: "REFUSED",
      error: "The schema could not be applied.",
    });

    // An ordinary billing event, not an owner action.
    await t.mutation(internal.functions.fastSearch.syncPremiumSelection, {
      workspaceId,
      actorUserId: owner,
    });

    const row = await bindingRow(t, workspaceId);
    expect(row?.databaseId).toBe("db-live-with-notes");
    expect(row?.databaseName).toBe("context-search-live");
    // Still retried — keeping the handle must not cost the retry.
    expect(row?.status).toBe("provisioning");
    expect(row?.errorCode).toBeUndefined();
  });

  test("a releasing row keeps the database it is mid-way through deleting", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await payingWithDatabase(t, "sync-keeps-releasing", {
      status: "ready",
      databaseId: "db-awaiting-delete",
      databaseName: "context-search-awaiting",
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, { workspaceId });
    expect(await bindingRow(t, workspaceId)).toMatchObject({
      status: "releasing",
      databaseId: "db-awaiting-delete",
    });

    await t.mutation(internal.functions.fastSearch.syncPremiumSelection, {
      workspaceId,
      actorUserId: owner,
    });

    // Re-opted in, so `releaseIndex` will stand down rather than delete — and
    // the database it stands down from is the one this row still names, which
    // `provisionIndex` then reuses instead of creating a second one.
    expect(await bindingRow(t, workspaceId)).toMatchObject({
      optedIn: true,
      databaseId: "db-awaiting-delete",
    });
  });

  test("but a legacy row still lets go, because those coordinates are another account's", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await payingWithDatabase(t, "sync-drops-legacy", {
      // A row written before Premium launched: the field is optional and only
      // ever holds the current literal, so "legacy" is its absence.
      generation: undefined,
      status: "failed",
      databaseId: "db-in-the-old-account",
      databaseName: "context-search-old",
    });

    await t.mutation(internal.functions.fastSearch.syncPremiumSelection, {
      workspaceId,
      actorUserId: owner,
    });

    const row = await bindingRow(t, workspaceId);
    expect(row?.generation).toBe(FAST_SEARCH_GENERATION);
    expect(row?.databaseId).toBeUndefined();
  });
});
