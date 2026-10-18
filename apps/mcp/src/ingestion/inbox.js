/**
 * Helpers for captures arriving through `/inbox` and email: size cap, slugs,
 * attendee formatting, content hashing. The handlers that write through the
 * privacy engine stay beside them.
 */

export const INBOX_CONTENT_BYTE_CAP = 2_000_000;

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
