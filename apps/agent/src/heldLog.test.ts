/**
 * This object holds the chat's whole log (2026-10-31: the gateway read it from
 * the bucket one event file at a time, about 400 storage calls before a
 * "hi Tex" could answer). The first answer hands back the log it read
 * (`log`), kept here as written; from then on every turn says `holdsLog` and
 * the gateway reads none of it (`apps/mcp/src/agent/warmCopy.js` `events`).
 * Decide is still shown only its own window (`TRANSCRIPT_CHARS`).
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { addEvent, holdsLog, keepLog, keptEvents, MAX_KEPT_EVENTS, renderTranscript, TRANSCRIPT_CHARS, unwritten, type TexEvent } from "./events";
import { agentAnswer, type Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";

const now = Date.now();
const ev = (at: number, seq: number, fields: Partial<TexEvent> = {}): TexEvent => ({ id: `${String(at).padStart(13, "0")}-${String(seq).padStart(6, "0")}`, at, chat: "c", from: { kind: "person" }, kind: "text", text: "hi", ...fields });

describe("the held log", () => {
  it("keeps the log the gateway read as written, and says it holds it from then on", async () => {
    const storage = new MemoryStorage();
    expect(await holdsLog(storage, "c")).toBe(false);
    const mine = await addEvent(storage, { at: now - 1_000, chat: "c", from: { kind: "person" }, kind: "text", text: "now" });
    await keepLog(storage, "c", [ev(now - 60_000, 1, { text: "from the bucket" }), ev(now - 50_000, 2, { chat: "other" }), { id: "nope" } as TexEvent], now);
    expect(await holdsLog(storage, "c")).toBe(true);
    expect(await holdsLog(storage, "other")).toBe(false);
    expect((await keptEvents(storage, "c")).map((event) => event.text)).toEqual(["from the bucket", "now"]);
    expect((await keptEvents(storage, "other"))).toEqual([]);
    // Kept from the bucket, it is never sent back; this object's own unwritten event still is.
    expect((await unwritten(storage)).map((event) => event.id)).toEqual([mine]);
  });

  it("an event already kept is left as it was", async () => {
    const storage = new MemoryStorage();
    const id = await addEvent(storage, { at: now - 1_000, chat: "c", from: { kind: "person" }, kind: "text", text: "mine" });
    await keepLog(storage, "c", [{ ...ev(now - 1_000, 0), id, text: "changed" }], now);
    expect((await keptEvents(storage, "c")).map((event) => event.text)).toEqual(["mine"]);
  });

  it("holds as much as the gateway reads, and decide still sees only its window", async () => {
    expect(MAX_KEPT_EVENTS).toBe(400);
    const long = Array.from({ length: 300 }, (_, i) => ev(now - 300_000 + i, i, { text: "x".repeat(200) }));
    expect(renderTranscript(long).length).toBeLessThanOrEqual(TRANSCRIPT_CHARS);
  });

  it("an answer's log is read as events only", () => {
    const answer = agentAnswer(200, { answer: "Hey.", log: [ev(now, 1), { id: 3 }, "x"] });
    expect(answer.kind === "answer" && answer.log?.map((event) => event.id)).toEqual([ev(now, 1).id]);
    const none = agentAnswer(200, { answer: "Hey." });
    expect(none.kind === "answer" && none.log).toBeUndefined();
  });
});

const msg = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: "chat_1", from: "+15555550100", messageId: `m_${eventId}`, text });

function deps(bodies: Record<string, unknown>[], answers: Record<string, unknown>[], at: number): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing") || path.endsWith("/read")) return new Response(null, { status: 204 });
    if (path.endsWith("/share_contact_card")) return new Response("{}", { status: 200 });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent/events") return Response.json({ written: body.events.map((event: { id: string }) => event.id) });
    if (path === "/agent") return bodies.push(body), Response.json(answers.shift() ?? { answer: "ok" });
    if (path.endsWith("/messages")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now: () => at };
}

describe("a turn and the held log", () => {
  it("the first turn's answer hands the log here, and the next turn says it holds it", async () => {
    const storage = new MemoryStorage();
    const bodies: Record<string, unknown>[] = [];
    const old = { ...ev(500, 7, { text: "said yesterday-ish" }), chat: "chat_1" };
    await accept(storage, msg("e1", "hi Tex"), 1_000);
    await drain(storage, deps(bodies, [{ answer: "Hey.", log: [old] }], 1_000));
    expect(bodies[0].holdsLog).toBeUndefined();
    await accept(storage, msg("e2", "what did I say?"), 2_000);
    await drain(storage, deps(bodies, [{ answer: "That." }], 2_000));
    expect(bodies[1].holdsLog).toBe(true);
    expect((bodies[1].recent as TexEvent[]).map((event) => event.text)).toEqual(expect.arrayContaining(["said yesterday-ish", "hi Tex", "what did I say?"]));
  });
});
