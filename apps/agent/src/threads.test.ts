/**
 * A check-in that continues an earlier text goes as a reply under it
 * (Dev, 2026-10-19: "why isn't there continuity in the chat").
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `textRoutine` not passing the found thread to `sendText` → "a check-in
 *     continuing their text goes under it" and "…Tex's own earlier text…" fail.
 *  2. `threadUnder` returning the newest remembered handle whatever its words
 *     → "a check-in whose text matches nothing goes plain" fails.
 *  3. `sendSendblueText` dropping the send's `message_handle` → "…Tex's own
 *     earlier text…" fails.
 *  4. `rememberText` keeping the words instead of a hash → "keeps handles and
 *     hashes, never words, and only the last thirty" fails.
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { textRoutine } from "./routines";
import { sendblueChatId } from "./sendblue";
import { MAX_THREADS, rememberText, THREADS_KEY, threadUnder } from "./threads";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const KEYS = { keyId: "kid", secret: "ksecret" };
const CHAT = sendblueChatId(LINE, PHONE);

type Call = { path: string; body: Record<string, unknown> };

/** Sendblue, which names each accepted send's handle, and a gateway that answers with words. */
function fake(calls: Call[], status: (body: Record<string, unknown>) => number = () => 200): Fetch {
  let sent = 0;
  return (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const body = init.body === undefined ? {} : JSON.parse(String(init.body));
    if (parsed.host === "api.sendblue.com") {
      calls.push({ path: parsed.pathname, body });
      if (parsed.pathname === "/api/v2/contact-sharing/state") {
        return Response.json({ status: "OK", data: { hasProfile: true, publishRecordPresent: true } });
      }
      const code = status(body);
      if (parsed.pathname === "/api/send-message" && code === 200) {
        return Response.json({ status: "QUEUED", message_handle: `mh_out_${++sent}` });
      }
      return new Response('{"status":"ERROR"}', { status: code });
    }
    if (parsed.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (parsed.pathname === "/agent") return Response.json({ answer: "The lane hold expires at 5 PM today. Want me to draft a reply?" });
    throw new Error(`unexpected ${url}`);
  }) as unknown as Fetch;
}

const inboxDeps = (fetcher: Fetch): InboxDeps => ({
  fetch: fetcher,
  controlPlaneOrigin: "https://cp.example",
  workerSecret: "s",
  gatewayOrigin: "https://gw.example",
  linqApiKey: "linq-key",
  sendblue: KEYS,
  hostPicture: async () => "https://agent.example/media/abc/card.vcf",
  now: () => 1_000,
});

const routineDeps = (fetcher: Fetch) => ({ fetch: fetcher, linqApiKey: "linq-key", sendblue: KEYS, now: () => 2_000, simulator: false });

const message = (handle: string, text: string, chatId = CHAT): Message => ({
  kind: "message",
  eventId: `sendblue:${handle}`,
  chatId,
  from: PHONE,
  messageId: handle,
  text,
});

const checkIns = (calls: Call[]) =>
  calls.filter((c) => c.path === "/api/send-message" && String(c.body.content ?? "").startsWith("CHECK-IN"));

