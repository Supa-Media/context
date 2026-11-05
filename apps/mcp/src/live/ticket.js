/**
 * Live-socket tickets: how the app's sockets authenticate without putting an
 * access token on the socket.
 *
 * A browser `WebSocket` cannot set an `Authorization` header. The sockets once
 * carried the console token in the URL (`/t/<token>/presence`), then in a
 * subprotocol (`context.token.<token>`). Both put a reusable credential where a
 * handshake log, a proxy or a crash report can keep it. A ticket replaces it:
 *
 * 1. The app asks `POST /presence/ticket` with its token in the
 *    `Authorization` header, naming the one socket it is about to open.
 * 2. The gateway resolves the token (a refused token gets no ticket) and
 *    answers a ticket: the token sealed with AES-GCM under a key derived from
 *    `GATEWAY_SECRET`, bound to that socket path and workspace selector, with a
 *    random nonce and an expiry `TICKET_TTL_MS` away.
 * 3. The socket offers `context.ticket.<ticket>` beside its protocol. The
 *    gateway opens it, spends its nonce in that nonce's own `LiveTicket`
 *    object (a second spend is refused) and resolves the token inside exactly
 *    as before, so revocation, expiry and every clamp are unchanged.
 *
 * What a captured ticket is worth: one socket, of the kind it was minted for,
 * within a minute, and only if nobody used it first, which the app always
 * does at once. The token inside never leaves the gateway in the clear, and
 * nothing is stored but a spent nonce, deleted by an alarm after it expires.
 */
import { decodeBase64, encodeBase64 } from "../crypto/bytes.js";
import { objectByName } from "../objectPlace.js";
import { SessionRefusal, bearerToken, resolveSession } from "../session.js";
import { createControlPlane } from "../controlPlane.js";
import { forbiddenResponse, unauthorizedResponse } from "../oauth.js";
import { json } from "../http/responses.js";
import { readBoundedRequestBytes } from "./collaborationHttp.js";
import { TREE_SOCKET_PATH } from "../../../../packages/shared/src/treeFrames.cjs";
import { ACCESS_SOCKET_PATH } from "../../../../packages/shared/src/accessFrames.cjs";
import { LIVE_TICKET_PATH, TICKET_PROTOCOL_PREFIX } from "../../../../packages/shared/src/liveTicket.cjs";

export { LIVE_TICKET_PATH, TICKET_PROTOCOL_PREFIX };

/** How long a ticket can wait to be spent. The app spends it within a second. */
export const TICKET_TTL_MS = 60_000;
/** The sockets a ticket can open. Kept here rather than imported from each route, so this module imports no route. */
export const TICKET_SOCKETS = Object.freeze(["/presence", TREE_SOCKET_PATH, ACCESS_SOCKET_PATH, "/tex/page/live"]);

const PREFIX = "t1.";
const LABEL = "context.live-ticket.v1";
const MAX_TICKET_CHARS = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const secretOf = (env) => (typeof env?.GATEWAY_SECRET === "string" && env.GATEWAY_SECRET.length >= 16 ? env.GATEWAY_SECRET : null);

async function ticketKey(secret, usage) {
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(LABEL)));
  return crypto.subtle.importKey("raw", derived, "AES-GCM", false, [usage]);
}

const toUrlSafe = (base64) => base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A ticket for `token` on `socket` under `slug`, or null when this deployment has no secret to seal with. */
export async function sealTicket(env, { token, socket, slug }, now = Date.now()) {
  const secret = secretOf(env);
  if (secret === null) return null;
  const body = { k: token, p: socket, s: slug ?? null, n: hex(crypto.getRandomValues(new Uint8Array(16))), e: now + TICKET_TTL_MS };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(LABEL) }, await ticketKey(secret, "encrypt"), encoder.encode(JSON.stringify(body))),
  );
  const joined = new Uint8Array(iv.length + sealed.length);
  joined.set(iv);
  joined.set(sealed, iv.length);
  return { ticket: `${PREFIX}${toUrlSafe(encodeBase64(joined))}`, expiresAt: body.e };
}

/**
 * What a ticket holds, when it was sealed here for this socket and selector and
 * has not expired; otherwise null. Does not spend it: `redeemTicket` does.
 */
export async function openTicket(env, ticket, { socket, slug }, now = Date.now()) {
  const secret = secretOf(env);
  if (secret === null || typeof ticket !== "string" || !ticket.startsWith(PREFIX) || ticket.length > MAX_TICKET_CHARS) return null;
  try {
    const joined = decodeBase64(ticket.slice(PREFIX.length));
    if (joined.length < 13) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: joined.subarray(0, 12), additionalData: encoder.encode(LABEL) },
      await ticketKey(secret, "decrypt"),
      joined.subarray(12),
    );
    const body = JSON.parse(decoder.decode(plain));
    if (!body || typeof body.k !== "string" || typeof body.n !== "string" || !Number.isFinite(body.e)) return null;
    if (body.p !== socket || (body.s ?? null) !== (slug ?? null)) return null;
    if (body.e <= now) return null;
    return { token: body.k, nonce: body.n, expiresAt: body.e };
  } catch {
    return null;
  }
}

