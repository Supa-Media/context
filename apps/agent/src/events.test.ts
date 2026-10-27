/**
 * Every message in and every part out of a person's own chat is an event
 * (`events.ts`, CONTRACT.md sections 1, 2, 5), on every line: Linq, Sendblue
 * (iMessage) and Whapi (WhatsApp).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `logInbound` keeping the phone in `from.who` instead of its hash →
 *     "inbound texts and Tex's parts are posted…" fails.
 *  2. `flushChat` not called on the session → "…before the turn reads the
 *     log" fails.
 *  3. `partEvent` marking an upload failure delivered → "a picture that
 *     could not be uploaded…" fails.
 *  4. `flushEvents` marking every event written whatever the gateway said →
 *     "fixed texts are kept in order…" fails.
 *  5. `prune` keeping everything → "the buffer is bounded" fails.
 *  6. `renderTranscript` ignoring `people` → "a newcomer's transcript…" fails.
 */

import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { addEvent, flushEvents, keptEvents, MAX_KEPT_EVENTS, renderTranscript, unwritten, type TexEvent } from "./events";
import { noteTold, owedTold } from "./told";
import { sha256Hex } from "./groupChat";
import { sendblueChatId } from "./sendblue";
import { whapiChatId } from "./whapi";
import { PICTURE_FAILED } from "./outgoing";
import { coverAll } from "./decideStub.testing";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const LINES = [
  { name: "Linq", chatId: "chat_1" },
  { name: "Sendblue", chatId: sendblueChatId(LINE, PHONE) },
  { name: "Whapi", chatId: whapiChatId(LINE, PHONE) },
];

const msg = (chatId: string, eventId: string, text: string, extra: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId,
  chatId,
  from: PHONE,
  messageId: `m_${eventId}`,
  text,
  ...extra,
});

type Posted = { conversation: unknown; events: TexEvent[]; token: string };

function world(opts: { agent?: Record<string, unknown>; hostFails?: boolean; written?: (ids: string[]) => string[] } = {}) {
  const order: string[] = [];
  const posted: Posted[] = [];
  const sends: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const path = parsed.pathname;
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "tok" });
    if (path === "/agent-texts/decide") return coverAll(init);
    if (path === "/agent/events") {
      order.push("events");
      posted.push({ ...body, token: new Headers(init?.headers).get("authorization") ?? "" });
      const ids = body.events.map((event: TexEvent) => event.id);
      return Response.json({ written: opts.written ? opts.written(ids) : ids });
    }
    if (path === "/agent") {
      order.push("agent");
      return Response.json(opts.agent ?? { answer: "Booked." });
    }
    if (/messages|send-message|send-reaction/.test(path) && !path.endsWith("/read")) {
      sends.push(path);
      if (parsed.host === "gate.whapi.cloud") return Response.json({ sent: true, message: { id: `wa_${sends.length}` } });
      return Response.json({ status: "QUEUED", message_handle: `h_${sends.length}` });
    }
    return new Response("{}", { status: path.endsWith("/typing") ? 204 : 200 });
  }) as unknown as Fetch;
  const deps: InboxDeps = {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    sendblue: { keyId: "id", secret: "key" },
    whapi: { token: "wt", line: LINE },
    hostPicture: async () => {
      if (opts.hostFails) throw new Error("no host");
      return "https://agent.example/media/p.png";
    },
    now: () => 1_000,
  };
  return { deps, order, posted, sends };
}

const all = (posted: Posted[]) => posted.flatMap((post) => post.events);

