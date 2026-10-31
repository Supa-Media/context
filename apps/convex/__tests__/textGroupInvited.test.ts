import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { parseInvitee } from "../functions/lib/invitees";

/**
 * INVITED FAMILY IN A GROUP CHAT (`lib/textGroupInvited.ts`,
 * `docs/decisions/texting-assistant/invited-family.md`).
 *
 * "Tex, add everyone here to @slug" from an owner invites each person in the
 * chat by number, and a pending phone invitation then counts as membership in
 * that chat: Tex works on the whole workspace at team tier. Every grant is
 * spent on the real `/gateway/session` route.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop the owner check in `inviteEveryone`: "only an owner" fails;
 *  - drop the `kind !== "shared"` check in `invitedChat`: "never a personal workspace" fails;
 *  - drop `invitationsStillCount` from `groupStillShares`: "revoking one stops the chat's grant" fails;
 *  - drop the `taggerRole` clamp in `mintGroupGrant` and `contextsForGrant`: "acts through the binder" fails;
 *  - skip `acceptPhoneInvitations` in `linkPhone`: "linking the number joins" fails;
 *  - drop `pendingInvitationOf` in `invitedChat`: "an invitation by name from Members counts" fails;
 *  - answer a guest chat as guests whatever `invitedChat` says (`applyGroupTurn`): both "leaves guest mode" tests fail;
 *  - drop its `hasBlocked` check: "an invitation addressed to somebody else, or from somebody they blocked" fails.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "6B1E2C3D-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const SEYI = "+15555550120";
const DAD = "+15555550131";
const MOM = "+15555550132";
const STRANGER = "+15555550199";

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

const addEveryone = (slug: string, role?: string) => ({ command: { kind: "invite", slug, ...(role ? { role } : {}) } });

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

const FAMILY = [SEYI, DAD, MOM, LINE];

/** Seyi owns @crystal-care; Dad and Mom have no account at all. */
async function family(t: T) {
  const seyi = await texter(t, "seyi", SEYI);
  const care = await createWorkspace(t, seyi.userId, "crystal-care", { kind: "shared" });
  return { seyi, care };
}

async function invitations(t: T, workspaceId: Id<"workspaces">) {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("workspaceInvitations")
        .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "pending"))
        .collect(),
  );
}

describe("a phone number is an invitee", () => {
  test("numbers are read as E.164; a US number may leave out +1", () => {
    for (const raw of ["+1 (555) 555-0131", "555-555-0131", "5555550131", "15555550131", "+15555550131"]) {
      expect(parseInvitee(raw)).toEqual({ ok: true, invitee: { kind: "phone", value: "+15555550131" } });
    }
    expect(parseInvitee("+44 20 7946 0958")).toEqual({ ok: true, invitee: { kind: "phone", value: "+442079460958" } });
  });

  test("a handle stays a handle, and a malformed number is refused about the string", () => {
    expect(parseInvitee("@lk")).toEqual({ ok: true, invitee: { kind: "name", value: "lk" } });
    expect(parseInvitee("agent007")).toEqual({ ok: true, invitee: { kind: "name", value: "agent007" } });
    expect(parseInvitee("555-0131")).toEqual({ ok: false, reason: "invalid_phone" });
    expect(parseInvitee("+0 555 555 0131")).toEqual({ ok: false, reason: "invalid_phone" });
  });

  test("an owner may invite by number in the app; nothing is mailed and it lasts a year", async () => {
    const t = setupTest();
    const { seyi, care } = await family(t);
    await asUser(t, seyi.userId).mutation(api.functions.invitations.inviteMember, { workspaceId: care, invitee: "(555) 555-0131", role: "editor" });
    const rows = await invitations(t, care);
    expect(rows.map((row) => [row.inviteeKind, row.invitee])).toEqual([["phone", DAD]]);
    expect(rows[0]!.expiresAt - rows[0]!.createdAt).toBeGreaterThan(300 * 24 * 60 * 60 * 1000);
    expect(rows[0]!.emailSentAt).toBeUndefined();
  });

  test("a note is never shared with a phone number", async () => {
    const t = setupTest();
    const { seyi, care } = await family(t);
    await expect(
      asUser(t, seyi.userId).mutation(api.functions.shares.createShare, { workspaceId: care, path: "plan.md", recipient: DAD } as never),
    ).rejects.toThrow(/@name or an email address/);
  });
});

