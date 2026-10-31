import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { due, makeDue, rowAt, runPendingScans } from "./routines.helpers";
import { nodeAt } from "../functions/lib/nodes/paths";

/**
 * A GROUP CHAT'S ROUTINES LIVE IN ITS HOME (decided by the owner, 2026-10-31;
 * docs/decisions/texting-assistant/chat-homes.md, `functions/lib/routines/homes.ts`).
 *
 * `tex/groups/<words>/routines/<how-often>/<name>.md` in the pin runs into the home's chat, as the person in the chat
 * who wrote it, with no grant of its own; the chat's own turn mints one. The pin's roles write none, run none and see
 * none, and somebody who leaves the chat stops being its writer.
 *
 * ## Sabotage record
 *
 *   `writesRoutine` asking the pin's role for a home path → "runs into the home's chat" fails (no writer)
 *   `writesHomeRoutine` true for anyone in a chat with a home → "nobody outside the chat is its writer" fails
 *   commit keeping the file's own `chat:` → "the home names the chat" fails
 *   handout not asking `writesRoutine` for a home path → "somebody who leaves the chat stops it" fails
 *   the scan listing homes at the owner's clearance → "runs into the home's chat" fails: the seal shuts owners out
 *   `routineForNote` without the home check → "the pin's pages show none" fails
 */

vi.setConfig({ testTimeout: 90_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";

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

async function chatRow(t: T) {
  return (await t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0] ?? null))!;
}

/** The pin, Ada and Bo linked, and their chat with its home. */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await texter(w.t, "ada", ADA);
  const bo = await texter(w.t, "bo", BO);
  // A workspace they share, so the chat's turn opens a session, which is what makes its home.
  const studio = await createWorkspace(w.t, bo, "studio", { kind: "shared" });
  await addMember(w.t, studio, ada, "editor");
  await turn(w.t, ADA, [ADA, BO, LINE]);
  const chat = await chatRow(w.t);
  const folder = `tex/groups/${chat.homeWords}`;
  const noteId = await w.t.run(async (ctx) => (await nodeAt(ctx.db, w.pinned, folder))!.noteId!);
  return { ...w, ada, bo, chat, folder, noteId, path: `${folder}/routines/daily/standup.md` };
}

type World = Awaited<ReturnType<typeof world>>;

/** A routine written in the home, as the chat's own turn writes it, then signalled by `writer`. */
async function writeRoutine(w: World, writer: Id<"users">, text = "---\nat: 8:00 am\n---\nPost what is on today.\n", path = w.path) {
  await w.t.action(internal.functions.files.runFileOperation, {
    workspaceId: w.pinned,
    scope: "team",
    grantedNames: [`#${w.noteId}`, `#${w.noteId}!edit`],
    operation: { kind: "write", path, text },
  });
  // The write's own fact passes first: their props landing asks for a scan, which `runPendingScans` runs at once.
  for (let pass = 0; pass < 4; pass += 1) {
    await w.t.action(internal.functions.files.runFileOperation, { workspaceId: w.pinned, scope: "private", operation: { kind: "nodesFactFill" } });
  }
  await runPendingScans(w.t);
  await gatewayPost(w.t, "/gateway/routines", { workspaceId: w.pinned, userId: writer, paths: [path] });
  await runPendingScans(w.t);
}

describe("a chat's routines in its home", () => {
  test("runs into the home's chat, as the person in it who wrote it, with no grant of its own", async () => {
    const w = await world();
    await writeRoutine(w, w.ada);
    const row = await rowAt(w.t, w.pinned, w.path);
    expect(row).toMatchObject({ chat: w.chat.groupKey.slice(0, 16), writerUserId: w.ada });
    await makeDue(w.t, w.pinned, w.path);
    const runs = await due(w.t);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ path: w.path, phones: [ADA], chat: w.chat.groupKey });
    expect(runs[0]!.accessToken).toBeUndefined();
  });

  test("the home names the chat, whatever the file's chat: line says", async () => {
    const w = await world();
    await writeRoutine(w, w.bo, `---\nat: 8:00 am\nchat: ${"cd".repeat(8)}\n---\nPost what is on today.\n`);
    expect((await rowAt(w.t, w.pinned, w.path))?.chat).toBe(w.chat.groupKey.slice(0, 16));
  });

  test("nobody outside the chat is its writer, the pin's owner included", async () => {
    for (const who of ["staff", "sayo"] as const) {
      const w = await world();
      await writeRoutine(w, w[who]);
      expect(await rowAt(w.t, w.pinned, w.path)).toBeNull();
    }
  });

  test("somebody who leaves the chat stops it, and a muted chat hears nothing", async () => {
    const w = await world();
    await writeRoutine(w, w.ada);
    await turn(w.t, BO, [BO, LINE]);
    await makeDue(w.t, w.pinned, w.path);
    expect(await due(w.t)).toEqual([]);
    expect((await rowAt(w.t, w.pinned, w.path))?.lastOutcome).toBe("writer_gone");

    const m = await world();
    await writeRoutine(m, m.ada);
    await m.t.run((ctx) => ctx.db.patch(m.chat._id, { mutedAt: Date.now() }));
    await makeDue(m.t, m.pinned, m.path);
    expect(await due(m.t)).toEqual([]);
    expect((await rowAt(m.t, m.pinned, m.path))?.lastOutcome).toBe("no_chat");
  });

  test("the pin's pages show none, and its owner can't run one", async () => {
    const w = await world();
    await writeRoutine(w, w.ada);
    expect(await rowAt(w.t, w.pinned, w.path)).not.toBeNull();
    expect(await asUser(w.t, w.staff).query(api.functions.routines.routineForNote, { workspaceId: w.pinned, path: w.path })).toBeNull();
    expect(await asUser(w.t, w.staff).mutation(api.functions.routines.runRoutineNow, { workspaceId: w.pinned, path: w.path })).toBe(false);
  });
});
