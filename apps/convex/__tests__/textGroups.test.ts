import { afterEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { TEXTS_GROUP_CLIENT_ID } from "../functions/textGroups";
import { SCOPE_PRIVATE } from "../functions/lib/consentScopes";

/**
 * TEX IN A GROUP CHAT: WHO COUNTS, AND WHAT THE CHAT MAY REACH.
 *
 * The rule (`functions/textGroups.ts`): every participant but the line must be
 * a phone linked by code, and the chat reaches one shared workspace every one
 * of them is a member of, at team tier, while all of them still are. These
 * tests spend the grant on the real `/gateway/session` route, because a grant
 * that is minted but resolves wider than the chat is the failure that matters.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";
const CY = "+15555550122";
const STRANGER = "+15555550199";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

/** A person with a personal workspace and a phone linked by code. */
async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  const linked = await agentPost(t, "/agent-texts/link", { phone, code });
  expect(linked.body.status).toBe("linked");
  return { userId, workspaceId };
}

async function turn(t: T, sender: string, participants: string[], extra: Record<string, unknown> = {}) {
  return (await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true, ...extra })).body;
}

async function resolves(t: T, accessToken: string) {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  const body = JSON.parse(await response.text()) as { session: Record<string, unknown> | null };
  return body.session as null | {
    clientId: string;
    scopes: string[];
    defaultWorkspaceId: string;
    workspaces: Array<{ workspaceId: string; slug?: string; role?: string; grantedNames?: string[]; setupOnly?: true }>;
  };
}

/** Ada, Bo and Cy, all linked, with one shared workspace Bo owns and the others are in. */
async function crew(t: T) {
  const ada = await texter(t, "ada", ADA);
  const bo = await texter(t, "bo", BO);
  const cy = await texter(t, "cy", CY);
  const studio = await createWorkspace(t, bo.userId, "studio", { kind: "shared" });
  await addMember(t, studio, ada.userId, "editor");
  await addMember(t, studio, cy.userId, "member");
  return { ada, bo, cy, studio };
}

describe("the door", () => {
  test("refuses without the agent worker's own secret", async () => {
    const t = setupTest();
    for (const secret of [null, "wrong", TEST_GATEWAY_SECRET]) {
      expect((await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA] }, secret)).status).toBe(401);
    }
  });

  test("a sender who isn't in the chat's own list is refused", async () => {
    const t = setupTest();
    await crew(t);
    expect(await turn(t, ADA, [BO, CY, LINE])).toEqual({ status: "refused" });
  });
});

describe("who counts", () => {
  test("a sender nobody linked is told once, and nothing is minted", async () => {
    const t = setupTest();
    await crew(t);
    expect(await turn(t, STRANGER, [ADA, BO, STRANGER, LINE])).toEqual({ status: "unknown_sender", tell: true });
    expect(await turn(t, STRANGER, [ADA, BO, STRANGER, LINE])).toEqual({ status: "unknown_sender", tell: false });
    const grants = await t.run(async (ctx) => await ctx.db.query("oauthGrants").collect());
    expect(grants.filter((grant) => grant.clientId === TEXTS_GROUP_CLIENT_ID)).toHaveLength(0);
    // The number itself is never stored.
    const groups = await t.run(async (ctx) => await ctx.db.query("textGroups").collect());
    expect(JSON.stringify(groups)).not.toContain(STRANGER);
    expect(JSON.stringify(groups)).not.toContain(GROUP);
  });

  test("one participant nobody linked means no notes for anyone", async () => {
    const t = setupTest();
    await crew(t);
    expect(await turn(t, ADA, [ADA, BO, STRANGER, LINE])).toEqual({ status: "no_shared" });
  });

  test("an entry that isn't a phone number counts as somebody unknown, never as nobody", async () => {
    const t = setupTest();
    await crew(t);
    expect(await turn(t, ADA, [ADA, BO, "someone@example.invalid", LINE])).toEqual({ status: "no_shared" });
    expect(await turn(t, ADA, [ADA, BO, 42 as unknown as string, LINE])).toEqual({ status: "no_shared" });
  });

  test("only the line the message came in on is Tex: another of our numbers is a stranger", async () => {
    const t = setupTest();
    await crew(t);
    expect(await turn(t, ADA, [ADA, BO, "+15555550002", LINE])).toEqual({ status: "no_shared" });
  });

  test("a person with texting paused counts as unknown", async () => {
    const t = setupTest();
    const { bo } = await crew(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("phoneSignInPauses", { userId: bo.userId, pausedAt: Date.now() } as never);
    });
    expect(await turn(t, ADA, [ADA, BO, LINE])).toEqual({ status: "no_shared" });
  });
});

