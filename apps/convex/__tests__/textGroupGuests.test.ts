import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, seedTreeRows, setupTest } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { TEXTS_GROUP_CLIENT_ID } from "../functions/textGroups";
import { SCOPE_PRIVATE } from "../functions/lib/consentScopes";
import { setAccessRow } from "../functions/lib/nodes/setAccess";
import { nodeAt } from "../functions/lib/nodes/paths";
import { THREE_WORD_LIST, threeWords } from "../functions/lib/threeWords";

/**
 * GUEST MODE: A GROUP CHAT WITH PEOPLE WHO AREN'T ON CONTEXT
 * (`lib/textGroupGuests.ts`, `docs/decisions/texting-assistant/group-guests.md`).
 *
 * "Tex, use @slug" from an owner or editor gives the chat a group and folder
 * of its own; then anyone in the chat may tag Tex, and the grant reads only
 * what is shared with that group. Every grant here is spent on the real
 * `/gateway/session` route and its rules read the way `/gateway/binding`
 * renders them, because a guest grant that resolves wider than the group is
 * the failure that matters.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop `READS_AS_GUEST` from `chatNamesOf`: "reads only what is shared with the group" fails;
 *  - read held rows as `team` regardless of the names in `chatRules`: the same test fails;
 *  - let a member (not owner or editor) bind in `mayOpenToGuests`: "only an owner or editor" fails;
 *  - drop the guest-group comparison in `groupStillShares`: "a demoted binder" and "back to an ordinary chat" fail;
 *  - meter the tagger instead of the binder: "usage counts against the binder" fails;
 *  - drop the once-only check in `ensureChatFolderGrant` and `withChatFolders`: "carries the group's grant for real, once" fails;
 *  - drop the `viaChat` check in `syncGroupRows`: "an owner's row is never touched" fails;
 *  - drop the `shared` check in `syncFolderPeople`: "took it from the chat's people too" fails;
 *  - call `unsyncChatPeople` nowhere in `clearGuests`: "guest mode off takes back" fails.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const BO = "+15555550111";
const ADA = "+15555550100";
const FRIEND = "+15555550188";
const OTHER_FRIEND = "+15555550199";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return { userId, workspaceId };
}

async function turn(t: T, sender: string, participants: string[], extra: Record<string, unknown> = {}) {
  return await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true, ...extra });
}

const use = (slug: string) => ({ command: { kind: "use", slug } });

type Session = {
  clientId: string;
  scopes: string[];
  defaultWorkspaceId: string;
  workspaces: Array<{ workspaceId: string; role: string; grantedNames?: string[] }>;
};

async function resolves(t: T, accessToken: string): Promise<Session | null> {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Session | null }).session;
}

/** The rules a store opened for this session holds, as `/gateway/binding` asks for them. */
async function heldRules(t: T, session: Session) {
  return await t.query(internal.functions.nodesPrivacy.authority, {
    workspaceId: session.defaultWorkspaceId as Id<"workspaces">,
    audience: "guest",
    chatNames: session.workspaces[0]!.grantedNames ?? [],
  });
}

/** Bo owns @studio; Ada is a member who only reads; a friend has no account at all. */
async function trip(t: T) {
  const bo = await texter(t, "bo", BO);
  const ada = await texter(t, "ada", ADA);
  const studio = await createWorkspace(t, bo.userId, "studio", { kind: "shared" });
  await addMember(t, studio, ada.userId, "member");
  await t.run(async (ctx) => {
    await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 } as never);
  });
  await seedTreeRows(t, studio, ["team/plan.md", "secret/keys.md", "budget.md"]);
  await t.run(async (ctx) => {
    const actor = { userId: bo.userId, role: "owner" as const };
    await setAccessRow(ctx as MutationCtx, { workspaceId: studio, path: "team", base: "team", kind: "folder", actor });
    await setAccessRow(ctx as MutationCtx, { workspaceId: studio, path: "secret", base: "private", kind: "folder", actor });
  });
  return { bo, ada, studio };
}

