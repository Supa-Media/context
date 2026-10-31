import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { hashToken } from "../functions/lib/crypto";
import { SCOPE_PRIVATE } from "../functions/lib/consentScopes";
import { chatReaches, chatWorkspace } from "../functions/lib/textGroupReach";
import { routineChat } from "../functions/lib/routines/chats";

/**
 * A GROUP CHAT REACHES THE SHARED WORKSPACES ALL ITS PEOPLE SHARE (decided by the owner, 2026-10-31, from the Tex Devs
 * meeting of 2026-10-30; `docs/decisions/texting-assistant/groups.md`, `chat-homes.md`).
 *
 * A chat is bound to no workspace. Its grant is minted on the pinned workspace (the chat's home), carries the shared
 * workspaces every person with an account is a live member of, and a tool call names one with `context: "@slug"`. Each
 * is a row of the grant's session at `team` tier with no granted names, held at the LOWEST role among the chat's people
 * there. Anyone with no account, and the chat has its home alone. A personal workspace and the pin are never in reach.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `sharedByAll` skipping the second person's memberships          -> "a workspace only some share is not in reach" fails
 *   `liveReach` reading the stored list without the membership check -> "one of them leaving B drops B ..." fails
 *   `reachOf` ignoring `hasGuests`                                   -> "a person with no account means home only" fails
 *   `mayBeInReach` letting personal workspaces through               -> "a personal workspace ... never in reach" fails
 *   `mayBeInReach` letting the pin through                           -> "... @context-lc ..." fails
 *   `lowest` returning the higher role                               -> "a viewer in the chat ..." fails
 *   `liveReach` not counting the sponsor                             -> "the sponsor who acts must be a member too" fails
 *   `homeOnlyRows` returning a stored list unfiltered                -> "a forged reach in the stored grant ..." fails
 *   `gatewayEditorClearance` honouring a home-only row               -> "no clearance on the pin" fails
 *   `routineChat` ignoring `chatReaches`                             -> "a chat's routine runs only in a workspace it reaches" fails
 */

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";
const GUEST = "+15555550133";

type T = PinnedWorld["t"];

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const personal = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return { userId, personal };
}

async function turn(t: T, sender: string, participants: string[], extra: Record<string, unknown> = {}) {
  return await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true, ...extra });
}

type Row = { workspaceId: string; slug?: string; role?: string; grantedNames?: string[]; homeOnly?: true; chatHome?: string };
type Session = { defaultWorkspaceId: string; scopes: string[]; workspaces: Row[] };

async function resolves(t: T, accessToken: string): Promise<Session | null> {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Session | null }).session;
}

/** Ada and Bo, each with an account; they share @alpha (Ada edits, Bo owns) and @beta (both edit). */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await texter(w.t, "ada", ADA);
  const bo = await texter(w.t, "bo", BO);
  const alpha = await createWorkspace(w.t, bo.userId, "ember-co", { kind: "shared" });
  await addMember(w.t, alpha, ada.userId, "editor");
  const beta = await createWorkspace(w.t, bo.userId, "fjord-co", { kind: "shared" });
  await addMember(w.t, beta, ada.userId, "editor");
  return { ...w, ada, bo, alpha, beta };
}

async function dropMember(t: T, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).unique();
    await ctx.db.delete(row!._id);
  });
}

async function chatRow(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0] ?? null);
}

async function grantRow(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect()).find((entry) => entry.texGroup !== undefined) ?? null);
}

const slugsOf = (session: Session | null) => (session?.workspaces ?? []).map((row) => row.slug);