describe("what the chat reaches", () => {
  test("one shared workspace is bound at once, introduced once, and the grant reaches only it, at team tier", async () => {
    const t = setupTest();
    const { ada, studio } = await crew(t);
    const first = await turn(t, ADA, [ADA, BO, CY, LINE]);
    expect(first).toMatchObject({ status: "ready", slug: "studio", intro: true, bound: true, minted: true, handle: "ada" });
    // Everyone's handle by their number, so the chat's words are filed by name.
    expect([...(first.names as { phone: string; handle: string }[])].sort((x, y) => x.handle.localeCompare(y.handle))).toEqual([
      { phone: ADA, handle: "ada" },
      { phone: BO, handle: "bo" },
      { phone: CY, handle: "cy" },
    ]);
    const session = await resolves(t, first.accessToken as string);
    expect(session?.clientId).toBe(TEXTS_GROUP_CLIENT_ID);
    expect(session?.defaultWorkspaceId).toBe(studio);
    expect(session?.workspaces.map((entry) => entry.workspaceId)).toEqual([studio]);
    // Not Ada's personal workspace, never the private tier, and no granted names.
    expect(JSON.stringify(session?.workspaces)).not.toContain(String(ada.workspaceId));
    expect(session?.scopes).not.toContain(SCOPE_PRIVATE);
    expect(session?.workspaces[0]?.grantedNames).toBeUndefined();

    const second = await turn(t, ADA, [ADA, BO, CY, LINE]);
    expect(second).toMatchObject({ status: "ready", intro: false, bound: false });
  });

  test("an owner who tags Tex still gets team tier", async () => {
    const t = setupTest();
    await crew(t);
    const answer = await turn(t, BO, [ADA, BO, CY, LINE]);
    const session = await resolves(t, answer.accessToken as string);
    expect(session?.scopes).not.toContain(SCOPE_PRIVATE);
  });

  test("a member who only views gets a grant that cannot write", async () => {
    const t = setupTest();
    await crew(t);
    const answer = await turn(t, CY, [ADA, BO, CY, LINE]);
    const session = await resolves(t, answer.accessToken as string);
    expect(session?.scopes.some((scope) => scope.includes("write"))).toBe(false);
  });

  test("personal workspaces never count, even when everyone is in one", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    const bo = await texter(t, "bo", BO);
    await addMember(t, ada.workspaceId, bo.userId, "member");
    expect(await turn(t, ADA, [ADA, BO, LINE])).toEqual({ status: "no_shared" });
  });

  test("a workspace only some of them share is not offered", async () => {
    const t = setupTest();
    const { ada, bo } = await crew(t);
    const side = await createWorkspace(t, bo.userId, "side", { kind: "shared" });
    await addMember(t, side, ada.userId, "editor");
    // Cy isn't in @side, so the chat of all three is offered @studio alone.
    expect(await turn(t, ADA, [ADA, BO, CY, LINE])).toMatchObject({ status: "ready", slug: "studio" });
  });

  test("several shared workspaces: the chat is asked to pick, and a pick is kept", async () => {
    const t = setupTest();
    const { ada, bo, cy } = await crew(t);
    const ops = await createWorkspace(t, bo.userId, "ops", { kind: "shared" });
    await addMember(t, ops, ada.userId, "editor");
    await addMember(t, ops, cy.userId, "member");
    expect(await turn(t, ADA, [ADA, BO, CY, LINE])).toEqual({ status: "choose", slugs: ["ops", "studio"] });

    const picked = await turn(t, CY, [ADA, BO, CY, LINE], { command: { kind: "use", slug: "@ops" } });
    // The pick's own line is the introduction, so the next answer doesn't repeat it.
    expect(picked).toMatchObject({ status: "ready", slug: "ops", bound: true, minted: false, intro: true });
    expect(picked.accessToken).toBeUndefined();
    const answer = await turn(t, ADA, [ADA, BO, CY, LINE]);
    expect(answer).toMatchObject({ status: "ready", slug: "ops", bound: false, intro: false });
    expect((await resolves(t, answer.accessToken as string))?.defaultWorkspaceId).toBe(ops);
  });

  test("naming a workspace the chat doesn't share binds nothing", async () => {
    const t = setupTest();
    const { bo } = await crew(t);
    await createWorkspace(t, bo.userId, "bos-own", { kind: "shared" });
    // The group chat of 2026-10-21: the no names the workspaces the chat can use, and only those.
    const shared = (await turn(t, ADA, [ADA, BO, CY, LINE], { command: { kind: "use", slug: "bos-own" } })) as { status: string; slugs: string[] };
    expect(shared.status).toBe("not_shared");
    expect(shared.slugs.length).toBeGreaterThan(0);
    expect(shared.slugs).not.toContain("bos-own");
    expect(await turn(t, ADA, [ADA, BO, CY, LINE], { command: { kind: "use", slug: "nowhere" } })).toEqual(shared);
  });

  test("a bound workspace someone new doesn't share stops being used", async () => {
    const t = setupTest();
    await crew(t);
    expect(await turn(t, ADA, [ADA, BO, CY, LINE])).toMatchObject({ status: "ready", slug: "studio" });
    await texter(t, "di", STRANGER);
    expect(await turn(t, ADA, [ADA, BO, CY, STRANGER, LINE])).toEqual({ status: "no_shared" });
  });
});

