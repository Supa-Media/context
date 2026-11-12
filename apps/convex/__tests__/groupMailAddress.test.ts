/**
 * A group chat's own address, `group-<words>@context.lc` (decided by the owner, 2026-11-08;
 * `functions/lib/groupMailIngest.ts`): it resolves to the chat's sealed home, opens only its `email/` folder, wakes
 * the chat's look, and every no is the same answer as an unknown username. The `group-` prefix is never a handle.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser, createUser, createWorkspace, ingestPost } from "./fixtures.helpers";
import { migrate, pinnedWorld } from "./pinnedReaders.helpers";
import { validateName } from "../functions/lib/names";
import { groupMailWords } from "../functions/lib/groupMailAddress";
import { claimChatLooks } from "../functions/lib/textGroupLooks";
import { nodeAt } from "../functions/lib/nodes/paths";

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

type W = Awaited<ReturnType<typeof pinnedWorld>>;
type T = W["t"];

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

/** The pinned world with a chat of Ada and Bo whose home is made, and its words. */
async function chatWithHome() {
  const w = await pinnedWorld();
  await migrate(w);
  await texter(w.t, "ada", ADA);
  await texter(w.t, "bo", BO);
  await agentPost(w.t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, BO, LINE], mint: true });
  const chat = await w.t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0]!);
  expect(chat.homeWords).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  return { w, chat, words: chat.homeWords! };
}

async function resolve(t: T, name: string) {
  const response = await ingestPost(t, "/gateway/ingest/resolve", { username: name, sizeBytes: 4096, envelopeFrom: "list@example.test" });
  return { status: response.status, text: await response.text() };
}

