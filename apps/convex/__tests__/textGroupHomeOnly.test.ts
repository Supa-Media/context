import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, PLAN, OLD_BUG, BENCH, GUIDE, SECRET, type PinnedWorld } from "./pinnedReaders.helpers";
import { nodeAt } from "../functions/lib/nodes/paths";
import { ensureChatHome } from "../functions/lib/textGroupHome";
import { usageWho } from "../functions/lib/textGroupUsage";
import { canSee } from "../functions/lib/privacy";

/**
 * A GROUP CHAT WITH NO SHARED WORKSPACE READS ITS HOME AND NOTHING ELSE (E1 of the guest-mode retirement, decided by
 * the owner, 2026-10-31; `docs/decisions/texting-assistant/group-guests.md`, `chat-homes.md`).
 *
 * A chat that not everyone shares a workspace with, or a guest who tags Tex, is answered on a HOME-ONLY grant: it is
 * minted on the pinned workspace (`@context-lc`), reads only the chat's own home there (`tex/groups/<words>/`), reads
 * as the chat reads (`READS_AS_CHAT`), and is refused everything else. Its session is the home's row alone, and it
 * resolves only while the chat is not muted and the sponsor who pays for it may still text.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `homeOnlyRows` returning every pin row instead of the home  -> "reads its home and no other workspace" fails
 *   the pin's own `pinnedContextRow` appended to the home-only set -> "reads no other workspace" fails
 *   `READS_AS_CHAT` dropped from the home-only names            -> "the rules it reads by" fails
 *   the `homeOnly` branch dropped from `validateLiveGrantRecord` -> "a home-only grant needs no membership" fails
 *   `groupStillShares` home-only branch returning true           -> "a muted chat" and "a paused sponsor" fail
 *   a home-only grant read under a non-texts client              -> "not an ordinary pin reader" fails
 *   `usageWho` ignoring `guestPhone`                             -> "a guest tagger is recorded by number" fails
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
/** A guest: a number in the chat with no account. */
const GUEST = "+15555550133";
const SAYO_HOME_OTHER = "e".repeat(64);

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

async function turn(t: T, sender: string, participants: string[], extra: Record<string, unknown> = {}) {
  return await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true, ...extra });
}

type SessionRow = { workspaceId: string; slug?: string; role?: string; grantedNames?: string[]; setupOnly?: true; chatHome?: string };
type Session = { defaultWorkspaceId: string; workspaces: SessionRow[] };

async function resolves(t: T, accessToken: string): Promise<Session | null> {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Session | null }).session;
}

/**
 * The pinned world with Ada and Bo, each with an account, sharing a workspace of their own with nobody else. The
 * chat's guest is named by number only: no account, so nothing shared with the whole chat exists.
 */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await texter(w.t, "ada", ADA);
  const bo = await texter(w.t, "bo", BO);
  const studio = await createWorkspace(w.t, bo, "studio", { kind: "shared" });
  await addMember(w.t, studio, ada, "member");
  return { ...w, ada, bo, studio };
}

async function chatRow(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0] ?? null);
}

/** The home's folder for the one chat in the world, and its row's token. */
async function homeOf(w: PinnedWorld) {
  const chat = await chatRow(w.t);
  const folder = `tex/groups/${chat!.homeWords}`;
  const token = await w.t.run(async (ctx) => (await nodeAt(ctx.db, w.pinned, folder))?.noteId ?? null);
  return { folder, token };
}

async function grantOf(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect()).find((grant) => grant.texGroup !== undefined) ?? null);
}

/** The rules the gateway holds for a session's one row, read as that chat reads. */
async function rulesFor(w: PinnedWorld, names: string[]) {
  return await w.t.query(internal.functions.nodesPrivacy.authority, { workspaceId: w.pinned, chatNames: names });
}

/** Whether the chat, holding `names`, reads `path` in the pin: the gateway's own `canSee`, on the rules it is given. */
function reads(held: Awaited<ReturnType<typeof rulesFor>>, names: string[], path: string): boolean {
  const rules = held.folders.map((rule) => ({ prefix: rule.prefix, vis: rule.visibility as never }));
  const overrides = new Map(held.notes.map((note) => [note.path, note.visibility as never] as const));
  return canSee(path, "team", rules, overrides, new Set(names.map((name) => name.replace(/^@/, ""))));
}

describe("a guest's tag in a chat with no shared workspace", () => {
  test("is answered from the chat's home on a home-only grant, as the guest it is", async () => {
    const w = await world();
    const answer = await turn(w.t, GUEST, [ADA, BO, GUEST, LINE]);
    expect(answer).toMatchObject({ status: "ready", slug: "context-lc", minted: true, guestTagger: expect.stringMatching(/^guest-[0-9a-f]{4}$/) });
    expect(answer.accessToken).toEqual(expect.any(String));
    const grant = await grantOf(w.t);
    expect(grant).toMatchObject({ workspaceId: w.pinned, texGroup: { homeOnly: true, guestPhone: GUEST } });
  });

  test("a chat whose people share a workspace but include a guest is not a shared chat: it is answered from the home", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    expect(answer).toMatchObject({ status: "ready", slug: "context-lc", minted: true });
    expect(await grantOf(w.t)).toMatchObject({ workspaceId: w.pinned, texGroup: { homeOnly: true, taggerId: w.ada } });
  });

  test("with no pin on this deployment there is no home, so no grant is minted", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.pinned, { slug: "not-the-pin" });
    });
    const answer = await turn(w.t, GUEST, [ADA, BO, GUEST, LINE]);
    expect(answer.status).not.toBe("ready");
    expect(await grantOf(w.t)).toBeNull();
  });
});

