/**
 * IN-APP MESSAGES — answered once per person, on the account.
 *
 * Every message the app shows unasked is named in `IN_APP_MESSAGES`
 * (`packages/shared`), and the ones without a home of their own are answered
 * here. Dev2, 2026-09-29: the early-beta notice came back on a second device,
 * and every other onboarding message and tip must hold the same way.
 *
 *  1. **Only the caller's own answers.** Neither function names a user; a
 *     signed-out caller reads nothing and writes nothing.
 *  2. **Only messages on the list, in their own scope.** An unknown name, a
 *     workspace on an account-wide message, no workspace on a workspace one,
 *     or a variant that is not a short label is refused, so the table cannot
 *     be used to store anything else.
 *  3. **Only workspaces the caller is in,** answered exactly like one that
 *     does not exist.
 *  4. **Once is once,** except for a message that may be asked again, whose
 *     time moves forward.
 *  5. **The early-beta notice's older table still counts,** so nobody who
 *     answered it before this is asked again.
 *  6. **Leaves with the account, and with the workspace.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   read returns every user's rows                                   2
 *   mark accepts any message name                                    1
 *   mark skips the membership check                                  1
 *   mark inserts a new row every time                                2
 *   ask-again message keeps its first time                           1
 *   betaNoticeReads not merged into the read                         1
 *   no sweep on account deletion                                     1
 *   no sweep on workspace deletion                                   1
 *   variants accepted on any message                                 1
 *   no ceiling on rows per person                                    1
 *   betaNoticeSeen not reading messageReads                          1
 */

import { describe, expect, test } from "vitest";

import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

const reads = api.functions.messages.myMessageReads;
const mark = api.functions.messages.markMessageSeen;

const allRows = (t: TestConvex) => t.run((ctx) => ctx.db.query("messageReads").collect());

