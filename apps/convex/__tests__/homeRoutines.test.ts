import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { chainAt, standFolders } from "../functions/lib/nodes/rowMove";
import { setAccessRow } from "../functions/lib/nodes/setAccess";
import { CHAT_HOMES_CLIENT_ID } from "../functions/lib/nodes/sealedChats";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { nodeAt } from "../functions/lib/nodes/paths";
import { READS_AS_CHAT_NAME } from "../functions/lib/nodes/chatFolders";
import { due, makeDue, rowAt, runPendingScans } from "./routines.helpers";

/**
 * A GROUP CHAT'S ROUTINES LIVE IN ITS HOME (the owner, 2026-11-02; `functions/lib/routines/homes.ts`,
 * docs/decisions/texting-assistant/chat-routines.md).
 *
 * A routine at `tex/groups/<words>/routines/<how-often>/<name>.md` in the pin is found by the scan, which the seal
 * would otherwise answer with nothing; it answers into the home's own chat whatever its `chat:` says; its writer is
 * one of the chat's people, never a role in the pin; and its run is a chat routine's, with no grant of its own.
 *
 * ## Sabotage record
 *
 *   `homeRoutineFiles` answering nothing → "runs into its own chat" fails
 *   `homeScheduleFromNote` keeping the note's `chat:` → "answers into its home's chat" fails
 *   `mayWriteRoutine` asking `writingRole` for a home → "runs into its own chat" fails (no chat person has a pin role)
 *   `homeRoutineChat` without the people check → "a writer who left the chat runs nothing" fails
 *   `homeRoutineChat` without the muted check → "a muted chat's routine runs nothing" fails
 */

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
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

const KEY = "ab".repeat(32);
const WORDS = "orbit-lamp-river";

/** Ada, Bo and Cy in one chat with a home, made as the chat homes' client makes it, and Dee, who is not in it. */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await texter(w.t, "ada", ADA);
  const bo = await texter(w.t, "bo", BO);
  const cy = await texter(w.t, "cy", CY);
  const dee = await texter(w.t, "dee", "+15555550133");
  const folder = `tex/groups/${WORDS}`;
  const people = [ada, bo, cy];
  await w.t.run(async (ctx) => {
    const m = ctx as unknown as MutationCtx;
    await standFolders(m, w.pinned, await chainAt(ctx.db, w.pinned, `${folder}/routines/-`), Date.now());
    const answer = await setAccessRow(m, {
      workspaceId: w.pinned,
      path: folder,
      base: "private",
      grantees: people.map((userId) => ({ kind: "user" as const, userId, role: "edit" as const })),
      kind: "folder",
      actor: { userId: w.staff, role: "owner", clientId: CHAT_HOMES_CLIENT_ID },
    });
    if (!answer.ok) throw new Error(`home refused: ${answer.code}`);
  });
  const home = (await w.t.run(async (ctx) => await nodeAt(ctx.db, w.pinned, folder)))!;
  return { ...w, ada, bo, cy, dee, people, folder, token: `#${home.noteId}`, chat: null as unknown as Doc<"textGroups"> };
}

type World = Awaited<ReturnType<typeof world>>;

const text = (chat: string | null = null) => `---\nat: 9:30 am\n${chat ? `chat: ${chat}\n` : ""}---\nPost who is on shift today.\n`;

/** The routine written in the home as the chat's own turn writes there, and the gateway's signal for it. */
async function homeRoutine(w: World, by: Id<"users">, content = text(), name = "shifts") {
  const path = `${w.folder}/routines/daily/${name}.md`;
  const written = await w.t.action(internal.functions.files.runFileOperation, {
    workspaceId: w.pinned,
    scope: "team",
    grantedNames: [READS_AS_CHAT_NAME, w.token, `${w.token}!edit`],
    operation: { kind: "write", path, text: content },
  });
  expect(written.kind).not.toBe("error");
  // The chat that owns the home, filed after its note: in production its notes are kept in the chat's own object,
  // which a test's file operation does not reach (`apps/mcp/src/store/idLayout.js`).
  const chatId = await w.t.run(async (ctx) => await ctx.db.insert("textGroups", { groupKey: KEY, lastSeenAt: Date.now(), homeWords: WORDS, homeUsers: w.people }));
  w.chat = (await w.t.run(async (ctx) => await ctx.db.get(chatId)))!;
  // Its front matter read into the tree's facts first, as the write's own fill does, so the scan below finds it current
  // (a fill that lands inside the scan asks for another scan, `nodeFacts.record`).
  for (let pass = 0; pass < 4; pass += 1) {
    await w.t.action(internal.functions.files.runFileOperation, { workspaceId: w.pinned, scope: "private", operation: { kind: "nodesFactFill" } });
  }
  await gatewayPost(w.t, "/gateway/routines", { workspaceId: w.pinned, userId: by, paths: [path] });
  await runPendingScans(w.t);
  return path;
}

describe("a chat's routine in its home", () => {
  test("runs into its own chat as its writer, with no grant of its own", async () => {
    const w = await world();
    const path = await homeRoutine(w, w.ada);
    const row = await rowAt(w.t, w.pinned, path);
    // Its time read from its front matter through the seal, not a default.
    expect(row).toMatchObject({ chat: w.chat.groupKey.slice(0, 16), writerUserId: w.ada, at: { hour: 9, minute: 30 } });
    expect(row?.nextRunAt).toBeGreaterThan(Date.now());
    await makeDue(w.t, w.pinned, path);
    const runs = await due(w.t);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ path, phones: [ADA], chat: w.chat.groupKey });
    expect(runs[0]!.accessToken).toBeUndefined();
  });

  test("answers into its home's chat, whatever its chat: line names", async () => {
    const w = await world();
    const path = await homeRoutine(w, w.ada, text("0123456789abcdef"));
    expect((await rowAt(w.t, w.pinned, path))?.chat).toBe(w.chat.groupKey.slice(0, 16));
  });

  test("is one of the chat's people's, never somebody else's", async () => {
    const w = await world();
    // Dee writes nothing there (the seal), but a signal naming her must not make her its writer.
    const path = await homeRoutine(w, w.dee);
    const row = await rowAt(w.t, w.pinned, path);
    expect(row === null || row.nextRunAt === null).toBe(true);
    expect(row?.writerUserId).not.toBe(w.dee);
    if (row !== null) {
      await w.t.run((ctx) => ctx.db.patch(row._id, { nextRunAt: Date.now() - 1000 }));
      expect(await due(w.t)).toEqual([]);
    }
  });

  test("a writer who left the chat runs nothing", async () => {
    const w = await world();
    const path = await homeRoutine(w, w.cy);
    // Cy leaves: the chat's next turn takes them off the home (`textGroupHome.ts`).
    await w.t.run((ctx) => ctx.db.patch(w.chat._id, { homeUsers: [w.ada, w.bo] }));
    await makeDue(w.t, w.pinned, path);
    expect(await due(w.t)).toEqual([]);
  });

  test("a muted chat's routine runs nothing", async () => {
    const w = await world();
    const path = await homeRoutine(w, w.ada);
    await w.t.run((ctx) => ctx.db.patch(w.chat._id, { mutedAt: Date.now() }));
    await makeDue(w.t, w.pinned, path);
    expect(await due(w.t)).toEqual([]);
    expect((await rowAt(w.t, w.pinned, path))?.lastOutcome).toBe("no_chat");
  });
});
