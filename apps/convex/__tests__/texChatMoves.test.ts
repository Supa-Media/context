import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { MOVE_CLAIM_MS, MOVES_PER_CLAIM } from "../functions/texChatMoves";
import { ADMIN, tester, user } from "./noteIds/noteIds.helpers";
import { withSession } from "./session.helpers";

/**
 * MOVING CHATS TO THE NEW NUMBER ONE AT A TIME (`functions/texChatMoves.ts`, Dev2 2026-11-15): staff list every person
 * and group and ask for one chat to move; the Worker claims asked moves through `/agent-texts/moves` and reports each
 * through `/agent-texts/move-report`, both behind its own secret.
 *
 * Sabotage (temporary local edits, reverted): dropping `requireAdmin` from `askTexChatMove` fails "a stranger can
 * neither list nor ask"; claiming without the `sending` flip fails "a claimed move is not handed out twice"; dropping
 * the `askedAt` check in `reportTexChatMove` fails "a late report of an earlier ask is stale".
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const NEW_NUMBER = "+15555550142";
const PHONE = "+15555550100";
const GROUP_KEY = "a".repeat(64);

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

async function worker(t: ReturnType<typeof tester>, path: string, body: unknown = {}, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

async function setUp(t: ReturnType<typeof tester>, { number = true }: { number?: boolean } = {}) {
  const staffId = await user(t, ADMIN);
  const staff = withSession(t, staffId);
  const ada = await user(t, "ada@example.test");
  await t.run(async (ctx) => {
    await ctx.db.insert("phoneLinks", { userId: ada, phone: PHONE, linkedAt: 1 });
    await ctx.db.insert("textGroups", { groupKey: GROUP_KEY, lastSeenAt: 5, chatName: "Book club", homeUsers: [ada] });
  });
  if (number) await staff.mutation(api.functions.texOldLine.setTexOldLine, { mode: "off", number: NEW_NUMBER, archiveOn: null });
  return { staff, staffId, ada };
}

describe("moving chats, as staff see it", () => {
  test("lists every linked person and group, with no move until one is asked", async () => {
    const t = tester();
    const { staff } = await setUp(t);
    const list = await staff.query(api.functions.texChatMoves.listTexChatMoves, {});
    expect(list.people).toEqual([expect.objectContaining({ phone: PHONE, move: null })]);
    expect(list.groups).toEqual([{ groupKey: GROUP_KEY, name: "Book club", people: 1, lastSeenAt: 5, move: null }]);
  });

  test("lists a phone let in off the waitlist that has no account yet, once", async () => {
    const t = tester();
    const { staff } = await setUp(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("waitlist", { phone: "+15555550177", status: "admitted", joinedAt: 1, source: "login" });
      await ctx.db.insert("waitlist", { phone: PHONE, status: "admitted", joinedAt: 2, source: "login" });
      await ctx.db.insert("waitlist", { phone: "+15555550178", status: "waiting", joinedAt: 3, source: "login" });
    });
    const people = (await staff.query(api.functions.texChatMoves.listTexChatMoves, {})).people;
    expect(people.map((row) => row.phone).sort()).toEqual([PHONE, "+15555550177"]);
    expect(people.find((row) => row.phone === "+15555550177")?.name).toBe("Not signed up yet");
  });

  test("a stranger can neither list nor ask", async () => {
    const t = tester();
    await setUp(t);
    const stranger = withSession(t, await user(t, "bo@example.test"));
    await expect(stranger.query(api.functions.texChatMoves.listTexChatMoves, {})).rejects.toThrow();
    await expect(stranger.mutation(api.functions.texChatMoves.askTexChatMove, { kind: "person", key: PHONE })).rejects.toThrow();
  });

  test("asking moves the row to asked, audited with the acting staff member", async () => {
    const t = tester();
    const { staff, staffId } = await setUp(t);
    expect(await staff.mutation(api.functions.texChatMoves.askTexChatMove, { kind: "person", key: PHONE })).toMatchObject({ status: "asked" });
    const list = await staff.query(api.functions.texChatMoves.listTexChatMoves, {});
    expect(list.people[0].move).toMatchObject({ status: "asked", toldAt: null });
    const events = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    expect(events.find((row) => row.action === "tex.chat_move_asked")).toMatchObject({ actorUserId: staffId, subject: "tex.chat_move", details: { kind: "person" } });
  });

  test("refuses without a saved new number, a key that is not a phone, and a group for now", async () => {
    const t = tester();
    const { staff } = await setUp(t, { number: false });
    await expect(staff.mutation(api.functions.texChatMoves.askTexChatMove, { kind: "person", key: PHONE })).rejects.toThrow(/new number/);
    await staff.mutation(api.functions.texOldLine.setTexOldLine, { mode: "off", number: NEW_NUMBER, archiveOn: null });
    await expect(staff.mutation(api.functions.texChatMoves.askTexChatMove, { kind: "person", key: "5555550100" })).rejects.toThrow(/phone/);
    await expect(staff.mutation(api.functions.texChatMoves.askTexChatMove, { kind: "group", key: GROUP_KEY })).rejects.toThrow(/group/);
  });
});

describe("moving chats, as the Worker takes and reports them", () => {
  test("refuses without the agent worker's own secret", async () => {
    const t = tester();
    for (const path of ["/agent-texts/moves", "/agent-texts/move-report"]) {
      expect((await worker(t, path, {}, "wrong")).status).toBe(401);
      expect((await worker(t, path, {}, null)).status).toBe(401);
    }
  });

  test("a claimed move is handed out once with the new number, then told, then moved", async () => {
    const t = tester();
    const { staff } = await setUp(t);
    await staff.mutation(api.functions.texChatMoves.askTexChatMove, { kind: "person", key: PHONE });
    const claim = await worker(t, "/agent-texts/moves");
    expect(claim.body).toMatchObject({ number: NEW_NUMBER, archiveOn: null, moves: [{ kind: "person", key: PHONE }] });
    expect((await worker(t, "/agent-texts/moves")).body.moves).toEqual([]);
    const askedAt = claim.body.moves[0].askedAt;
    expect((await worker(t, "/agent-texts/move-report", { kind: "person", key: PHONE, status: "told", askedAt })).body).toEqual({ outcome: "noted" });
    expect((await staff.query(api.functions.texChatMoves.listTexChatMoves, {})).people[0].move).toMatchObject({ status: "told" });
    expect((await worker(t, "/agent-texts/move-report", { kind: "person", key: PHONE, status: "moved" })).body).toEqual({ outcome: "noted" });
    const move = (await staff.query(api.functions.texChatMoves.listTexChatMoves, {})).people[0].move;
    expect(move).toMatchObject({ status: "moved" });
    expect(move?.movedAt).toEqual(expect.any(Number));
  });

  test("a late report of an earlier ask is stale, and a code it does not know is kept as unknown", async () => {
    const t = tester();
    const { staff } = await setUp(t);
    await staff.mutation(api.functions.texChatMoves.askTexChatMove, { kind: "person", key: PHONE });
    const askedAt = (await worker(t, "/agent-texts/moves")).body.moves[0].askedAt;
    expect((await worker(t, "/agent-texts/move-report", { kind: "person", key: PHONE, status: "told", askedAt: askedAt - 1 })).body).toEqual({ outcome: "stale" });
    expect((await worker(t, "/agent-texts/move-report", { kind: "person", key: PHONE, status: "failed", askedAt, detail: "made_up" })).body).toEqual({ outcome: "noted" });
    expect((await staff.query(api.functions.texChatMoves.listTexChatMoves, {})).people[0].move).toMatchObject({ status: "failed", detail: "unknown" });
    expect((await worker(t, "/agent-texts/move-report", { kind: "person", key: PHONE, status: "moved" })).body).toEqual({ outcome: "stale" });
    expect((await worker(t, "/agent-texts/move-report", { kind: "person", key: "+15555550111", status: "moved" })).body).toEqual({ outcome: "no_move" });
    expect((await worker(t, "/agent-texts/move-report", { kind: "person", key: PHONE, status: "asked" })).status).toBe(400);
  });

  test("hands out at most a few at a time, and one the Worker lost again after a while", async () => {
    const t = tester();
    const { staff } = await setUp(t);
    const phones = Array.from({ length: MOVES_PER_CLAIM + 2 }, (_, i) => `+1555555020${i}`);
    for (const phone of phones) await staff.mutation(api.functions.texChatMoves.askTexChatMove, { kind: "person", key: phone });
    expect((await worker(t, "/agent-texts/moves")).body.moves).toHaveLength(MOVES_PER_CLAIM);
    expect((await worker(t, "/agent-texts/moves")).body.moves).toHaveLength(2);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("texChatMoves").collect()) await ctx.db.patch(row._id, { claimedAt: Date.now() - MOVE_CLAIM_MS - 1 });
    });
    expect((await worker(t, "/agent-texts/moves")).body.moves).toHaveLength(MOVES_PER_CLAIM);
  });
});