describe("what a chat reaches", () => {
  test("two people who share A and B reach both, as rows of the grant on the pin, after the home", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, LINE]);
    expect(answer).toMatchObject({ status: "ready", slug: "context-lc", reach: ["ember-co", "fjord-co"], minted: true, bound: false });
    const session = await resolves(w.t, answer.accessToken as string);
    expect(session?.defaultWorkspaceId).toBe(String(w.pinned));
    expect(slugsOf(session)).toEqual(["context-lc", "ember-co", "fjord-co"]);
    expect(session?.workspaces[0]).toMatchObject({ homeOnly: true, role: "editor" });
    expect(await grantRow(w.t)).toMatchObject({ workspaceId: w.pinned, texGroup: { homeOnly: true, reach: [w.alpha, w.beta] } });
    // Team tier with no granted names: the grant never holds the private tier, whoever tagged.
    expect(session?.scopes).not.toContain(SCOPE_PRIVATE);
    for (const row of session!.workspaces.slice(1)) expect(row.grantedNames).toBeUndefined();
    // The chat is bound to nothing, and its single-workspace readers take the first by name.
    expect((await chatRow(w.t))?.workspaceId).toBeUndefined();
    expect(await w.t.run(async (ctx) => (await chatWorkspace(ctx, (await ctx.db.query("textGroups").first())!))?._id)).toBe(w.alpha);
  });

  test("a workspace only some share is not in reach", async () => {
    const w = await world();
    const cy = await texter(w.t, "cy", "+15555550122");
    const gamma = await createWorkspace(w.t, w.bo.userId, "gamma-co", { kind: "shared" });
    await addMember(w.t, gamma, w.ada.userId, "editor");
    await addMember(w.t, w.beta, cy.userId, "member");
    const answer = await turn(w.t, ADA, [ADA, BO, "+15555550122", LINE]);
    // Cy is only in @beta, and Ada is not in anything Cy is in but @beta.
    expect(answer).toMatchObject({ status: "ready", reach: ["fjord-co"] });
    expect(slugsOf(await resolves(w.t, answer.accessToken as string))).toEqual(["context-lc", "fjord-co"]);
  });

  test("one of them leaving B drops B on the next call, with no new turn", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, LINE]);
    const token = answer.accessToken as string;
    expect(slugsOf(await resolves(w.t, token))).toEqual(["context-lc", "ember-co", "fjord-co"]);
    await dropMember(w.t, w.beta, w.ada.userId);
    expect(slugsOf(await resolves(w.t, token))).toEqual(["context-lc", "ember-co"]);
    // The other person leaving the other workspace drops it too; the chat has only its home left, and the grant lives.
    await dropMember(w.t, w.alpha, w.bo.userId);
    expect(slugsOf(await resolves(w.t, token))).toEqual(["context-lc"]);
    // The next turn works it out afresh.
    expect(await turn(w.t, ADA, [ADA, BO, LINE])).toMatchObject({ status: "ready", reach: [] });
  });

  test("a person with no account means home only, whoever tags", async () => {
    const w = await world();
    for (const sender of [ADA, GUEST]) {
      const answer = await turn(w.t, sender, [ADA, BO, GUEST, LINE]);
      expect(answer).toMatchObject({ status: "ready", slug: "context-lc", reach: [], minted: true });
      const session = await resolves(w.t, answer.accessToken as string);
      expect(slugsOf(session)).toEqual(["context-lc"]);
      expect(JSON.stringify(session)).not.toContain(String(w.alpha));
    }
    expect((await grantRow(w.t))?.texGroup?.reach).toEqual([]);
  });

  test("a person whose texting is paused counts as having no account: home only", async () => {
    const w = await world();
    await w.t.run(async (ctx) => void (await ctx.db.insert("phoneSignInPauses", { userId: w.bo.userId, pausedAt: Date.now() } as never)));
    const answer = await turn(w.t, ADA, [ADA, BO, LINE]);
    expect(answer).toMatchObject({ status: "ready", reach: [] });
  });

  test("a personal workspace, and @context-lc's team notes, are never in reach, though both people are members", async () => {
    const w = await world();
    // Bo is a member of Ada's personal workspace, and both are members of the pinned workspace.
    await addMember(w.t, w.ada.personal, w.bo.userId, "member");
    await addMember(w.t, w.pinned, w.ada.userId, "member", w.staff);
    await addMember(w.t, w.pinned, w.bo.userId, "member", w.staff);
    const answer = await turn(w.t, ADA, [ADA, BO, LINE]);
    expect(answer).toMatchObject({ status: "ready", reach: ["ember-co", "fjord-co"] });
    const session = await resolves(w.t, answer.accessToken as string);
    const ids = session!.workspaces.map((row) => row.workspaceId);
    expect(ids).not.toContain(String(w.ada.personal));
    expect(ids).not.toContain(String(w.bo.personal));
    // The pin appears once, as the home row, with the chat's names only, never as a team workspace.
    expect(ids.filter((id) => id === String(w.pinned))).toHaveLength(1);
    expect(session?.workspaces.find((row) => row.workspaceId === String(w.pinned))).toMatchObject({ homeOnly: true });
  });

  test("a viewer in the chat makes that workspace read-only, and only that one", async () => {
    const w = await world();
    // Make Bo a viewer in @beta: the chat holds the lowest role among its people there.
    await w.t.run(async (ctx) => {
      const row = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", w.beta).eq("userId", w.ada.userId)).unique();
      await ctx.db.patch(row!._id, { role: "member" });
    });
    const answer = await turn(w.t, BO, [ADA, BO, LINE]);
    const session = await resolves(w.t, answer.accessToken as string);
    const roles = Object.fromEntries(session!.workspaces.map((row) => [row.slug, row.role]));
    // Bo owns both, Ada edits @alpha and views @beta.
    expect(roles).toMatchObject({ "ember-co": "editor", "fjord-co": "member" });
  });

  test("the sponsor who acts must be a member too: a sponsor out of a workspace loses it", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, LINE]);
    const cy = await texter(w.t, "cy", "+15555550122");
    // A grant whose sponsor has left the chat is still the sponsor's: writes in a workspace are audited as them.
    const answer = await turn(w.t, ADA, [ADA, BO, LINE]);
    const sponsor = (await chatRow(w.t))!.sponsorId!;
    expect(sponsor).toBe(w.ada.userId);
    await w.t.run(async (ctx) => {
      const grant = (await ctx.db.query("oauthGrants").collect()).find((entry) => entry.texGroup !== undefined)!;
      // The chat as it was before the sponsor was added to its people, with Cy (who is in nothing) never there.
      await ctx.db.patch(grant._id, { texGroup: { ...grant.texGroup!, reachPeople: [w.bo.userId] } });
    });
    expect(slugsOf(await resolves(w.t, answer.accessToken as string))).toEqual(["context-lc", "ember-co", "fjord-co"]);
    await dropMember(w.t, w.alpha, w.ada.userId);
    expect(slugsOf(await resolves(w.t, answer.accessToken as string))).toEqual(["context-lc", "fjord-co"]);
    expect(cy.userId).toBeDefined();
  });
});

