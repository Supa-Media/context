"use strict";

/**
 * A bot's webhook call, the parts both sides agree on: the signing key's
 * shape (made in the app, shown once, sealed by the control plane), the
 * header a person may add, and the body every call carries. The control
 * plane signs (`apps/convex/functions/botHooks.ts`); the bot checks.
 * See `docs/decisions/app-and-console/area-bots.md`.
 *
 *   x-context-timestamp: <unix seconds>
 *   x-context-signature: v1=<hex HMAC-SHA256(key, "<timestamp>.<body>")>
 *
 * The body says mail arrived and where, never what it says:
 *   {"type":"mail","workspace":"@supa","bot":"finance","from":"@seyi",
 *    "area":"areas/finance","note":"areas/finance/mail/seyi.md","at":"…"}
 *
 * An area's routine that came due says which routine, never its words; the bot
 * reads the note and answers in the area's mail:
 *   {"type":"routine","workspace":"@supa","bot":"grok-bot","from":"context",
 *    "area":"areas/operations/Scorecard",
 *    "note":"areas/operations/Scorecard/routines/weekly/score-every-area.md","at":"…"}
 */

const KEY_PREFIX = "ctxbot_";
const KEY_SHAPE = /^ctxbot_[0-9a-f]{64}$/;
/** How long a bot has to answer one call. */
const HOOK_TIMEOUT_MS = 10_000;

/** A new signing key from 32 random bytes; `random` fills a byte array (Web Crypto's `getRandomValues`). */
function makeSigningKey(random) {
  const bytes = new Uint8Array(32);
  random(bytes);
  return KEY_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function signingKeyShaped(key) {
  return typeof key === "string" && KEY_SHAPE.test(key);
}

/** Headers a person may not set: the ones the call itself owns, and the ones a proxy would act on. */
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "transfer-encoding", "connection", "user-agent", "cookie",
  "x-context-timestamp", "x-context-signature", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded",
]);

/** `Name: value` as `{name, value}`, or null when it is not a header a person may add. */
function headerLine(raw) {
  const match = /^\s*([A-Za-z0-9-]{1,64})\s*:\s*([\x20-\x7e]{1,1024}?)\s*$/.exec(String(raw ?? ""));
  if (match === null) return null;
  const name = match[1].toLowerCase();
  if (RESERVED_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("sec-")) return null;
  return { name, value: match[2] };
}

/** The body a call carries, with only the fields it may: no message, no address, nothing else. */
function hookPayload(input) {
  const type = input.type === "mail" || input.type === "routine" ? input.type : "test";
  const out = { type, workspace: String(input.workspace ?? ""), bot: String(input.bot ?? ""), from: String(input.from ?? "") };
  if (out.type !== "test") {
    out.area = String(input.area ?? "");
    out.note = String(input.note ?? "");
  }
  out.at = new Date(input.at ?? Date.now()).toISOString();
  return out;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The hex HMAC-SHA256 of `"<timestamp>.<body>"` under the key. */
async function signHook(key, timestamp, body) {
  const encoder = new TextEncoder();
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", imported, encoder.encode(`${timestamp}.${body}`)));
}

module.exports = { HOOK_TIMEOUT_MS, makeSigningKey, signingKeyShaped, headerLine, hookPayload, signHook };
