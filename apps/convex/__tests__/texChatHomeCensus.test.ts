import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser, createUser, createWorkspace } from "./fixtures.helpers";
import { migrate, pinnedWorld } from "./pinnedReaders.helpers";

/**
 * THE CHAT HOMES CENSUS ANSWERS COUNTS AND CODES, NEVER A NAME (2026-11-01; `functions/texChatHomeCensus.ts`).
 *
 * A chat whose home was never made keeps its memory in its bound workspace with nothing logged. The census says how
 * many chats have a home and, for one chat picked by the hash its memory note is named by, which code it is.
 *
 * Sabotage record: `homeCode` answering "ok" whatever the row → "a chat with no home is counted as one" fails.
 */

vi.setConfig({ testTimeout: 60_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";

async function hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("the chat homes census", () => {
  test("a chat with a home is counted as one, a chat with no home is counted as none, and only codes leave", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const post = async (path: string, body: unknown) =>
      JSON.parse(await (await w.t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) })).text()) as Record<string, unknown>;
    for (const [name, phone] of [["ada", ADA], ["bo", BO]] as const) {
      const userId = await createUser(w.t, `${name}@example.invalid`);
      await createWorkspace(w.t, userId, name, { kind: "personal" });
      const { code } = await asUser(w.t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
      await post("/agent-texts/link", { phone, code });
    }
    expect((await post("/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, BO, LINE], mint: true })).status).toBe("ready");
    const homeless = "e".repeat(64);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: homeless, lastSeenAt: Date.now() });
    });
    const answer = await w.t.query(internal.functions.texChatHomeCensus.census, { match: (await hex(homeless)).slice(0, 12) });
    expect(answer).toMatchObject({ pin: "ok", chats: 2, homes: { ok: 1, no_words: 1 } });
    expect(answer.matched).toEqual([expect.objectContaining({ home: "no_words", homeUsers: 0 })]);
    expect(JSON.stringify(answer)).not.toMatch(/eeee|tex\/groups|@/);
  });
});