describe("turning guest mode on", () => {
  test("an owner's use gives the chat a three-word group and a folder, and binds nothing else", async () => {
    const t = setupTest();
    const { studio } = await trip(t);
    const on = await turn(t, BO, [BO, FRIEND, LINE], use("@studio"));
    expect(on).toMatchObject({ status: "ready", slug: "studio", bound: true, minted: false, intro: true });
    expect(on.accessToken).toBeUndefined();
    const guest = on.guest as { group: string; words: string; folder: string };
    expect(guest.words.split("-")).toHaveLength(3);
    expect(guest.group).toBe(`studio-${guest.words}`);
    expect(guest.folder).toBe(`tex/chats/${guest.words}`);
    const groups = await t.run(async (ctx) => await ctx.db.query("workspaceGroups").collect());
    expect(groups.map((group) => [group.workspaceId, group.name])).toEqual([[studio, guest.group]]);
    // Claimed in the one namespace, as any group's name is.
    const claimed = await t.run(async (ctx) => await ctx.db.query("names").withIndex("by_name", (q) => q.eq("name", guest.group)).unique());
    expect(claimed?.kind).toBe("group");
    // The participant list and the chat's id are still never stored.
    const chats = await t.run(async (ctx) => await ctx.db.query("textGroups").collect());
    expect(JSON.stringify(chats)).not.toContain(FRIEND);
    expect(JSON.stringify(chats)).not.toContain(GROUP);
    // Saying it again keeps the same group.
    const again = await turn(t, BO, [BO, FRIEND, LINE], use("studio"));
    expect((again.guest as { group: string }).group).toBe(guest.group);
    expect(again.bound).toBe(false);
  });

  test("an editor may turn it on too, a personal workspace included", async () => {
    const t = setupTest();
    const { bo } = await trip(t);
    expect(await turn(t, BO, [BO, FRIEND, LINE], use("@bo"))).toMatchObject({ status: "ready", slug: "bo" });
  });

  test("only an owner or editor: a member, a stranger and a name nobody has get one answer", async () => {
    const t = setupTest();
    await trip(t);
    const member = await turn(t, ADA, [ADA, FRIEND, LINE], use("studio"));
    expect(member).toEqual({ status: "not_allowed", slug: "studio" });
    expect(await turn(t, ADA, [ADA, FRIEND, LINE], use("nowhere"))).toEqual({ status: "not_allowed", slug: "nowhere" });
    // Somebody with no account can't turn it on anywhere.
    expect((await turn(t, FRIEND, [ADA, FRIEND, LINE], use("studio"))).status).toBe("unknown_sender");
    expect(await t.run(async (ctx) => await ctx.db.query("workspaceGroups").collect())).toEqual([]);
  });
});

