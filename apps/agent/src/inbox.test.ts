import { describe, expect, it, vi } from "vitest";
import { accept, CARD_EVERY_MS, drain, LINK_PREVIEW_MS, MAX_ANSWER_ATTEMPTS, MAX_PENDING, MAX_SEND_ATTEMPTS, SEEN_FOR_MS, TEXT_WAIT_MS, TYPING_AGAIN_MS, type InboxDeps } from "./inbox";
import { COPY, type Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { READY_FIRST_MS, READY_KEY } from "./ready";
import { afterRepliesSettled } from "./afterReply";
import { TEXT_COLUMNS, textTimingPoint } from "./textTiming";
import { recentEvents } from "./events";

const msg = (eventId: string, text = "hi"): Message => ({
  kind: "message",
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  text,
});

type Sent = { text: string; idempotency: string };

function deps(opts: {
  linqStatus?: () => number;
  sent?: Sent[];
  asks?: string[];
  /** Every `/agent` body, whole. */
  bodies?: Record<string, unknown>[];
  now?: number;
  unlinked?: boolean;
  events?: string[];
  typingStatus?: number;
  cards?: string[];
  /** Holds the contact card's request until it resolves: work after a reply that is slow. */
  cardGate?: Promise<unknown>;
  cardStatus?: number;
  readStatus?: number;
  progress?: string[];
  /** The status the stream's last line carries after its progress lines. */
  streamStatus?: () => number;
  agentStatus?: () => number;
  sessionStatus?: () => number;
  setup?: unknown;
  agentMs?: number;
}): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing")) {
      // Slower than the answer, as Linq can be, so a bubble that is not
      // awaited would land after the reply and hang in the chat.
      await new Promise((resolve) => setTimeout(resolve, 5));
      opts.events?.push("typing");
      return new Response(null, { status: opts.typingStatus ?? 204 });
    }
    if (path.endsWith("/read")) {
      opts.events?.push("read");
      return new Response("{}", { status: opts.readStatus ?? 200 });
    }
    if (path.endsWith("/share_contact_card")) {
      opts.cards?.push(path);
      await opts.cardGate;
      return new Response("{}", { status: opts.cardStatus ?? 200 });
    }
    if (path === "/agent-texts/session") {
      const status = opts.sessionStatus?.() ?? 200;
      if (status !== 200) return Response.json({}, { status });
      return Response.json(opts.unlinked ? { status: "unlinked" } : { status: "linked", accessToken: "t" });
    }
    // A phone nobody may set up by text (`setup.ts`) gets the sign-in link.
    if (path === "/agent-texts/setup") return Response.json(opts.setup ?? { status: "not_eligible" });
    if (path === "/agent-texts/invite") {
      return Response.json({ status: "issued", url: "https://app.example/texts/abc123" });
    }
    if (path === "/agent") {
      opts.asks?.push(body.question);
      opts.bodies?.push(body);
      if (opts.agentMs) await new Promise((resolve) => setTimeout(resolve, opts.agentMs));
      const status = opts.agentStatus?.() ?? 200;
      if (status !== 200) return Response.json({ error: "model_unavailable" }, { status });
      if (opts.progress) {
        const last = opts.streamStatus?.() ?? 200;
        const lines = [...opts.progress.map((progress) => ({ progress })), last === 200 ? { status: 200, body: { answer: `answer to ${body.question}` } } : { status: last, body: { error: "model_unavailable" } }];
        return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return Response.json({ answer: `answer to ${body.question}` });
    }
    if (path.endsWith("/messages")) {
      const status = opts.linqStatus?.() ?? 200;
      if (status < 300) opts.sent?.push({ text: body.message.parts[0].value, idempotency: body.message.idempotency_key });
      opts.events?.push("send");
      return new Response("{}", { status });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    now: () => opts.now ?? 1_000,
  };
}

