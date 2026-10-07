import { describe, expect, it } from "vitest";
import { accept, CARD_EVERY_MS, drain, MAX_PENDING, MAX_SEND_ATTEMPTS, SEEN_FOR_MS, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";

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
  now?: number;
  unlinked?: boolean;
  events?: string[];
  typingStatus?: number;
  cards?: string[];
  cardStatus?: number;
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
    if (path.endsWith("/share_contact_card")) {
      opts.cards?.push(path);
      return new Response("{}", { status: opts.cardStatus ?? 200 });
    }
    if (path === "/agent-texts/session") {
      return Response.json(opts.unlinked ? { status: "unlinked" } : { status: "linked", accessToken: "t" });
    }
    if (path === "/agent-texts/invite") {
      return Response.json({ status: "issued", url: "https://app.example/texts/abc123" });
    }
    if (path === "/agent") {
      opts.asks?.push(body.question);
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
    expect(await accept(storage, msg("e2", "second"), 1_000)).toBe("queued");
    expect(storage.alarms).toEqual([1_000, 1_000]);

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

  it("sends a sign-in link as its own text, and a retry repeats neither text's key", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg("e1"), 1_000);
    const sent: Sent[] = [];
    let sends = 0;
    // The greeting goes through, the link fails, then everything succeeds.
    await drain(storage, deps({ unlinked: true, sent, linqStatus: () => (++sends === 2 ? 503 : 200) }));
    await drain(storage, deps({ unlinked: true, sent }));
    expect(sent.map((s) => s.idempotency)).toEqual(["reply:e1", "reply:e1", "reply:e1:1"]);
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
    expect(events).toEqual(["typing", "send"]);
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
    expect(cards).toEqual(["/api/partner/v3/chats/chat_1/share_contact_card"]);
    // After the reply: Linq shares a card only into a chat with an outbound message.
    expect(events).toEqual(["typing", "send"]);
    expect(typeof storage.data.get("card")).toBe("number");

    await accept(storage, msg("e2"), 2_000);
    await drain(storage, deps({ cards, now: 2_000 }));
    expect(cards).toHaveLength(1);

    await accept(storage, msg("e3"), 1_000 + CARD_EVERY_MS);
    await drain(storage, deps({ cards, now: 1_000 + CARD_EVERY_MS }));
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
});
