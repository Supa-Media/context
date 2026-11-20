/**
 * The Worker keeps only its outbox and reads the chat from the gateway's
 * ledger (Dev, 2026-11-02: "Outbox only, read the ledger"; `chatRead.ts`,
 * `events.ts`). Before this it kept the chat's last day beside the ledger, and
 * handed it to every turn (`holdsLog`).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-02):
 *  1. `flushEvents` keeping what the gateway wrote → "what the gateway took is forgotten here".
 *  2. `chatEvents` ignoring the gateway's answer → "the chat is the ledger's day with the outbox on top".
 *
 * Sabotage record (2026-11-03): `flushWithReader` returning before it posts → "a group's chatter between Tex's turns
 * reaches the ledger as it is said".
 *
 * Sabotage record (2026-11-12): `chatEvents` ignoring `byLedger` → "reads the chat by its ledger key over the gateway
 * binding" fails.
 */

import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { addEvent, flushEvents, keptEvents, unwritten, type TexEvent } from "./events";
import { chatEvents, flushWithReader, rememberChatReader } from "./chatRead";
import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";

const now = Date.now();
const ev = (at: number, seq: number, fields: Partial<TexEvent> = {}): TexEvent => ({ id: `${String(at).padStart(13, "0")}-${String(seq).padStart(6, "0")}`, at, chat: "c", from: { kind: "person" }, kind: "text", text: "hi", ...fields });

describe("the outbox", () => {
  it("what the gateway took is forgotten here, and what it did not take waits", async () => {
    const storage = new MemoryStorage();
    const taken = await addEvent(storage, { at: now - 2_000, chat: "c", from: { kind: "person" }, kind: "text", text: "taken" });
    const left = await addEvent(storage, { at: now - 1_000, chat: "c", from: { kind: "person" }, kind: "text", text: "left" });
    const fetcher = (async () => Response.json({ written: [taken] })) as unknown as Fetch;
    await flushEvents(storage, { fetch: fetcher, gatewayOrigin: "https://gw.example", now: () => now }, "t", "texts");
    expect((await keptEvents(storage, "c")).map((event) => event.id)).toEqual([left]);
    expect((await unwritten(storage)).map((event) => event.id)).toEqual([left]);
  });

  it("a day kept by an older version of this object goes on the next flush", async () => {
    const storage = new MemoryStorage();
    const old = ev(now - 60_000, 1, { text: "kept the old way" });
    await storage.put(`ev:${old.id}`, { e: old, w: true });
    await storage.put("evfull:c", now - 60_000);
    const fetcher = (async () => Response.json({ written: [] })) as unknown as Fetch;
    await flushEvents(storage, { fetch: fetcher, gatewayOrigin: "https://gw.example", now: () => now }, "t", "texts");
    expect(await keptEvents(storage, "c")).toEqual([]);
    expect(await storage.get("evfull:c")).toBeUndefined();
  });
});

describe("reading the chat", () => {
  it("the chat is the ledger's day with the outbox on top, one event per id, oldest first", async () => {
    const storage = new MemoryStorage();
    const mine = await addEvent(storage, { at: now - 1_000, chat: "c", from: { kind: "person" }, kind: "text", text: "not posted yet" });
    const asked: { url: string; auth: string | null; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      asked.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      return Response.json({ events: [ev(now - 60_000, 1, { text: "from the ledger" }), ev(now - 50_000, 2, { chat: "other" }), { id: "nope" }, { ...ev(now - 1_000, 0), id: mine, text: "the ledger's copy" }] });
    }) as unknown as Fetch;
    rememberChatReader(storage, "c", { token: "tok", conversation: "texts", fetch: fetcher, gatewayOrigin: "https://gw.example" });
    const events = await chatEvents(storage, "c");
    expect(events.map((event) => event.text)).toEqual(["from the ledger", "not posted yet"]);
    expect(asked).toEqual([{ url: "https://gw.example/agent/chat", auth: "Bearer tok", body: { conversation: "texts", chat: "c" } }]);
  });

  it("a group's chat is asked for by its group, with its own token", async () => {
    const storage = new MemoryStorage();
    const asked: unknown[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => (asked.push(JSON.parse(String(init.body))), Response.json({ events: [ev(now, 1, { chat: "g1" })] }))) as unknown as Fetch;
    rememberChatReader(storage, "g1", { token: "gtok", conversation: { group: "g1" }, fetch: fetcher, gatewayOrigin: "https://gw.example" });
    expect((await chatEvents(storage, "g1")).length).toBe(1);
    expect(asked).toEqual([{ conversation: { group: "g1" } }]);
    expect(await chatEvents(storage, "c")).toEqual([]);
  });

  it("with no turn since this object woke, or a gateway that does not answer, the outbox alone", async () => {
    const storage = new MemoryStorage();
    await addEvent(storage, { at: now, chat: "c", from: { kind: "person" }, kind: "text", text: "waiting" });
    expect((await chatEvents(storage, "c")).map((event) => event.text)).toEqual(["waiting"]);
    rememberChatReader(storage, "c", { token: "tok", conversation: "texts", fetch: (async () => new Response("{}", { status: 503 })) as unknown as Fetch, gatewayOrigin: "https://gw.example" });
    expect((await chatEvents(storage, "c")).map((event) => event.text)).toEqual(["waiting"]);
    rememberChatReader(storage, "c", { token: "tok", conversation: "texts", fetch: (async () => { throw new Error("down"); }) as unknown as Fetch, gatewayOrigin: "https://gw.example" });
    expect((await chatEvents(storage, "c")).map((event) => event.text)).toEqual(["waiting"]);
  });
});

