import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { accept, carryOnAfterHandback, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { HANDBACK_EVERY_MS, HANDBACK_FIRST_MS, HANDBACK_GIVE_UP_MS, HANDBACK_KEY, HANDBACK_PATH, HANDBACK_SLOW_AFTER_MS, HANDBACK_SLOW_MS, watchForHandback } from "./handbackWatch";
import { GROUP_QUEUE, queueKey } from "./chatQueue";

/**
 * TEX CARRIES ON ONCE SOMEONE PRESSES DONE ON ITS TAKE-OVER SCREEN (Dev2,
 * 2026-11-12: "it should notify tex so it continues on").
 *
 * A turn whose answer names the browser it handed over (`handbackWatch`)
 * starts a watch; the watch asks the control plane until that browser was
 * handed back, then queues a turn with no words and
 * `event: "browser_handed_back"`. Never when they texted after Done, never
 * twice for one Done, and never past the browser's hold.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `reply.ts` not calling `onHandedOver`                                 1
 *   `carryOnAfterHandback` without the "texted since" check               1
 *   `checkHandedBack` without the give-up                                 1
 */

const PHONE = "+15555550100";
const BROWSER = "a".repeat(64);

const msg = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: "chat_1", from: PHONE, messageId: `m_${eventId}`, text });

type Asked = { question: string; event?: string };

function deps(opts: { now: () => number; asked: Asked[]; sent: string[]; looks: { since: number; browsers: string[] }[]; done: () => unknown; watch?: boolean }): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing") || path.endsWith("/read") || path.endsWith("/share_contact_card")) return new Response("{}", { status: 200 });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent-texts/handed-back") {
      opts.looks.push({ since: body.since, browsers: body.browsers });
      return Response.json(opts.done());
    }
    if (path === "/agent") {
      opts.asked.push({ question: body.question, ...(body.event ? { event: body.event } : {}) });
      const watch = opts.watch !== false && /book/.test(body.question);
      return Response.json({ answer: body.event ? "Thanks, booking it now." : "There's a captcha, here's the browser.", ...(watch ? { handbackWatch: BROWSER } : {}) });
    }
    if (path.endsWith("/messages")) {
      opts.sent.push(body.message.parts[0].value);
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now: opts.now };
}

describe("Done on the take-over screen carries the task on", () => {
  it("watches after a turn handed its browser over, and once Done is pressed, Tex carries on with no text from them", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    let doneAt: number | null = null;
    const asked: Asked[] = [];
    const sent: string[] = [];
    const looks: { since: number; browsers: string[] }[] = [];
    const d = deps({ now: () => now, asked, sent, looks, done: () => (doneAt === null ? { status: "waiting" } : { status: "done", doneAt }) });

    await accept(storage, msg("e1", "book the tee time"), now);
    await drain(storage, d);
    expect(sent).toEqual(["There's a captcha, here's the browser."]);
    expect(await storage.get(HANDBACK_KEY)).toMatchObject({ phone: PHONE, since: now, browsers: [BROWSER] });

    await carryOnAfterHandback(storage, d);
    expect(looks).toEqual([]);
    now += HANDBACK_FIRST_MS;
    await carryOnAfterHandback(storage, d);
    expect(looks).toEqual([{ since: 1_000, browsers: [BROWSER] }]);
    expect(storage.alarms.at(-1)).toBe(now + HANDBACK_EVERY_MS);

    doneAt = now + 1_000;
    now += HANDBACK_EVERY_MS;
    await carryOnAfterHandback(storage, d);
    expect(await storage.get(HANDBACK_KEY)).toBeUndefined();
    await drain(storage, d);
    expect(asked.at(-1)).toEqual({ question: "", event: "browser_handed_back" });
    expect(sent.at(-1)).toBe("Thanks, booking it now.");

    now += HANDBACK_EVERY_MS;
    await carryOnAfterHandback(storage, d);
    expect(asked.length).toBe(2);
  });

  it("a turn that handed nothing over starts no watch", async () => {
    const storage = new MemoryStorage();
    const d = deps({ now: () => 1_000, asked: [], sent: [], looks: [], done: () => ({ status: "waiting" }), watch: false });
    await accept(storage, msg("e1", "book the tee time"), 1_000);
    await drain(storage, d);
    expect(await storage.get(HANDBACK_KEY)).toBeUndefined();
  });

  it("a text after Done already carried it on, so nothing is queued", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const asked: Asked[] = [];
    const d = deps({ now: () => now, asked, sent: [], looks: [], done: () => ({ status: "done", doneAt: 2_000 }) });
    await watchForHandback(storage, PHONE, now, BROWSER);
    now = 3_000;
    await accept(storage, msg("e2", "done"), now);
    await drain(storage, d);
    now += HANDBACK_FIRST_MS;
    await carryOnAfterHandback(storage, d);
    await drain(storage, d);
    expect(asked.map((ask) => ask.event)).toEqual([undefined]);
  });

  it("looks less often after a few minutes, and stops past the browser's hold", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const looks: { since: number; browsers: string[] }[] = [];
    const d = deps({ now: () => now, asked: [], sent: [], looks, done: () => ({ status: "waiting" }) });
    await watchForHandback(storage, PHONE, now, BROWSER);
    now += HANDBACK_SLOW_AFTER_MS + 1;
    await carryOnAfterHandback(storage, d);
    expect(storage.alarms.at(-1)).toBe(now + HANDBACK_SLOW_MS);
    now = 1_000 + HANDBACK_GIVE_UP_MS;
    const before = looks.length;
    await carryOnAfterHandback(storage, d);
    expect(looks.length).toBe(before);
    expect(await storage.get(HANDBACK_KEY)).toBeUndefined();
  });

  it("a name that is not a browser hash starts no watch", async () => {
    const storage = new MemoryStorage();
    await watchForHandback(storage, PHONE, 1_000, "https://example.test/link");
    expect(await storage.get(HANDBACK_KEY)).toBeUndefined();
  });

  it("a browser handed over in a group chat: its Done is that chat's turn, under the ask, never a 1:1 text", async () => {
    const storage = new MemoryStorage();
    await watchForHandback(storage, PHONE, 1_000, BROWSER, { groupId: "grp_1", line: "+15555550199", messageId: "m_ask", text: "Tex book us a lane" });
    const d = deps({ now: () => 1_000 + HANDBACK_FIRST_MS, asked: [], sent: [], looks: [], done: () => ({ status: "done", doneAt: 1_500 }) });
    await carryOnAfterHandback(storage, d);
    await carryOnAfterHandback(storage, d);
    const queued = await storage.get<{ message: Record<string, unknown> }>(queueKey(GROUP_QUEUE, 1));
    expect(queued?.message).toMatchObject({
      kind: "group-message",
      groupId: "grp_1",
      from: PHONE,
      messageId: "m_ask",
      event: "browser_handed_back",
      routine: { runId: "handback:1500", path: HANDBACK_PATH },
    });
    expect(await storage.get(queueKey(GROUP_QUEUE, 2))).toBeUndefined();
    expect(await storage.get(queueKey({ counter: "seq", prefix: "pending:", max: 20 }, 1))).toBeUndefined();
  });
});
