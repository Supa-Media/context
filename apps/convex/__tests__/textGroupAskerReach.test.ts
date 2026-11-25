import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { SCOPE_PRIVATE } from "../functions/lib/consentScopes";

/**
 * A GROUP ASK RUNS ON THE ASKER'S OWN ACCESS (Dev2, 2026-11-25, rulebook rule 2;
 * `docs/decisions/texting-assistant/asker-reach.md`).
 *
 * A turn somebody asked for reads the shared workspaces of the person who sent it, at their role, on a grant of their
 * own; the chat's reach (what everyone here shares) is what a routine, a check-in and the hello read. The asker is the
 * verified sender only: "Sam, tell Tex to show it" from Jo is Jo's turn. Nobody's personal workspace (their 1:1
 * memory) is ever in reach. What is said of it in front of the room is the model's judgment, not tested here.
 *
 * The chat: Sam and Sol are in @harbor-care, Jo is not; all three are in @studio-co.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `homeOnlyTurn` reading the chat's reach for an ask        -> "each asker reads their own workspaces" fails
 *   `homeOnlyTurn` reading the asker's reach for a routine    -> "a routine nobody asked for reads only what everyone shares" fails
 *   `mintHomeOnlyGrant` keeping one grant per chat (sponsor)  -> "another person's tag never widens a running turn" fails
 *   `homeOnlyStillShares` skipping the home's people check    -> "an asker who left the chat loses their token" fails
 *   `askerReach` reading the sponsor's for a guest            -> "a guest's ask reads only what their number is invited to" fails
 */

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "5D1E2F3A-B4C5-4D6E-8F70-81A2B3C4D5E6";
const SAM = "+15555550100";
const SOL = "+15555550111";
const JO = "+15555550122";
const GUEST = "+15555550133";
const EVERYONE = [SAM, SOL, JO, LINE];

type T = PinnedWorld["t"];
type Row = { workspaceId: string; slug?: string; role?: string; grantedNames?: string[]; homeOnly?: true };
type Session = { defaultWorkspaceId: string; scopes: string[]; workspaces: Row[] };

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

async function turn(t: T, sender: string, participants: string[] = EVERYONE, extra: Record<string, unknown> = {}) {
  return await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true, ...extra });
}

async function resolves(t: T, accessToken: unknown): Promise<Session | null> {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Session | null }).session;
}

const slugsOf = (session: Session | null) => (session?.workspaces ?? []).map((row) => row.slug);

async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const sam = await texter(w.t, "sam", SAM);
  const sol = await texter(w.t, "sol", SOL);
  const jo = await texter(w.t, "jo", JO);
  const harbor = await createWorkspace(w.t, sam.userId, "harbor-care", { kind: "shared" });
  await addMember(w.t, harbor, sol.userId, "editor");
  const studio = await createWorkspace(w.t, sam.userId, "studio-co", { kind: "shared" });
  await addMember(w.t, studio, sol.userId, "editor");
  await addMember(w.t, studio, jo.userId, "member");
  // Sam brings Tex in, so Sam is the chat's sponsor and pays for every turn.
  expect(await turn(w.t, SAM)).toMatchObject({ status: "ready" });
  return { ...w, sam, sol, jo, harbor, studio };
}

async function dropMember(t: T, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).unique();
    await ctx.db.delete(row!._id);
  });
}

