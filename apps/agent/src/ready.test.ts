import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import {
  checkReady,
  oweReadyText,
  READY_COPY,
  READY_EVERY_MS,
  READY_FIRST_MS,
  READY_GIVE_UP_MS,
  READY_KEY,
  type ReadyDeps,
} from "./ready";

/**
 * THE TEXT TEX OWES SOMEBODY SET UP BY TEXT, ONCE THEIR NOTES ARE READY
 * (Dev2, 2026-10-18). Sent once, to the chat they set up from, with the link
 * the control plane built and no other; never before the notes are ready.
 */

const PHONE = "+15555550100";
const LINK = "https://app.example/signin/" + "a".repeat(64);

type Sent = { chatId: string; text: string; idempotency: string };

function deps(opts: { ready: () => unknown; status?: () => number; linqStatus?: () => number; sent: Sent[]; now: () => number; asked?: string[] }): ReadyDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path === "/agent-texts/ready") {
      opts.asked?.push(body.phone);
      return Response.json(opts.ready(), { status: opts.status?.() ?? 200 });
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

describe("the ready text", () => {
  it("waits for the first look, then asks until the notes are ready, and texts the line and the link once", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const sent: Sent[] = [];
    const asked: string[] = [];
    let ready = false;
    const d = deps({ ready: () => (ready ? { status: "ready", url: LINK } : { status: "waiting" }), sent, asked, now: () => now });

    await oweReadyText(storage, { phone: PHONE, chatId: "chat_1" }, now);
    expect(storage.alarms).toEqual([1_000 + READY_FIRST_MS]);

    // An alarm for something else, before the first look, asks nothing.
    await checkReady(storage, d);
    expect(asked).toEqual([]);

    now += READY_FIRST_MS;
    await checkReady(storage, d);
    expect(asked).toEqual([PHONE]);
    expect(sent).toEqual([]);
    expect(storage.alarms.at(-1)).toBe(now + READY_EVERY_MS);

    ready = true;
    now += READY_EVERY_MS;
    await checkReady(storage, d);
    expect(sent.map((s) => s.text)).toEqual([READY_COPY.ready, LINK]);
    expect(sent.every((s) => s.chatId === "chat_1")).toBe(true);
    expect(await storage.get(READY_KEY)).toBeUndefined();

    now += READY_EVERY_MS;
    await checkReady(storage, d);
    expect(sent).toHaveLength(2);
  });

  it("never texts a link that is not an https link to a path", async () => {
    for (const url of ["http://app.example/signin/x", "javascript:alert(1)", "https://app.example", 42]) {
      const storage = new MemoryStorage();
      const sent: Sent[] = [];
      const d = deps({ ready: () => ({ status: "ready", url }), sent, now: () => READY_FIRST_MS });
      await oweReadyText(storage, { phone: PHONE, chatId: "chat_1" }, 0);
      await checkReady(storage, d);
      expect(sent).toEqual([]);
      expect(await storage.get(READY_KEY)).toBeDefined();
    }
  });

  it("stops asking for a phone the control plane says is gone, and texts nothing", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    const d = deps({ ready: () => ({ status: "gone" }), sent, now: () => READY_FIRST_MS });
    await oweReadyText(storage, { phone: PHONE, chatId: "chat_1" }, 0);
    await checkReady(storage, d);
    expect(sent).toEqual([]);
    expect(await storage.get(READY_KEY)).toBeUndefined();
  });

  it("after twenty minutes of waiting, says it is taking longer and owes nothing more", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    const d = deps({ ready: () => ({ status: "waiting" }), sent, now: () => READY_GIVE_UP_MS });
    await oweReadyText(storage, { phone: PHONE, chatId: "chat_1" }, 0);
    await checkReady(storage, d);
    expect(sent.map((s) => s.text)).toEqual([READY_COPY.late]);
    expect(await storage.get(READY_KEY)).toBeUndefined();
  });

  it("keeps waiting through a control plane that is down", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    const d = deps({ ready: () => ({}), status: () => 503, sent, now: () => READY_FIRST_MS });
    await oweReadyText(storage, { phone: PHONE, chatId: "chat_1" }, 0);
    await checkReady(storage, d);
    expect(sent).toEqual([]);
    expect(await storage.get(READY_KEY)).toBeDefined();
  });

  it("a refused send is tried again with the same keys, and the text goes once", async () => {
    const storage = new MemoryStorage();
    let now = READY_FIRST_MS;
    const sent: Sent[] = [];
    let linq = 500;
    const d = deps({ ready: () => ({ status: "ready", url: LINK }), linqStatus: () => linq, sent, now: () => now });
    await oweReadyText(storage, { phone: PHONE, chatId: "chat_1" }, 0);
    await checkReady(storage, d);
    expect(sent).toEqual([]);
    expect(await storage.get(READY_KEY)).toBeDefined();
    linq = 200;
    now += READY_EVERY_MS;
    await checkReady(storage, d);
    expect(sent.map((s) => s.idempotency)).toEqual(["ready:0:0", "ready:0:1"]);
  });
});