describe("Tex, add everyone here", () => {
  test("an owner invites every number in the chat that isn't a member, and the chat then uses the workspace", async () => {
    const t = setupTest();
    const { care } = await family(t);
    const added = await turn(t, SEYI, FAMILY, addEveryone("@crystal-care"));
    expect(added).toEqual({ status: "invited", slug: "crystal-care", count: 2, role: "editor" });
    const rows = await invitations(t, care);
    expect(rows.map((row) => row.invitee).sort()).toEqual([DAD, MOM]);
    expect(rows.every((row) => row.role === "editor")).toBe(true);
    // No guest group: the chat reads the whole workspace.
    expect(await t.run(async (ctx) => await ctx.db.query("workspaceGroups").collect())).toEqual([]);

    const tagged = await turn(t, SEYI, FAMILY);
    expect(tagged).toMatchObject({ status: "ready", slug: "crystal-care", minted: true, handle: "seyi" });
    expect((tagged.guests as Array<{ label: string }>).map((guest) => guest.label)).toHaveLength(2);
    expect(JSON.stringify(tagged.names)).not.toContain(DAD);
    const session = await resolves(t, tagged.accessToken as string);
    expect(session?.defaultWorkspaceId).toBe(care);
    // Team tier, named for nobody: the same reach as a chat of members.
    expect(session?.workspaces.find((row) => row.workspaceId === care)).toMatchObject({ role: "owner" });
    expect(session?.workspaces.find((row) => row.workspaceId === care)?.grantedNames).toBeUndefined();
    expect(session?.scopes).not.toContain("context:private");
  });

  test("as members, when the owner says so", async () => {
    const t = setupTest();
    const { care } = await family(t);
    expect(await turn(t, SEYI, FAMILY, addEveryone("crystal-care", "member"))).toMatchObject({ status: "invited", role: "member" });
    expect((await invitations(t, care)).every((row) => row.role === "member")).toBe(true);
  });

  test("only an owner: an editor, a stranger's name and a personal workspace get one answer", async () => {
    const t = setupTest();
    const { care } = await family(t);
    const editor = await texter(t, "bro", "+15555550133");
    await addMember(t, care, editor.userId, "editor");
    const people = [SEYI, "+15555550133", DAD, LINE];
    expect(await turn(t, "+15555550133", people, addEveryone("crystal-care"))).toEqual({ status: "not_allowed", slug: "crystal-care" });
    expect(await turn(t, SEYI, people, addEveryone("nobody-here"))).toEqual({ status: "not_allowed", slug: "nobody-here" });
    expect(await turn(t, SEYI, people, addEveryone("seyi"))).toEqual({ status: "not_allowed", slug: "seyi" });
    expect(await invitations(t, care)).toEqual([]);
  });
});