describe("what a forged grant or call cannot reach", () => {
  test("a forged reach in the stored grant (a personal workspace, the pin, a workspace nobody is in) serves none of them", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, LINE]);
    const stranger = await createUser(w.t, "stranger@example.invalid");
    const secret = await createWorkspace(w.t, stranger, "secret-room", { kind: "shared" });
    await w.t.run(async (ctx) => {
      const grant = (await ctx.db.query("oauthGrants").collect()).find((entry) => entry.texGroup !== undefined)!;
      await ctx.db.patch(grant._id, { texGroup: { ...grant.texGroup!, reach: [w.ada.personal, w.pinned, secret, w.alpha] } });
    });
    const session = await resolves(w.t, answer.accessToken as string);
    expect(slugsOf(session)).toEqual(["context-lc", "ember-co"]);
    expect(JSON.stringify(session)).not.toContain(String(secret));
    expect(JSON.stringify(session)).not.toContain(String(w.ada.personal));
  });

  test("a call that names a workspace outside the grant's rows is refused", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, LINE]);
    const hashedAccessToken = await hashToken(answer.accessToken as string);
    const outside = await createWorkspace(w.t, w.bo.userId, "outside-co", { kind: "shared" });
    const join = (workspaceId: string, path = "areas/note.md") =>
      w.t.mutation(internal.functions.noteMail.joinMailbox, { hashedAccessToken, workspaceId, path, name: "tex", mailboxId: "mb_abcdefgh" });
    expect(await join(String(outside))).toEqual({ ok: false, error: "refused" });
    expect(await join(String(w.ada.personal))).toEqual({ ok: false, error: "refused" });
    expect(await join(String(w.pinned))).toEqual({ ok: false, error: "refused" });
    expect(await join(String(w.alpha))).toMatchObject({ ok: true });
    // After Ada leaves @alpha the same call is refused: the call is judged against the live rows.
    await dropMember(w.t, w.alpha, w.ada.userId);
    expect(await join(String(w.alpha), "areas/other.md")).toEqual({ ok: false, error: "refused" });
  });

  test("no clearance on the pin: a chat's home-only row never clears an owner or editor check there", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, LINE]);
    const hashedAccessToken = await hashToken(answer.accessToken as string);
    for (const query of [internal.functions.controlPlane.ownerClearanceForGateway, internal.functions.controlPlane.editorClearanceForGateway]) {
      expect(await w.t.query(query, { hashedAccessToken, expectedWorkspaceId: String(w.pinned) })).toBeNull();
    }
  });
});

