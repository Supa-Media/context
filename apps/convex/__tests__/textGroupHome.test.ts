import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { MEL_TOKEN, migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { nodeAt } from "../functions/lib/nodes/paths";
import { setAccessRow } from "../functions/lib/nodes/setAccess";
import { ensureChatHome, HOME_FOLDERS } from "../functions/lib/textGroupHome";
import { PERSON_ONLY_TEX_PARTS, TEX_PARTS } from "@context/shared/src/folderJobInfo.cjs";
import { grantedNamesFor } from "../functions/lib/grantedNames";
import { checkReachRow } from "../../mcp/src/workspaceStore/access.js";

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
 *   `withSameNumber` dropped from `makeChatHome` → "a person's other account that holds their number" fails
 *   an unconfirmed sign-in phone counted → the same case fails (the claimer is named)
 *   `rowNames` left off the person object's reach row → "a member of the pin named on a home holds its names" fails
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

/** Every folder a person's Tex has (`HOME_FOLDERS`), written out so a dropped name fails here. */
const PERSON_TEX_FOLDERS = ["skills", "routines", "heartbeat", "attention", "dreams", "handbacks", "housekeeping", "pictures"];

describe("a chat's home", () => {
  test("holds every folder a person's Tex has but the person-only ones, from one list", () => {
    // A folder added to a person's Tex reaches every home unless it is named person-only: the two never drift.
    expect([...PERSON_ONLY_TEX_PARTS].sort()).toEqual(["chats", "groups", "transcripts"]);
    expect([...HOME_FOLDERS].sort()).toEqual([...PERSON_TEX_FOLDERS].sort());
    expect([...HOME_FOLDERS, ...PERSON_ONLY_TEX_PARTS].sort()).toEqual([...TEX_PARTS].sort());
  });

  test("the first turn makes the home, three words under the homes folder, naming everyone in the chat to edit", async () => {
    const w = await world();
    expect(await turn(w.t, ADA, [ADA, BO, CY, LINE])).toMatchObject({ status: "ready", slug: "context-lc", reach: ["studio"], minted: true });
    const chat = await chatRow(w.t);
    expect(chat?.homeWords).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    const folder = `tex/groups/${chat!.homeWords}`;
    const home = await homeRow(w, folder);
    expect(home?.row.kind).toBe("folder");
    expect(home?.people).toEqual(sorted([w.ada, w.bo, w.cy]));
    // It holds a person's Tex folders from the start, under its own row.
    for (const inner of PERSON_TEX_FOLDERS) expect((await homeRow(w, `${folder}/${inner}`))?.row.kind).toBe("folder");
    // The same chat keeps its home: no second folder, no new words.
    await turn(w.t, BO, [ADA, BO, CY, LINE]);
    expect((await chatRow(w.t))?.homeWords).toBe(chat!.homeWords);
  });

  test("a home made before it held its folders gets them on the chat's next turn", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    const folder = `tex/groups/${(await chatRow(w.t))!.homeWords}`;
    // As every home made before 2026-11-02 stands: the folder alone.
    await w.t.run(async (ctx) => {
      for (const inner of ["skills", "routines"]) {
        const row = await nodeAt(ctx.db, w.pinned, `${folder}/${inner}`);
        if (row !== null) await ctx.db.delete(row._id);
      }
    });
    expect(await homeRow(w, `${folder}/skills`)).toBeNull();
    await turn(w.t, BO, [ADA, BO, CY, LINE]);
    for (const inner of PERSON_TEX_FOLDERS) expect((await homeRow(w, `${folder}/${inner}`))?.row.kind).toBe("folder");
    expect((await homeRow(w, folder))?.people).toEqual(sorted([w.ada, w.bo, w.cy]));
  });

  test("a person's other account that holds their number is named too; one that only claims it is not", async () => {
    const w = await world();
    // Ada signs in to the app with a second account, confirmed on her number; another claims her number unconfirmed.
    const adaApp = await createUser(w.t, "ada-app@example.invalid");
    const claimer = await createUser(w.t, "claimer@example.invalid");
    const stranger = await createUser(w.t, "stranger@example.invalid");
    await w.t.run(async (ctx) => {
      await ctx.db.patch(adaApp, { phone: ADA, phoneVerificationTime: Date.now() });
      await ctx.db.patch(claimer, { phone: ADA });
      await ctx.db.patch(stranger, { phone: "+15555550199", phoneVerificationTime: Date.now() });
    });
    await turn(w.t, BO, [ADA, BO, CY, LINE]);
    const chat = await chatRow(w.t);
    const home = await homeRow(w, `tex/groups/${chat!.homeWords}`);
    expect(home?.people).toEqual(sorted([w.ada, adaApp, w.bo, w.cy]));
    expect([...(chat?.homeUsers ?? [])].sort()).toEqual([w.ada, adaApp, w.bo, w.cy].sort());
  });

  test("homes made before are named again by the workflow, dry run first, without waiting for a text", async () => {
    const w = await world();
    await turn(w.t, BO, [ADA, BO, CY, LINE]);
    const adaApp = await createUser(w.t, "ada-app@example.invalid");
    await w.t.run(async (ctx) => ctx.db.patch(adaApp, { phone: ADA, phoneVerificationTime: Date.now() }));
    const folder = `tex/groups/${(await chatRow(w.t))!.homeWords}`;
    expect(await w.t.action(internal.functions.texChatHomePeople.nameAgain, { dryRun: true })).toEqual({ dryRun: true, homes: 1, widened: 1, added: 1, unstood: 0, refused: 0 });
    expect((await homeRow(w, folder))?.people).toEqual(sorted([w.ada, w.bo, w.cy]));
    expect(await w.t.action(internal.functions.texChatHomePeople.nameAgain, { dryRun: false })).toEqual({ dryRun: false, homes: 1, widened: 1, added: 1, unstood: 0, refused: 0 });
    expect((await homeRow(w, folder))?.people).toEqual(sorted([w.ada, adaApp, w.bo, w.cy]));
    expect(await w.t.action(internal.functions.texChatHomePeople.nameAgain, { dryRun: true })).toMatchObject({ widened: 0 });
  });

  test("a quiet chat's home missing folders gets them from the workflow, dry run first", async () => {
    const w = await world();
    await turn(w.t, BO, [ADA, BO, CY, LINE]);
    const folder = `tex/groups/${(await chatRow(w.t))!.homeWords}`;
    // As every home made before 2026-11-02's full set stands: skills and routines alone.
    await w.t.run(async (ctx) => {
      for (const inner of PERSON_TEX_FOLDERS.filter((name) => name !== "skills" && name !== "routines")) {
        const row = await nodeAt(ctx.db, w.pinned, `${folder}/${inner}`);
        if (row !== null) await ctx.db.delete(row._id);
      }
    });
    expect(await w.t.action(internal.functions.texChatHomePeople.nameAgain, { dryRun: true })).toEqual({ dryRun: true, homes: 1, widened: 0, added: 0, unstood: 1, refused: 0 });
    expect(await homeRow(w, `${folder}/dreams`)).toBeNull();
    expect(await w.t.action(internal.functions.texChatHomePeople.nameAgain, { dryRun: false })).toMatchObject({ unstood: 1, refused: 0 });
    for (const inner of PERSON_TEX_FOLDERS) expect((await homeRow(w, `${folder}/${inner}`))?.row.kind).toBe("folder");
    // The home's people are unchanged, and a second pass finds nothing to do.
    expect((await homeRow(w, folder))?.people).toEqual(sorted([w.ada, w.bo, w.cy]));
    expect(await w.t.action(internal.functions.texChatHomePeople.nameAgain, { dryRun: true })).toMatchObject({ unstood: 0, widened: 0 });
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

  test("a member of the pin named on a home holds its names in the reach row the person object keeps, as the app's session gives them", async () => {
    const w = await world();
    // Ada is also a member of the pin, as the people who run it are: her session there is her membership's.
    await addMember(w.t, w.pinned, w.ada, "member", w.staff);
    await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    const folder = `tex/groups/${(await chatRow(w.t))!.homeWords}`;
    const noteId = (await homeRow(w, folder))!.row.noteId;
    // What the control plane's own session gives the app's client in the pin (`grantedNamesFor`).
    const convexNames = await w.t.run(async (ctx) => await grantedNamesFor(ctx, w.pinned, w.ada));
    expect(convexNames).toEqual(expect.arrayContaining([`#${noteId}`, `#${noteId}!edit`]));
    // The person object's copy of the same (2026-11-02: it had only the groups, so the app opened no home).
    const person = await w.t.query(internal.functions.accessObjectsExpected.person, { userId: w.ada, now: 1 });
    const pinRow = (person.reach.rows as { workspaceId: string; rowNames?: string[] }[]).find((row) => row.workspaceId === String(w.pinned));
    expect(pinRow?.rowNames).toEqual(convexNames.filter((name) => name.startsWith("#")).sort());
    expect(() => checkReachRow(pinRow)).not.toThrow();
    // Bo is not a member of the pin: his reach of it is the pin reader's, and carries no names of his.
    const bo = await w.t.query(internal.functions.accessObjectsExpected.person, { userId: w.bo, now: 1 });
    const boPin = (bo.reach.rows as { workspaceId: string; rowNames?: string[]; pinned?: boolean }[]).find((row) => row.workspaceId === String(w.pinned));
    expect(boPin?.pinned).toBe(true);
    expect(boPin?.rowNames).toBeUndefined();
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

describe("where a chat's home is, asked by the gateway", () => {
  /** `POST /gateway/tex/chat-home` as mel's AI client, a member of the pinned workspace. */
  const ask = async (w: PinnedWorld, body: Record<string, unknown>) => (await (await gatewayPost(w.t, "/gateway/tex/chat-home", { accessToken: MEL_TOKEN, ...body })).json()) as { home: boolean };

  test("a chat with a home answers yes only in the pinned workspace, for a token that reads it", async () => {
    const w = await world();
    await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    const chat = (await chatRow(w.t))!;
    expect(chat.homeWords).toBeTruthy();
    expect(await ask(w, { workspaceId: w.pinned, chat: chat.groupKey })).toEqual({ home: true });
    // Not its home: a workspace that holds no homes, even one the token reads.
    const melOwn = await w.t.run(async (ctx) => (await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", "mel")).unique())!._id);
    expect(await ask(w, { workspaceId: melOwn, chat: chat.groupKey })).toEqual({ home: false });
    // A workspace the token does not read, a chat that does not exist, a malformed key and a stranger's token: no.
    expect(await ask(w, { workspaceId: w.studio, chat: chat.groupKey })).toEqual({ home: false });
    expect(await ask(w, { workspaceId: w.pinned, chat: "e".repeat(64) })).toEqual({ home: false });
    expect(await ask(w, { workspaceId: w.pinned, chat: "../x" })).toEqual({ home: false });
    expect(await ask(w, { workspaceId: w.pinned, chat: chat.groupKey, accessToken: "cat_nobody_000000000000000000" })).toEqual({ home: false });
    // Without the gateway's secret the route is closed.
    expect((await gatewayPost(w.t, "/gateway/tex/chat-home", { accessToken: MEL_TOKEN, workspaceId: w.pinned, chat: chat.groupKey }, { secret: null })).status).toBe(401);
  });
});