describe("an invited chat", () => {
  test("an invited person's tag acts through the binder, never past editor, and as nobody's own account", async () => {
    const t = setupTest();
    const { seyi, care } = await family(t);
    await turn(t, SEYI, FAMILY, addEveryone("crystal-care"));
    const dad = await turn(t, DAD, FAMILY);
    expect(dad).toMatchObject({ status: "ready", slug: "crystal-care", minted: true, handle: "" });
    expect(dad.guestTagger).toMatch(/^guest-[0-9a-f]{4}$/);
    const session = await resolves(t, dad.accessToken as string);
    expect(session?.workspaces.find((row) => row.workspaceId === care)?.role).toBe("editor");
    const grant = await t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect()).find((row) => row.texGroup !== undefined));
    expect(grant?.userId).toBe(seyi.userId);
    expect(grant?.texGroup?.invitedTaggerRole).toBe("editor");
  });

  test("a member-role invitation tags read-only", async () => {
    const t = setupTest();
    await family(t);
    await turn(t, SEYI, FAMILY, addEveryone("crystal-care", "member"));
    const mom = await turn(t, MOM, FAMILY);
    const session = await resolves(t, mom.accessToken as string);
    expect(session?.scopes).not.toContain("context:write");
    expect(session?.workspaces[0]?.role).toBe("member");
  });

  test("revoking one stops the chat's grant at once, and the chat no longer counts as invited", async () => {
    const t = setupTest();
    const { seyi, care } = await family(t);
    await turn(t, SEYI, FAMILY, addEveryone("crystal-care"));
    const tagged = await turn(t, SEYI, FAMILY);
    expect(await resolves(t, tagged.accessToken as string)).not.toBeNull();
    const dadInvite = (await invitations(t, care)).find((row) => row.invitee === DAD)!;
    await asUser(t, seyi.userId).mutation(api.functions.invitations.revokeInvitation, { invitationId: dadInvite._id });
    expect(await resolves(t, tagged.accessToken as string)).toBeNull();
    // The owner's next tag is no longer the whole workspace: with Dad not in it, the chat is answered from its home
    // (E1, 2026-10-31), and this deployment has no pin to hold one, so it is not answered as an invited chat at all.
    const next = await turn(t, SEYI, FAMILY);
    expect(next).not.toMatchObject({ status: "ready", slug: "crystal-care" });
    expect(next.guest).toBeUndefined();
  });

  test("a stranger in the chat, and it counts as nothing", async () => {
    const t = setupTest();
    await family(t);
    await turn(t, SEYI, FAMILY, addEveryone("crystal-care"));
    expect((await turn(t, DAD, [...FAMILY, STRANGER])).status).toBe("unknown_sender");
    // Not as invited, and not as guests of the workspace either (E1): the chat has no home without a pin here.
    expect(await turn(t, SEYI, [...FAMILY, STRANGER])).not.toMatchObject({ guest: expect.anything() });
  });

  test("an invited person can't say use, and nobody stands behind their tag once the binder leaves", async () => {
    const t = setupTest();
    await family(t);
    await turn(t, SEYI, FAMILY, addEveryone("crystal-care"));
    expect((await turn(t, DAD, FAMILY, { command: { kind: "use", slug: "crystal-care" } })).status).not.toBe("ready");
    expect((await turn(t, DAD, [DAD, MOM, LINE])).status).toBe("unknown_sender");
  });

  test("linking the number joins the workspace, and the chat goes on as one of members", async () => {
    const t = setupTest();
    const { care } = await family(t);
    await turn(t, SEYI, FAMILY, addEveryone("crystal-care"));
    const dad = await texter(t, "dad", DAD);
    const joined = await t.run(
      async (ctx) =>
        await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace_user", (q) => q.eq("workspaceId", care).eq("userId", dad.userId))
          .unique(),
    );
    expect(joined?.role).toBe("editor");
    expect((await invitations(t, care)).map((row) => row.invitee)).toEqual([MOM]);
    const tagged = await turn(t, DAD, FAMILY);
    expect(tagged).toMatchObject({ status: "ready", handle: "dad" });
    expect(await resolves(t, tagged.accessToken as string)).not.toBeNull();
  });

  test("an invitation by name from Members counts: a linked person in the chat joins, and a guest chat leaves guest mode", async () => {
    const t = setupTest();
    const { seyi, care } = await family(t);
    const dad = await texter(t, "dad", DAD);
    const mom = await texter(t, "mom", MOM);
    // Before anyone was invited, naming the workspace is no longer a guest mode (E1): it is not shared with everyone here.
    expect(await turn(t, SEYI, FAMILY, { command: { kind: "use", slug: "crystal-care" } })).toMatchObject({ status: "not_shared" });
    for (const invitee of ["@dad", "@mom"]) {
      await asUser(t, seyi.userId).mutation(api.functions.invitations.inviteMember, { workspaceId: care, invitee, role: "editor" });
    }
    // Named again once they are invited: the chat binds to the workspace, its people counting as invited there.
    await turn(t, SEYI, FAMILY, { command: { kind: "use", slug: "crystal-care" } });
    const tagged = await turn(t, SEYI, FAMILY);
    expect(tagged).toMatchObject({ status: "ready", slug: "crystal-care", handle: "seyi" });
    expect(tagged.guest).toBeUndefined();
    const roles = await t.run(async (ctx) => {
      const rows = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", care)).collect();
      return Object.fromEntries(rows.map((row) => [row.userId, row.role]));
    });
    expect([roles[dad.userId], roles[mom.userId]]).toEqual(["editor", "editor"]);
    expect(await invitations(t, care)).toEqual([]);
    expect((await resolves(t, tagged.accessToken as string))?.workspaces[0]?.grantedNames ?? []).not.toContain("#reads-as-guest");
  });

  test("a chat whose people are all invited by number from Members is answered as invited", async () => {
    const t = setupTest();
    const { seyi, care } = await family(t);
    expect(await turn(t, SEYI, FAMILY, { command: { kind: "use", slug: "crystal-care" } })).toMatchObject({ status: "not_shared" });
    for (const invitee of [DAD, MOM]) {
      await asUser(t, seyi.userId).mutation(api.functions.invitations.inviteMember, { workspaceId: care, invitee, role: "editor" });
    }
    await turn(t, SEYI, FAMILY, { command: { kind: "use", slug: "crystal-care" } });
    const tagged = await turn(t, SEYI, FAMILY);
    expect(tagged).toMatchObject({ status: "ready", slug: "crystal-care", handle: "seyi" });
    expect(tagged.guest).toBeUndefined();
    expect(await t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0]?.guestGroupId ?? null)).toBeNull();
    // Dad's own tag still answers, through Seyi, as an invited person's does.
    expect(await turn(t, DAD, FAMILY)).toMatchObject({ status: "ready", handle: "", guestTagger: expect.stringMatching(/^guest-/) });
  });

  test("an invitation addressed to somebody else, or from somebody they blocked, counts for nobody here", async () => {
    const t = setupTest();
    const { seyi, care } = await family(t);
    const dad = await texter(t, "dad", DAD);
    await texter(t, "mom", MOM);
    await createWorkspace(t, await createUser(t, "bob@example.invalid"), "bob", { kind: "personal" });
    await asUser(t, seyi.userId).mutation(api.functions.invitations.inviteMember, { workspaceId: care, invitee: "@bob", role: "editor" });
    await asUser(t, seyi.userId).mutation(api.functions.invitations.inviteMember, { workspaceId: care, invitee: "@mom", role: "editor" });
    await asUser(t, seyi.userId).mutation(api.functions.invitations.inviteMember, { workspaceId: care, invitee: "@dad", role: "editor" });
    // Dad blocked Seyi after the invitation went out (straight to the row: `blockPerson` would also void it).
    await t.run(async (ctx) => void (await ctx.db.insert("userBlocks", { blockerId: dad.userId, blockedId: seyi.userId, createdAt: Date.now() })));
    expect(await turn(t, SEYI, FAMILY, { command: { kind: "use", slug: "crystal-care" } })).toMatchObject({ status: "not_shared" });
    expect(await turn(t, SEYI, FAMILY)).not.toMatchObject({ guest: expect.anything() });
    const member = await t.run(
      async (ctx) => await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", care).eq("userId", dad.userId)).unique(),
    );
    expect(member).toBeNull();
  });
});
