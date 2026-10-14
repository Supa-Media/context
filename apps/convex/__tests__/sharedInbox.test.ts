/**
 * @SHARED — everything shared with you by name, and your place in it.
 *
 *  1. **One row per note.** Sharing the same note with someone twice is one
 *     thing in their list, the newest share, never two.
 *  2. **The row names its sharer and where the note lives**, so the list can
 *     draw a face and leave "in @atlas" off a note from the sharer's own
 *     workspace.
 *  3. **The dot clears everywhere, never backwards, and leaves with the
 *     account** — What's new's rule (`devlog.test.ts`).
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   drop the dedupe in listSharedWithMeHandler                     1
 *   sharedByHandle always null                                     1
 *   title ignores front matter `title:`                            1
 *   markSharedSeen patches without the `now > seenAt` guard         0 (time only moves forward in one process)
 *   drop the sharedInboxReads sweep from personalRows              1
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

async function scenario(t: TestConvex) {
  const ana = await createUser(t, "ana@example.invalid");
  const lk = await createUser(t, "lk@example.invalid");
  const anaOwn = await createWorkspace(t, ana, "ana");
  await createWorkspace(t, lk, "lk");
  const atlas = await createWorkspace(t, ana, "atlas", { kind: "shared", displayName: "Atlas" });
  return { ana, lk, anaOwn, atlas };
}

function share(t: TestConvex, by: Id<"users">, workspaceId: Id<"workspaces">, path: string) {
  return asUser(t, by).mutation(api.functions.shares.createShare, { workspaceId, path, recipient: "@lk" });
}

describe("what @shared lists", () => {
  test("one row per note, the newest share, newest note first", async () => {
    const t = setupTest();
    const { ana, lk, anaOwn, atlas } = await scenario(t);
    // The same note reaching lk twice: once by email, once by handle.
    const byEmail = await asUser(t, ana).mutation(api.functions.shares.createShare, {
      workspaceId: anaOwn,
      path: "1-projects/beneath-the-chaos.md",
      recipient: "lk@example.invalid",
    });
    const plan = await share(t, ana, atlas, "1-projects/plan.md");
    const byHandle = await share(t, ana, anaOwn, "1-projects/beneath-the-chaos.md");
    expect(byHandle.token).not.toBe(byEmail.token);
    const order = [byEmail.token, plan.token, byHandle.token];
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("noteShares").collect()) {
        await ctx.db.patch(row._id, { createdAt: 1_000 + order.indexOf(row.token) });
      }
    });

    const rows = await asUser(t, lk).query(api.functions.shares.listSharedWithMe, {});
    expect(rows.map((row) => row.entryPath)).toEqual(["1-projects/beneath-the-chaos.md", "1-projects/plan.md"]);
    expect(rows[0]!.token).toBe(byHandle.token);
  });

  test("each row names its sharer and the kind of workspace it lives in", async () => {
    const t = setupTest();
    const { ana, lk, anaOwn, atlas } = await scenario(t);
    await share(t, ana, anaOwn, "1-projects/beneath-the-chaos.md");
    await share(t, ana, atlas, "1-projects/plan.md");

    const rows = await asUser(t, lk).query(api.functions.shares.listSharedWithMe, {});
    const byPath = new Map(rows.map((row) => [row.entryPath, row]));
    expect(byPath.get("1-projects/beneath-the-chaos.md")).toMatchObject({
      workspaceKind: "personal",
      sharedByHandle: "ana",
    });
    expect(byPath.get("1-projects/plan.md")).toMatchObject({
      workspaceKind: "shared",
      displayName: "Atlas",
      sharedByHandle: "ana",
    });
  });

  test("each row carries the note's own title and its sharer's name", async () => {
    const t = setupTest();
    const { ana, lk, anaOwn, atlas } = await scenario(t);
    await share(t, ana, anaOwn, "1-projects/beneath-the-chaos.md");
    await share(t, ana, atlas, "1-projects/plan.md");
    await share(t, ana, atlas, "1-projects/sealed.md");
    await t.run(async (ctx) => {
      await ctx.db.patch(ana, { name: "Ana Ruiz" });
      const row = { kind: "file" as const, observedAt: 1 };
      await ctx.db.insert("nodes", {
        ...row,
        workspaceId: anaOwn,
        path: "1-projects/beneath-the-chaos.md",
        name: "beneath-the-chaos.md",
        props: JSON.stringify({ properties: {}, heading: "Beneath  the\nChaos" }),
      });
      await ctx.db.insert("nodes", {
        ...row,
        workspaceId: atlas,
        path: "1-projects/plan.md",
        name: "plan.md",
        props: JSON.stringify({ properties: { title: "Launch week plan" }, heading: "Plan" }),
      });
      // Sealed: no props, so no title.
      await ctx.db.insert("nodes", { ...row, workspaceId: atlas, path: "1-projects/sealed.md", name: "sealed.md" });
    });

    const rows = await asUser(t, lk).query(api.functions.shares.listSharedWithMe, {});
    const byPath = new Map(rows.map((row) => [row.entryPath, row]));
    expect(byPath.get("1-projects/beneath-the-chaos.md")).toMatchObject({ title: "Beneath the Chaos", sharedByName: "Ana Ruiz" });
    expect(byPath.get("1-projects/plan.md")?.title).toBe("Launch week plan");
    expect(byPath.get("1-projects/sealed.md")?.title).toBeNull();
  });

  test("nobody else sees the row", async () => {
    const t = setupTest();
    const { ana, anaOwn } = await scenario(t);
    const stranger = await createUser(t, "stranger@example.invalid");
    await share(t, ana, anaOwn, "1-projects/beneath-the-chaos.md");
    expect(await asUser(t, stranger).query(api.functions.shares.listSharedWithMe, {})).toEqual([]);
  });
});

describe("the reader's place in @shared", () => {
  test("signed out reads nothing; marking records the server's time", async () => {
    const t = setupTest();
    const { lk } = await scenario(t);
    expect(await t.query(api.functions.sharedInbox.sharedSeenAt, {})).toBeNull();

    const me = asUser(t, lk);
    expect(await me.query(api.functions.sharedInbox.sharedSeenAt, {})).toBeNull();
    const before = Date.now();
    await me.mutation(api.functions.sharedInbox.markSharedSeen, {});
    const first = await me.query(api.functions.sharedInbox.sharedSeenAt, {});
    expect(first).toBeGreaterThanOrEqual(before);
    await me.mutation(api.functions.sharedInbox.markSharedSeen, {});
    expect(await me.query(api.functions.sharedInbox.sharedSeenAt, {})).toBeGreaterThanOrEqual(first!);
  });

  test("one person's place is not another's", async () => {
    const t = setupTest();
    const { ana, lk } = await scenario(t);
    await asUser(t, lk).mutation(api.functions.sharedInbox.markSharedSeen, {});
    expect(await asUser(t, ana).query(api.functions.sharedInbox.sharedSeenAt, {})).toBeNull();
  });

  test("the row goes with the account", async () => {
    const t = setupTest();
    const { lk } = await scenario(t);
    await asUser(t, lk).mutation(api.functions.sharedInbox.markSharedSeen, {});
    await asUser(t, lk).mutation(api.functions.account.deleteAccount, {});
    const rows = await t.run((ctx) => ctx.db.query("sharedInboxReads").collect());
    expect(rows).toEqual([]);
  });

  test("signing in is required to record a read", async () => {
    const t = setupTest();
    await expect(t.mutation(api.functions.sharedInbox.markSharedSeen, {})).rejects.toThrow();
  });
});
