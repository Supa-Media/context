import { describe, expect, it } from "vitest";
import { accept, drain, MAX_PENDING, MAX_SEND_ATTEMPTS, SEEN_FOR_MS, type InboxDeps, type InboxStorage } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";

class MemoryStorage implements InboxStorage {
  data = new Map<string, unknown>();
  alarms: number[] = [];
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>({ prefix }: { prefix: string }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    return new Map(keys.map((k) => [k, this.data.get(k) as T]));
  }
  async setAlarm(at: number) {
    this.alarms.push(at);
  }
}

const msg = (eventId: string, text = "hi"): Message => ({
  kind: "message",
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  text,
});

type Sent = { text: string; idempotency: string };

function deps(opts: { linqStatus?: () => number; sent?: Sent[]; asks?: string[]; now?: number }): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path === "/agent-texts/session") {
      return Response.json({ status: "linked", accessToken: "t" });
    }
    if (path === "/agent") {
      opts.asks?.push(body.question);
      return Response.json({ answer: `answer to ${body.question}` });
    }
    if (path.endsWith("/messages")) {
      const status = opts.linqStatus?.() ?? 200;
      if (status < 300) opts.sent?.push({ text: body.parts[0].value, idempotency: body.idempotency_key });
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
});