describe("a grant follows the chat while it lives", () => {
  test("removing any co-viewer from the workspace stops the grant at once", async () => {
    const t = setupTest();
    const { cy, studio } = await crew(t);
    const answer = await turn(t, ADA, [ADA, BO, CY, LINE]);
    expect(await resolves(t, answer.accessToken as string)).not.toBeNull();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", studio).eq("userId", cy.userId))
        .unique();
      await ctx.db.delete(row!._id);
    });
    expect(await resolves(t, answer.accessToken as string)).toBeNull();
  });

  test("muting the chat stops the grant, and only start lifts it", async () => {
    const t = setupTest();
    await crew(t);
    const answer = await turn(t, ADA, [ADA, BO, CY, LINE]);
    expect(await turn(t, CY, [ADA, BO, CY, LINE], { command: { kind: "stop" } })).toEqual({ status: "stopped" });
    expect(await resolves(t, answer.accessToken as string)).toBeNull();
    expect(await turn(t, ADA, [ADA, BO, CY, LINE])).toEqual({ status: "muted" });
    expect(await turn(t, ADA, [ADA, BO, CY, LINE], { command: { kind: "start" } })).toEqual({ status: "started" });
    expect(await turn(t, ADA, [ADA, BO, CY, LINE])).toMatchObject({ status: "ready" });
  });

  test("a group grant with no chat on it resolves to nothing", async () => {
    const t = setupTest();
    const { ada, studio } = await crew(t);
    const token = "cat_forged_group_grant_without_a_chat";
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthClients", {
        clientId: TEXTS_GROUP_CLIENT_ID,
        clientName: "Tex (group chats)",
        redirectUris: [],
        hashedClientSecret: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: [],
        responseTypes: [],
        createdAt: Date.now(),
      });
      await ctx.db.insert("oauthGrants", {
        workspaceId: studio as Id<"workspaces">,
        userId: ada.userId,
        clientId: TEXTS_GROUP_CLIENT_ID,
        scopes: ["context:read"],
        hashedRefreshToken: await hashToken("unused"),
        hashedAccessToken: await hashToken(token),
        accessTokenExpiresAt: Date.now() + 60_000,
        status: "active",
        createdAt: Date.now(),
      });
    });
    expect(await resolves(t, token)).toBeNull();
  });

  test("each turn replaces the tagger's last token in that chat", async () => {
    const t = setupTest();
    await crew(t);
    const first = await turn(t, ADA, [ADA, BO, CY, LINE]);
    const second = await turn(t, ADA, [ADA, BO, CY, LINE]);
    expect(await resolves(t, first.accessToken as string)).toBeNull();
    expect(await resolves(t, second.accessToken as string)).not.toBeNull();
  });
});

describe("what a turn is charged to", () => {
  test("the tagger's own personal workspace, never the chat's", async () => {
    const t = setupTest();
    const { ada } = await crew(t);
    const answer = await turn(t, ADA, [ADA, BO, CY, LINE]);
    const hashedAccessToken = await hashToken(answer.accessToken as string);
    await t.mutation(internal.functions.builtinModel.startBuiltinTurn, { hashedAccessToken, expectedWorkspaceId: null });
    const usage = await t.run(async (ctx) => await ctx.db.query("jevUsage" as never).collect());
    const charged = new Set((usage as Array<{ workspaceId: string }>).map((row) => row.workspaceId));
    expect([...charged]).toEqual([ada.workspaceId]);
  });
});

describe("Tex's setup in a group chat", () => {
  afterEach(() => vi.unstubAllEnvs());

  /** The pinned workspace, made the way it really is: shared, by staff (`pinnedContext.test.ts`). */
  async function pin(t: T) {
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const staff = await createUser(t, "staff@example.invalid");
    await createWorkspace(t, staff, "staff-personal");
    return await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  }

  test("the grant carries the pin last, marked setup-only, at member role, and nothing else new", async () => {
    const t = setupTest();
    const pinned = await pin(t);
    const { ada, studio } = await crew(t);
    const answer = await turn(t, ADA, [ADA, BO, CY, LINE]);
    const session = await resolves(t, answer.accessToken as string);
    expect(session?.defaultWorkspaceId).toBe(studio);
    expect(session?.workspaces.map((entry) => entry.workspaceId)).toEqual([studio, pinned]);
    expect(session?.workspaces[0]?.setupOnly).toBeUndefined();
    expect(session?.workspaces[1]).toMatchObject({ slug: PINNED_CONTEXT_SLUG, role: "member", setupOnly: true });
    expect(JSON.stringify(session?.workspaces)).not.toContain(String(ada.workspaceId));
  });

  test("the setup-only pin is never a mailbox's workspace", async () => {
    const t = setupTest();
    const pinned = await pin(t);
    await crew(t);
    const answer = await turn(t, ADA, [ADA, BO, CY, LINE]);
    const hashedAccessToken = await hashToken(answer.accessToken as string);
    const join = (workspaceId: string) =>
      t.mutation(internal.functions.noteMail.joinMailbox, { hashedAccessToken, workspaceId, path: "ai/production/texting-assistant.md", name: "tex", mailboxId: "mb_abcdefgh" });
    expect(await join(String(pinned))).toEqual({ ok: false, error: "refused" });
  });
});
