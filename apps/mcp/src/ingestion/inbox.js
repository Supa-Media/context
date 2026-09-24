/**
 * Helpers for captures arriving through `/inbox` and email: size cap, slugs,
 * attendee formatting, content hashing, and the store a local ingestion run
 * writes through. Moved verbatim out of `src/index.js`; the handlers that
 * write through the privacy engine stay beside it.
 */

import { R2Store } from "../store/r2.js";

export const INBOX_CONTENT_BYTE_CAP = 2_000_000;

/**
 * A store for the deployment's own local bucket, for the two features that have
 * no user behind them: the calendar cron and the Granola webhook.
 *
 * **This is not an access path and no MCP session can reach it.** It exists
 * only for a single-deployment install — someone self-hosting the gateway over
 * their own bucket — where there is no customer credential to fetch and no
 * OAuth token on a cron tick. On the multi-tenant product deployment
 * `LOCAL_CONTEXT_BUCKET` is unset, and both features are inert.
 *
 * Anything a *caller* can reach goes through `storeForSession`, which requires a
 * live grant. Do not call this from a request path that carries a token.
 */
export function localIngestionStore(env) {
  const bucket = env?.LOCAL_CONTEXT_BUCKET;
  if (!bucket || typeof bucket.get !== "function") return null;
  return new R2Store(bucket, { rootPrefix: env.LOCAL_CONTEXT_ROOT_PREFIX });
}

export function singleLine(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function safeSlug(value, maxLength) {
  return singleLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength) || "capture";
}

export function normalizeInboxAttendees(value) {
  if (Array.isArray(value)) {
    return value.map(formatInboxAttendee).filter(Boolean).slice(0, 200);
  }
  if (typeof value === "string") {
    return value.split(/[\n,;]+/).map(singleLine).filter(Boolean).slice(0, 200);
  }
  return [];
}

function formatInboxAttendee(value) {
  if (value && typeof value === "object") {
    const name = singleLine(value.name || "");
    const email = singleLine(value.email || "");
    if (name && email) return `${name} <${email}>`;
    return name || email;
  }
  return singleLine(value);
}

export async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
