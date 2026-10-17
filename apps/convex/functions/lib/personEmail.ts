/**
 * Email a person's AI sends as them (`docs/decisions/communications/sending-email.md`).
 *
 * The gateway holds every one of these until the person says yes to the exact
 * copy (`apps/mcp/src/tools/emailGate.js`); this side is the second check and
 * the one the gateway cannot skip: who the sender is and how many the person
 * may send. Pure helpers here; the route is `gatewayRoutes/personEmail.ts` and
 * the counting is `functions/personEmail.ts`.
 *
 * Sent through the person's own connected Gmail, and only one whose consent
 * granted `gmail.send` (decided by the owner, 2026-10-17: "Wait for Gmail",
 * rather than sending from their Context address). Context does not ask
 * Google for that scope yet (`GMAIL_SCOPES` in `googleOAuth.ts`), because the
 * Google review in progress covers read scopes only, so until that changes no
 * connection has it and nothing is sent. Nothing of an email is kept here:
 * the limits count hashes of recipient addresses, never the addresses, the
 * subject or the body (non-negotiable #1, metadata only).
 */

/** The Gmail permission a connection must have granted before it sends. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/** Most emails one person's AIs may send in a day, and in an hour. */
export const PERSON_EMAIL_DAILY_LIMIT = 20;
export const PERSON_EMAIL_HOURLY_LIMIT = 5;
/** Most emails to one address in a day, so an AI cannot pester somebody. */
export const PERSON_EMAIL_RECIPIENT_DAILY_LIMIT = 3;
/** Most addresses on one email, To and Cc together. */
export const PERSON_EMAIL_MAX_RECIPIENTS = 10;
export const PERSON_EMAIL_MAX_SUBJECT = 200;
export const PERSON_EMAIL_MAX_BODY = 20_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A plain address: no display name, no comments, no second address hidden
 * after a comma or a newline. Anything a header could be split on is refused.
 */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export interface PersonEmail {
  /** Which of the person's connected Gmail addresses sends it; absent means their first one that can. */
  from: string | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

export type PersonEmailRefusal =
  | "invalid"
  | "not_allowed"
  | "no_sender"
  | "hourly_limit"
  | "daily_limit"
  | "recipient_limit"
  | "not_configured"
  | "unavailable";

function addresses(value: unknown): string[] | null {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") return null;
    const address = item.trim();
    if (address.length > 254 || !ADDRESS.test(address)) return null;
    out.push(address.toLowerCase());
  }
  return out;
}

/** Control characters other than newline and tab, which a body may carry. */
const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const SUBJECT_CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/**
 * The email as the gateway sent it, checked again here, or null. The gateway
 * runs the same rules (`apps/mcp/src/tools/email.js`); a mismatch between the
 * two is refused rather than repaired, because a repaired email is not the
 * copy the person said yes to.
 */
export function readPersonEmail(value: unknown): PersonEmail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const from = raw.from === undefined ? [] : addresses(raw.from);
  if (from === null || from.length > 1) return null;
  const to = addresses(raw.to);
  const cc = addresses(raw.cc);
  if (to === null || cc === null || to.length === 0) return null;
  const all = [...to, ...cc];
  if (all.length > PERSON_EMAIL_MAX_RECIPIENTS || new Set(all).size !== all.length) return null;
  const subject = typeof raw.subject === "string" ? raw.subject : "";
  const body = typeof raw.body === "string" ? raw.body : "";
  if (subject.trim() === "" || subject.length > PERSON_EMAIL_MAX_SUBJECT || SUBJECT_CONTROL.test(subject)) return null;
  if (body.trim() === "" || body.length > PERSON_EMAIL_MAX_BODY || BODY_CONTROL.test(body)) return null;
  return { from: from[0] ?? null, to, cc, subject, body };
}

/** Every address the email goes to. */
export function recipientsOf(email: PersonEmail): string[] {
  return [...email.to, ...email.cc];
}

/** The counters one send spends, all or none (`functions/personEmail.ts`). */
export function personEmailPolicies(userId: string, recipientHashes: string[]) {
  return [
    { key: `person_email.hour:${userId}`, limit: PERSON_EMAIL_HOURLY_LIMIT, windowMs: HOUR_MS, refusal: "hourly_limit" as const },
    { key: `person_email.day:${userId}`, limit: PERSON_EMAIL_DAILY_LIMIT, windowMs: DAY_MS, refusal: "daily_limit" as const },
    ...recipientHashes.map((hash) => ({
      key: `person_email.to:${userId}:${hash}`,
      limit: PERSON_EMAIL_RECIPIENT_DAILY_LIMIT,
      windowMs: DAY_MS,
      refusal: "recipient_limit" as const,
    })),
  ];
}

/** RFC 2047 for a header that is not plain ASCII. */
function headerText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${base64(new TextEncoder().encode(value))}?=`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The message Gmail's `messages.send` takes, as base64url. Every header value
 * was validated by `readPersonEmail`, so none carries a line break; the body
 * travels base64-encoded and cannot end the headers early either.
 */
export function gmailRaw(email: PersonEmail, from: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${email.to.join(", ")}`,
    ...(email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    `Subject: ${headerText(email.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64(new TextEncoder().encode(email.body.replace(/\r?\n/g, "\r\n"))).replace(/.{76}/g, "$&\r\n"),
  ];
  return base64(new TextEncoder().encode(lines.join("\r\n"))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