describe("a check-in goes under the text it continues", () => {
  it("a check-in continuing their text goes under it", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("mh_q", "can you   hold the lane\ntill 5?"), 1_000);
    const calls: Call[] = [];
    const texted = await textRoutine(
      storage,
      // As the gateway keeps their turn: their words, then a line naming what they attached.
      { text: "CHECK-IN: the hold is confirmed.", idempotencyKey: "heartbeat:r:p", continues: "can you hold the lane till 5?\n[They sent: photo.jpg]" },
      routineDeps(fake(calls)),
    );
    expect(texted).toBe("texted");
    expect(checkIns(calls).map((c) => c.body.reply_to)).toEqual([{ message_handle: "mh_q" }]);
  });

  it("a check-in continuing Tex's own earlier text goes under that text, by the handle Sendblue gave its send", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("mh_hi", "what's on today"), 1_000);
    const calls: Call[] = [];
    await drain(storage, inboxDeps(fake(calls)));
    // The gateway's copy of Tex's answer is before formatting: Markdown and all.
    await textRoutine(
      storage,
      { text: "CHECK-IN: still want that reply drafted?", idempotencyKey: "k", continues: "The **lane hold** expires at 5 PM today. Want me to draft a reply?" },
      routineDeps(fake(calls)),
    );
    expect(checkIns(calls).map((c) => c.body.reply_to)).toEqual([{ message_handle: "mh_out_1" }]);
  });

  it("a check-in whose text matches nothing goes plain, as does one with nothing to continue", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("mh_q", "can you hold the lane till 5?"), 1_000);
    const calls: Call[] = [];
    await textRoutine(storage, { text: "CHECK-IN: one", idempotencyKey: "k1", continues: "what's the Oct 30 pricing" }, routineDeps(fake(calls)));
    await textRoutine(storage, { text: "CHECK-IN: two", idempotencyKey: "k2" }, routineDeps(fake(calls)));
    // A shorter remembered text the words do not run on past at a word's end is no match.
    await textRoutine(storage, { text: "CHECK-IN: three", idempotencyKey: "k3", continues: "can you hold the lane till 5?!" }, routineDeps(fake(calls)));
    expect(checkIns(calls).map((c) => c.body.reply_to)).toEqual([undefined, undefined, undefined]);
  });

  it("only this chat's texts are threaded under, and a thread Sendblue refuses still goes, plain", async () => {
    const storage = new MemoryStorage();
    const other = sendblueChatId("+15555550198", PHONE);
    await accept(storage, message("mh_other", "can you hold the lane till 5?", other), 1_000);
    expect(await threadUnder(storage, CHAT, "can you hold the lane till 5?")).toBeUndefined();
    await accept(storage, message("mh_q", "can you hold the lane till 5?"), 1_000);
    const calls: Call[] = [];
    const texted = await textRoutine(
      storage,
      { text: "CHECK-IN: confirmed.", idempotencyKey: "k", continues: "can you hold the lane till 5?" },
      routineDeps(fake(calls, (body) => (body.reply_to ? 400 : 200))),
    );
    expect(texted).toBe("texted");
    expect(checkIns(calls).map((c) => c.body.reply_to)).toEqual([{ message_handle: "mh_q" }, undefined]);
  });

  it("keeps handles and hashes, never words, and only the last thirty; a Linq chat keeps nothing", async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < MAX_THREADS + 5; i += 1) await rememberText(storage, CHAT, `mh_${i}`, `secret words number ${i}`, i);
    await rememberText(storage, "linq_chat", "m_linq", "linq words", 1);
    const kept = (await storage.get<{ id: string }[]>(THREADS_KEY)) ?? [];
    expect(kept).toHaveLength(MAX_THREADS);
    expect(kept[0].id).toBe("mh_5");
    expect(JSON.stringify([...storage.data.entries()])).not.toMatch(/secret words|linq words|m_linq/);
    expect(await threadUnder(storage, CHAT, "secret words number 7")).toBe("mh_7");
    expect(await threadUnder(storage, CHAT, "secret words number 2")).toBeUndefined();
  });

  it("the newest of two texts that start alike is the one gone under", async () => {
    const storage = new MemoryStorage();
    await rememberText(storage, CHAT, "mh_old", "ok", 1);
    await rememberText(storage, CHAT, "mh_long", "ok so the hold", 2);
    await rememberText(storage, CHAT, "mh_new", "ok", 3);
    expect(await threadUnder(storage, CHAT, "ok")).toBe("mh_new");
    // The same opening words win over a shorter text it runs on past.
    expect(await threadUnder(storage, CHAT, "ok so the hold")).toBe("mh_long");
    expect(await threadUnder(storage, CHAT, "ok so the hold ends at five")).toBe("mh_long");
  });
});
