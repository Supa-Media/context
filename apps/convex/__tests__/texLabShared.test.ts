/**
 * THE LAB'S "SHARED WITH DEVELOPERS" CHATS (`functions/lib/texLabShared.ts`, Dev2, 2026-11-16).
 *
 *  1. A person's 1:1 is listed only while they say yes (Settings → Feedback or by text), and leaves the moment they
 *     say no; the caller's own chats are never here.
 *  2. A group chat is listed only when everybody in it said yes or is on the team, and at least one said yes: one
 *     person who has not keeps the whole chat out.
 *  3. Each listed chat names where its history file lives: the person's own workspace, or the group's chat object.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record (temporary local edits, reverted, 2026-11-16)
 *
 *   `sharedChats` skipping the everyone check                    1 failed ("a group counts only when everybody ...")
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import type { Id } from "../_generated/dataModel";
import { addMember, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { sharedChats } from "../functions/lib/texLabShared";

const GROUP_A = "a".repeat(64);
const GROUP_B = "b".repeat(64);

afterEach(() => vi.unstubAllEnvs());

describe("chats shared with the developers", () => {
  test("a yes lists the 1:1, a no takes it away, and never the caller's own", async () => {
    const t = setupTest();
    const dev = await createUser(t, "dev@example.invalid");
    await createWorkspace(t, dev, "devperson", { kind: "personal" });
    const sam = await createUser(t, "sam@example.invalid");
    const samWs = await createWorkspace(t, sam, "samperson", { kind: "personal" });
    const lee = await createUser(t, "lee@example.invalid");
    await createWorkspace(t, lee, "leeperson", { kind: "personal" });
    await t.run(async (ctx) => {
      await ctx.db.insert("texReviewSharing", { userId: sam, sharedAt: 5 });
      await ctx.db.insert("texReviewSharing", { userId: dev, sharedAt: 6 });
    });
    const listed = await t.run((ctx) => sharedChats(ctx, dev));
    expect(listed.map((c) => [c.key, c.kind, c.name, c.owner])).toEqual([[`u:${sam}`, "1:1", "@samperson", { person: samWs }]]);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("texReviewSharing").collect()) if (row.userId === sam) await ctx.db.delete(row._id);
    });
    expect(await t.run((ctx) => sharedChats(ctx, dev))).toEqual([]);
  });

  test("a group counts only when everybody said yes or is on the team; one person who has not keeps it out", async () => {
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const t = setupTest();
    const staff = await createUser(t, "staff@example.invalid");
    const pinned = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
    const dev = await createUser(t, "dev@example.invalid");
    await createWorkspace(t, dev, "devperson", { kind: "personal" });
    const people: Record<string, Id<"users">> = {};
    for (const name of ["sam", "lee", "kai", "teammate"]) {
      people[name] = await createUser(t, `${name}@example.invalid`);
      await createWorkspace(t, people[name], name + "person", { kind: "personal" });
    }
    await addMember(t, pinned, people.teammate, "member");
    await t.run(async (ctx) => {
      await ctx.db.insert("texReviewSharing", { userId: people.sam, sharedAt: 5 });
      await ctx.db.insert("texReviewSharing", { userId: people.lee, sharedAt: 6 });
      // Everybody said yes or is on the team.
      await ctx.db.insert("textGroups", { groupKey: GROUP_A, lastSeenAt: 10, homeUsers: [people.sam, people.lee, people.teammate], chatName: "Trip" });
      // Kai never said yes.
      await ctx.db.insert("textGroups", { groupKey: GROUP_B, lastSeenAt: 11, homeUsers: [people.sam, people.kai] });
    });
    const groups = (await t.run((ctx) => sharedChats(ctx, dev))).filter((c) => c.kind === "group");
    expect(groups.map((c) => [c.key, c.name, c.people, c.owner, [...c.sharedBy].sort()])).toEqual([[GROUP_A, "Trip", 3, { chat: GROUP_A }, ["leeperson", "samperson"]]]);
    // A group the caller is in is under "Your account", not here.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("textGroups").withIndex("by_key", (q) => q.eq("groupKey", GROUP_A)).unique();
      await ctx.db.patch(row!._id, { homeUsers: [people.sam, dev] });
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("texReviewSharing", { userId: dev, sharedAt: 7 });
    });
    expect((await t.run((ctx) => sharedChats(ctx, dev))).some((c) => c.key === GROUP_A)).toBe(false);
  });
});