const msg = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: "chat_1", from: "+15555550100", messageId: `m_${eventId}`, text });

function deps(bodies: Record<string, unknown>[], at: number): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing") || path.endsWith("/read")) return new Response(null, { status: 204 });
    if (path.endsWith("/share_contact_card")) return new Response("{}", { status: 200 });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent/events") return Response.json({ written: body.events.map((event: { id: string }) => event.id) });
    if (path === "/agent/chat") return Response.json({ events: [] });
    if (path === "/agent") return bodies.push(body), Response.json({ answer: "ok" });
    if (path.endsWith("/messages")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now: () => at };
}

describe("a turn", () => {
  it("hands the gateway only what it has not taken, never says it holds the chat, and keeps nothing once posted", async () => {
    const storage = new MemoryStorage();
    const bodies: Record<string, unknown>[] = [];
    await accept(storage, msg("e1", "hi Tex"), 1_000);
    await drain(storage, deps(bodies, 1_000));
    await accept(storage, msg("e2", "what did I say?"), 2_000);
    await drain(storage, deps(bodies, 2_000));
    expect(bodies.length).toBe(2);
    for (const body of bodies) expect(body.holdsLog).toBeUndefined();
    expect(((bodies[1].recent as TexEvent[] | undefined) ?? []).map((event) => event.text)).not.toContain("hi Tex");
  });
});

describe("chatter between turns", () => {
  it("a group's chatter between Tex's turns reaches the ledger as it is said, with the chat's own token", async () => {
    const storage = new MemoryStorage();
    const posted: { url: string; auth: string | null; body: { conversation: unknown; events: TexEvent[] } }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      posted.push({ url, auth: new Headers(init.headers).get("authorization"), body });
      return Response.json({ written: body.events.map((event: TexEvent) => event.id) });
    }) as unknown as Fetch;
    // No turn since this object woke: nothing to post with, so it waits for the next turn.
    const early = await addEvent(storage, { at: now - 2_000, chat: "g1", from: { kind: "person", who: "a" }, kind: "text", text: "before any turn" });
    expect(await flushWithReader(storage, "g1", () => now)).toBe("none");
    expect(posted).toEqual([]);
    // A turn opened the chat: the next thing anyone says goes now, with what waited before it, and only this chat's.
    rememberChatReader(storage, "g1", { token: "gtok", conversation: { group: "g1" }, fetch: fetcher, gatewayOrigin: "https://gw.example" });
    const other = await addEvent(storage, { at: now - 1_500, chat: "g2", from: { kind: "person", who: "b" }, kind: "text", text: "another chat" });
    const said = await addEvent(storage, { at: now - 1_000, chat: "g1", from: { kind: "person", who: "b" }, kind: "text", text: "not for Tex" });
    expect(await flushWithReader(storage, "g1", () => now)).toBe("token");
    expect(posted.map((p) => [p.url, p.auth, p.body.conversation])).toEqual([["https://gw.example/agent/events", "Bearer gtok", { group: "g1" }]]);
    expect(posted[0]!.body.events.map((event) => event.id)).toEqual([early, said]);
    expect((await unwritten(storage)).map((event) => event.id)).toEqual([other]);
  });

  it("a token the gateway refuses leaves the chatter for the next turn, and never throws", async () => {
    const storage = new MemoryStorage();
    const said = await addEvent(storage, { at: now, chat: "g1", from: { kind: "person" }, kind: "text", text: "kept" });
    rememberChatReader(storage, "g1", { token: "old", conversation: { group: "g1" }, fetch: (async () => new Response("{}", { status: 401 })) as unknown as Fetch, gatewayOrigin: "https://gw.example" });
    expect(await flushWithReader(storage, "g1", () => now)).toBe("token");
    rememberChatReader(storage, "g1", { token: "old", conversation: { group: "g1" }, fetch: (async () => { throw new Error("down"); }) as unknown as Fetch, gatewayOrigin: "https://gw.example" });
    expect(await flushWithReader(storage, "g1", () => now)).toBe("token");
    expect((await unwritten(storage)).map((event) => event.id)).toEqual([said]);
  });
});