describe("a group chat's address", () => {
  test("reserves every name shaped like a group's address, and only those", () => {
    expect(validateName("group-chair-blast-tiger")).toMatchObject({ ok: false, reason: "reserved" });
    expect(validateName("group-ocean-river-wolf")).toMatchObject({ ok: false, reason: "reserved" });
    // Names that merely start with the word stay free: workspaces already hold some.
    expect(validateName("group-home")).toMatchObject({ ok: true });
    expect(validateName("groupie")).toMatchObject({ ok: true });
    expect(groupMailWords("group-chair-blast-tiger")).toBe("chair-blast-tiger");
    expect(groupMailWords("group-chair-chair-tiger")).toBeNull();
    expect(groupMailWords("group-chair-blast-notaword")).toBeNull();
  });

  test("resolves to the chat's home, with a ticket that opens only its email folder", async () => {
    const { w, chat, words } = await chatWithHome();
    const answer = await resolve(w.t, `group-${words}`);
    const body = JSON.parse(answer.text) as { ingestion: Record<string, unknown> & { ticket: string; policy: { allowAnySender: boolean } } };
    expect(body.ingestion).toMatchObject({ context: { kind: "group", path: `group-${words}` }, targetFolder: `tex/groups/${words}/` });
    expect(body.ingestion.policy.allowAnySender).toBe(true);
    const ticket = await w.t.run(async (ctx) => (await ctx.db.query("ingestionTickets").collect())[0]!);
    expect(ticket.workspaceId).toBe(w.pinned);
    expect(ticket.targetFolder).toBe(`tex/groups/${words}/email/`);
    expect(ticket.chatId).toBe(chat._id);

    // Spent for its credential, the ticket's id routes take its email folder and nothing else in the home.
    expect((await ingestPost(w.t, "/gateway/ingest/binding", { ticket: body.ingestion.ticket })).status).toBe(200);
    const inside = await ingestPost(w.t, "/gateway/ingest/note-ids/lookup", { ticket: body.ingestion.ticket, paths: [`tex/groups/${words}/email/abc.md`] });
    expect(JSON.parse(await inside.text())).not.toEqual({ served: false });
    for (const path of [`tex/groups/${words}/about.md`, `tex/groups/${words}/routines/daily/x.md`, "index.md"]) {
      const outside = await ingestPost(w.t, "/gateway/ingest/note-ids/lookup", { ticket: body.ingestion.ticket, paths: [path] });
      expect(JSON.parse(await outside.text())).toEqual({ served: false });
    }
  });

  test("an unknown group, a chat with no home, and an unknown username are one answer", async () => {
    const { w, words } = await chatWithHome();
    const other = words === "ocean-river-wolf" ? "ocean-river-tiger" : "ocean-river-wolf";
    const unknownGroup = await resolve(w.t, `group-${other}`);
    const malformed = await resolve(w.t, "group-not-a-chat");
    const unknownName = await resolve(w.t, "nobody-here");
    expect(unknownGroup).toEqual(unknownName);
    expect(malformed).toEqual(unknownName);
    expect(JSON.parse(unknownName.text)).toEqual({ ingestion: null });
  });

  test("a capture marks the chat and brings its look forward", async () => {
    const { w, chat, words } = await chatWithHome();
    const body = JSON.parse((await resolve(w.t, `group-${words}`)).text) as { ingestion: { ticket: string } };
    await ingestPost(w.t, "/gateway/ingest/binding", { ticket: body.ingestion.ticket });
    const before = Date.now();
    expect((await ingestPost(w.t, "/gateway/ingest/record", { ticket: body.ingestion.ticket, outcome: "captured", bytes: 10 })).status).toBe(200);
    const after = await w.t.run(async (ctx) => await ctx.db.get(chat._id));
    expect(after?.mailAt).toBeGreaterThanOrEqual(before);
    expect(after?.nextLookAt).toBeGreaterThan(before);
    expect(after!.nextLookAt! - before).toBeLessThan(10 * 60_000);
  });

  test("a chat that reaches no workspace looks in its home, for mail at its address too", async () => {
    const { w, chat, words } = await chatWithHome();
    const due = Date.now() + 10 * 60_000;
    // A quiet chat looks only when there is mail to look at (`claimChatLooks` `listening`): before any, nothing goes.
    await w.t.run(async (ctx) => ctx.db.patch(chat._id, { nextLookAt: Date.now() - 1, speaksUp: "quiet" }));
    expect(await w.t.run(async (ctx) => claimChatLooks(ctx, ["run-0"], Date.now()))).toEqual([]);
    const body = JSON.parse((await resolve(w.t, `group-${words}`)).text) as { ingestion: { ticket: string } };
    await ingestPost(w.t, "/gateway/ingest/binding", { ticket: body.ingestion.ticket });
    await ingestPost(w.t, "/gateway/ingest/record", { ticket: body.ingestion.ticket, outcome: "captured", bytes: 10 });
    const looks = await w.t.run(async (ctx) => claimChatLooks(ctx, ["run-1"], due));
    expect(looks).toHaveLength(1);
    expect(looks[0]).toMatchObject({ runId: "run-1", chat: chat.groupKey, path: "(check-in)" });
    // Looked at once: the mail is seen, and the next claim has nothing new.
    await w.t.run(async (ctx) => ctx.db.patch(chat._id, { nextLookAt: due, lookClaimedAt: undefined }));
    expect(await w.t.run(async (ctx) => claimChatLooks(ctx, ["run-2"], due + 1))).toEqual([]);
  });

  test("a chat that reaches no workspace checks in like any chat: armed by a turn, handed out as its check-in (the owner, 2026-11-12)", async () => {
    const { w, chat } = await chatWithHome();
    // The first tag made the home; the next arms the look (and the daily arming catches a chat with no next tag).
    await agentPost(w.t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: BO, participants: [ADA, BO, LINE], mint: true });
    const armed = await w.t.run(async (ctx) => await ctx.db.get(chat._id));
    expect(armed?.nextLookAt).toBeGreaterThan(Date.now());
    const looks = await w.t.run(async (ctx) => claimChatLooks(ctx, ["run-3"], armed!.nextLookAt! + 1));
    expect(looks).toHaveLength(1);
    expect(looks[0]).toMatchObject({ runId: "run-3", chat: chat.groupKey, path: "(check-in)", phones: [ADA] });
  });

  test("a capture's note is adopted in the home's email folder, where the home's rule reaches it", async () => {
    const { w, words } = await chatWithHome();
    await w.t.run(async (ctx) => {
      const layout = await ctx.db.query("noteIdLayout").first();
      const fields = { mode: "keys" as const, updatedAt: 1 };
      if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, ...fields });
      else await ctx.db.patch(layout._id, fields);
      await ctx.db.insert("noteIdCopies", { workspaceId: w.pinned, status: "done", runId: 1, files: 0, copied: 0, failed: 0, failures: [], updatedAt: 1, keyedAt: 1 });
    });
    const body = JSON.parse((await resolve(w.t, `group-${words}`)).text) as { ingestion: { ticket: string } };
    await ingestPost(w.t, "/gateway/ingest/binding", { ticket: body.ingestion.ticket });
    const path = `tex/groups/${words}/email/0123456789abcdef01234567.md`;
    const note = "0190c0de-0000-7000-8000-00000000c001";
    const adopted = await ingestPost(w.t, "/gateway/ingest/note-ids/adopt", { ticket: body.ingestion.ticket, path, noteId: note, key: `notes/${note}.md`, etag: "e1", size: 10, at: 1_000 });
    expect(JSON.parse(await adopted.text())).toEqual({ ok: true, adopted: true, taken: null });
    const row = await w.t.run(async (ctx) => await nodeAt(ctx.db, w.pinned, path));
    expect(row?.noteId).toBe(note);
    // Its nearest setting is the home's, which names only the chat's people.
    const home = await w.t.run(async (ctx) => await nodeAt(ctx.db, w.pinned, `tex/groups/${words}`));
    expect(home?.kind).toBe("folder");
  });
});
