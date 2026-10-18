import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import worker, { type Env } from "./index";
import { accept, CHAT_KEY, NEW_LINE_KEY, NEW_LINE_TOLD_KEY } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { bearerMatches, formatNumber, newNumberText, parseTellRequest, tellEveryone, tellNewLine, type Told } from "./newLine";
import type { Message } from "./reply";

const PHONE = "+15555550100";
const NUMBER = "+18133350746";
const TEXT = newNumberText(NUMBER);
const SECRET = "a-worker-secret-long-enough";

const msg = (over: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId: "e1",
  chatId: "chat_1",
  from: PHONE,
  messageId: "m1",
  text: "hi",
  ...over,
});

type Sent = { url: string; text: string; key: string };

function linq(sent: Sent[], status = 200): Fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (status < 300) sent.push({ url, text: body.message.parts[0].value, key: body.message.idempotency_key });
    return new Response("{}", { status });
  }) as unknown as Fetch;
}

const deps = (sent: Sent[], status = 200) => ({ fetch: linq(sent, status), linqApiKey: "k", now: () => 5_000 });

describe("the new-number text", () => {
  it("names the new number the way people read it", () => {
    expect(formatNumber(NUMBER)).toBe("+1 (813) 335-0746");
    expect(formatNumber("+447700900123")).toBe("+447700900123");
    expect(TEXT).toContain("+1 (813) 335-0746");
  });
});

describe("telling one phone", () => {
  it("texts the old-line chat that phone started, once", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    expect(await tellNewLine(storage, { text: TEXT, dryRun: false }, deps(sent))).toBe("told");
    expect(sent).toEqual([{ url: expect.stringContaining("/chats/chat_1/messages"), text: TEXT, key: "new-line:chat_1" }]);
    expect(await tellNewLine(storage, { text: TEXT, dryRun: false }, deps(sent))).toBe("already");
    expect(sent).toHaveLength(1);
  });

  it("texts nobody on a dry run", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    expect(await tellNewLine(storage, { text: TEXT, dryRun: true }, deps(sent))).toBe("would");
    expect(sent).toEqual([]);
    expect(storage.data.has(NEW_LINE_TOLD_KEY)).toBe(false);
  });

  it("never texts a phone that never texted Tex, a simulated chat, or one already on the new line", async () => {
    const sent: Sent[] = [];
    expect(await tellNewLine(new MemoryStorage(), { text: TEXT, dryRun: false }, deps(sent))).toBe("no_chat");
    const simulated = new MemoryStorage();
    await simulated.put(CHAT_KEY, { chatId: "sim", channel: "simulator", at: 1 });
    expect(await tellNewLine(simulated, { text: TEXT, dryRun: false }, deps(sent))).toBe("no_chat");
    const moved = new MemoryStorage();
    await accept(moved, msg({ chatId: `sendblue:${NUMBER}:${PHONE}` }), 1_000);
    expect(await tellNewLine(moved, { text: TEXT, dryRun: false }, deps(sent))).toBe("on_new_line");
    expect(sent).toEqual([]);
  });

  it("is failed, and tried again next time, when the old line refuses", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    expect(await tellNewLine(storage, { text: TEXT, dryRun: false }, deps([], 500))).toBe("failed");
    expect(storage.data.has(NEW_LINE_TOLD_KEY)).toBe(false);
  });

  it("means their first text on the new line needs no 'new number' line", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    await tellNewLine(storage, { text: TEXT, dryRun: false }, deps([]));
    await accept(storage, msg({ eventId: "e2", chatId: `sendblue:${NUMBER}:${PHONE}` }), 2_000);
    expect(storage.data.has(NEW_LINE_KEY)).toBe(false);
  });
});

describe("telling everyone", () => {
  it("asks the control plane for phones with the worker's secret, and tells each valid one once", async () => {
    const asked: { url: string; auth: string | null }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      asked.push({ url, auth: new Headers(init.headers).get("authorization") });
      return Response.json({ phones: [PHONE, PHONE, "+15555550101", "not a phone", 7, "+15555550102"] });
    }) as unknown as Fetch;
    const outcomes: Record<string, Told> = { [PHONE]: "told", "+15555550101": "on_new_line" };
    const told: string[] = [];
    const counts = await tellEveryone(
      {
        fetch: fetcher,
        controlPlaneOrigin: "https://cp.example",
        workerSecret: SECRET,
        tellPhone: async (phone, body) => {
          told.push(phone);
          expect(body).toEqual({ text: TEXT, dryRun: false });
          if (phone === "+15555550102") throw new Error("boom");
          return outcomes[phone];
        },
      },
      { number: NUMBER, dryRun: false },
    );
    expect(asked).toEqual([{ url: "https://cp.example/agent-texts/phones", auth: `Bearer ${SECRET}` }]);
    expect(told.sort()).toEqual([PHONE, "+15555550101", "+15555550102"]);
    expect(counts).toEqual({ phones: 3, told: 1, would: 0, already: 0, on_new_line: 1, no_chat: 0, failed: 1 });
  });

  it("throws when the control plane does not answer with phones", async () => {
    const fetcher = (async () => new Response("nope", { status: 401 })) as unknown as Fetch;
    await expect(
      tellEveryone({ fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: SECRET, tellPhone: async () => "told" }, { number: NUMBER, dryRun: true }),
    ).rejects.toThrow();
  });
});

describe("the door", () => {
  it("opens only for the worker's own secret, and never for a short one", async () => {
    expect(await bearerMatches(SECRET, `Bearer ${SECRET}`)).toBe(true);
    expect(await bearerMatches(SECRET, `Bearer ${SECRET}x`)).toBe(false);
    expect(await bearerMatches(SECRET, SECRET)).toBe(false);
    expect(await bearerMatches(SECRET, null)).toBe(false);
    expect(await bearerMatches("short", "Bearer short")).toBe(false);
    expect(await bearerMatches(undefined, "Bearer ")).toBe(false);
  });

  it("is a dry run unless send is exactly true", () => {
    expect(parseTellRequest({ number: NUMBER })).toEqual({ number: NUMBER, dryRun: true });
    expect(parseTellRequest({ number: NUMBER, send: "true" })).toEqual({ number: NUMBER, dryRun: true });
    expect(parseTellRequest({ number: NUMBER, send: true })).toEqual({ number: NUMBER, dryRun: false });
    expect(parseTellRequest({ number: "8133350746", send: true })).toBeNull();
    expect(parseTellRequest(null)).toBeNull();
  });

  it("refuses the worker route without the secret and texts nobody", async () => {
    const reached: string[] = [];
    const env = {
      SENDER_INBOX: { idFromName: () => ({}), get: () => ({ fetch: async () => (reached.push("inbox"), Response.json({ told: "told" })) }) },
      LINQ_WEBHOOK_SECRET: "x",
      LINQ_API_KEY: "k",
      AGENT_WORKER_SECRET: SECRET,
      CONTROL_PLANE_ORIGIN: "https://cp.example",
      GATEWAY_ORIGIN: "https://gw.example",
    } as unknown as Env;
    for (const auth of [null, "Bearer wrong", `Basic ${SECRET}`]) {
      const headers: Record<string, string> = auth === null ? {} : { authorization: auth };
      const response = await worker.fetch(
        new Request("https://agent.example/new-line", { method: "POST", headers, body: JSON.stringify({ number: NUMBER, send: true }) }),
        env,
      );
      expect(response.status).toBe(401);
    }
    expect(reached).toEqual([]);
  });
});
