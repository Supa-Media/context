import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { nodeAt } from "../functions/lib/nodes/paths";
import { setAccessRow } from "../functions/lib/nodes/setAccess";
import { ensureChatHome } from "../functions/lib/textGroupHome";

/**
 * A GROUP CHAT'S HOME: MADE FOR ITS PEOPLE, AND THE ONE PLACE ITS TURN MAY CHANGE IN THE PIN (decided by the owner,
 * 2026-10-31; docs/decisions/texting-assistant/chat-homes.md).
 *
 * `lib/textGroupHome.ts` makes `tex/groups/<words>/` in `@context-lc` on a chat's first turn with a session, naming
 * the chat's people with an account to edit, and keeps that list as the chat's people change. The grant's setup row
 * (`liveGrants.ts`) carries the home and its token to edit beside the pin reader's names, read as a chat reads. These
 * pin who is named, what the session carries, and that the rules the gateway gets for it open the home to change and
 * nothing else.
 *
 * ## Sabotage record
 *
 *   `ensureChatHome` call dropped from `mintGroupGrant` → "the first turn makes the home" fails
 *   people list not re-synced (`kept` always true) → "somebody who leaves the chat is taken off" fails
 *   `groupSetupRow` without `READS_AS_CHAT` → "the rules the session reads by" fails
 *   `sealedPin` answering any workspace → "no home where there is no pin" fails
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
const CY = "+15555550122";

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
  return userId;
}

async function turn(t: T, sender: string, participants: string[]) {
  return await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true });
}

type SessionRow = { workspaceId: string; slug?: string; role?: string; grantedNames?: string[]; setupOnly?: true; homeOnly?: true; chatHome?: string };

async function resolves(t: T, accessToken: string): Promise<{ workspaces: SessionRow[] } | null> {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return (JSON.parse(await response.text()) as { session: { workspaces: SessionRow[] } | null }).session;
}

/** The pinned world, Ada, Bo and Cy linked, and a workspace all three share. */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await texter(w.t, "ada", ADA);
  const bo = await texter(w.t, "bo", BO);
  const cy = await texter(w.t, "cy", CY);
  const studio = await createWorkspace(w.t, bo, "studio", { kind: "shared" });
  await addMember(w.t, studio, ada, "editor");
  await addMember(w.t, studio, cy, "member");
  return { ...w, ada, bo, cy, studio };
}

async function chatRow(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0] ?? null);
}

/** The home's row and the accounts it names, sorted. */
async function homeRow(w: PinnedWorld, folder: string) {
  return await w.t.run(async (ctx) => {
    const row = await nodeAt(ctx.db, w.pinned, folder);
    if (row === null) return null;
    const grants = await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).collect();
    return { row, people: grants.map((grant) => ({ user: grant.granteeUserId, role: grant.role })).sort((a, b) => String(a.user).localeCompare(String(b.user))) };
  });
}

function sorted(ids: Id<"users">[]) {
  return [...ids].sort().map((user) => ({ user, role: "edit" }));
}

describe("a chat's home", () => {
  test("the first turn makes the home, three words under the homes folder, naming everyone in the chat to edit", async () => {
    const w = await world();
    expect(await turn(w.t, ADA, [ADA, BO, CY, LINE])).toMatchObject({ status: "ready", slug: "context-lc", reach: ["studio"], minted: true });
    const chat = await chatRow(w.t);
    expect(chat?.homeWords).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const folder = `tex/groups/${chat!.homeWords}`;
    const home = await homeRow(w, folder);
    expect(home?.row.kind).toBe("folder");
    expect(home?.people).toEqual(sorted([w.ada, w.bo, w.cy]));
    // The same chat keeps its home: no second folder, no new words.
    await turn(w.t, BO, [ADA, BO, CY, LINE]);
    expect((await chatRow(w.t))?.homeWords).toBe(chat!.homeWords);
  });

  test("somebody who leaves the chat is taken off, and somebody added is named", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    const folder = `tex/groups/${(await chatRow(w.t))!.homeWords}`;
    await turn(w.t, ADA, [ADA, BO, LINE]);
    expect((await homeRow(w, folder))?.people).toEqual(sorted([w.ada, w.bo]));
    await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    expect((await homeRow(w, folder))?.people).toEqual(sorted([w.ada, w.bo, w.cy]));
  });

  test("no home where there is no pin", async () => {
    const w = await world();
    // The pin renamed: the seal is drawn by the name, so without it a chat is never filed in a folder that isn't sealed.
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.pinned, { slug: "not-the-pin" });
    });
    const made = await w.t.run(async (ctx) => {
      const chat = await ctx.db.insert("textGroups", { groupKey: "f".repeat(64), lastSeenAt: 1 });
      return await ensureChatHome(ctx as unknown as MutationCtx, (await ctx.db.get(chat))!, [w.ada], w.ada);
    });
    expect(made).toBeNull();
  });
});

