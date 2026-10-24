import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { accept, carryOnAfterSave, drain, type InboxDeps } from "./inbox";
import { chatJobs, readJobUpdate, startJobs } from "./jobs";
import { jobUpdate } from "./jobTexts";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { VAULT_EVERY_MS, VAULT_FIRST_MS, VAULT_GIVE_UP_MS, VAULT_KEY, VAULT_SLACK_MS, watchForSave } from "./vaultWatch";

/**
 * TEX CARRIES THE TASK ON ONCE THE LOGIN IT ASKED FOR IS SAVED (Dev2,
 * 2026-10-24: "after adding the email and password Tex should know that i'm
 * done adding").
 *
 * A turn whose answer says it texted a save link starts a watch; the watch
 * asks the control plane until the save lands, then queues a turn with no
 * words and `event: "vault_saved"`, answered in the chat they last texted
 * from. Never when they texted after saving, never twice for one save, and
 * never past the link's life.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `reply.ts` not calling `onVaultLink`                                  1
 *   `carryOnAfterSave` without the "texted since" check                   1
 *   `carryOnAfterSave` without the seen check                             1
 */

const PHONE = "+15555550100";

const msg = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: "chat_1", from: PHONE, messageId: `m_${eventId}`, text });

type Asked = { question: string; event?: string };

function deps(opts: { now: () => number; asked: Asked[]; sent: string[]; looks: { since: number }[]; saved: () => unknown; watch?: boolean }): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing") || path.endsWith("/read") || path.endsWith("/share_contact_card")) return new Response("{}", { status: 200 });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent-texts/vault-saved") {
      opts.looks.push({ since: body.since });
      return Response.json(opts.saved());
    }
    if (path === "/agent") {
      opts.asked.push({ question: body.question, ...(body.event ? { event: body.event } : {}) });
      const watch = opts.watch !== false && /instacart/.test(body.question);
      return Response.json({ answer: body.event ? "Signed in. Building your cart now." : "Here's the link to save it.", ...(watch ? { vaultWatch: true } : {}) });
    }
    if (path.endsWith("/messages")) {
      opts.sent.push(body.message.parts[0].value);
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now: opts.now };
}

describe("a saved login carries the task on", () => {
  it("watches after a turn texted the link, and once it is saved, Tex carries on with no text from them", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    let savedAt: number | null = null;
    const asked: Asked[] = [];
    const sent: string[] = [];
    const looks: { since: number }[] = [];
    const d = deps({ now: () => now, asked, sent, looks, saved: () => (savedAt === null ? { status: "waiting" } : { status: "saved", savedAt }) });

    await accept(storage, msg("e1", "order my groceries on instacart"), now);
    await drain(storage, d);
    expect(sent).toEqual(["Here's the link to save it."]);
    expect(await storage.get(VAULT_KEY)).toMatchObject({ phone: PHONE, since: now });

    // Not yet due, then due and still waiting.
    await carryOnAfterSave(storage, d);
    expect(looks).toEqual([]);
    now += VAULT_FIRST_MS;
    await carryOnAfterSave(storage, d);
    expect(looks).toEqual([{ since: 1_000 - VAULT_SLACK_MS }]);
    expect(storage.alarms.at(-1)).toBe(now + VAULT_EVERY_MS);

    savedAt = now + 5_000;
    now += VAULT_EVERY_MS;
    await carryOnAfterSave(storage, d);
    expect(await storage.get(VAULT_KEY)).toBeUndefined();
    await drain(storage, d);
    expect(asked.at(-1)).toEqual({ question: "", event: "vault_saved" });
    expect(sent.at(-1)).toBe("Signed in. Building your cart now.");
    expect([...storage.data.keys()].filter((key) => key.startsWith("pending:"))).toEqual([]);

    // Nothing more is looked for or queued.
    now += VAULT_EVERY_MS;
    await carryOnAfterSave(storage, d);
    expect(asked.length).toBe(2);
  });

  it("a turn that texted no link starts no watch", async () => {
    const storage = new MemoryStorage();
    const d = deps({ now: () => 1_000, asked: [], sent: [], looks: [], saved: () => ({ status: "waiting" }), watch: false });
    await accept(storage, msg("e1", "order my groceries on instacart"), 1_000);
    await drain(storage, d);
    expect(await storage.get(VAULT_KEY)).toBeUndefined();
  });

  it("a text after the save already carried it on, so nothing is queued", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const asked: Asked[] = [];
    const d = deps({ now: () => now, asked, sent: [], looks: [], saved: () => ({ status: "saved", savedAt: 2_000 }) });
    await watchForSave(storage, PHONE, now);
    now = 3_000;
    await accept(storage, msg("e2", "done"), now);
    await drain(storage, d);
    now += VAULT_FIRST_MS;
    await carryOnAfterSave(storage, d);
    await drain(storage, d);
    expect(asked.map((ask) => ask.event)).toEqual([undefined]);
  });

  it("one save queues one turn, and the look ends with the link's life", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const looks: { since: number }[] = [];
    const asked: Asked[] = [];
    await storage.put("chat", { chatId: "chat_1", at: 500 });
    const d = deps({ now: () => now, asked, sent: [], looks, saved: () => ({ status: "saved", savedAt: 900 }) });
    for (let i = 0; i < 2; i += 1) {
      await watchForSave(storage, PHONE, now);
      now += VAULT_FIRST_MS;
      await carryOnAfterSave(storage, d);
    }
    await drain(storage, d);
    expect(asked).toEqual([{ question: "", event: "vault_saved" }]);

    const waiting = deps({ now: () => now, asked, sent: [], looks, saved: () => ({ status: "waiting" }) });
    await watchForSave(storage, PHONE, now);
    now += VAULT_GIVE_UP_MS;
    const before = looks.length;
    await carryOnAfterSave(storage, waiting);
    expect(looks.length).toBe(before);
    expect(await storage.get(VAULT_KEY)).toBeUndefined();
  });

  it("a gone answer ends the look quietly", async () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    await storage.put("chat", { chatId: "chat_1", at: 500 });
    const asked: Asked[] = [];
    const d = deps({ now: () => now, asked, sent: [], looks: [], saved: () => ({ status: "gone" }) });
    await watchForSave(storage, PHONE, now);
    now += VAULT_FIRST_MS;
    await carryOnAfterSave(storage, d);
    await drain(storage, d);
    expect(await storage.get(VAULT_KEY)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("a background job that texted the link starts the watch in its chat's inbox", async () => {
    const storage = new MemoryStorage();
    await startJobs(storage, [{ title: "Instacart order", brief: "b" }], {
      now: 1_000,
      inbox: PHONE,
      origin: { kind: "phone", phone: PHONE, question: "order my groceries on instacart" },
      place: { chatId: "chat_1", messageId: "m_ask" },
      spawn: async () => {},
    });
    const [id] = (await chatJobs(storage, 1_000)).map((job) => job.id);
    const d = deps({ now: () => 2_000, asked: [], sent: [], looks: [], saved: () => ({ status: "waiting" }) });
    const update = readJobUpdate({ id, state: "done", status: "Sent the link.", texts: ["Here's the link to save it."], first: 0, vaultWatch: PHONE });
    expect(update?.vaultWatch).toBe(PHONE);
    expect(await jobUpdate(storage, d, update!)).toBe(true);
    expect(await storage.get(VAULT_KEY)).toMatchObject({ phone: PHONE, since: 2_000 });
  });
});
