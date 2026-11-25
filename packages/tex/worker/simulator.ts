/**
 * The texts simulator: a staging-only way to text the assistant from a browser,
 * without Linq and without a real phone number.
 *
 *     browser ──/texts-simulator/api/send──▶ this Worker ──▶ the gateway's TexChat
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
import { cut } from "./inbound";
import type { Message } from "./reply";
import { chatInGateway } from "./gatewayChats";
import type { TextsBinding } from "./gatewaySession";
import { claim, clear, record, sha256Hex, SIMULATED_PHONE, thread } from "./simulatorLog";
import { handleSimulatorGroup, SIM_GROUP_PATH } from "./simulatorGroup";

// The simulator's log, claim and phone rules live in `simulatorLog.ts`; they are re-exported here for the 1:1 routes.
export { claim, clear, record, SIMULATED_PHONE, SIM_LOG_FOR_MS, SIM_LOG_LIMIT, thread, type SimEntry } from "./simulatorLog";

export const SIMULATOR_PATH = "/texts-simulator";

export function simulatorEnabled(value: string | undefined): boolean {
  return value === "on";
}

// ── The Worker's routes ───────────────────────────────────────────────────

/** `GATEWAY_TEXTS`: a simulated chat runs in the gateway, as every chat does (`handOver.ts`). */
export type SimulatorEnv = { GATEWAY_TEXTS?: TextsBinding };

const MAX_REQUEST_BYTES = 16 * 1024;
const KEY_PATTERN = /^[0-9a-f]{32,128}$/;

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

  // A simulated group (`simulatorGroup.ts`) has its own routes, bodies and object; it never takes a 1:1 number.
  const isGroup = path.startsWith(`${SIM_GROUP_PATH}/`);
  const action = isGroup ? undefined : { "/api/send": "send", "/api/thread": "thread", "/api/clear": "clear" }[path];
  if (!isGroup && action === undefined) return new Response(null, { status: 404 });
  if (!isGroup && request.method !== (action === "thread" ? "GET" : "POST")) return new Response(null, { status: 405 });

  const key = request.headers.get("x-simulator-key") ?? "";
  if (!KEY_PATTERN.test(key)) return new Response(null, { status: 401 });
  if (isGroup) return handleSimulatorGroup(request, env, path, await sha256Hex(key), url);

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
      text = typeof body.text === "string" ? cut(body.text.trim()) : "";
      if (text === "") return new Response(null, { status: 400 });
    }
  }
  if (phone === null || !SIMULATED_PHONE.test(phone)) return new Response(null, { status: 400 });

  const body = JSON.stringify({ keyHash: await sha256Hex(key), phone, text });
  // The simulated chat is the gateway's, born there on its first call, so the simulator proves the gateway's queue and
  // turns (step 3 of Tex's config graph); there is no other copy of it.
  return await chatInGateway(env, phone).fetch(`https://inbox/sim/${action}`, { method: "POST", body });
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