describe("what a home-only grant reads", () => {
  test("its own home, and nothing else of the pin: the rules it reads by open the home and close every other note", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    const session = await resolves(w.t, answer.accessToken as string);
    expect(session?.workspaces).toHaveLength(1);
    const [row] = session!.workspaces;
    const { folder, token } = await homeOf(w);
    expect(row).toMatchObject({ workspaceId: String(w.pinned), role: "editor", chatHome: folder });
    expect(row!.setupOnly).toBeUndefined();
    // READS_AS_CHAT, and the home's token to change it: never the names an account or a member holds.
    expect(row!.grantedNames).toEqual(expect.arrayContaining(["#reads-as-chat", `#${token}`, `#${token}!edit`]));
    expect(row!.grantedNames).not.toContain("#reads-as-guest");
    const held = await rulesFor(w, row!.grantedNames!);
    const ruleAt = (prefix: string) => held.folders.find((rule) => rule.prefix === prefix)?.visibility;
    expect(ruleAt(folder)).toBe("team");
    expect(reads(held, row!.grantedNames!, `${folder}/chat-note.md`)).toBe(true);
    // Every other note in the pin is closed to it, whatever its base: a team note, a members' note, a private one.
    for (const path of [GUIDE, PLAN, BENCH, OLD_BUG, SECRET, "guides/bug-reports.md", "index.md"]) {
      expect(reads(held, row!.grantedNames!, path), path).toBe(false);
    }
    expect(held.readOnly?.folders ?? []).not.toContain("guides");
  });

  test("another chat's home is closed to it", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    const other = await w.t.run(async (ctx) => {
      const chat = await ctx.db.insert("textGroups", { groupKey: SAYO_HOME_OTHER, lastSeenAt: 1 });
      return await ensureChatHome(ctx as unknown as MutationCtx, (await ctx.db.get(chat))!, [w.sayo], w.sayo);
    });
    expect(other).toMatch(/^tex\/groups\//);
    const session = await resolves(w.t, answer.accessToken as string);
    const held = await rulesFor(w, session!.workspaces[0]!.grantedNames!);
    expect(held.folders.find((rule) => rule.prefix === other)?.visibility).toBe("private");
  });

  test("no other workspace: neither the chat's people's own workspaces nor the one they share", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    const session = await resolves(w.t, answer.accessToken as string);
    const slugs = session!.workspaces.map((entry) => entry.slug);
    expect(slugs).toEqual(["context-lc"]);
    expect(session!.workspaces.map((entry) => entry.workspaceId)).not.toContain(String(w.studio));
  });

  test("it is not an ordinary pin reader: under any other client the grant resolves to nothing", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    // Presented as the MCP client the pin's readers use, the same grant must not read the pin as a guest does.
    await w.t.run(async (ctx) => {
      const row = (await ctx.db.query("oauthGrants").collect()).find((entry) => entry.texGroup !== undefined);
      await ctx.db.patch(row!._id, { clientId: "mcp_client_pinned" });
    });
    expect(await resolves(w.t, answer.accessToken as string)).toBeNull();
  });

});

describe("a home-only grant lives only as long as the chat may", () => {
  test("a muted chat ends it", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    expect(await resolves(w.t, answer.accessToken as string)).not.toBeNull();
    await turn(w.t, ADA, [ADA, BO, GUEST, LINE], { command: { kind: "stop" } });
    expect(await resolves(w.t, answer.accessToken as string)).toBeNull();
  });

  test("the sponsor who pays for it stops texting, and it ends", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    const sponsor = (await chatRow(w.t))!.sponsorId!;
    expect(sponsor).toBeDefined();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("phoneSignInPauses", { userId: sponsor, pausedAt: Date.now() } as never);
    });
    expect(await resolves(w.t, answer.accessToken as string)).toBeNull();
  });

  test("a grant held by anyone but the chat's sponsor resolves to nothing", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    const sponsor = (await chatRow(w.t))!.sponsorId!;
    const other = sponsor === w.ada ? w.bo : w.ada;
    await w.t.run(async (ctx) => {
      const row = (await ctx.db.query("oauthGrants").collect()).find((entry) => entry.texGroup !== undefined);
      await ctx.db.patch(row!._id, { userId: other });
    });
    expect(await resolves(w.t, answer.accessToken as string)).toBeNull();
  });

  test("the sponsor is set once: a later tagger does not take over the grant", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    const first = (await chatRow(w.t))!.sponsorId;
    await turn(w.t, BO, [ADA, BO, GUEST, LINE]);
    expect((await chatRow(w.t))!.sponsorId).toBe(first);
  });
});

describe("usage is recorded against the person who tagged Tex", () => {
  test("a guest tagger is recorded by number, and an account holder as themselves", async () => {
    const w = await world();
    await turn(w.t, GUEST, [ADA, BO, GUEST, LINE]);
    const guest = await grantOf(w.t);
    expect(usageWho(guest!)).toBe(`phone:${GUEST}`);
    await turn(w.t, BO, [ADA, BO, GUEST, LINE]);
    const bo = await grantOf(w.t);
    expect(usageWho(bo!)).toBe(`user:${w.bo}`);
  });

  test("a grant with no texGroup marks is never recorded as a guest", () => {
    expect(usageWho({ userId: "u1" as Id<"users"> })).toMatch(/^user:/);
  });
});
