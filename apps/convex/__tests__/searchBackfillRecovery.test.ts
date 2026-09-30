/**
 * A search index that failed on something waiting can fix gets going again on
 * its own, and says why it failed where a developer can read it.
 *
 * The screen that started this: Settings › Search at "Failed, 84% indexed"
 * with "Cloudflare could not be reached. This will retry.", and nothing ever
 * retried. A projection pass recorded `failed` on any D1 error, and `failed`
 * was outside everything that restarts work.
 *
 * ## Sabotage record
 *
 * Temporary local edits, reverted, counts as measured over this file:
 *
 *   a Cloudflare blip recorded as `failed` instead of retried by the chain    1
 *   the sweep restarting a failure waiting cannot fix                         1
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { FAKE_D1 } from "./fixtures.helpers";
import { cancelPendingJobs, opted, project, queued, row } from "./searchBackfill.trigger.helpers";

afterEach(async () => {
  await cancelPendingJobs();
  vi.unstubAllGlobals();
});

describe("a projection that fails on a blip", () => {
  test("a Cloudflare blip is retried by the chain, not recorded as failed", async () => {
    /*
      The screen a person actually saw: "Cloudflare could not be reached. This
      will retry." at 84%, and nothing retried, because a projection pass
      recorded `failed` on any failure and a `failed` row is outside
      everything that restarts work. A failure waiting can fix spends a link on
      a delayed retry instead, and the row keeps saying it is preparing.
    */
    const { t, workspaceId, d1 } = await opted({ notes: 3 });
    d1.fail = "UNAVAILABLE";

    await project(t, workspaceId, 4);

    const after = await row(t, workspaceId);
    expect(after?.status).toBe("backfilling");
    expect(after?.error).toBeUndefined();
    const retries = await queued(t, "runFileOperation");
    expect(retries).toHaveLength(1);
    // Delayed, not immediate: an outage answered at once is answered the same.
    expect(retries[0]!.scheduledTime).toBeGreaterThan(Date.now() + 10_000);
    // And it spends a link, which is what keeps an outage from looping forever.
    expect(retries[0]!.args[0].operation).toEqual({ kind: "projectIndex", passes: 3 });
  });

  test("a chain that runs out of links on a blip records it, for the sweep", async () => {
    const { t, workspaceId, d1 } = await opted({ notes: 3 });
    d1.fail = "RATE_LIMITED";

    await project(t, workspaceId, 0);

    const after = await row(t, workspaceId);
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("RATE_LIMITED");
    expect(after?.error).toContain("tries again on its own");
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("the sweep restarts a row that failed on a blip, counters kept", async () => {
    const { t, workspaceId } = await opted({ notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, {
        status: "failed",
        errorCode: "UNAVAILABLE",
        error: "Cloudflare could not be reached.",
        notesIndexed: 580,
        notesPending: 110,
        updatedAt: Date.now() - 86_400_000,
      });
    });

    const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    expect(swept.started).toBe(1);
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("backfilling");
    expect(after?.error).toBeUndefined();
    expect(after?.errorCode).toBeUndefined();
    // Resumed, not restarted: the percentage does not drop back to zero.
    expect(after?.notesIndexed).toBe(580);
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
  });

  test("the sweep re-provisions a row that failed on a blip before its schema", async () => {
    const { t, workspaceId } = await opted({ notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, {
        status: "failed",
        errorCode: "NOT_FOUND",
        schemaVersion: undefined,
        updatedAt: Date.now() - 86_400_000,
      });
    });

    const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    expect(swept.started).toBe(1);
    expect((await row(t, workspaceId))?.status).toBe("provisioning");
    expect(await queued(t, "provisionIndex")).toHaveLength(1);
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("the sweep leaves a terminal failure, a fresh one, and an opted-out one alone", async () => {
    for (const [patch, label] of [
      [{ errorCode: "UNAUTHORIZED" }, "refused token"],
      [{ errorCode: "NOT_CONFIGURED" }, "missing secret"],
      [{ errorCode: "UNAVAILABLE", updatedAt: Date.now() }, "failed a moment ago"],
      [{ errorCode: "UNAVAILABLE", optedIn: false }, "opted out"],
    ] as const) {
      const { t, workspaceId } = await opted({ notes: 3 });
      await t.run(async (ctx) => {
        const existing = await ctx.db
          .query("searchIndexes")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
          .unique();
        await ctx.db.patch(existing!._id, {
          status: "failed",
          updatedAt: Date.now() - 86_400_000,
          ...patch,
        });
      });

      const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

      expect(swept.started, label).toBe(0);
      expect((await row(t, workspaceId))?.status, label).toBe("failed");
    }
  });
});

describe("what a failed pass leaves for a developer", () => {
  test("every failure is logged with how it happened, and nothing of the notes", async () => {
    const { t, workspaceId, d1 } = await opted({ notes: 3 });
    d1.fail = "UNAVAILABLE";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await project(t, workspaceId, 4);

    const line = logged.mock.calls.find((call) => call[0] === "fast_search.projection_failed");
    expect(line).toBeDefined();
    const fields = line![1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      workspaceId,
      code: "UNAVAILABLE",
      cause: "http_503",
      retrying: true,
      passesLeft: 4,
    });
    // Our statement's verb and table: enough to say which step fell over.
    expect(fields.statement).toMatch(/^[A-Z]+ [a-z_]+$/);
    expect(typeof fields.elapsedMs).toBe("number");
    // And nothing else: no path, no note text, no token, no account.
    const text = JSON.stringify(line);
    expect(text).not.toContain("1-projects");
    expect(text).not.toContain("quokkaplan");
    expect(text).not.toContain(FAKE_D1.apiToken);
    expect(text).not.toContain(FAKE_D1.accountId);
  });
});

describe("Try again on a database that already holds notes", () => {
  test("keeps the count rather than showing nothing indexed", async () => {
    /*
      Pressing Try again re-runs the provisioner, which re-applies the schema
      to the recorded database and restarts the copy. It also wrote
      `notesIndexed: 0`, so a card at 84% read "Nothing indexed yet" over a
      database still holding every note it had copied.
    */
    const { t, workspaceId } = await opted({ status: "provisioning", notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { notesIndexed: 580 });
    });

    await t.action(internal.functions.fastSearchProvision.provisionIndex, {
      workspaceId,
      generation: "premium-v1",
    });

    const after = await row(t, workspaceId);
    expect(after?.status).toBe("backfilling");
    expect(after?.notesIndexed).toBe(580);
  });
});