describe("what the chat's session carries in the pin", () => {
  test("the home row names the home and holds its token to edit, as a chat reads", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    const folder = `tex/groups/${(await chatRow(w.t))!.homeWords}`;
    const home = await homeRow(w, folder);
    const session = await resolves(w.t, answer.accessToken as string);
    const setup = session?.workspaces.find((entry) => entry.homeOnly === true);
    expect(setup).toMatchObject({ workspaceId: String(w.pinned), role: "editor", chatHome: folder });
    expect(setup?.grantedNames).toEqual(expect.arrayContaining(["#reads-as-chat", `#${home!.row.noteId}`, `#${home!.row.noteId}!edit`]));
    // The home is the default row, then the workspace everyone in the chat shares.
    expect(session?.workspaces.filter((entry) => entry.homeOnly !== true).map((entry) => entry.slug)).toEqual(["studio"]);
  });

  test("the rules the session reads by open the home to change, read the guides, and close the rest", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    const folder = `tex/groups/${(await chatRow(w.t))!.homeWords}`;
    const setup = (await resolves(w.t, answer.accessToken as string))?.workspaces.find((entry) => entry.homeOnly === true);
    const held = await w.t.query(internal.functions.nodesPrivacy.authority, { workspaceId: w.pinned, chatNames: setup!.grantedNames });
    const ruleAt = (prefix: string) => held.folders.find((rule) => rule.prefix === prefix)?.visibility;
    expect(ruleAt(folder)).toBe("team");
    expect(ruleAt("tex/groups")).toBe("private");
    expect(ruleAt("areas")).toBe("private");
    // Only the home (E1): not even the guides every account reads.
    expect(ruleAt("guides")).toBe("private");
    expect(held.readOnly?.folders ?? []).not.toContain(folder);
  });

  test("another chat's home is closed to it", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    // Another chat, somebody else's, with its own home.
    const other = await w.t.run(async (ctx) => {
      const chat = await ctx.db.insert("textGroups", { groupKey: "e".repeat(64), lastSeenAt: 1 });
      return await ensureChatHome(ctx as unknown as MutationCtx, (await ctx.db.get(chat))!, [w.sayo], w.sayo);
    });
    expect(other).toMatch(/^tex\/groups\//);
    const setup = (await resolves(w.t, answer.accessToken as string))?.workspaces.find((entry) => entry.homeOnly === true);
    const held = await w.t.query(internal.functions.nodesPrivacy.authority, { workspaceId: w.pinned, chatNames: setup!.grantedNames });
    expect(held.folders.find((rule) => rule.prefix === other)?.visibility).toBe("private");
  });

  test("an owner of the pin still can't set the home's people by hand", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    const folder = `tex/groups/${(await chatRow(w.t))!.homeWords}`;
    const refused = await w.t.run(async (ctx) =>
      await setAccessRow(ctx as unknown as MutationCtx, {
        workspaceId: w.pinned,
        path: folder,
        base: "private",
        grantees: [{ kind: "user", userId: w.staff, role: "edit" }],
        actor: { userId: w.staff, role: "owner" },
      }),
    );
    expect(refused).toEqual({ ok: false, code: "FORBIDDEN" });
  });
});