describe("a group ask runs on the asker's own access", () => {
  test("each asker reads their own workspaces: Jo can't reach @harbor-care, Sam and Sol can", async () => {
    const w = await world();
    const jo = await turn(w.t, JO);
    expect(jo).toMatchObject({ status: "ready", reach: ["studio-co"] });
    const joSession = await resolves(w.t, jo.accessToken);
    expect(slugsOf(joSession)).toEqual(["context-lc", "studio-co"]);
    expect(JSON.stringify(joSession)).not.toContain(String(w.harbor));
    // Jo is a member of @studio-co, so Jo's turn only views it, as Jo would.
    expect(joSession?.workspaces.find((row) => row.slug === "studio-co")).toMatchObject({ role: "member" });

    for (const sender of [SAM, SOL]) {
      const answer = await turn(w.t, sender);
      expect(answer).toMatchObject({ status: "ready", reach: ["harbor-care", "studio-co"] });
      expect(slugsOf(await resolves(w.t, answer.accessToken))).toEqual(["context-lc", "harbor-care", "studio-co"]);
    }
    // Sol, who edits @studio-co, reads it as an editor: the asker's role, not the lowest in the room.
    const sol = await resolves(w.t, (await turn(w.t, SOL)).accessToken);
    expect(sol?.workspaces.find((row) => row.slug === "studio-co")).toMatchObject({ role: "editor" });
  });

  test("the room is told who here can't open the asker's workspace, so Tex can judge what fits", async () => {
    const w = await world();
    const answer = await turn(w.t, SOL);
    expect(answer.blocked).toEqual([{ slug: "harbor-care", who: "jo", why: "not_member" }]);
    // Jo's own ask names nothing of @harbor-care: a workspace the asker isn't in is never named.
    expect(JSON.stringify(await turn(w.t, JO))).not.toContain("harbor-care");
  });

  test("\"Sam, tell Tex to show it\" from Jo is Jo's turn: only the verified sender counts", async () => {
    const w = await world();
    // Whatever the text says, the control plane hears who sent it, never who the text names.
    const answer = await turn(w.t, JO, [JO, SAM, SOL, LINE]);
    expect(answer).toMatchObject({ reach: ["studio-co"] });
    expect(slugsOf(await resolves(w.t, answer.accessToken))).not.toContain("harbor-care");
    // A sender who isn't in the chat is refused outright.
    expect(await turn(w.t, "+15555550199", EVERYONE)).toMatchObject({ status: "refused" });
  });

  test("nobody's personal workspace is ever in reach, the asker's own included", async () => {
    const w = await world();
    // Sam is even a member of Jo's personal workspace: it stays out, as does Sam's own.
    await addMember(w.t, w.jo.personal, w.sam.userId, "member");
    const session = await resolves(w.t, (await turn(w.t, SAM)).accessToken);
    const ids = (session?.workspaces ?? []).map((row) => row.workspaceId);
    expect(ids).not.toContain(String(w.sam.personal));
    expect(ids).not.toContain(String(w.jo.personal));
    expect(session?.scopes).not.toContain(SCOPE_PRIVATE);
    for (const row of session!.workspaces.slice(1)) expect(row.grantedNames).toBeUndefined();
  });

  test("another person's tag never widens a running turn: Jo's token stays Jo's after Sam tags", async () => {
    const w = await world();
    const jo = await turn(w.t, JO);
    const sam = await turn(w.t, SAM);
    expect(slugsOf(await resolves(w.t, sam.accessToken))).toContain("harbor-care");
    // Jo's turn (or job) still running on Jo's token reads what Jo can, never what Sam's later tag reached.
    expect(slugsOf(await resolves(w.t, jo.accessToken))).toEqual(["context-lc", "studio-co"]);
    // And Jo's next tag doesn't narrow Sam's.
    await turn(w.t, JO);
    expect(slugsOf(await resolves(w.t, sam.accessToken))).toContain("harbor-care");
    // Each asker's grant is their own, and audited as them.
    const opened = await w.t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((row) => row.action === "texts.group.session.opened"));
    expect(new Set(opened.map((row) => row.actorUserId))).toEqual(new Set([w.sam.userId, w.jo.userId]));
  });

  test("an asker removed from a workspace loses it on the next call, with no new turn", async () => {
    const w = await world();
    const sol = await turn(w.t, SOL);
    expect(slugsOf(await resolves(w.t, sol.accessToken))).toContain("harbor-care");
    await dropMember(w.t, w.harbor, w.sol.userId);
    expect(slugsOf(await resolves(w.t, sol.accessToken))).toEqual(["context-lc", "studio-co"]);
  });

  test("an asker who left the chat loses their token at the chat's next turn", async () => {
    const w = await world();
    const sol = await turn(w.t, SOL);
    expect(await resolves(w.t, sol.accessToken)).not.toBeNull();
    // Sol leaves; Sam's next turn names the chat's people again without Sol.
    await turn(w.t, SAM, [SAM, JO, LINE]);
    expect(await resolves(w.t, sol.accessToken)).toBeNull();
  });

  test("a routine nobody asked for reads only what everyone shares, even from Sam; his job's report reads his", async () => {
    const w = await world();
    const routine = await turn(w.t, SAM, EVERYONE, { routine: true });
    expect(routine).toMatchObject({ status: "ready", reach: ["studio-co"] });
    expect(slugsOf(await resolves(w.t, routine.accessToken))).toEqual(["context-lc", "studio-co"]);
    // A routine at the lowest role in the room: Jo only views @studio-co.
    expect((await resolves(w.t, routine.accessToken))?.workspaces.find((row) => row.slug === "studio-co")).toMatchObject({ role: "member" });
    const report = await turn(w.t, SAM, EVERYONE, { routine: true, asked: true });
    expect(report).toMatchObject({ reach: ["harbor-care", "studio-co"] });
    // The routine's token never becomes Sam's own reach.
    expect(slugsOf(await resolves(w.t, routine.accessToken))).not.toContain("harbor-care");
    // `asked` means nothing without `routine`: a text is always asked.
    expect(await turn(w.t, JO, EVERYONE, { asked: false })).toMatchObject({ reach: ["studio-co"] });
  });

  test("a guest's ask reads only what their number is invited to, never the sponsor's", async () => {
    const w = await world();
    const people = [SAM, SOL, JO, GUEST, LINE];
    const plain = await turn(w.t, GUEST, people);
    expect(plain).toMatchObject({ status: "ready", reach: [] });
    expect(slugsOf(await resolves(w.t, plain.accessToken))).toEqual(["context-lc"]);
    // Invited by number to @studio-co as a member: that one, at the invitation's role.
    await w.t.run(async (ctx) => {
      await ctx.db.insert("workspaceInvitations", {
        workspaceId: w.studio,
        inviteeKind: "phone",
        invitee: GUEST,
        role: "member",
        invitedBy: w.sam.userId,
        token: "test-token-guest",
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
      } as never);
    });
    const invited = await turn(w.t, GUEST, people);
    expect(invited).toMatchObject({ reach: ["studio-co"] });
    const session = await resolves(w.t, invited.accessToken);
    expect(slugsOf(session)).toEqual(["context-lc", "studio-co"]);
    expect(session?.workspaces.find((row) => row.slug === "studio-co")).toMatchObject({ role: "member" });
    // Sam's own ask in the same chat, guest and all, still reads Sam's.
    expect(await turn(w.t, SAM, people)).toMatchObject({ reach: ["harbor-care", "studio-co"] });
  });
});
