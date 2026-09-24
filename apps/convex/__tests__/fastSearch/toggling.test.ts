import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { storageMoved } from "../../functions/storage";
import {
  asUser,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  fastSearchActive,
  fastSearchOptedIn,
} from "../../functions/lib/fastSearch";
import {
  context,
  bindingRow,
  workspaceDoc,
  planDoc,
} from "./fixtures";

describe("turning it on", () => {
  test("writes one row, opted in, and reports preparing", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "on-ctx");

    const result = await asUser(t, owner).mutation(
      api.functions.fastSearch.enable,
      { workspaceId },
    );
    expect(result.state).toBe("preparing");

    const row = await bindingRow(t, workspaceId);
    expect(row?.optedIn).toBe(true);
    expect(row?.status).toBe("provisioning");
    expect(row?.optedInBy).toBe(owner);
    // No database yet — that is the provisioner's job, and until it succeeds
    // there is nothing to delete.
    expect(row?.databaseId).toBeUndefined();
  });

  test("pressing it twice does not make a second database", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "twice");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-1", status: "ready" });
    });

    const second = await asUser(t, owner).mutation(
      api.functions.fastSearch.enable,
      { workspaceId },
    );
    expect(second.state).toBe("on");

    const rows = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].databaseId).toBe("db-1");
  });

  test("a failed index can actually be retried, which it could not", async () => {
    // The bug this pins: a failed row keeps `optedIn: true`, because nobody
    // opted out — the provision fell over. `enable` returned early on
    // `optedIn` alone, so every press of the card's "Try again" returned the
    // failure it was called to clear and wrote nothing at all. Asserting the
    // returned state would not catch it, because a no-op and a real retry can
    // both read "preparing" to a caller. What separates them is that the row
    // was WRITTEN: the error cleared and the clock moved.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "retry");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      // Exactly the shape a refused Cloudflare token leaves behind.
      await ctx.db.patch(row!._id, {
        status: "failed",
        errorCode: "UNAUTHORIZED",
        error: "The configured Cloudflare token was refused.",
        updatedAt: 1,
      });
    });

    const again = await asUser(t, owner).mutation(
      api.functions.fastSearch.enable,
      { workspaceId },
    );
    expect(again.state).toBe("preparing");

    const rows = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("provisioning");
    expect(rows[0].error).toBeUndefined();
    expect(rows[0].errorCode).toBeUndefined();
    // The clock moved, so a write happened. An early return leaves this at 1.
    expect(rows[0].updatedAt).toBeGreaterThan(1);
  });

  /**
   * AND RE-ENABLING MUST NOT LOSE THE HANDLE ON WHAT WAS ALREADY BUILT.
   *
   * `enable`'s re-enable patch keeps `databaseId` on purpose, and its comment
   * says why: "so the sweep still knows what to delete if this fails again."
   * Nothing was asserting it. Adding `databaseId: undefined` to that patch
   * reddened **nothing** — including the test directly above, which checks the
   * row count, the status, the cleared error and the clock, every field except
   * the one whose loss cannot be undone.
   *
   * TWO ROUTES REACH THAT PATCH, and only one of them is new. The failed-retry
   * route arrived with the fix above. The **`releasing` route did not**:
   * `disable` sets `optedIn: false`, so a row mid-release never satisfied the
   * old `existing !== null && existing.optedIn` early return either, and the
   * patch has run down that path since `#209` — which is what the comment it
   * quotes is actually about ("if the release had not finished"). Both routes
   * are covered below, because the older one was unproved for longer.
   *
   * WHAT THE MUTANT COSTS, traced rather than assumed. `provisionIndex`
   * creates a database only `if (databaseId === undefined)`, so a cleared
   * handle sends the next provision back to `createDatabase` — with the same
   * deterministic `databaseNameFor(workspaceId)`, so whether Cloudflare then
   * duplicates or refuses is provider behaviour this repo neither tests nor
   * documents, and is not asserted here. What IS traceable, and is worse: with
   * `databaseId` gone, `disable` takes its `existing.databaseId === undefined`
   * branch and **deletes the row outright** — no `releasing`, no schedule, no
   * retry. The handle on a live database holding a derived copy of this
   * customer's note text is destroyed by the very action that exists to delete
   * that copy, and `releaseIndex` reaches a database only through
   * `binding.databaseId`. Nothing in this repository can find it afterwards;
   * `databaseNameFor` is deterministic, so an operator still could, which is
   * the difference between unrecoverable and merely lost.
   *
   * That defeats the second of the two questions this file exists to answer:
   * *does off actually delete it?* So the tests below turn it off and check
   * that the row survives as `releasing` with its handle, rather than checking
   * two field values and stopping.
   *
   * SABOTAGE: `databaseId: undefined` in the re-enable patch reddens both tests
   * below and nothing else.
   */
  test("a retry keeps the database it already provisioned, so nothing is orphaned", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "retry-keeps-db");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    // The real partial-failure shape: `provisionIndex` records `databaseId`
    // BEFORE applying the schema, precisely so a schema failure leaves a row
    // that still knows what it created. So this is a failure WITH a database.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, {
        status: "failed",
        databaseId: "db-already-created",
        databaseName: "context-search-already-created",
        errorCode: "REFUSED",
        error: "The schema could not be applied.",
        updatedAt: 1,
      });
    });

    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });

    const retried = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(retried).toHaveLength(1);
    expect(retried[0].databaseId).toBe("db-already-created");
    expect(retried[0].databaseName).toBe("context-search-already-created");
    // And it really did retry, so the case above is not what passed here.
    expect(retried[0].status).toBe("provisioning");
    expect(retried[0].updatedAt).toBeGreaterThan(1);

    // The property, not the field. With the handle gone, `disable` takes its
    // `databaseId === undefined` branch and deletes the row — so off stops
    // being able to delete the copy, which is the whole point of off.
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    const afterOff = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(afterOff).toHaveLength(1);
    expect(afterOff[0].status).toBe("releasing");
    expect(afterOff[0].databaseId).toBe("db-already-created");
  });

  /**
   * THE OLDER ROUTE INTO THE SAME PATCH, which has been live since `#209`.
   *
   * Turning it off mid-release and turning it straight back on. `disable` sets
   * `optedIn: false`, so this never hit the old early return and has always
   * reached the re-enable patch — the case its "if the release had not
   * finished" comment is written about, and the one nothing asserted for
   * longer. Same mutant, same loss: the row is re-enabled pointing at nothing,
   * and the database it was mid-way through deleting is stranded.
   */
  test("re-enabling during a release keeps the handle on what is being released", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "reenable-mid-release");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { status: "ready", databaseId: "db-mid-release" });
    });

    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    const releasing = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(releasing[0].status).toBe("releasing");
    expect(releasing[0].databaseId).toBe("db-mid-release");

    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    const back = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(back).toHaveLength(1);
    expect(back[0].status).toBe("provisioning");
    expect(back[0].databaseId).toBe("db-mid-release");

    // And the same property the retry test ends on: off can still delete it.
    // Without the handle this row is deleted outright instead of released.
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    const afterOff = await t.run(
      async (ctx) => await ctx.db.query("searchIndexes").collect(),
    );
    expect(afterOff).toHaveLength(1);
    expect(afterOff[0].status).toBe("releasing");
    expect(afterOff[0].databaseId).toBe("db-mid-release");
  });

  test("it is audited as a decision", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "audited");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    const audit = await t.run(
      async (ctx) => await ctx.db.query("auditEvents").collect(),
    );
    expect(audit.map((row) => row.action)).toContain("search.fast_enabled");
  });
});

