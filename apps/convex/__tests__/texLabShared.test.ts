/**
 * THE LAB'S "SHARED WITH DEVELOPERS" CHATS (`functions/lib/texLabShared.ts`, Dev2, 2026-11-16).
 *
 *  1. A person's 1:1 is listed only while they say yes (Settings → Feedback or by text), and leaves the moment they
 *     say no; the caller's own chats are never here.
 *  2. A group chat is listed only when everybody in it said yes or is on the team, and at least one said yes: one
 *     person who has not keeps the whole chat out.
 *  3. Each listed chat names where its history file lives: the person's own workspace, or the group's chat object.
 *  4. A test text in a shared 1:1 runs on the sharer's own Tex session, only while it is listed.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record (temporary local edits, reverted, 2026-11-16)
 *
 *   `sharedChats` skipping the everyone check                    1 failed ("a group counts only when everybody ...")
 *   `sharedSessionFor` handing out a session for an unlisted 1:1  1 failed ("a shared 1:1's test session ...")
 *   (2026-11-17) the shared-groups filter dropped                 1 failed ("a shared 1:1 reads only the groups ...")
 *   (2026-11-17) `devShareOf` skipping the team check              1 failed ("a group turn is told its sharing ...")
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import type { Id } from "../_generated/dataModel";
import { addMember, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { devShareOf, sharedChats } from "../functions/lib/texLabShared";
import { intakeChats, sharedSessionFor } from "../functions/texLabSandbox";

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

  test("a shared 1:1's test session is the sharer's own, and only while they say yes", async () => {
    const t = setupTest();
    const dev = await createUser(t, "dev@example.invalid");
    await createWorkspace(t, dev, "devperson", { kind: "personal" });
    const sam = await createUser(t, "sam@example.invalid");
    const samWs = await createWorkspace(t, sam, "samperson", { kind: "personal" });
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthGrants", { workspaceId: samWs, userId: sam, clientId: "context_texts", scopes: ["context:read"], hashedAccessToken: "hashed_example_sam", hashedRefreshToken: "refresh_hashed_example_sam", accessTokenExpiresAt: Date.now() + 3_600_000, status: "active", createdAt: Date.now() });
    });
    expect((await t.run((ctx) => sharedSessionFor(ctx, dev, `u:${sam}`))).status).toBe("not_found");
    const yes = await t.run((ctx) => ctx.db.insert("texReviewSharing", { userId: sam, sharedAt: 5 }));
    const answer = await t.run((ctx) => sharedSessionFor(ctx, dev, `u:${sam}`));
    expect(answer.status).toBe("ok");
    if (answer.status === "ok") {
      expect(answer.session.actorUserId).toBe(sam);
      expect(answer.session.defaultWorkspaceId).toBe(samWs);
      expect(answer.people).toEqual([{ handle: "samperson", name: "@samperson" }]);
    }
    await t.run((ctx) => ctx.db.delete(yes));
    expect((await t.run((ctx) => sharedSessionFor(ctx, dev, `u:${sam}`))).status).toBe("not_found");
  });

  test("a shared 1:1 reads only the groups shared with the developers too, never the sharer's others", async () => {
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const t = setupTest();
    const dev = await createUser(t, "dev@example.invalid");
    await createWorkspace(t, dev, "devperson", { kind: "personal" });
    const sam = await createUser(t, "sam@example.invalid");
    const samWs = await createWorkspace(t, sam, "samperson", { kind: "personal" });
    const kai = await createUser(t, "kai@example.invalid");
    await createWorkspace(t, kai, "kaiperson", { kind: "personal" });
    const lee = await createUser(t, "lee@example.invalid");
    await createWorkspace(t, lee, "leeperson", { kind: "personal" });
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthGrants", { workspaceId: samWs, userId: sam, clientId: "context_texts", scopes: ["context:read"], hashedAccessToken: "hashed_example_sam", hashedRefreshToken: "refresh_hashed_example_sam", accessTokenExpiresAt: Date.now() + 3_600_000, status: "active", createdAt: Date.now() });
      await ctx.db.insert("texReviewSharing", { userId: sam, sharedAt: 5 });
      await ctx.db.insert("texReviewSharing", { userId: lee, sharedAt: 6 });
      // Everybody in it said yes: shared. Kai never did: not shared, so a test turn never lists it.
      await ctx.db.insert("textGroups", { groupKey: GROUP_A, lastSeenAt: 10, homeUsers: [sam, lee], chatName: "Trip" });
      await ctx.db.insert("textGroups", { groupKey: GROUP_B, lastSeenAt: 11, homeUsers: [sam, kai], chatName: "Family" });
    });
    const answer = await t.run((ctx) => sharedSessionFor(ctx, dev, `u:${sam}`));
    expect(answer.status).toBe("ok");
    if (answer.status === "ok") expect((answer.chat as { groups: { key: string }[] }).groups.map((g) => g.key)).toEqual([GROUP_A]);
  });
});

describe("a group turn is told its own sharing (Dev2, 2026-11-17: Tex said \"Dev2 can't see this chat\" while it was shared)", () => {
  test("a group turn is told its sharing by the list's own rule: who said yes and who keeps it out", async () => {
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const t = setupTest();
    const staff = await createUser(t, "staff@example.invalid");
    const pinned = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
    const people: Record<string, Id<"users">> = {};
    for (const name of ["sam", "kai", "teammate"]) {
      people[name] = await createUser(t, `${name}@example.invalid`);
      await createWorkspace(t, people[name], name + "person", { kind: "personal" });
    }
    await addMember(t, pinned, people.teammate, "member");
    await t.run(async (ctx) => {
      await ctx.db.insert("texReviewSharing", { userId: people.sam, sharedAt: 5 });
    });
    const told = (homeUsers: Id<"users">[]) => t.run((ctx) => devShareOf(ctx, { homeUsers }));
    expect(await told([people.sam, people.teammate])).toEqual({ devShare: { shared: true, by: ["samperson"], waiting: [] } });
    expect(await told([people.sam, people.kai])).toEqual({ devShare: { shared: false, by: ["samperson"], waiting: ["kaiperson"] } });
    expect(await told([people.teammate])).toEqual({ devShare: { shared: false, by: [], waiting: [] } });
    expect(await told([])).toEqual({ devShare: { shared: false, by: [], waiting: [] } });
  });
});

describe("every chat Tex can name, for the gateway's intake sweep (2026-11-21)", () => {
  test("each linked phone once and each group's key; nothing else", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const bo = await createUser(t, "bo@example.invalid");
    await t.run(async (ctx) => {
      await ctx.db.insert("phoneLinks", { userId: ada, phone: "+15555550100", linkedAt: 1 });
      await ctx.db.insert("phoneLinks", { userId: bo, phone: "+15555550101", linkedAt: 2 });
      // The same number linked twice (a sign-in row beside a texted one) is one chat.
      await ctx.db.insert("phoneLinks", { userId: ada, phone: "+15555550100", linkedAt: 3 });
      await ctx.db.insert("textGroups", { groupKey: GROUP_A, lastSeenAt: 1 } as never);
      await ctx.db.insert("textGroups", { groupKey: GROUP_B, lastSeenAt: 2 } as never);
    });
    const chats = await t.run((ctx) => intakeChats(ctx));
    expect(chats.phones.sort()).toEqual(["+15555550100", "+15555550101"]);
    expect(chats.groups.sort()).toEqual([GROUP_A, GROUP_B]);
  });
});
