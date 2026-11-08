import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { createUser, createWorkspace, seedGoogleConnection, type TestConvex } from "../fixtures.helpers";
import { enableMailSync, patchConnection, readConnection, scenario } from "./fixtures.helpers";
import { MAIL_IN_NOTES_FLAG } from "../../functions/lib/googleSync/mailCopy";
import { turnOnFlagFor } from "../featureFlags.helpers";

/**
 * MAIL IN NOTES, FOR FLAGGED PEOPLE ONLY (owner, 2026-11-08).
 *
 * Copying stopped for everyone on 2026-10-21, and with it the only thing that
 * brought a check-in forward when mail arrived. The `mail.in-notes` flag turns
 * the Gmail pass back on for one person. These fail if:
 *  - a look starts a pass for someone the flag does not name (sabotage:
 *    drop the people filter in `candidates`);
 *  - a pass for a flagged person copies Calendar or Chat days (sabotage: drop
 *    the `only` filter in `forwardSyncJob.ts`);
 *  - a pass queued while the flag was on still runs after it is turned off
 *    (sabotage: drop the `MAIL_IN_NOTES_OFF` check).
 */

async function scheduledPasses(t: TestConvex) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.name.includes("runFileOperation"))
      .map((job) => job.args[0] as { workspaceId: Id<"workspaces">; operation: Record<string, unknown> }),
  );
}

async function look(t: TestConvex) {
  return await t.mutation(internal.functions.mailCopy.startFlagged, {});
}

describe("mail in notes: who gets a pass", () => {
  test("nobody is copied while the flag names nobody", async () => {
    enableMailSync();
    const { t } = await scenario();
    expect(await look(t)).toEqual({ started: 0 });
    expect(await scheduledPasses(t)).toEqual([]);
  });

  test("a flagged person's Gmail gets one Gmail-only pass, claimed", async () => {
    enableMailSync();
    const { t, owner, workspaceId, connectionId } = await scenario();
    await turnOnFlagFor(t, MAIL_IN_NOTES_FLAG, owner);
    expect(await look(t)).toEqual({ started: 1 });
    expect(await scheduledPasses(t)).toEqual([
      { workspaceId, scope: "private", operation: { kind: "googleForwardSync", connectionId, only: "gmail" } },
    ]);
    expect((await readConnection(t, connectionId)).syncStartedAt).toBeTypeOf("number");
    // Claimed: a second look a moment later starts nothing.
    expect(await look(t)).toEqual({ started: 0 });
  });

  test("another person's flag never copies this person's mail", async () => {
    enableMailSync();
    const { t } = await scenario();
    const other = await createUser(t, "other@example.invalid");
    const otherWorkspace = await createWorkspace(t, other, "other-person");
    await seedGoogleConnection(t, { workspaceId: otherWorkspace, boundBy: other, address: "other@example.invalid" });
    await turnOnFlagFor(t, MAIL_IN_NOTES_FLAG, other);
    expect(await look(t)).toEqual({ started: 1 });
    const passes = await scheduledPasses(t);
    expect(passes.map((pass) => pass.workspaceId)).toEqual([otherWorkspace]);
  });

  test("nothing starts while the deployment may not read mail", async () => {
    const { t, owner } = await scenario();
    await turnOnFlagFor(t, MAIL_IN_NOTES_FLAG, owner);
    expect(await look(t)).toEqual({ started: 0 });
  });

  test("a disconnected or still-running connection is left alone", async () => {
    enableMailSync();
    const { t, owner, connectionId } = await scenario();
    await turnOnFlagFor(t, MAIL_IN_NOTES_FLAG, owner);
    await patchConnection(t, connectionId, { syncStartedAt: Date.now() - 60_000 });
    expect(await look(t)).toEqual({ started: 0 });
    await patchConnection(t, connectionId, { syncStartedAt: undefined, disconnectedAt: Date.now() });
    expect(await look(t)).toEqual({ started: 0 });
  });
});

describe("mail in notes: the pass asks again", () => {
  test("Gmail only, even on an account that also has Calendar and Chat", async () => {
    enableMailSync();
    const { t, owner, workspaceId, connectionId } = await scenario();
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, {
      products: ["gmail", "calendar"],
      calendar: { scopes: [], destinationFolder: "inbox/calendar" },
      gmail: { ...row.gmail!, historyId: "100" },
    });
    await turnOnFlagFor(t, MAIL_IN_NOTES_FLAG, owner);
    const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, { workspaceId, connectionId, only: "gmail" });
    expect(job).toMatchObject({ kind: "run", product: "gmail" });
  });

  test("a pass queued before the flag went off copies nothing", async () => {
    enableMailSync();
    const { t, workspaceId, connectionId } = await scenario();
    const job = await t.query(internal.functions.googleSync.googleForwardSyncJob, { workspaceId, connectionId, only: "gmail" });
    expect(job).toEqual({ kind: "skip", reason: "MAIL_IN_NOTES_OFF" });
  });
});
