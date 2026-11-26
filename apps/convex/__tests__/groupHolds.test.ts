import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";

/**
 * AN ANSWER HELD FROM A GROUP, AND THE ASKER'S YES THAT SHARES IT (privacy rulebook rules 3 and 4, Dev2, 2026-11-25
 * and 2026-11-26; `functions/groupHolds.ts`).
 *
 * The chat: Sam and Sol are in @harbor-care, Jo is not; all three are in @studio-co. Sol asks, the gateway holds the
 * answer because Jo can't open @harbor-care, and Sol says yes in their own chat with Tex: @harbor-care is then open in
 * this chat for exactly the people who were there. Anyone new locks it again.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `unlockedSlugs` ignoring who is present          -> "a newcomer locks it again" fails
 *   `shareHold` skipping the `hold.by` check          -> "only the asker shares their hold" fails
 *   `shareHold` accepting a group chat's token        -> "only the asker shares their hold" fails (the tag token shares)
 *   `shareHold` skipping the membership check         -> "an asker who left the workspace can't share it" fails
 *   the grant not keeping who was there at mint       -> every test that holds fails ("bad_request")
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
const NEW = "+15555550133";
const EVERYONE = [SAM, SOL, JO, LINE];
const HOLD = "h0123456789abcdef";

type T = PinnedWorld["t"];

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return { userId };
}

const turn = async (t: T, sender: string, participants: string[] = EVERYONE) => await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true });
const ownChat = async (t: T, phone: string) => (await agentPost(t, "/agent-texts/session", { phone })).accessToken as string;
const post = async (t: T, path: string, body: Record<string, unknown>) => (await (await gatewayPost(t, path, body)).json()) as Record<string, unknown>;
const groupKey = async (t: T) => (await t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0]?.groupKey)) as string;
/** The people Tex sees in the chat, as the gateway would hand them on a hold: every number but its own line. */

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
  expect(await turn(w.t, SAM)).toMatchObject({ status: "ready" });
  return { ...w, sam, sol, jo, harbor, studio };
}

/** Sol asks, and the answer is held in front of everyone here. */
async function held(w: Awaited<ReturnType<typeof world>>, participants = EVERYONE) {
  const sol = await turn(w.t, SOL, participants);
  expect(sol.unshared).toEqual(["harbor-care"]);
  expect(await post(w.t, "/gateway/group/hold", { accessToken: sol.accessToken, id: HOLD, slugs: ["harbor-care"] })).toEqual({ status: "held" });
  return sol;
}

async function dropMember(t: T, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).unique();
    await ctx.db.delete(row!._id);
  });
}

describe("an answer held from a group, and the asker's yes", () => {
  test("the asker's yes opens the workspace in this chat for the people who were here", async () => {
    const w = await world();
    await held(w);
    // Held, not yet shared: still closed.
    expect((await turn(w.t, SOL)).unshared).toEqual(["harbor-care"]);
    expect(await post(w.t, "/gateway/group/share", { accessToken: await ownChat(w.t, SOL), groupKey: await groupKey(w.t), id: HOLD })).toEqual({ status: "shared", slugs: ["harbor-care"] });
    const after = await turn(w.t, SOL);
    expect(after.unshared).toEqual([]);
    expect(after.blocked).toEqual([]);
    // Sam's ask in the same room is open too: what was shared was said in front of these people.
    expect((await turn(w.t, SAM)).unshared).toEqual([]);
    // Someone leaving keeps it open: everyone left was there.
    expect((await turn(w.t, SOL, [SOL, JO, LINE])).unshared).toEqual([]);
  });

  test("a newcomer locks it again", async () => {
    const w = await world();
    await held(w);
    await post(w.t, "/gateway/group/share", { accessToken: await ownChat(w.t, SOL), groupKey: await groupKey(w.t), id: HOLD });
    await texter(w.t, "nia", NEW);
    const joined = await turn(w.t, SOL, [...EVERYONE, NEW]);
    // Nia isn't in @studio-co either, so it's closed too; what matters is that @harbor-care is closed again.
    expect(joined.unshared).toContain("harbor-care");
    expect(joined.blocked).toEqual(expect.arrayContaining([{ slug: "harbor-care", who: "jo", why: "not_member" }]));
  });

  test("only the asker shares their hold, from their own chat with Tex", async () => {
    const w = await world();
    const sol = await held(w);
    const key = await groupKey(w.t);
    // Sam is in @harbor-care, but this was Sol's ask: to Sam it is no hold at all.
    expect(await post(w.t, "/gateway/group/share", { accessToken: await ownChat(w.t, SAM), groupKey: key, id: HOLD })).toEqual({ status: "not_found" });
    // The group turn's own token can't share it, even on Sol's tag.
    expect(await post(w.t, "/gateway/group/share", { accessToken: sol.accessToken, groupKey: key, id: HOLD })).toEqual({ status: "refused" });
    expect(await post(w.t, "/gateway/group/share", { accessToken: "not-a-real-token", groupKey: key, id: HOLD })).toEqual({ status: "refused" });
    expect(await post(w.t, "/gateway/group/share", { accessToken: await ownChat(w.t, SOL), groupKey: key, id: "h-nope-nope" })).toEqual({ status: "not_found" });
    // With no id it is their newest one there: none for Sam, Sol's for Sol.
    expect(await post(w.t, "/gateway/group/share", { accessToken: await ownChat(w.t, SAM), groupKey: key })).toEqual({ status: "not_found" });
    expect((await turn(w.t, SOL)).unshared).toEqual(["harbor-care"]);
    expect(await post(w.t, "/gateway/group/share", { accessToken: await ownChat(w.t, SOL), groupKey: key })).toEqual({ status: "shared", slugs: ["harbor-care"] });
  });

  test("an asker who left the workspace can't share it", async () => {
    const w = await world();
    await held(w);
    await dropMember(w.t, w.harbor, w.sol.userId);
    expect(await post(w.t, "/gateway/group/share", { accessToken: await ownChat(w.t, SOL), groupKey: await groupKey(w.t), id: HOLD })).toEqual({ status: "not_member" });
  });

  test("a hold needs the group turn's own token, and keeps no number", async () => {
    const w = await world();
    expect(await post(w.t, "/gateway/group/hold", { accessToken: await ownChat(w.t, SOL), id: HOLD, slugs: ["harbor-care"] })).toEqual({ status: "refused" });
    expect(await post(w.t, "/gateway/group/hold", { accessToken: "not-a-real-token", id: HOLD, slugs: ["harbor-care"] })).toEqual({ status: "refused" });
    const sol = await turn(w.t, SOL);
    expect(await post(w.t, "/gateway/group/hold", { accessToken: sol.accessToken, id: "bad id", slugs: ["harbor-care"] })).toEqual({ status: "bad_request" });
    await held(w);
    const row = await w.t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0]);
    expect(JSON.stringify(row?.holds)).not.toMatch(/\+1555/);
    expect(row?.holds?.[0]).toMatchObject({ id: HOLD, slugs: ["harbor-care"], by: w.sol.userId });
  });
});