describe("turning it off", () => {
  test("with a database, the row survives until the delete confirms", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "off-ctx");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-9", status: "ready" });
    });

    const result = await asUser(t, owner).mutation(
      api.functions.fastSearch.disable,
      { workspaceId },
    );
    expect(result.state).toBe("off");

    const row = await bindingRow(t, workspaceId);
    // THE PROPERTY. A row deleted here is a database nothing can ever find to
    // delete — an orphaned copy of somebody's notes on our infrastructure.
    expect(row).not.toBeNull();
    expect(row?.optedIn).toBe(false);
    expect(row?.status).toBe("releasing");
    expect(row?.databaseId).toBe("db-9");
  });

  test("with no database, the row goes immediately", async () => {
    // Nothing was ever created, so there is nothing to clean up and the
    // context returns to "never asked" rather than keeping a tombstone.
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "off-early");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("a releasing context serves nothing, immediately", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "releasing");
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, {
      workspaceId,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-2", status: "ready" });
    });
    await asUser(t, owner).mutation(api.functions.fastSearch.disable, {
      workspaceId,
    });

    // The delete finishing is bookkeeping; the switch is already off.
    const row = await bindingRow(t, workspaceId);
    expect(fastSearchOptedIn(row)).toBe(false);
    expect(fastSearchActive(workspaceDoc(), planDoc(), row)).toBe(false);
  });

  test("disabling a context that was never on is a no-op", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "never-on");
    const result = await asUser(t, owner).mutation(
      api.functions.fastSearch.disable,
      { workspaceId },
    );
    expect(result.state).toBe("off");
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });
});

