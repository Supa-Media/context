/**
 * Stickers people stuck in a chat, kept for Tex to stick again (`stickers.ts`; Dev2, 2026-11-25).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `stickerOf` answering any kept guid without matching the id → "an id this chat never kept sends the emoji" fails.
 *  2. `inbox.ts` `react` not keeping the sticker → "a sticker stuck in a Photon 1:1 is kept ..." fails.
 *  3. `tapback()` sticking without `stickerOf` → "an id this chat never kept sends the emoji" fails.
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { agentAnswer } from "./clients";
import { accept, drain, react, type InboxDeps } from "./inbox";
import { keptEvents, unwritten } from "./events";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { keepSticker, MAX_STICKERS, stickerId, stickerOf, STICKERS_KEY } from "./stickers";
import { tapback } from "./stepEvents";
import type { Reaction } from "./reactions";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const CHAT = `photon:${LINE}:${PHONE}`;
const STICKER: Reaction = { how: "Reacted", words: "we won!!", onTex: true, emoji: "with a sticker", sticker: "at_0_ABC-123" };

describe("a chat's stickers", () => {
  it("are kept by a short id that is the same for the same sticker", async () => {
    const storage = new MemoryStorage();
    const id = stickerId("at_0_ABC-123");
    expect(id).toMatch(/^s[0-9a-z]{6}$/);
    expect(stickerId("at_0_ABC-123")).toBe(id);
    expect(stickerId("at_0_ABC-124")).not.toBe(id);
    const read = await keepSticker(storage, STICKER, 1_000);
    expect(read.emoji).toBe(`sticker ${id}`);
    expect(await stickerOf(storage, id)).toBe("at_0_ABC-123");
    expect(await stickerOf(storage, "s000000")).toBeNull();
    expect(await stickerOf(storage, "at_0_ABC-123")).toBeNull();
  });

  it("keep the newest few, and leave a tapback, a taken-back sticker and one with no attachment as they came", async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < MAX_STICKERS + 5; i += 1) await keepSticker(storage, { ...STICKER, sticker: `g-${i}` }, i);
    const kept = (await storage.get<{ id: string }[]>(STICKERS_KEY)) ?? [];
    expect(kept).toHaveLength(MAX_STICKERS);
    expect(await stickerOf(storage, stickerId("g-0"))).toBeNull();
    expect(await stickerOf(storage, stickerId(`g-${MAX_STICKERS + 4}`))).toBe(`g-${MAX_STICKERS + 4}`);
    const like: Reaction = { how: "Liked", words: "ok" };
    expect(await keepSticker(storage, like, 1)).toBe(like);
    const gone = { ...STICKER, removed: true as const };
    expect(await keepSticker(storage, gone, 1)).toBe(gone);
    const bare = { ...STICKER, sticker: undefined };
    expect(await keepSticker(storage, bare, 1)).toBe(bare);
  });
});

describe("Tex's tapback with a sticker", () => {
  it("sticks the kept sticker and logs it as the react step", async () => {
    const storage = new MemoryStorage();
    const { emoji } = await keepSticker(storage, STICKER, 1_000);
    const id = emoji!.slice("sticker ".length);
    const stuck: string[] = [];
    const tapped: string[] = [];
    const sent = await tapback(storage, { chat: CHAT, now: () => 2_000, by: "tex", asked: "😂" }, "lol", async (e) => tapped.push(e), { id, stick: async (guid) => void stuck.push(guid) });
    expect(sent).toBe(`sticker ${id}`);
    expect(stuck).toEqual(["at_0_ABC-123"]);
    expect(tapped).toEqual([]);
    const steps = (await unwritten(storage)).filter((event) => event.kind === "step");
    expect(steps.at(-1)?.step).toMatchObject({ name: "react", ok: true, output: { sticker: id }, input: { sticker: id } });
  });

  it("an id this chat never kept, a line without stickers, or a stick that fails sends the emoji, and says why", async () => {
    for (const [id, stick, why] of [
      ["s000000", async () => {}, "sticker_unknown"],
      [null, undefined, "sticker_no_line"],
      [null, async () => { throw new TypeError("refused"); }, "sticker_failed:TypeError"],
    ] as const) {
      const storage = new MemoryStorage();
      const { emoji } = await keepSticker(storage, STICKER, 1_000);
      const tapped: string[] = [];
      const sent = await tapback(storage, { chat: CHAT, now: () => 2_000, by: "tex", asked: "😂" }, "lol", async (e) => tapped.push(e), { id: id ?? emoji!.slice("sticker ".length), stick });
      expect(sent).toBe("😂");
      expect(tapped).toEqual(["😂"]);
      const steps = (await unwritten(storage)).filter((event) => event.kind === "step");
      expect(steps.at(-1)?.step).toMatchObject({ name: "react", ok: true, output: { emoji: "😂", instead: why } });
    }
  });

  it("the gateway's sticker is read only beside a quiet tapback, and only as an id", () => {
    expect(agentAnswer(200, { answer: "", quiet: true, react: "😂", sticker: "s1a2b3c" })).toMatchObject({ react: "😂", sticker: "s1a2b3c" });
    expect(agentAnswer(200, { answer: "", quiet: true, react: "😂", sticker: "at_0_ABC" })).not.toHaveProperty("sticker");
    expect(agentAnswer(200, { answer: "ha", sticker: "s1a2b3c" })).not.toHaveProperty("sticker");
  });
});

describe("a Photon 1:1, end to end in the chat object", () => {
  type Op = { op: string; body: Record<string, unknown> };
  const message = (eventId: string): Message => ({ kind: "message", eventId, chatId: CHAT, from: PHONE, messageId: eventId, text: "lmaooo" });

  function deps(sticker: string, ops: Op[]): InboxDeps {
    const gateway = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
      if (path === "/agent") return Response.json({ answer: "", quiet: true, react: "😂", sticker });
      return Response.json({});
    }) as unknown as Fetch;
    const photon = {
      fetch: async (url: string, init?: RequestInit) => {
        ops.push({ op: new URL(url).pathname.slice(1), body: init?.body ? JSON.parse(String(init.body)) : {} });
        return Response.json({ ok: true, guid: "g" });
      },
    } as unknown as Fetcher;
    return { fetch: gateway, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "", photon, now: () => 5_000 };
  }

  it("a sticker stuck in a Photon 1:1 is kept and read by its id, and Tex's tapback sticks it back on their next text", async () => {
    const storage = new MemoryStorage();
    await react(storage, { kind: "reaction", eventId: "photon:r1", chatId: CHAT, from: PHONE, messageId: "tex-1", reaction: STICKER }, 1_000);
    const id = stickerId("at_0_ABC-123");
    const lines = (await keptEvents(storage, CHAT)).map((event) => ("text" in event ? event.text : undefined));
    expect(lines.some((text) => text?.startsWith(`sticker ${id} on Tex's message`))).toBe(true);
    await accept(storage, message("photon:m2"), 2_000);
    const ops: Op[] = [];
    await drain(storage, deps(id, ops));
    const stuck = ops.filter((call) => call.op === "sticker");
    expect(stuck).toEqual([{ op: "sticker", body: { line: LINE, chat: `any;-;${PHONE}`, guid: "photon:m2", sticker: "at_0_ABC-123" } }]);
    expect(ops.some((call) => call.op === "react")).toBe(false);
  });

  it("an id this chat never kept sends the emoji as a tapback instead", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("photon:m3"), 2_000);
    const ops: Op[] = [];
    await drain(storage, deps(stickerId("from-another-chat"), ops));
    expect(ops.some((call) => call.op === "sticker")).toBe(false);
    expect(ops.find((call) => call.op === "react")?.body).toMatchObject({ guid: "photon:m3", kind: "laugh", on: true });
  });
});