describe("what a guest chat reaches", () => {
  test("a guest's tag is answered, from a grant that reads only what is shared with the group", async () => {
    const t = setupTest();
    const { bo, studio } = await trip(t);
    const on = await turn(t, BO, [BO, FRIEND, LINE], use("studio"));
    const folder = (on.guest as { folder: string }).folder;

    const asked = await turn(t, FRIEND, [BO, FRIEND, LINE]);
    expect(asked).toMatchObject({ status: "ready", slug: "studio", minted: true, handle: "" });
    expect(asked.guestTagger).toMatch(/^guest-[0-9a-f]{4}$/);
    // Bo is named by handle (an email may be offered to go from his account); the friend only by label.
    expect(asked.names).toEqual([{ phone: BO, handle: "bo" }]);
    expect(asked.guests).toEqual([{ phone: FRIEND, label: asked.guestTagger }]);

    const session = (await resolves(t, asked.accessToken as string))!;
    expect(session.clientId).toBe(TEXTS_GROUP_CLIENT_ID);
    expect(session.workspaces.map((entry) => entry.workspaceId)).toEqual([studio]);
    expect(session.scopes).not.toContain(SCOPE_PRIVATE);
    // Bo owns the studio; the chat never holds more than an editor's hand there.
    expect(session.workspaces[0]!.role).toBe("editor");
    const names = session.workspaces[0]!.grantedNames ?? [];
    expect(names).toContain("#reads-as-guest");
    expect(names).toContain("#reads-as-chat");
    // The grant is Bo's (the friend has no account), marked as a guest's.
    const grant = await t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect()).find((row) => row.clientId === TEXTS_GROUP_CLIENT_ID));
    expect(grant?.userId).toBe(bo.userId);
    expect(grant?.texGroup?.guestTagger).toBe(true);

    // Only the chat's folder reads: not the team's folder, not the private one, not the root.
    const held = await heldRules(t, session);
    const vis = new Map(held.folders.map((rule) => [rule.prefix, rule.visibility]));
    expect(vis.get(folder)).toBe("team");
    expect(vis.get("team")).toBe("private");
    expect(vis.get("secret")).toBe("private");
    expect(held.notes.some((note) => note.visibility === "team")).toBe(false);
    expect(held.readOnly).toEqual({ folders: [], notes: [] });
  });

  test("a note shared with the group to view reads and is listed as read-only; one shared to edit is not", async () => {
    const t = setupTest();
    const { bo, studio } = await trip(t);
    const on = await turn(t, BO, [BO, FRIEND, LINE], use("studio"));
    const groupId = await t.run(async (ctx) => (await ctx.db.query("workspaceGroups").collect())[0]!._id);
    await t.run(async (ctx) => {
      const actor = { userId: bo.userId, role: "owner" as const };
      await setAccessRow(ctx as MutationCtx, { workspaceId: studio, path: "budget.md", base: "inherit", grantees: [{ kind: "group", groupId, role: "view" }], actor });
      await setAccessRow(ctx as MutationCtx, { workspaceId: studio, path: "team/plan.md", base: "inherit", grantees: [{ kind: "group", groupId, role: "edit" }], actor });
    });
    const session = (await resolves(t, (await turn(t, FRIEND, [BO, FRIEND, LINE])).accessToken as string))!;
    const held = await heldRules(t, session);
    const notes = new Map(held.notes.map((note) => [note.path, note.visibility]));
    expect(notes.get("budget.md")).toBe("team");
    expect(notes.get("team/plan.md")).toBe("team");
    expect(held.readOnly).toEqual({ folders: [], notes: ["budget.md"] });
    expect(on.status).toBe("ready");
  });

  test("once the folder has a row, it carries the group's grant for real, once", async () => {
    const t = setupTest();
    const { bo, studio } = await trip(t);
    const on = await turn(t, BO, [BO, FRIEND, LINE], use("studio"));
    const folder = (on.guest as { folder: string }).folder;
    await seedTreeRows(t, studio, [`${folder}/flights.md`]);
    await turn(t, FRIEND, [BO, FRIEND, LINE]);
    const grants = await t.run(async (ctx) => {
      const row = await nodeAt(ctx.db, studio, folder);
      return await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row!._id)).collect();
    });
    expect(grants.map((grant) => [grant.granteeKind, grant.role])).toEqual([["group", "edit"]]);
    // And it still reads, from the real row now.
    const session = (await resolves(t, (await turn(t, FRIEND, [BO, FRIEND, LINE])).accessToken as string))!;
    const held = await heldRules(t, session);
    expect(new Map(held.folders.map((rule) => [rule.prefix, rule.visibility])).get(folder)).toBe("team");

    // The owner takes the group off the row: the folder is hidden from the chat, and no turn puts it back.
    await t.run(async (ctx) => {
      await setAccessRow(ctx as MutationCtx, { workspaceId: studio, path: folder, base: "inherit", grantees: [], kind: "folder", actor: { userId: bo.userId, role: "owner" } });
    });
    const after = (await resolves(t, (await turn(t, FRIEND, [BO, FRIEND, LINE])).accessToken as string))!;
    const hidden = await heldRules(t, after);
    expect(new Map(hidden.folders.map((rule) => [rule.prefix, rule.visibility])).get(folder) ?? "private").toBe("private");
  });

  test("a member of the workspace who tags acts as themselves, read-only role and all", async () => {
    const t = setupTest();
    const { ada } = await trip(t);
    await turn(t, BO, [ADA, BO, FRIEND, LINE], use("studio"));
    const asked = await turn(t, ADA, [ADA, BO, FRIEND, LINE]);
    expect(asked).toMatchObject({ status: "ready", handle: "ada" });
    expect(asked.guestTagger).toBeUndefined();
    const session = (await resolves(t, asked.accessToken as string))!;
    expect(session.scopes.some((scope) => scope.includes("write"))).toBe(false);
    const grant = await t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect()).find((row) => row.clientId === TEXTS_GROUP_CLIENT_ID));
    expect(grant?.userId).toBe(ada.userId);
    expect(grant?.texGroup?.guestTagger).toBe(false);
  });

  test("usage counts against the binder, whoever tags", async () => {
    const t = setupTest();
    const { bo } = await trip(t);
    await turn(t, BO, [ADA, BO, FRIEND, LINE], use("studio"));
    for (const sender of [FRIEND, ADA]) {
      const answer = await turn(t, sender, [ADA, BO, FRIEND, LINE]);
      await t.mutation(internal.functions.builtinModel.startBuiltinTurn, { hashedAccessToken: await hashToken(answer.accessToken as string), expectedWorkspaceId: null });
    }
    const usage = await t.run(async (ctx) => await ctx.db.query("jevUsage" as never).collect());
    expect([...new Set((usage as Array<{ workspaceId: string }>).map((row) => row.workspaceId))]).toEqual([bo.workspaceId]);
  });

  test("people joining and leaving the chat change nothing about what it reads", async () => {
    const t = setupTest();
    await trip(t);
    await turn(t, BO, [BO, FRIEND, LINE], use("studio"));
    expect(await turn(t, OTHER_FRIEND, [BO, FRIEND, OTHER_FRIEND, LINE])).toMatchObject({ status: "ready", minted: true });
    expect(await turn(t, FRIEND, [FRIEND, LINE])).toMatchObject({ status: "ready", minted: true });
  });
});