/**
 * THE PROJECTION IS DERIVED FROM A BUCKET. IT CANNOT OUTLIVE THE BINDING.
 *
 * A `searchIndexes` row with a `databaseId` names a real, billed D1 database
 * holding this context's notes — titles, headings, tags, body chunks. Every
 * other way a workspace can stop having a bucket already releases it:
 * `disable` when somebody turns the feature off, the account cascade when the
 * workspace is deleted.
 *
 * **Disconnecting storage did not.** The credential row was deleted, the
 * customer had revoked our key, and the projection of their notes stayed on our
 * infrastructure with nothing pointing at it — which is the outcome the opt-out
 * exists to prevent, reached by the one door nobody had checked. Reported as
 * "I disconnected it and it still had my data — it's just cached", and it was.
 *
 * A rebind onto **different** storage is the same fact arriving differently:
 * the projection describes a bucket this workspace is no longer bound to, so it
 * is stale as well as retained. A rebind onto the *same* storage is the repair
 * path — somebody rotating a key on the bucket they already had — and must keep
 * what it has, or every credential repair costs a re-provision.
 */
describe("storage going away takes the projection with it", () => {
  async function bound(t: TestConvex, slug: string, bucket: string) {
    const { owner, workspaceId } = await context(t, slug);
    await asUser(t, owner).mutation(api.functions.fastSearch.enable, { workspaceId });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { databaseId: "db-storage", status: "ready" });
      await ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "s3",
        endpoint: "https://s3.example.invalid",
        region: "auto",
        bucket,
        forcePathStyle: true,
        capabilities: {
          conditionalWrite: true,
          conditionalCreate: true,
          conditionalDelete: true,
        },
        status: "connected",
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    return { owner, workspaceId };
  }

  test("disconnecting storage releases the database, and keeps the row until it is gone", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await bound(t, "disc-ctx", "their-bucket");

    expect(
      await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
        workspaceId,
      }),
    ).toEqual({ disconnected: true });

    const row = await bindingRow(t, workspaceId);
    // Marked, not deleted — the same property `disable` has, for the same
    // reason: a row removed here is a database nothing can find to delete.
    expect(row).not.toBeNull();
    expect(row?.optedIn).toBe(false);
    expect(row?.status).toBe("releasing");
    expect(row?.databaseId).toBe("db-storage");
  });

  test("...and it serves nothing from the moment the credential is gone", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await bound(t, "disc-serve", "their-bucket");
    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });
    const row = await bindingRow(t, workspaceId);
    expect(fastSearchOptedIn(row)).toBe(false);
    expect(fastSearchActive(workspaceDoc(), planDoc(), row)).toBe(false);
  });

  test("rebinding onto a different bucket releases it too", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await bound(t, "rebind-away", "old-bucket");

    await t.mutation(internal.functions.storage.applyBinding, {
      actorUserId: owner,
      workspaceId,
      provider: "s3",
      endpoint: "https://s3.example.invalid",
      region: "auto",
      bucket: "a-different-bucket",
      accessKeyId: "AKIAEXAMPLEEXAMPLE01",
      encryptedSecretAccessKey: "not-a-real-envelope",
      forcePathStyle: true,
    });

    const row = await bindingRow(t, workspaceId);
    expect(row?.optedIn).toBe(false);
    expect(row?.status).toBe("releasing");
  });

  test("...but repairing the credential on the same bucket keeps it", async () => {
    /*
      THE HALF THAT MAKES THE OTHER HALF AFFORDABLE.

      Releasing deletes a billed database and rebuilding one is minutes of work
      against a bucket that may not even be reachable yet. Somebody rotating an
      access key on the bucket they already had has not moved their notes, and
      charging them a re-provision for a repair would make the repair the
      expensive thing to do.
    */
    const t = setupTest();
    const { owner, workspaceId } = await bound(t, "rebind-repair", "same-bucket");

    await t.mutation(internal.functions.storage.applyBinding, {
      actorUserId: owner,
      workspaceId,
      provider: "s3",
      endpoint: "https://s3.example.invalid",
      region: "auto",
      bucket: "same-bucket",
      accessKeyId: "AKIAEXAMPLEEXAMPLE99",
      encryptedSecretAccessKey: "a-rotated-envelope",
      forcePathStyle: true,
    });

    const row = await bindingRow(t, workspaceId);
    expect(row?.optedIn).toBe(true);
    expect(row?.status).toBe("ready");
    expect(row?.databaseId).toBe("db-storage");
  });

  test("...and the same bucket under a different prefix is a different place", async () => {
    // A rootPrefix is part of every key, so the same bucket under another one
    // holds a different context's worth of notes.
    const t = setupTest();
    const { owner, workspaceId } = await bound(t, "rebind-prefix", "same-bucket");

    await t.mutation(internal.functions.storage.applyBinding, {
      actorUserId: owner,
      workspaceId,
      provider: "s3",
      endpoint: "https://s3.example.invalid",
      region: "auto",
      bucket: "same-bucket",
      rootPrefix: "somewhere-else/",
      accessKeyId: "AKIAEXAMPLEEXAMPLE01",
      encryptedSecretAccessKey: "not-a-real-envelope",
      forcePathStyle: true,
    });

    expect((await bindingRow(t, workspaceId))?.status).toBe("releasing");
  });

  test("the address is what moved, never the credential", () => {
    const here = { provider: "s3", endpoint: "https://s3.example.invalid", bucket: "b" };
    expect(storageMoved(here, { ...here })).toBe(false);
    expect(storageMoved(here, { ...here, bucket: "c" })).toBe(true);
    expect(storageMoved(here, { ...here, rootPrefix: "sub/" })).toBe(true);
    expect(storageMoved(here, { provider: "dropbox", dropboxAccountId: "dbid:x" })).toBe(true);
    // A first connect has nothing to have moved from.
    expect(storageMoved(null, here)).toBe(false);
    /*
      A ROW THAT EXISTS AND NAMES NOWHERE IS A MOVE.

      This read `false` — "a half-built row names nowhere, and nowhere is not
      evidence of anything" — and that is the wrong half of the sentence to
      act on. `storageAddress` returning `null` does not mean the notes stayed
      put; it means we cannot tell, and the two answers to "cannot tell" cost
      very different things. Keeping it keeps a D1 database of one bucket's
      note text attached to a binding for another one, which is the exact
      outcome this describe block exists to prevent. Releasing it costs a
      re-provision of a disposable derivative on a row that was already
      half-built.

      It is reachable rather than hypothetical: `recordConnectFailure` writes
      `provider: "dropbox"` over a non-connected row without an account id,
      so a workspace whose S3 binding is in `error` and whose projection is
      `ready` comes out of one failed Dropbox connect with an address nothing
      can read. The integration test below walks exactly that.

      `null` — no row at all — stays `false`: a first connect has nothing to
      have moved from, and that is a different fact from a row that names
      nowhere.
    */
    expect(storageMoved({ provider: "s3" }, here)).toBe(true);
    expect(storageMoved({ provider: "dropbox" }, here)).toBe(true);
    // Dropbox is addressed by account, so the same account is the same place.
    const dbx = { provider: "dropbox", dropboxAccountId: "dbid:one" };
    expect(storageMoved(dbx, { ...dbx })).toBe(false);
    expect(storageMoved(dbx, { ...dbx, dropboxAccountId: "dbid:two" })).toBe(true);
  });

  test("a failed Dropbox connect does not strand the old bucket's notes", async () => {
    /*
      THE DOOR THIS DESCRIBE BLOCK LEFT OPEN, WALKED END TO END.

      Every step is an ordinary thing a person does:

        1. S3 bucket, fast search on, the projection holds their notes.
        2. The binding goes to `error` — a rotated key, a provider hiccup.
        3. They press Connect Dropbox and the sign-in takes too long.
           `recordConnectFailure` patches `provider: "dropbox"` onto the row
           and leaves the S3 fields where they are. There is no account id, so
           `storageAddress` can no longer read the row.
        4. They give up on Dropbox and connect a DIFFERENT bucket.

      At step 4 the row names somewhere new and the projection still holds the
      old bucket's note text — titles, headings, body chunks — with `optedIn`
      and `ready` untouched, so the gateway goes on answering searches out of
      it. The customer has revoked our key on the bucket those notes came from.
    */
    const t = setupTest();
    const { owner, workspaceId } = await bound(t, "rebind-unreadable", "old-bucket");

    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(binding!._id, { status: "error" });
    });

    await t.mutation(internal.functions.dropboxConnect.recordConnectFailure, {
      workspaceId,
      boundBy: owner,
      errorCode: "DROPBOX_CODE_EXPIRED",
    });

    // The shape that does it: a provider with no address, over a bucket that
    // still has a projection.
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      expect(binding?.provider).toBe("dropbox");
      expect(binding?.dropboxAccountId).toBeUndefined();
      expect(binding?.bucket).toBe("old-bucket");
    });
    expect((await bindingRow(t, workspaceId))?.status).toBe("ready");

    await t.mutation(internal.functions.storage.applyBinding, {
      actorUserId: owner,
      workspaceId,
      provider: "s3",
      endpoint: "https://s3.example.invalid",
      region: "auto",
      bucket: "a-different-bucket",
      accessKeyId: "AKIAEXAMPLEEXAMPLE01",
      encryptedSecretAccessKey: "not-a-real-envelope",
      forcePathStyle: true,
    });

    const row = await bindingRow(t, workspaceId);
    expect(row?.optedIn).toBe(false);
    expect(row?.status).toBe("releasing");
  });

  test("disconnecting a context with no index is an ordinary disconnect", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await context(t, "disc-none");
    await t.run(async (ctx) => {
      await ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "s3",
        endpoint: "https://s3.example.invalid",
        region: "auto",
        bucket: "plain",
        forcePathStyle: true,
        capabilities: {
          conditionalWrite: true,
          conditionalCreate: true,
          conditionalDelete: true,
        },
        status: "connected",
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect(
      await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
        workspaceId,
      }),
    ).toEqual({ disconnected: true });
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });
});

// -- the races the provisioner can lose ----------------------------------