describe("inbox", () => {
  it("answers queued messages in order and keeps no text afterwards", async () => {
    const storage = new MemoryStorage();
    expect(await accept(storage, msg("e1", "first"), 1_000)).toBe("queued");
    // A reply to other words, so the two are not one burst (`sameBurst`).
    expect(await accept(storage, { ...msg("e2", "second"), quoted: "other words" }, 1_000)).toBe("queued");
    expect(storage.alarms).toEqual([1_000 + TEXT_WAIT_MS, 1_000]);

    const sent: Sent[] = [];
    await drain(storage, deps({ sent }));
    expect(sent).toEqual([
      { text: "answer to first", idempotency: "reply:e1" },
      { text: "answer to second", idempotency: "reply:e2" },
    ]);
    const leftovers = [...storage.data.entries()].filter(([k]) => k.startsWith("pending:"));
    expect(leftovers).toEqual([]);
    // Only timestamps remain under seen:, never text.
    for (const [key, value] of storage.data) {
      if (key.startsWith("seen:")) expect(typeof value).toBe("number");
    }
  });

  it("answers a redelivered webhook once", async () => {
    const storage = new MemoryStorage();
    expect(await accept(storage, msg("e1"), 1_000)).toBe("queued");
    expect(await accept(storage, msg("e1"), 1_500)).toBe("duplicate");
    const asks: string[] = [];
    await drain(storage, deps({ asks }));
    expect(await accept(storage, msg("e1"), 2_000)).toBe("duplicate");
    expect(asks).toEqual(["hi"]);
  });

  it("tells the gateway when the first text of a turn came in, so the turn log shows how long it waited", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "hey"), 1_000);
    const bodies: Record<string, unknown>[] = [];
    await drain(storage, deps({ bodies, now: 241_000 }));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].arrivedAt).toBe(1_000);
  });

  it("forgets seen ids after a day, but only then", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    await drain(storage, deps({ now: 1_000 + SEEN_FOR_MS }));
    expect(storage.data.has("seen:e1")).toBe(true);
    await drain(storage, deps({ now: 1_000 + SEEN_FOR_MS + 1 }));
    expect(storage.data.has("seen:e1")).toBe(false);
  });

  it("retries a failed send with the same answer, without asking the model again", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "q"), 1_000);
    const asks: string[] = [];
    let status = 503;
    await drain(storage, deps({ asks, linqStatus: () => status }));
    expect(storage.alarms.at(-1)).toBeGreaterThan(1_000);
    status = 200;
    const sent: Sent[] = [];
    await drain(storage, deps({ asks, sent, linqStatus: () => status }));
    expect(asks).toEqual(["q"]);
    expect(sent).toEqual([{ text: "answer to q", idempotency: "reply:e1" }]);
  });

  it("asks again later when the turn could not start, rather than saying something went wrong", async () => {
    // A production deploy mid-text answered "Something went wrong" (2026-10-16).
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "q"), 1_000);
    const asks: string[] = [];
    const sent: Sent[] = [];
    let agent = 503;
    let session = 500;
    await drain(storage, deps({ asks, sent, sessionStatus: () => session, agentStatus: () => agent }));
    expect(sent).toEqual([]);
    expect(storage.alarms.at(-1)).toBeGreaterThan(1_000);
    session = 200;
    await drain(storage, deps({ asks, sent, sessionStatus: () => session, agentStatus: () => agent }));
    expect(sent).toEqual([]);
    agent = 200;
    await drain(storage, deps({ asks, sent, sessionStatus: () => session, agentStatus: () => agent }));
    expect(asks).toEqual(["q", "q"]);
    expect(sent).toEqual([{ text: "answer to q", idempotency: "reply:e1" }]);
    expect(storage.data.has("pending:000000000001")).toBe(false);
  });

  it("says something went wrong once the turn still could not start on the last try", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "q"), 1_000);
    const sent: Sent[] = [];
    for (let i = 0; i < MAX_ANSWER_ATTEMPTS; i++) await drain(storage, deps({ sent, agentStatus: () => 503 }));
    expect(sent).toEqual([{ text: COPY.unavailable, idempotency: "reply:e1" }]);
    expect(storage.data.has("pending:000000000001")).toBe(false);
  });

  it("never asks again a turn that failed after it started, since its tools may have run", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "q"), 1_000);
    const asks: string[] = [];
    const sent: Sent[] = [];
    await drain(storage, deps({ asks, sent, agentStatus: () => 502 }));
    expect(asks).toEqual(["q"]);
    expect(sent).toEqual([{ text: COPY.unavailable, idempotency: "reply:e1" }]);
  });

  it("sends a sign-in link as its own text, and a retry resends only the text that failed", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    const sent: Sent[] = [];
    let sends = 0;
    // The greeting goes through, the link fails, then everything succeeds.
    await drain(storage, deps({ unlinked: true, sent, linqStatus: () => (++sends === 2 ? 503 : 200) }));
    await drain(storage, deps({ unlinked: true, sent }));
    // The greeting is not sent twice: a line with no idempotency key (Sendblue) would show it twice.
    expect(sent.map((s) => s.idempotency)).toEqual(["reply:e1", "reply:e1:1"]);
    expect(sent.at(-1)?.text).toBe("https://app.example/texts/abc123");
    expect(storage.data.has("pending:000000000001")).toBe(false);
  });

  it("still sends a reply stored as one string by an earlier version", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    await storage.put("pending:000000000001", { message: msg("e1"), reply: "kept answer", attempts: 1 });
    const sent: Sent[] = [];
    await drain(storage, deps({ sent }));
    expect(sent).toEqual([{ text: "kept answer", idempotency: "reply:e1" }]);
  });

  it("gives up after the last attempt and deletes the message", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      await drain(storage, deps({ linqStatus: () => 500 }));
    }
    expect([...storage.data.keys()].some((k) => k.startsWith("pending:"))).toBe(false);
  });

  it("takes a lone picture just after a texted link on Sendblue for the link's preview, and drops it", async () => {
    // Owner's report, 2026-10-21: the card came on as its own text and got "That's the Context banner".
    const storage = new MemoryStorage();
    const chatId = "sendblue:+15555550199:+15555550100";
    const link = { ...msg("e1", "https://context.lc/note/@kofi/2-areas/ada.md"), chatId };
    const card = { ...msg("e2", ""), chatId, attachments: [{ url: "https://cdn.example/f/card.png", mimeType: "", filename: "card.png", size: null }] };
    expect(await accept(storage, link, 1_000)).toBe("queued");
    expect(await accept(storage, card, 1_000 + LINK_PREVIEW_MS - 1)).toBe("preview");
    expect((await storage.list({ prefix: "pending:" })).size).toBe(1);
    // A picture well after the link is a picture.
    const later = { ...card, eventId: "e3", messageId: "m_e3" };
    expect(await accept(storage, later, 1_000 + LINK_PREVIEW_MS + 1)).toBe("queued");
    // And a file that is not a picture is never taken for a preview.
    const pdf = { ...card, eventId: "e4", messageId: "m_e4", attachments: [{ url: "https://cdn.example/f/a.pdf", mimeType: "", filename: "a.pdf", size: null }] };
    await accept(storage, { ...link, eventId: "e5", messageId: "m_e5" }, 50_000);
    expect(await accept(storage, pdf, 50_001)).toBe("queued");
  });

  it("drops new messages once one sender has too many waiting", async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < MAX_PENDING; i++) expect(await accept(storage, msg(`e${i}`), 1_000)).toBe("queued");
    expect(await accept(storage, msg("overflow"), 1_000)).toBe("full");
  });
  it("shows the typing bubble while it works, and before the answer, never after", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "who's my brother"), 1_000);
    const events: string[] = [];
    await drain(storage, deps({ events }));
    expect(events).toEqual(["read", "typing", "send"]);
  });

  it("asks for the bubble again just after the read receipt, while a slower answer is worked out", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    const events: string[] = [];
    await drain(storage, deps({ events, agentMs: TYPING_AGAIN_MS + 300 }));
    expect(events).toEqual(["read", "typing", "typing", "send"]);
  });

  it("answers anyway when the typing bubble is refused", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    const sent: Sent[] = [];
    await drain(storage, deps({ sent, typingStatus: 500 }));
    expect(sent.map((s) => s.text)).toEqual(["answer to hi"]);
  });

  it("sends a multi-paragraph answer as separate texts with their own keys", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "**bold**\n\nsecond"), 1_000);
    const sent: Sent[] = [];
    await drain(storage, deps({ sent }));
    expect(sent).toEqual([
      { text: "answer to bold", idempotency: "reply:e1" },
      { text: "second", idempotency: "reply:e1:1" },
    ]);
  });

  it("offers the contact card after a reply goes out, then not again for a day", async () => {
    const storage = new MemoryStorage();
    const cards: string[] = [];
    const events: string[] = [];
    await accept(storage, msg("e1"), 1_000);
    await drain(storage, deps({ cards, events }));
    await afterRepliesSettled(storage);
    expect(cards).toEqual(["/api/partner/v3/chats/chat_1/share_contact_card"]);
    // After the reply: Linq shares a card only into a chat with an outbound message.
    expect(events).toEqual(["read", "typing", "send"]);
    expect(typeof storage.data.get("card")).toBe("number");

    await accept(storage, msg("e2"), 2_000);
    await drain(storage, deps({ cards, now: 2_000 }));
    await afterRepliesSettled(storage);
    expect(cards).toHaveLength(1);

    await accept(storage, msg("e3"), 1_000 + CARD_EVERY_MS);
    await drain(storage, deps({ cards, now: 1_000 + CARD_EVERY_MS }));
    await afterRepliesSettled(storage);
    expect(cards).toHaveLength(2);
  });

  it("answers anyway when the card is refused, and does not ask again that day", async () => {
    const storage = new MemoryStorage();
    const cards: string[] = [];
    const sent: Sent[] = [];
    await accept(storage, msg("e1"), 1_000);
    await drain(storage, deps({ cards, sent, cardStatus: 404 }));
    await accept(storage, msg("e2"), 1_500);
    await drain(storage, deps({ cards, sent, cardStatus: 404, now: 1_500 }));
    expect(sent.map((s) => s.text)).toEqual(["answer to hi", "answer to hi"]);
    expect(cards).toHaveLength(1);
  });

  it("offers no card while the reply has not gone out", async () => {
    const storage = new MemoryStorage();
    const cards: string[] = [];
    await accept(storage, msg("e1"), 1_000);
    await drain(storage, deps({ cards, linqStatus: () => 503 }));
    expect(cards).toEqual([]);
    expect(storage.data.has("card")).toBe(false);
  });

  it("answers anyway when marking the chat read is refused", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    const sent: Sent[] = [];
    const events: string[] = [];
    await drain(storage, deps({ sent, events, readStatus: 500 }));
    expect(events).toEqual(["read", "typing", "send"]);
    expect(sent.map((s) => s.text)).toEqual(["answer to hi"]);
  });

  it("marks a text read once, not again when a failed send is retried", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    const events: string[] = [];
    let status = 503;
    await drain(storage, deps({ events, linqStatus: () => status }));
    status = 200;
    await drain(storage, deps({ events, linqStatus: () => status }));
    expect(events.filter((e) => e === "read")).toHaveLength(1);
  });

  it("texts a long task's progress as it happens, before the answer, each once", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    await accept(storage, msg("e1", "connect my chatgpt"), 1_000);
    await drain(storage, deps({ sent, progress: ["Opening ChatGPT now.", "Found the connector page.", "Opening ChatGPT now.", "Reading its settings."] }));
    expect(sent.map((entry) => entry.text)).toEqual(["Opening ChatGPT now.", "Found the connector page.", "Reading its settings.", "answer to connect my chatgpt"]);
    const keys = sent.slice(0, 3).map((entry) => entry.idempotency);
    for (const key of keys) expect(key).toMatch(/^progress:e1:[0-9a-f]{16}$/);
    expect(new Set(keys).size).toBe(3);
    // Each line is in the chat's log as Tex's, in order, before the answer.
    const log = (await recentEvents(storage, msg("e1").chatId)).filter((event) => event.from.kind === "tex");
    expect(log.map((event) => event.text)).toEqual(["Opening ChatGPT now.", "Found the connector page.", "Reading its settings.", "answer to connect my chatgpt"]);
    expect(log.every((event) => event.delivered)).toBe(true);
    // Nothing kept once the turn is over.
    expect([...storage.data.keys()].filter((key) => key.startsWith("psent:"))).toEqual([]);
  });

  it("never sends a progress line twice when the turn is run again", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    await accept(storage, msg("e1", "book a table"), 1_000);
    let status = 503;
    const lines = ["Checking OpenTable for Friday.", "Found 3 tables at Nopa."];
    await drain(storage, deps({ sent, progress: lines, streamStatus: () => status, now: 2_000 }));
    expect(sent.map((entry) => entry.text)).toEqual(lines);
    status = 200;
    await drain(storage, deps({ sent, progress: [...lines, "Holding the 7pm."], streamStatus: () => status, now: 60_000 }));
    expect(sent.map((entry) => entry.text)).toEqual([...lines, "Holding the 7pm.", "answer to book a table"]);
  });

  it("never sends a progress line twice when a newer text joins the turn run again, and keeps nothing once it is answered", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    const asks: string[] = [];
    await accept(storage, msg("e1", "book a table"), 1_000);
    let status = 503;
    const lines = ["Checking OpenTable for Friday.", "Found 3 tables at Nopa."];
    await drain(storage, deps({ sent, asks, progress: lines, streamStatus: () => status, now: 2_000 }));
    // A second text comes in before the rerun, so the rerun answers both, under the newer one.
    await accept(storage, msg("e2", "for 4"), 2_500);
    status = 200;
    await drain(storage, deps({ sent, asks, progress: lines, streamStatus: () => status, now: 60_000 }));
    expect(asks).toEqual(["book a table", "book a table\nfor 4"]);
    expect(sent.map((entry) => entry.text)).toEqual([...lines, "answer to book a table\nfor 4"]);
    expect([...storage.data.keys()].filter((key) => key.startsWith("psent:"))).toEqual([]);
  });

  it("drops the lines kept for work never answered once they are a day old", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    await accept(storage, msg("e1", "book a table"), 1_000);
    await drain(storage, deps({ sent, progress: ["Checking OpenTable for Friday."], streamStatus: () => 503, now: 2_000 }));
    expect([...storage.data.keys()].filter((key) => key.startsWith("psent:"))).toHaveLength(1);
    // The text is gone with its work never answered (a throw, say): nothing is left to clear its lines but their age.
    for (const key of [...storage.data.keys()].filter((key) => key.startsWith("pending:"))) await storage.delete(key);
    await drain(storage, deps({ sent, now: 2_000 + SEEN_FOR_MS - 1 }));
    expect([...storage.data.keys()].filter((key) => key.startsWith("psent:"))).toHaveLength(1);
    await drain(storage, deps({ sent, now: 2_000 + SEEN_FOR_MS + 1 }));
    expect([...storage.data.keys()].filter((key) => key.startsWith("psent:"))).toEqual([]);
  });

  it("never texts a progress line that is only a word meant for the Worker", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    await accept(storage, msg("e1", "check my jobs"), 1_000);
    await drain(storage, deps({ sent, progress: ["SKIP", "NO_REPLY", "Opening the jobs page."] }));
    expect(sent.map((entry) => entry.text)).toEqual(["Opening the jobs page.", "answer to check my jobs"]);
  });

  it("writes a simulated task's progress to the simulator's log, not to Linq", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    await accept(storage, { ...msg("e1", "connect my chatgpt"), channel: "simulator" }, 1_000);
    await drain(storage, deps({ sent, progress: ["Opening ChatGPT now."] }));
    expect(sent).toEqual([]);
    const log = [...(await storage.list<{ text: string }>({ prefix: "sim:log:" })).values()].map((entry) => JSON.stringify(entry));
    expect(log.join(" ")).toContain("Opening ChatGPT now.");
    expect(log.join(" ")).toContain("answer to connect my chatgpt");
  });

  it("sends a link in a progress line as a text of its own", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    await accept(storage, msg("e1", "log in to chatgpt for me"), 1_000);
    await drain(storage, deps({ sent, progress: ["Sign in here and I'll take it from there:\n\nhttps://live.example/s/abc"] }));
    expect(sent.map((entry) => entry.text)).toEqual([
      "Sign in here and I'll take it from there:",
      "https://live.example/s/abc",
      "answer to log in to chatgpt for me",
    ]);
  });
});