describe("a guest grant lives only as long as the chat may", () => {
  test("a demoted binder ends it at once, and the next tag turns guest mode off", async () => {
    const t = setupTest();
    const { bo, studio } = await trip(t);
    await turn(t, BO, [BO, FRIEND, LINE], use("studio"));
    const asked = await turn(t, FRIEND, [BO, FRIEND, LINE]);
    expect(await resolves(t, asked.accessToken as string)).not.toBeNull();
    // An owner can't be demoted, so the binder here is an editor.
    const ed = await texter(t, "ed", OTHER_FRIEND);
    await addMember(t, studio, ed.userId, "editor");
    await turn(t, OTHER_FRIEND, [OTHER_FRIEND, FRIEND, LINE], use("studio"));
    const edAsked = await turn(t, FRIEND, [OTHER_FRIEND, FRIEND, LINE]);
    expect(await resolves(t, edAsked.accessToken as string)).not.toBeNull();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", studio).eq("userId", ed.userId))
        .unique();
      await ctx.db.patch(row!._id, { role: "member" });
    });
    expect(await resolves(t, edAsked.accessToken as string)).toBeNull();
    expect(await turn(t, FRIEND, [OTHER_FRIEND, FRIEND, LINE])).toEqual({ status: "guests_off" });
    // Bo's earlier turn went with it: the chat counted against Ed from his "use" on.
    expect(await resolves(t, asked.accessToken as string)).toBeNull();
    expect(bo.userId).toBeDefined();
  });

  test("deleting the chat's group ends it", async () => {
    const t = setupTest();
    await trip(t);
    await turn(t, BO, [BO, FRIEND, LINE], use("studio"));
    const asked = await turn(t, FRIEND, [BO, FRIEND, LINE]);
    await t.run(async (ctx) => {
      for (const group of await ctx.db.query("workspaceGroups").collect()) await ctx.db.delete(group._id);
    });
    expect(await resolves(t, asked.accessToken as string)).toBeNull();
    expect(await turn(t, FRIEND, [BO, FRIEND, LINE])).toEqual({ status: "guests_off" });
  });

  test("muting stops it like any chat", async () => {
    const t = setupTest();
    await trip(t);
    await turn(t, BO, [BO, FRIEND, LINE], use("studio"));
    const asked = await turn(t, FRIEND, [BO, FRIEND, LINE]);
    expect(await turn(t, FRIEND, [BO, FRIEND, LINE], { command: { kind: "stop" } })).toEqual({ status: "stopped" });
    expect(await resolves(t, asked.accessToken as string)).toBeNull();
    expect(await turn(t, FRIEND, [BO, FRIEND, LINE])).toEqual({ status: "muted" });
  });

  test("back to an ordinary chat: use names a workspace everyone shares, and the guest grant stops", async () => {
    const t = setupTest();
    await trip(t);
    await turn(t, BO, [ADA, BO, LINE], use("bo"));
    const asked = await turn(t, ADA, [ADA, BO, LINE]);
    expect(asked.guest).toBeDefined();
    const back = await turn(t, ADA, [ADA, BO, LINE], use("studio"));
    expect(back).toMatchObject({ status: "ready", slug: "studio", bound: true });
    expect(back.guest).toBeUndefined();
    expect(await resolves(t, asked.accessToken as string)).toBeNull();
    const ordinary = await turn(t, ADA, [ADA, BO, LINE]);
    expect(ordinary.guest).toBeUndefined();
    expect((await resolves(t, ordinary.accessToken as string))?.workspaces[0]?.grantedNames).toBeUndefined();
  });
});