describe("a person's chat as events", () => {
  for (const line of LINES) {
    it(`inbound texts and Tex's parts are posted to the gateway with the chat's token (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world();
      await accept(storage, msg(line.chatId, "e1", "book a table"), 1_000);
      await drain(storage, w.deps);
      const events = all(w.posted);
      expect(w.posted.every((post) => post.conversation === "texts" && post.token === "Bearer tok")).toBe(true);
      const inbound = events.find((event) => event.from.kind === "person")!;
      expect(inbound).toMatchObject({ chat: line.chatId, kind: "text", text: "book a table", from: { kind: "person", who: await sha256Hex(PHONE) } });
      expect(inbound.id).toMatch(/^\d{13}-\d{6}$/);
      // Who sent it is a hash, never the number (`chat` is the Worker's chat key, as the contract has it).
      expect(JSON.stringify(events.map((event) => [event.from, event.text]))).not.toContain(PHONE);
      const out = events.find((event) => event.from.kind === "tex")!;
      expect(out).toMatchObject({ kind: "text", text: "Booked.", delivered: true, covers: [inbound.id] });
      expect(out.turn).toMatch(/^[0-9a-f-]{36}$/);
      expect(await unwritten(storage)).toEqual([]);
    });

  }

  // Linq uploads to its own host (outgoing.test.ts); Sendblue and Whapi through `hostPicture`.
  for (const line of LINES.filter(({ name }) => name !== "Linq")) {
    it(`a picture that could not be uploaded is an event that never went (${line.name})`, async () => {
      const storage = new MemoryStorage();
      const w = world({ agent: { answer: "Here it is.", pictures: [{ name: "p.png", mediaType: "image/png", data: "iVBORw0KGgo=" }] }, hostFails: true });
      await accept(storage, msg(line.chatId, "e1", "draw me a dog"), 1_000);
      await drain(storage, w.deps);
      const outs = (await keptEvents(storage, line.chatId)).filter((event) => event.from.kind === "tex");
      expect(outs.map((event) => [event.kind, event.delivered, event.reason])).toEqual([
        ["text", true, undefined],
        ["picture", false, "upload_failed"],
      ]);
      expect(outs.some((event) => event.text === PICTURE_FAILED)).toBe(false);
    });
  }

  it("every approval a turn armed is an ask event with its record, after the words, under the turn", async () => {
    const storage = new MemoryStorage();
    const w = world({ agent: { answer: "Here's the email I'd send. Give it a 👍 and I'll send it.", askIds: ["rec_1"] } });
    await accept(storage, msg("chat_1", "e1", "email Bo"), 1_000);
    await drain(storage, w.deps);
    const outs = (await keptEvents(storage, "chat_1")).filter((event) => event.from.kind === "tex");
    expect(outs.map((event) => event.kind)).toEqual(["text", "ask"]);
    expect(outs[1]).toMatchObject({ ask: "rec_1", turn: outs[0].turn });
    expect(outs.every((event) => typeof event.turn === "string")).toBe(true);
  });

  it("a turn the gateway says was cancelled sends nothing", async () => {
    const storage = new MemoryStorage();
    const w = world({ agent: { cancelled: true, answer: "", asked: 0 } });
    await accept(storage, msg("chat_1", "e1", "do it"), 1_000);
    await drain(storage, w.deps);
    expect(w.sends).toEqual([]);
  });

  it("a batch the gateway refuses as malformed is dropped, never retried forever", async () => {
    const storage = new MemoryStorage();
    await addEvent(storage, { at: 1_000, chat: "c", from: { kind: "person" }, kind: "text", text: "x" });
    const refusing = (async () => Response.json({ error: "invalid_request", error_description: "events[0].from" }, { status: 400 })) as unknown as Fetch;
    await flushEvents(storage, { fetch: refusing, gatewayOrigin: "https://gw.example" }, "tok", "texts");
    expect(await unwritten(storage)).toEqual([]);
  });

  it("display names are cut to what the gateway takes", async () => {
    const storage = new MemoryStorage();
    await addEvent(storage, { at: 1, chat: "g", from: { kind: "person", name: "Ada <script>🎉" }, kind: "text", text: "x" });
    await addEvent(storage, { at: 2, chat: "g", from: { kind: "person", name: "🎉🎉" }, kind: "text", text: "y" });
    const [one, two] = await keptEvents(storage, "g");
    expect(one.from.name).toBe("Ada script");
    expect(two.from).toEqual({ kind: "person" });
  });

  it("the chat's events are written before the turn reads the log", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await accept(storage, msg("chat_1", "e1", "hi"), 1_000);
    await drain(storage, w.deps);
    expect(w.order.slice(0, 2)).toEqual(["events", "agent"]);
  });

  it("a refused picture send is an event with send_refused", async () => {
    const storage = new MemoryStorage();
    const chatId = sendblueChatId(LINE, PHONE);
    const w = world({ agent: { answer: "Look.", pictures: [{ url: "https://img.example/a.png" }] } });
    const refusing = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/api/send-message" && String(init?.body).includes("media_url")) return new Response("{}", { status: 400 });
      return w.deps.fetch(url, init);
    }) as unknown as Fetch;
    await accept(storage, msg(chatId, "e1", "show me"), 1_000);
    await drain(storage, { ...w.deps, fetch: refusing });
    const outs = (await keptEvents(storage, chatId)).filter((event) => event.from.kind === "tex");
    expect(outs.map((event) => [event.kind, event.delivered, event.reason])).toEqual([
      ["text", true, undefined],
      ["picture", false, "send_refused"],
    ]);
  });
});

/** THE FIXED TEXTS A TURN'S HISTORY IS OWED (`told.ts`): now outbound events carrying `told`, kept until written. */
describe("told", () => {
  it("fixed texts are kept in order, and only what the gateway wrote stops being owed", async () => {
    const storage = new MemoryStorage();
    await noteTold(storage, "setup", "chat_1", 1_000);
    await noteTold(storage, "ready", "chat_1", 1_001);
    expect(await owedTold(storage)).toEqual(["setup", "ready"]);
    const w = world({ written: (ids) => ids.slice(0, 1) });
    await flushEvents(storage, w.deps, "tok", "texts");
    expect(await owedTold(storage)).toEqual(["ready"]);
    await noteTold(storage, "ready_late", "chat_1", 1_002);
    await flushEvents(storage, world().deps, "tok", "texts");
    expect(await owedTold(storage)).toEqual([]);
    expect(all(w.posted)[0]).toMatchObject({ from: { kind: "system" }, kind: "text", told: "setup", delivered: true });
    expect(all(w.posted)[0].text).toBeUndefined();
  });

  it("the names reach the gateway with the next text, before its turn", async () => {
    const storage = new MemoryStorage();
    await noteTold(storage, "setup", "chat_1", 900);
    await noteTold(storage, "ready", "chat_1", 950);
    const w = world();
    await accept(storage, msg("chat_1", "e1", "Done"), 1_000);
    await drain(storage, w.deps);
    expect(all(w.posted).flatMap((event) => (event.told ? [event.told] : []))).toEqual(["setup", "ready"]);
    expect(w.order[0]).toBe("events");
  });

  it("a gateway that is down keeps them owed", async () => {
    const storage = new MemoryStorage();
    await noteTold(storage, "gmail", "chat_1", 900);
    const down = (async () => new Response("{}", { status: 503 })) as unknown as Fetch;
    await flushEvents(storage, { fetch: down, gatewayOrigin: "https://gw.example" }, "tok", "texts");
    expect(await owedTold(storage)).toEqual(["gmail"]);
  });
});

describe("the event buffer", () => {
  it("the buffer is bounded", async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < MAX_KEPT_EVENTS + 25; i += 1) await addEvent(storage, { at: 1_000 + i, chat: "c", from: { kind: "person" }, kind: "text", text: "x" });
    expect(await keptEvents(storage, "c")).toHaveLength(MAX_KEPT_EVENTS);
  });

  it("posts at most 50 events a call", async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < 55; i += 1) await addEvent(storage, { at: 1_000 + i, chat: "c", from: { kind: "person" }, kind: "text", text: "x" });
    const w = world();
    await flushEvents(storage, w.deps, "tok", "texts");
    expect(w.posted.map((post) => post.events.length)).toEqual([50, 5]);
  });

  it("renders as section 5: You for Tex, not answered, not delivered", () => {
    const at = Date.UTC(2026, 9, 26, 12, 16);
    const events: TexEvent[] = [
      { id: "1", at, chat: "c", from: { kind: "person", name: "Ada" }, kind: "text", text: "Tex check this link out" },
      { id: "2", at, chat: "c", from: { kind: "person", name: "Ada" }, kind: "link", text: "https://example.com/x" },
      { id: "3", at: at + 60_000, chat: "c", from: { kind: "tex" }, kind: "text", text: "I read it.", delivered: true, covers: ["1", "2"] },
      { id: "4", at: at + 60_000, chat: "c", from: { kind: "tex" }, kind: "picture", delivered: false, reason: "upload_failed" },
      { id: "5", at: at + 180_000, chat: "c", from: { kind: "person", name: "Ada" }, kind: "text", text: "are you thinking straight?" },
    ];
    expect(renderTranscript(events)).toBe(
      [
        "--- Monday, Oct 26 ---",
        "[12:16 PM] Ada: Tex check this link out",
        "[12:16 PM] Ada: https://example.com/x",
        "[12:17 PM] You: I read it.",
        "[12:17 PM] You: (a picture)",
        "           (not delivered: the picture didn't reach them)",
        "[12:19 PM] Ada: are you thinking straight?   (not answered)",
      ].join("\n"),
    );
  });

  it("a newcomer's transcript starts where they were there", () => {
    const events: TexEvent[] = [
      { id: "1", at: 1, chat: "g", from: { kind: "person", name: "Ada" }, kind: "text", text: "before Cy", people: "ab" },
      { id: "2", at: 2, chat: "g", from: { kind: "person", name: "Cy" }, kind: "text", text: "hi all", people: "abc" },
    ];
    const shown = renderTranscript(events, { people: "abc" });
    expect(shown).toContain("hi all");
    expect(shown).not.toContain("before Cy");
  });
});