describe("where one workspace is needed", () => {
  test("the bound one if it is still in reach, else the first in reach by name", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, LINE]);
    const pick = async () =>
      await w.t.run(async (ctx) => {
        const chat = (await ctx.db.query("textGroups").first())!;
        return { picked: (await chatWorkspace(ctx, chat))?._id ?? null, reachesBeta: await chatReaches(ctx, chat, w.beta) };
      });
    expect(await pick()).toEqual({ picked: w.alpha, reachesBeta: true });
    // An old row bound to @beta, which is still in reach: it keeps it.
    await w.t.run(async (ctx) => void (await ctx.db.patch((await ctx.db.query("textGroups").first())!._id, { workspaceId: w.beta })));
    expect(await pick()).toEqual({ picked: w.beta, reachesBeta: true });
    // Out of reach it falls to the first by name.
    await dropMember(w.t, w.beta, w.bo.userId);
    expect(await pick()).toEqual({ picked: w.alpha, reachesBeta: false });
    await dropMember(w.t, w.alpha, w.ada.userId);
    expect(await pick()).toEqual({ picked: null, reachesBeta: false });
  });

  test("a chat's routine runs only in a workspace it reaches", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, LINE]);
    const key = (await chatRow(w.t))!.groupKey.slice(0, 16);
    const found = async (workspaceId: Id<"workspaces">) => await w.t.run(async (ctx) => (await routineChat(ctx, workspaceId, key))?.groupKey ?? null);
    expect(await found(w.alpha)).not.toBeNull();
    expect(await found(w.beta)).not.toBeNull();
    const other = await createWorkspace(w.t, w.bo.userId, "other-co", { kind: "shared" });
    expect(await found(other)).toBeNull();
    expect(await found(w.ada.personal)).toBeNull();
    await dropMember(w.t, w.beta, w.ada.userId);
    expect(await found(w.beta)).toBeNull();
  });

  test("the chat's mailbox, check-in and decision read the one workspace the same way", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, LINE]);
    const decided = await w.t.query(internal.functions.textGroups.groupDecideWorkspace, { groupKey: (await chatRow(w.t))!.groupKey });
    expect(decided).toBe(w.alpha);
    await dropMember(w.t, w.alpha, w.bo.userId);
    expect(await w.t.query(internal.functions.textGroups.groupDecideWorkspace, { groupKey: (await chatRow(w.t))!.groupKey })).toBe(w.beta);
  });
});
