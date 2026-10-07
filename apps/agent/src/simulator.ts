/**
 * The texts simulator: a staging-only way to text the assistant from a browser,
 * without Linq and without a real phone number.
 *
 *     browser ──/texts-simulator/api/send──▶ this Worker ──▶ SenderInbox
 *                                                              │  alarm, same
 *                                                              ▼  replyTo()
 *     browser ◀──/texts-simulator/api/thread── the inbox's simulator log
 *
 * A simulated text enters the same per-sender queue as a Linq delivery and is
 * answered by the same `replyTo`; only the last hop differs, where the reply is
 * written to a short log in the sender's Durable Object instead of sent.
 *
 * Why this cannot be used to answer as someone's real phone:
 * - It is off unless the Worker's `SIMULATOR` var is "on", which only the
 *   staging environment sets. Production answers 404, and its deploy checks.
 * - The sender must be a number in 555-0100 to 555-0199, which is reserved for
 *   fiction in every North American area code, so it is never a real phone's
 *   number, and a Linq delivery never comes from one.
 * - The first browser to use a number claims it with a random key (sent as a
 *   header, never in a URL). Its hash is all that is stored, and every later
 *   read or send for that number must present the same key.
 * Linking still goes through the real sign-in link, so a simulated number
 * answers only from the staging account its user signed in to.
 */

import type { InboxStorage } from "./inbox";
import { MAX_INBOUND_TEXT } from "./inbound";
import type { Message } from "./reply";

export const SIMULATOR_PATH = "/texts-simulator";

/** +1, a real area code, then 555-01XX: the numbers set aside for fiction. */
export const SIMULATED_PHONE = /^\+1[2-9]\d{2}55501\d{2}$/;

/** The log keeps the newest entries for a day, and never more than this many. */
export const SIM_LOG_LIMIT = 100;
export const SIM_LOG_FOR_MS = 24 * 60 * 60 * 1000;

const KEY_HASH = "sim:key";
const LOG_SEQ = "sim:seq";
const logKey = (seq: number) => `sim:log:${String(seq).padStart(12, "0")}`;

export type SimEntry = { id: number; dir: "in" | "out"; text: string; at: number };

export function simulatorEnabled(value: string | undefined): boolean {
  return value === "on";
}

/**
 * The first key presented for a number claims it; afterwards only that key
 * opens it. Clearing the chat keeps the claim, so a cleared number cannot be
 * picked up by another browser.
 */
export async function claim(storage: InboxStorage, keyHash: string): Promise<boolean> {
  const held = await storage.get<string>(KEY_HASH);
  if (held === undefined) {
    await storage.put(KEY_HASH, keyHash);
    return true;
  }
  return held === keyHash;
}

/** Append one bubble to the log, then trim it by age and count. */
export async function record(storage: InboxStorage, dir: SimEntry["dir"], text: string, now: number): Promise<void> {
  const seq = ((await storage.get<number>(LOG_SEQ)) ?? 0) + 1;
  await storage.put(LOG_SEQ, seq);
  await storage.put<SimEntry>(logKey(seq), { id: seq, dir, text, at: now });
  const entries = [...(await storage.list<SimEntry>({ prefix: "sim:log:" }))];
  const excess = entries.length - SIM_LOG_LIMIT;
  for (const [index, [key, entry]] of entries.entries()) {
    if (index < excess || now - entry.at > SIM_LOG_FOR_MS) await storage.delete(key);
  }
}

/** What the page draws: the log, and whether an answer is still being worked on. */
export async function thread(storage: InboxStorage, now: number): Promise<{ messages: SimEntry[]; typing: boolean }> {
  const entries = [...(await storage.list<SimEntry>({ prefix: "sim:log:" })).values()];
  const pending = await storage.list<unknown>({ prefix: "pending:" });
  return {
    messages: entries.filter((entry) => now - entry.at <= SIM_LOG_FOR_MS),
    typing: pending.size > 0,
  };
}

export async function clear(storage: InboxStorage): Promise<void> {
  for (const key of (await storage.list<SimEntry>({ prefix: "sim:log:" })).keys()) await storage.delete(key);
}

// ── The Worker's routes ───────────────────────────────────────────────────

export type SimulatorEnv = { SENDER_INBOX: DurableObjectNamespace };

const MAX_REQUEST_BYTES = 16 * 1024;
const KEY_PATTERN = /^[0-9a-f]{32,128}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // The page talks only to its own API. Its sign-in link cards are plain
  // anchors, which a CSP does not govern.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Every route under /texts-simulator. The caller has already checked it is on. */
export async function handleSimulator(request: Request, env: SimulatorEnv, page: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(SIMULATOR_PATH.length);

  if (path === "" || path === "/") {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    return new Response(page, { headers: PAGE_HEADERS });
  }

  const action = { "/api/send": "send", "/api/thread": "thread", "/api/clear": "clear" }[path];
  if (action === undefined) return new Response(null, { status: 404 });
  if (request.method !== (action === "thread" ? "GET" : "POST")) return new Response(null, { status: 405 });

  const key = request.headers.get("x-simulator-key") ?? "";
  if (!KEY_PATTERN.test(key)) return new Response(null, { status: 401 });

  let phone: string | null = url.searchParams.get("phone");
  let text = "";
  if (action !== "thread") {
    const raw = await request.text();
    if (raw.length > MAX_REQUEST_BYTES) return new Response(null, { status: 413 });
    let body: { phone?: unknown; text?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response(null, { status: 400 });
    }
    phone = typeof body.phone === "string" ? body.phone : null;
    if (action === "send") {
      text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_INBOUND_TEXT) : "";
      if (text === "") return new Response(null, { status: 400 });
    }
  }
  if (phone === null || !SIMULATED_PHONE.test(phone)) return new Response(null, { status: 400 });

  const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(phone));
  return stub.fetch(`https://inbox/sim/${action}`, {
    method: "POST",
    body: JSON.stringify({ keyHash: await sha256Hex(key), phone, text }),
  });
}

/** The Durable Object's side: one sender's claim, log and queue. */
export async function simulatorInbox(
  storage: InboxStorage,
  action: string,
  body: { keyHash: string; phone: string; text: string },
  now: number,
  enqueue: (message: Message) => Promise<string>,
): Promise<Response> {
  if (!(await claim(storage, body.keyHash))) return new Response(null, { status: 409 });
  if (action === "thread") return Response.json(await thread(storage, now));
  if (action === "clear") {
    await clear(storage);
    return Response.json({ ok: true });
  }
  if (action !== "send") return new Response(null, { status: 404 });

  await record(storage, "out", body.text, now);
  const id = crypto.randomUUID();
  const outcome = await enqueue({
    kind: "message",
    channel: "simulator",
    eventId: `sim_${id}`,
    chatId: `sim:${body.phone}`,
    from: body.phone,
    messageId: id,
    text: body.text,
  });
  return Response.json({ outcome }, { status: outcome === "full" ? 429 : 200 });
}