describe("chatter with no token in memory (Tex Devs, 2026-11-13)", () => {
  const LEDGER = "ab".repeat(32);
  const ledgerBinding = (answer: (body: { ledger: string; chat: string; events: TexEvent[] }) => Response) => {
    const posted: { url: string; auth: string | null; body: { ledger: string; chat: string; events: TexEvent[] } }[] = [];
    const binding = {
      fetch: async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        posted.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
        return answer(body);
      },
    };
    return { posted, binding };
  };

  it("goes to the ledger by the chat's key over the binding, at once, only this chat's, and is forgotten once written", async () => {
    const storage = new MemoryStorage();
    const { posted, binding } = ledgerBinding((body) => Response.json({ written: body.events.map((event) => event.id) }));
    const before = await addEvent(storage, { at: now - 2_000, chat: "g1", from: { kind: "person", who: "a" }, kind: "text", text: "Instinct, what do you think?" });
    const other = await addEvent(storage, { at: now - 1_500, chat: "g2", from: { kind: "person", who: "b" }, kind: "text", text: "another chat" });
    const said = await addEvent(storage, { at: now - 1_000, chat: "g1", from: { kind: "person", who: "b" }, kind: "text", text: "I told you in this group?" });
    expect(await flushWithReader(storage, "g1", () => now, { binding, ledger: LEDGER })).toBe("ledger");
    expect(posted.map((p) => [p.url, p.body.ledger, p.body.chat])).toEqual([["https://gateway/texts/events", LEDGER, "g1"]]);
    // No token rides along: the binding is the credential.
    expect(posted[0]!.auth).toBe("Bearer");
    expect(posted[0]!.body.events.map((event) => event.id)).toEqual([before, said]);
    expect((await unwritten(storage)).map((event) => event.id)).toEqual([other]);
  });

  it("a token held still goes first, the binding never asked", async () => {
    const storage = new MemoryStorage();
    const { posted, binding } = ledgerBinding(() => Response.json({ written: [] }));
    await addEvent(storage, { at: now, chat: "g1", from: { kind: "person" }, kind: "text", text: "hi" });
    rememberChatReader(storage, "g1", { token: "gtok", conversation: { group: "g1" }, fetch: (async (_url: string, init: RequestInit) => Response.json({ written: JSON.parse(String(init.body)).events.map((event: TexEvent) => event.id) })) as unknown as Fetch, gatewayOrigin: "https://gw.example" });
    expect(await flushWithReader(storage, "g1", () => now, { binding, ledger: LEDGER })).toBe("token");
    expect(posted).toEqual([]);
    expect(await unwritten(storage)).toEqual([]);
  });

  it("a chat with no ledger, a failed gateway or a refusal of the ask keeps the chatter for the next turn", async () => {
    const storage = new MemoryStorage();
    const said = await addEvent(storage, { at: now, chat: "g1", from: { kind: "person" }, kind: "text", text: "kept" });
    for (const answer of [() => new Response(null, { status: 404 }), () => new Response(null, { status: 503 }), () => new Response(null, { status: 400 })]) {
      const { binding } = ledgerBinding(answer);
      expect(await flushWithReader(storage, "g1", () => now, { binding, ledger: LEDGER })).toBe("ledger");
    }
    const down = { fetch: async () => { throw new Error("down"); } };
    expect(await flushWithReader(storage, "g1", () => now, { binding: down, ledger: LEDGER })).toBe("ledger");
    expect((await unwritten(storage)).map((event) => event.id)).toEqual([said]);
    // An event the gateway names as malformed would be refused forever: dropped, as the token's path drops it.
    const { binding } = ledgerBinding(() => Response.json({ error: "invalid_request", error_description: "events[0].text" }, { status: 400 }));
    const log = console.log;
    console.log = () => {};
    try {
      await flushWithReader(storage, "g1", () => now, { binding, ledger: LEDGER });
    } finally {
      console.log = log;
    }
    expect(await unwritten(storage)).toEqual([]);
  });
});

describe("a group's judge without a token (Dev2, 2026-11-12)", () => {
  it("reads the chat by its ledger key over the gateway binding, with the outbox on top", async () => {
    const storage = new MemoryStorage();
    const mine = await addEvent(storage, { at: now, chat: "g", from: { kind: "person" }, kind: "text", text: "newest" });
    const asked: { url: string; body: unknown }[] = [];
    const binding = { fetch: async (url: string, init?: RequestInit) => {
      asked.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ events: [ev(now - 5_000, 1, { chat: "g", text: "earlier" })] });
    } };
    const events = await chatEvents(storage, "g", 500, { binding, ledger: "k".repeat(64) });
    expect(events.map((event) => event.text)).toEqual(["earlier", "newest"]);
    expect(events.at(-1)?.id).toBe(mine);
    expect(asked).toEqual([{ url: "https://gateway/texts/chat", body: { ledger: "k".repeat(64), chat: "g" } }]);
  });

  it("falls back to the outbox when the gateway does not answer", async () => {
    const storage = new MemoryStorage();
    await addEvent(storage, { at: now, chat: "g", from: { kind: "person" }, kind: "text", text: "newest" });
    const binding = { fetch: async () => new Response("no", { status: 503 }) };
    expect((await chatEvents(storage, "g", 500, { binding, ledger: "k".repeat(64) })).map((event) => event.text)).toEqual(["newest"]);
  });
});
