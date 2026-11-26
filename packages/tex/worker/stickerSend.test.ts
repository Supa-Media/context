/**
 * Tex sends a kept sticker as a picture of its own (the front door's `send_sticker`,
 * `packages/tex/gateway/agent/stickerSend.js`; Dev2, 2026-11-26, "Own send action for stickers").
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `agentAnswer` not reading `sendSticker` → "after Tex's words, in a Photon 1:1, the kept sticker goes as its own send" fails.
 *  2. `sendReply` not sending `item.sticker` → the same test fails.
 *  3. `sendKeptSticker` sticking without `stickerOf` → "an id this chat never kept sends nothing, and no emoji" fails.
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { agentAnswer } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { keptEvents, unwritten } from "./events";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { keepSticker, stickerId } from "./stickers";
import { sendKeptSticker } from "./stepEvents";
import type { Reaction } from "./reactions";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const CHAT = `photon:${LINE}:${PHONE}`;
const STICKER: Reaction = { how: "Reacted", words: "we won!!", onTex: true, emoji: "with a sticker", sticker: "at_0_ABC-123" };
const ID = stickerId("at_0_ABC-123");

type Op = { op: string; body: Record<string, unknown> };
const message = (eventId: string): Message => ({ kind: "message", eventId, chatId: CHAT, from: PHONE, messageId: eventId, text: "tex send me a sticker" });

function deps(answer: Record<string, unknown>, ops: Op[]): InboxDeps {
  const gateway = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent") return Response.json(answer);
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

describe("Tex's send_sticker", () => {
  it("the gateway's sendSticker is read as an id, beside words or alone", () => {
    expect(agentAnswer(200, { answer: "here you go", sendSticker: "s1a2b3c" })).toMatchObject({ kind: "answer", text: "here you go", sendSticker: "s1a2b3c" });
    expect(agentAnswer(200, { answer: "", sendSticker: "s1a2b3c" })).toMatchObject({ kind: "answer", sendSticker: "s1a2b3c" });
    expect(agentAnswer(200, { answer: "hi", sendSticker: "at_0_ABC" })).not.toHaveProperty("sendSticker");
  });

  it("after Tex's words, in a Photon 1:1, the kept sticker goes as its own send and is kept as Tex's line", async () => {
    const storage = new MemoryStorage();
    await keepSticker(storage, STICKER, 1_000);
    await accept(storage, message("photon:m1"), 2_000);
    const ops: Op[] = [];
    await drain(storage, deps({ answer: "here you go", sendSticker: ID }, ops));
    const sends = ops.filter((call) => call.op.startsWith("send") || call.op === "sticker").map((call) => call.op);
    expect(sends.at(-1)).toBe("sticker");
    expect(sends.indexOf("sticker")).toBeGreaterThan(0); // after the words
    expect(ops.find((call) => call.op === "sticker")?.body).toMatchObject({ sticker: "at_0_ABC-123", send: true });
    const lines = (await keptEvents(storage, CHAT)).map((event) => ("text" in event ? event.text : undefined));
    expect(lines).toContain(`sticker ${ID}`);
  });

  it("an id this chat never kept sends nothing, and no emoji", async () => {
    const storage = new MemoryStorage();
    const stuck: string[] = [];
    expect(await sendKeptSticker(storage, { chat: CHAT, now: () => 1 }, stickerId("elsewhere"), async (guid) => void stuck.push(guid))).toBeNull();
    expect(stuck).toEqual([]);
    const steps = (await unwritten(storage)).filter((event) => event.kind === "step");
    expect(steps.at(-1)?.step).toMatchObject({ name: "react", ok: false, input: { by: "fd" }, output: { instead: "sticker_unknown" } });
  });
});