describe("people joining and leaving are kept in the group and on the folder", () => {
  const CAROL = "+15555550122";

  async function groupRows(t: T) {
    return await t.run(async (ctx) => await ctx.db.query("workspaceGroupMembers").collect());
  }

  async function folderGrants(t: T, studio: Id<"workspaces">, folder: string) {
    return await t.run(async (ctx) => {
      const row = await nodeAt(ctx.db, studio, folder);
      const grants = await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row!._id)).collect();
      return grants.map((grant) => [grant.granteeKind, grant.granteeUserId ?? grant.granteeGroupId, grant.role]);
    });
  }

  /** Guest mode on in @studio with its folder's row in place, so the folder has had the group's grant. */
  async function tripWithFolder(t: T, participants: string[]) {
    const { bo, ada, studio } = await trip(t);
    const on = await turn(t, BO, participants, use("studio"));
    const guest = on.guest as { folder: string; group: string };
    await seedTreeRows(t, studio, [`${guest.folder}/flights.md`]);
    const groupId = await t.run(async (ctx) => (await ctx.db.query("workspaceGroups").withIndex("by_name", (q) => q.eq("name", guest.group)).unique())!._id);
    return { bo, ada, studio, folder: guest.folder, groupId };
  }

  test("a member in the chat is in its group while there, and an owner's row is never touched", async () => {
    const t = setupTest();
    const { bo, ada, groupId } = await tripWithFolder(t, [ADA, BO, FRIEND, LINE]);
    await turn(t, FRIEND, [ADA, BO, FRIEND, LINE]);
    const rows = await groupRows(t);
    expect(rows.map((row) => row.userId).sort()).toEqual([ada.userId, bo.userId].sort());
    expect(rows.every((row) => row.groupId === groupId && row.viaChat !== undefined)).toBe(true);
    // Ada leaves the chat: her row goes, Bo's stays.
    await turn(t, FRIEND, [BO, FRIEND, LINE]);
    expect((await groupRows(t)).map((row) => row.userId)).toEqual([bo.userId]);

    // A row the owner adds is the owner's: leaving the chat doesn't take it.
    const studioId = rows[0]!.workspaceId;
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceGroupMembers", { groupId, workspaceId: studioId, userId: ada.userId, addedBy: bo.userId, addedAt: 1 });
    });
    await turn(t, FRIEND, [ADA, BO, FRIEND, LINE]);
    await turn(t, FRIEND, [BO, FRIEND, LINE]);
    const kept = (await groupRows(t)).find((row) => row.userId === ada.userId);
    expect(kept).toBeDefined();
    expect(kept?.viaChat).toBeUndefined();
  });

  test("someone with an account who isn't a member is named on the folder to edit, and only while in the chat", async () => {
    const t = setupTest();
    const carol = await texter(t, "carol", CAROL);
    const { studio, folder, groupId } = await tripWithFolder(t, [BO, CAROL, LINE]);
    await turn(t, CAROL, [BO, CAROL, LINE]);
    expect(await folderGrants(t, studio, folder)).toEqual(
      expect.arrayContaining([["group", groupId, "edit"], ["user", carol.userId, "edit"]]),
    );
    // A group row would reach nothing for her, so none is written.
    expect((await groupRows(t)).some((row) => row.userId === carol.userId)).toBe(false);
    // Not a member, so nothing else of the workspace.
    expect(await t.run(async (ctx) => await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", studio).eq("userId", carol.userId)).unique())).toBeNull();
    // No phone number is kept for her.
    expect(JSON.stringify(await t.run(async (ctx) => await ctx.db.query("textGroups").collect()))).not.toContain(CAROL);

    await turn(t, BO, [BO, LINE, FRIEND]);
    expect(await folderGrants(t, studio, folder)).toEqual([["group", groupId, "edit"]]);
  });

  test("a guest with no account is named on the first tag after they link", async () => {
    const t = setupTest();
    const { studio, folder, groupId } = await tripWithFolder(t, [BO, FRIEND, LINE]);
    await turn(t, FRIEND, [BO, FRIEND, LINE]);
    expect(await folderGrants(t, studio, folder)).toEqual([["group", groupId, "edit"]]);
    const fay = await texter(t, "fay", FRIEND);
    await turn(t, FRIEND, [BO, FRIEND, LINE]);
    expect(await folderGrants(t, studio, folder)).toContainEqual(["user", fay.userId, "edit"]);
  });

  test("an owner who took the folder from the chat's group took it from the chat's people too", async () => {
    const t = setupTest();
    const carol = await texter(t, "carol", CAROL);
    const { bo, studio, folder } = await tripWithFolder(t, [BO, CAROL, LINE]);
    await turn(t, CAROL, [BO, CAROL, LINE]);
    await t.run(async (ctx) => {
      await setAccessRow(ctx as MutationCtx, { workspaceId: studio, path: folder, base: "inherit", grantees: [{ kind: "user", userId: carol.userId, role: "edit" }], kind: "folder", actor: { userId: bo.userId, role: "owner" } });
    });
    await turn(t, CAROL, [BO, CAROL, LINE]);
    expect(await folderGrants(t, studio, folder)).toEqual([]);
    expect(carol.userId).toBeDefined();
  });

  test("a grantee the owner named stays when the chat's people change", async () => {
    const t = setupTest();
    const carol = await texter(t, "carol", CAROL);
    const { bo, ada, studio, folder, groupId } = await tripWithFolder(t, [BO, CAROL, LINE]);
    await turn(t, CAROL, [BO, CAROL, LINE]);
    await t.run(async (ctx) => {
      await setAccessRow(ctx as MutationCtx, {
        workspaceId: studio,
        path: folder,
        base: "inherit",
        grantees: [{ kind: "group", groupId, role: "edit" }, { kind: "user", userId: carol.userId, role: "edit" }, { kind: "user", userId: ada.userId, role: "view" }],
        kind: "folder",
        actor: { userId: bo.userId, role: "owner" },
      });
    });
    await turn(t, BO, [BO, LINE]);
    expect(await folderGrants(t, studio, folder)).toEqual(expect.arrayContaining([["group", groupId, "edit"], ["user", ada.userId, "view"]]));
    expect((await folderGrants(t, studio, folder)).some((grant) => grant[1] === carol.userId)).toBe(false);
  });

  test("guest mode off takes back what the chat added", async () => {
    const t = setupTest();
    const carol = await texter(t, "carol", CAROL);
    const { ada, studio, folder, groupId } = await tripWithFolder(t, [ADA, BO, CAROL, LINE]);
    await turn(t, CAROL, [ADA, BO, CAROL, LINE]);
    expect((await groupRows(t)).length).toBe(2);
    expect(await folderGrants(t, studio, folder)).toContainEqual(["user", carol.userId, "edit"]);
    const back = await turn(t, ADA, [ADA, BO, LINE], use("studio"));
    expect(back.guest).toBeUndefined();
    expect(await groupRows(t)).toEqual([]);
    expect(await folderGrants(t, studio, folder)).toEqual([["group", groupId, "edit"]]);
    expect(ada.userId).toBeDefined();
  });
});

describe("three words", () => {
  test("three different words from the list, joined by hyphens", () => {
    let i = 0;
    const steps = [0, 0, 0.5, 0.9999];
    expect(threeWords(() => steps[i++]!)).toBe(`${THREE_WORD_LIST[0]}-${THREE_WORD_LIST[Math.floor(0.5 * THREE_WORD_LIST.length)]}-${THREE_WORD_LIST.at(-1)}`);
    for (const word of THREE_WORD_LIST) expect(word).toMatch(/^[a-z]{2,8}$/);
    expect(new Set(THREE_WORD_LIST).size).toBe(THREE_WORD_LIST.length);
  });
});
