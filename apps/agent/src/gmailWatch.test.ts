import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import {
  checkGmail,
  GMAIL_COPY,
  GMAIL_FIRST_MS,
  GMAIL_GIVE_UP_MS,
  GMAIL_KEY,
  GMAIL_LATER_MS,
  GMAIL_SOON_FOR_MS,
  GMAIL_SOON_MS,
  watchForGmail,
  type GmailWatchDeps,
} from "./gmailWatch";
import { owedTold } from "./told";

/**
 * TEX SAYS SO ITSELF WHEN THE GMAIL IT ASKED FOR CONNECTS (Dev2, 2026-10-20).
 * Once, to the chat they set up from, naming the address and whether it is
 * now their main email, and asking about other Gmails; never before it has
 * connected, never an address the control plane did not give, and never past
 * the day the texted link lives.
 */

const PHONE = "+15555550100";
const GMAIL = "ada.lovelace@gmail.com";

type Sent = { chatId: string; text: string; idempotency: string };

function deps(opts: { answer: () => unknown; status?: () => number; linqStatus?: () => number; sent: Sent[]; now: () => number; asked?: string[] }): GmailWatchDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path === "/agent-texts/gmail") {
      opts.asked?.push(body.phone);
      return Response.json(opts.answer(), { status: opts.status?.() ?? 200 });
    }
    if (path.endsWith("/messages")) {
      const status = opts.linqStatus?.() ?? 200;
      if (status < 300) {
        opts.sent.push({ chatId: path.split("/").at(-2)!, text: body.message.parts[0].value, idempotency: body.message.idempotency_key });
      }
      return new Response("{}", { status });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", linqApiKey: "k", now: opts.now };
}

describe("the Gmail-connected text", () => {
  it("looks after a minute, then until it connects, and texts once that it is their main email", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const sent: Sent[] = [];
    const asked: string[] = [];
    let connected = false;
    const d = deps({
      answer: () => (connected ? { status: "connected", address: GMAIL, main: true } : { status: "waiting" }),
      sent,
      asked,
      now: () => now,
    });

    await watchForGmail(storage, { phone: PHONE, chatId: "chat_1" }, now);
    expect(storage.alarms).toEqual([1_000 + GMAIL_FIRST_MS]);
    await checkGmail(storage, d);
    expect(asked).toEqual([]);

    now += GMAIL_FIRST_MS;
    await checkGmail(storage, d);
    expect(asked).toEqual([PHONE]);
    expect(sent).toEqual([]);
    expect(storage.alarms.at(-1)).toBe(now + GMAIL_SOON_MS);

    connected = true;
    now += GMAIL_SOON_MS;
    await checkGmail(storage, d);
    expect(sent).toEqual([{ chatId: "chat_1", text: GMAIL_COPY.main(GMAIL), idempotency: "gmail:1000" }]);
    expect(sent[0].text).toContain("main email");
    expect(sent[0].text).toContain("other Gmails");
    expect(await storage.get(GMAIL_KEY)).toBeUndefined();
    expect(await owedTold(storage)).toEqual(["gmail_main"]);

    now += GMAIL_SOON_MS;
    await checkGmail(storage, d);
    expect(sent).toHaveLength(1);
  });

  it("says it can read a Gmail that did not become the main email, without calling it that", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    const d = deps({ answer: () => ({ status: "connected", address: GMAIL, main: false }), sent, now: () => GMAIL_FIRST_MS });
    await watchForGmail(storage, { phone: PHONE, chatId: "chat_1" }, 0);
    await checkGmail(storage, d);
    expect(sent.map((s) => s.text)).toEqual([GMAIL_COPY.connected(GMAIL)]);
    expect(sent[0].text).not.toContain("main email");
    expect(await owedTold(storage)).toEqual(["gmail"]);
  });

  it("never texts something that is not one address", async () => {
    for (const address of ["", "two words@x.com", "no-at-sign", `${"a".repeat(65)}@x.com`, 42, "a@b.com https://evil.example"]) {
      const storage = new MemoryStorage();
      const sent: Sent[] = [];
      const d = deps({ answer: () => ({ status: "connected", address, main: true }), sent, now: () => GMAIL_FIRST_MS });
      await watchForGmail(storage, { phone: PHONE, chatId: "chat_1" }, 0);
      await checkGmail(storage, d);
      expect(sent).toEqual([]);
      expect(await storage.get(GMAIL_KEY)).toBeDefined();
    }
  });

  it("looks less often after half an hour, and gives up silently after a day", async () => {
    const storage = new MemoryStorage();
    let now = 0;
    const sent: Sent[] = [];
    const d = deps({ answer: () => ({ status: "waiting" }), sent, now: () => now });
    await watchForGmail(storage, { phone: PHONE, chatId: "chat_1" }, 0);
    now = GMAIL_SOON_FOR_MS;
    await checkGmail(storage, d);
    expect(storage.alarms.at(-1)).toBe(now + GMAIL_LATER_MS);
    now = GMAIL_GIVE_UP_MS;
    await checkGmail(storage, d);
    expect(sent).toEqual([]);
    expect(await storage.get(GMAIL_KEY)).toBeUndefined();
  });

  it("stops for a phone the control plane says is gone, and keeps looking through one that is down or not deployed yet", async () => {
    const gone = new MemoryStorage();
    const sent: Sent[] = [];
    await watchForGmail(gone, { phone: PHONE, chatId: "chat_1" }, 0);
    await checkGmail(gone, deps({ answer: () => ({ status: "gone" }), sent, now: () => GMAIL_FIRST_MS }));
    expect(await gone.get(GMAIL_KEY)).toBeUndefined();

    for (const status of [503, 404]) {
      const storage = new MemoryStorage();
      await watchForGmail(storage, { phone: PHONE, chatId: "chat_1" }, 0);
      await checkGmail(storage, deps({ answer: () => ({}), status: () => status, sent, now: () => GMAIL_FIRST_MS }));
      expect(await storage.get(GMAIL_KEY)).toBeDefined();
    }
    expect(sent).toEqual([]);
  });

  it("a refused send is tried again with the same key, and goes once", async () => {
    const storage = new MemoryStorage();
    let now = GMAIL_FIRST_MS;
    const sent: Sent[] = [];
    let linq = 500;
    const d = deps({ answer: () => ({ status: "connected", address: GMAIL, main: true }), linqStatus: () => linq, sent, now: () => now });
    await watchForGmail(storage, { phone: PHONE, chatId: "chat_1" }, 0);
    await checkGmail(storage, d);
    expect(sent).toEqual([]);
    linq = 200;
    now += GMAIL_SOON_MS;
    await checkGmail(storage, d);
    expect(sent.map((s) => s.idempotency)).toEqual(["gmail:0"]);
  });
});