describe("setting up by text", () => {
  it("owes the chat the ready text once setup starts a bucket, and arms the alarm for it", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    await accept(storage, msg("e1", "ada"), 1_000);
    await drain(storage, deps({ sent, unlinked: true, now: 5_000, setup: { status: "set_up", handle: "ada", storage: "on_the_way" } }));
    expect(sent).toHaveLength(1);
    expect(await storage.get(READY_KEY)).toMatchObject({ phone: "+15555550100", chatId: "chat_1", since: 5_000 });
    expect(storage.alarms).toContain(5_000 + READY_FIRST_MS);
  });

  it("owes nothing when no bucket was started", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "ada"), 1_000);
    await drain(storage, deps({ sent: [], unlinked: true, now: 5_000, setup: { status: "set_up", handle: "ada", storage: "none" } }));
    expect(await storage.get(READY_KEY)).toBeUndefined();
  });
});

describe("the work after a reply", () => {
  it("sends the reply before the slow work after it, and a text that comes in during that work is answered without waiting for it", async () => {
    const storage = new MemoryStorage();
    const cards: string[] = [];
    const sent: Sent[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await accept(storage, msg("e1", "first"), 1_000);
    // The first drain returns while the card is still held: nothing after the reply holds the alarm.
    const first = drain(storage, deps({ sent, cards, cardGate: gate }));
    const outcome = await Promise.race([
      first.then(() => "returned" as const),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 300)),
    ]);
    expect(outcome).toBe("returned");
    expect(sent.map((s) => s.text)).toEqual(["answer to first"]);
    // The card's request is in flight now, behind the reply it follows.
    for (let tries = 0; cards.length === 0 && tries < 1_000; tries += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(cards).toHaveLength(1);

    // A text that comes in while the card is held is answered by the next drain, not after the card.
    await accept(storage, msg("e2", "second"), 1_500);
    await drain(storage, deps({ sent, cards, cardGate: gate, now: 1_500 }));
    expect(sent.map((s) => s.text)).toEqual(["answer to first", "answer to second"]);

    release();
    await afterRepliesSettled(storage);
    expect(cards).toHaveLength(1);
  });

  it("offers the card after the last reply of a run, never between two replies", async () => {
    const storage = new MemoryStorage();
    const cards: string[] = [];
    const sent: Sent[] = [];
    // How many cards had gone when each text was sent: none may land between the two replies.
    const cardsAtSend: number[] = [];
    await accept(storage, msg("e1", "first"), 1_000);
    // A reply to other words, so the two are not one burst (`sameBurst`).
    await accept(storage, { ...msg("e2", "second"), quoted: "other words" }, 1_000);
    await drain(
      storage,
      deps({
        sent,
        cards,
        linqStatus: () => {
          cardsAtSend.push(cards.length);
          return 200;
        },
      }),
    );
    await afterRepliesSettled(storage);
    expect(sent.map((s) => s.text)).toEqual(["answer to first", "answer to second"]);
    expect(cardsAtSend).toEqual([0, 0]);
    expect(cards).toHaveLength(1);
  });

  it("logs one timing line per turn, made of numbers only", async () => {
    const storage = new MemoryStorage();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    try {
      await accept(storage, msg("e1", "secret words"), 1_000);
      await drain(storage, deps({}));
      await afterRepliesSettled(storage);
    } finally {
      spy.mockRestore();
    }
    const lines = logs.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const timing = lines.find((line) => line.event === "inbox_turn_timing");
    expect(timing).toBeDefined();
    for (const [key, value] of Object.entries(timing!)) {
      if (key !== "event") expect(typeof value).toBe("number");
    }
    expect(logs.join("\n")).not.toContain("secret words");
    expect(logs.join("\n")).not.toContain("5555550100");
  });

  it("writes each answered text's wait, from arrival to its first bubble, as numbers only", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1", "secret words"), 1_000);
    const points: { blobs?: string[]; doubles?: number[] }[] = [];
    const sent: Sent[] = [];
    let clock = 5_000;
    const run = { ...deps({ sent }), now: () => (clock += 100), textTiming: { writeDataPoint: (point: { blobs?: string[]; doubles?: number[] }) => void points.push(point) } };
    await drain(storage, run);
    await afterRepliesSettled(storage);
    expect(sent).toHaveLength(1);
    expect(points).toHaveLength(1);
    expect(points[0].blobs).toEqual(["one"]);
    const row = Object.fromEntries(TEXT_COLUMNS.map((name, i) => [name, points[0].doubles![i]]));
    expect(row.parts).toBe(1);
    expect(row.queueMs).toBeGreaterThan(4_000);
    // The wait the person felt ends at the first bubble, before the last and before the work after it.
    expect(row.toFirstTextMs).toBeGreaterThan(row.queueMs + row.gatewayMs - 1);
    expect(row.toLastTextMs).toBeGreaterThanOrEqual(row.toFirstTextMs);
    for (const value of points[0].doubles!) expect(value).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(points)).not.toMatch(/secret words|5555550100|chat_1/);
  });

  it("a step not reached, or an arrival not kept, is -1, never a made-up wait", () => {
    const point = textTimingPoint("group", { gatewayMs: 2_400.4, toFirstTextMs: undefined, sendMs: -3 });
    const row = Object.fromEntries(TEXT_COLUMNS.map((name, i) => [name, point.doubles[i]]));
    expect(row.gatewayMs).toBe(2_400);
    expect(row.toFirstTextMs).toBe(-1);
    expect(row.sendMs).toBe(-1);
    expect(point.blobs).toEqual(["group"]);
  });
});