describe("in-app message answers", () => {
  test("an account-wide answer holds on every device of that person only", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const jon = await createUser(t, "jon@example.invalid");
    expect(await asUser(t, seyi).query(reads, {})).toEqual([]);
    await asUser(t, seyi).mutation(mark, { message: "beta-notice" });
    const mine = await asUser(t, seyi).query(reads, {});
    expect(mine).toEqual([
      { message: "beta-notice", workspaceId: null, variant: null, seenAt: expect.any(Number) },
    ]);
    expect(await asUser(t, jon).query(reads, {})).toEqual([]);
  });

  test("signed out: nothing to read and nothing to write", async () => {
    const t = setupTest();
    expect(await t.query(reads, {})).toBeNull();
    await expect(t.mutation(mark, { message: "beta-notice" })).rejects.toThrow();
    expect(await allRows(t)).toEqual([]);
  });

  test("only messages on the list, in their own scope, with a label for a variant", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const ws = await createWorkspace(t, seyi, "seyi");
    const as = asUser(t, seyi);
    await expect(as.mutation(mark, { message: "anything-at-all" })).rejects.toThrow();
    // Answered on their own rows, never through this table.
    await expect(as.mutation(mark, { message: "setup-checklist", workspaceId: ws })).rejects.toThrow();
    await expect(as.mutation(mark, { message: "beta-notice", workspaceId: ws })).rejects.toThrow();
    await expect(as.mutation(mark, { message: "track-by-status" })).rejects.toThrow();
    await expect(
      as.mutation(mark, { message: "context-intro", workspaceId: ws, variant: "1-projects/secret plans" }),
    ).rejects.toThrow();
    await expect(
      as.mutation(mark, { message: "context-intro", workspaceId: ws, variant: "x".repeat(41) }),
    ).rejects.toThrow();
    expect(await allRows(t)).toEqual([]);
    await as.mutation(mark, { message: "context-intro", workspaceId: ws, variant: "member+read-only" });
    expect(await allRows(t)).toHaveLength(1);
  });

  test("a variant only where the message takes one, and never an endless list", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const ws = await createWorkspace(t, seyi, "seyi");
    const as = asUser(t, seyi);
    await expect(
      as.mutation(mark, { message: "track-by-status", workspaceId: ws, variant: "member" }),
    ).rejects.toThrow();
    await expect(as.mutation(mark, { message: "beta-notice", variant: "member" })).rejects.toThrow();
    await t.run(async (ctx) => {
      for (let index = 0; index < 1000; index += 1) {
        await ctx.db.insert("messageReads", {
          userId: seyi,
          message: "context-intro",
          workspaceId: ws,
          variant: `v-${String.fromCharCode(97 + (index % 26))}${index}`.replace(/[0-9]/g, "x"),
          seenAt: 1,
        });
      }
    });
    await as.mutation(mark, { message: "context-intro", workspaceId: ws, variant: "brand-new" });
    expect(await allRows(t)).toHaveLength(1000);
  });

  test("an older client asking about the early-beta notice hears a newer client's answer", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(mark, { message: "beta-notice" });
    expect(await asUser(t, seyi).query(api.functions.telemetry.betaNoticeSeen, {})).toBe(true);
  });

  test("a workspace answer needs the caller to be in that workspace", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const jon = await createUser(t, "jon@example.invalid");
    const ws = await createWorkspace(t, seyi, "seyi");
    await expect(
      asUser(t, jon).mutation(mark, { message: "track-by-status", workspaceId: ws }),
    ).rejects.toThrow();
    expect(await allRows(t)).toEqual([]);
    await addMember(t, ws, jon, "member");
    await asUser(t, jon).mutation(mark, { message: "track-by-status", workspaceId: ws });
    expect(await asUser(t, jon).query(reads, {})).toEqual([
      { message: "track-by-status", workspaceId: ws, variant: null, seenAt: expect.any(Number) },
    ]);
    // Seyi's answers are Seyi's: Jon's does not answer it for the owner.
    expect(await asUser(t, seyi).query(reads, {})).toEqual([]);
  });

  test("answering twice keeps one row and the first time", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const ws = await createWorkspace(t, seyi, "seyi");
    const as = asUser(t, seyi);
    await as.mutation(mark, { message: "storage-layout-offer", workspaceId: ws });
    const [first] = await allRows(t);
    await as.mutation(mark, { message: "storage-layout-offer", workspaceId: ws });
    const rows = await allRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seenAt).toBe(first!.seenAt);
  });

  test("a message that may be asked again moves its time forward", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const as = asUser(t, seyi);
    await as.mutation(mark, { message: "resume-storage" });
    const [first] = await allRows(t);
    await t.run((ctx) => ctx.db.patch(first!._id, { seenAt: first!.seenAt - 1000 }));
    await as.mutation(mark, { message: "resume-storage" });
    const rows = await allRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seenAt).toBeGreaterThan(first!.seenAt - 1000);
  });

  test("an early-beta answer kept before this still counts", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    await asUser(t, seyi).mutation(api.functions.telemetry.markBetaNoticeSeen, {});
    expect(await asUser(t, seyi).query(reads, {})).toEqual([
      { message: "beta-notice", workspaceId: null, variant: null, seenAt: expect.any(Number) },
    ]);
  });

  test("answers go with the account", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const ws = await createWorkspace(t, seyi, "seyi");
    await asUser(t, seyi).mutation(mark, { message: "beta-notice" });
    await asUser(t, seyi).mutation(mark, { message: "track-by-status", workspaceId: ws });
    await asUser(t, seyi).mutation(api.functions.account.deleteAccount, {});
    expect(await allRows(t)).toEqual([]);
  });

  test("a workspace's answers go with the workspace", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const jon = await createUser(t, "jon@example.invalid");
    const ws = await createWorkspace(t, seyi, "ourteam", { kind: "shared" });
    await addMember(t, ws, jon, "member");
    await asUser(t, jon).mutation(mark, { message: "context-intro", workspaceId: ws, variant: "member" });
    await asUser(t, jon).mutation(mark, { message: "beta-notice" });
    await asUser(t, seyi).mutation(api.functions.account.deleteWorkspace, {
      workspaceId: ws as Id<"workspaces">,
      confirmSlug: "ourteam",
    });
    const rows = await allRows(t);
    expect(rows.map((row) => row.message)).toEqual(["beta-notice"]);
  });
});