/** Mark a nonce spent in its own object. True only for the first spend. */
export async function spendNonce(env, nonce, expiresAt) {
  if (!env?.LIVE_TICKET) return false;
  const stub = objectByName(env.LIVE_TICKET, `ticket:${nonce}`);
  try {
    const answer = await stub.fetch(new Request("https://ticket.invalid/spend", { method: "POST", body: JSON.stringify({ expiresAt }) }));
    return answer.status === 200;
  } catch {
    return false;
  }
}

/** The ticket a socket offered beside `protocol`, or null. */
export function offeredTicket(request, protocol) {
  const offered = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((entry) => entry.trim());
  if (!offered.includes(protocol)) return null;
  const entry = offered.find((value) => value.startsWith(TICKET_PROTOCOL_PREFIX));
  const ticket = entry === undefined ? "" : entry.slice(TICKET_PROTOCOL_PREFIX.length);
  return ticket || null;
}

/**
 * The session a ticket opens: open it, spend it and resolve the token inside,
 * the spend and the resolve side by side. Refused, byte for byte as a bad
 * token is, when the ticket is forged, expired, for another socket or
 * selector, or already spent.
 */
export async function redeemTicket(env, ticket, { socket, slug, controlPlane }) {
  const opened = await openTicket(env, ticket, { socket, slug });
  if (opened === null) throw new SessionRefusal(401, "invalid_token", "The access token is invalid or expired.");
  const [spent, session] = await Promise.all([
    spendNonce(env, opened.nonce, opened.expiresAt),
    resolveSession(opened.token, slug, controlPlane, { kind: "header" }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
  ]);
  if (!spent) throw new SessionRefusal(401, "invalid_token", "The access token is invalid or expired.");
  if (session.error) throw session.error;
  return session.value;
}

/**
 * `POST /presence/ticket` with `{"socket": "/presence"}` and the token in the
 * `Authorization` header: a ticket for that socket, or the refusal the token
 * would get anywhere else. The header only: a token in the URL is exactly what
 * this route exists to keep out of one.
 */
export async function handleLiveTicket(request, env, { slug, pathToken, origin }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (pathToken) return json({ error: "invalid_request", error_description: "Send the token in the Authorization header." }, 400);
  if (!env.LIVE_TICKET || secretOf(env) === null) return json({ error: "tickets_unavailable" }, 501);
  let body;
  try {
    const bytes = await readBoundedRequestBytes(request, 1024);
    if (bytes === null) return json({ error: "request_too_large" }, 413);
    body = JSON.parse(decoder.decode(bytes));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const socket = body && typeof body === "object" ? body.socket : null;
  if (typeof socket !== "string" || !TICKET_SOCKETS.includes(socket)) return json({ error: "invalid_socket" }, 400);

  const controlPlane = createControlPlane(env);
  const token = bearerToken(request);
  try {
    await resolveSession(token, slug, controlPlane, token ? { kind: "header" } : null);
  } catch (error) {
    if (!(error instanceof SessionRefusal)) throw error;
    return error.status === 403 ? forbiddenResponse(origin, null, error) : unauthorizedResponse(origin, slug, error);
  }
  const sealed = await sealTicket(env, { token, socket, slug });
  if (sealed === null) return json({ error: "tickets_unavailable" }, 501);
  return json({ ticket: sealed.ticket, expiresAt: sealed.expiresAt });
}

/**
 * One ticket's spent mark: a Durable Object per nonce, so "spent once" is
 * decided in one place without a table every socket shares. It stores one key,
 * and an alarm deletes it a minute after the ticket would have expired anyway.
 */
export class LiveTicketObject {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let expiresAt = Date.now() + TICKET_TTL_MS;
    try {
      const body = await request.json();
      if (Number.isFinite(body?.expiresAt)) expiresAt = Math.min(body.expiresAt, Date.now() + TICKET_TTL_MS);
    } catch {
      // A spend with no body still spends; it just keeps the mark a full TTL.
    }
    // No await between the read and the write but the storage calls themselves,
    // which the object's input gate holds every other request behind: two
    // spends of one nonce cannot both read "unspent".
    if (await this.state.storage.get("spent")) return new Response(null, { status: 409 });
    await this.state.storage.put("spent", 1);
    await this.state.storage.setAlarm(expiresAt + TICKET_TTL_MS);
    return new Response(null, { status: 200 });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
