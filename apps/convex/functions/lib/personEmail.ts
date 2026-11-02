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
 * rather than sending from their Context address). Every Gmail connect asks
 * for it (`WRITE_SCOPES` in `googleOAuth.ts`); one connected before that
 * reconnects once. Nothing of an email is kept here:
 * the limits count hashes of recipient addresses, never the addresses, the
 * subject or the body (non-negotiable #1, metadata only).
 */

/** The Gmail permissions a connection must have granted before it sends, or saves a draft. */
export { GMAIL_COMPOSE_SCOPE, GMAIL_SEND_SCOPE, canSendEmail } from "./googleOAuth";

/** Most emails one person's AIs may send in a day, and in an hour. */
export const PERSON_EMAIL_DAILY_LIMIT = 100;
export const PERSON_EMAIL_HOURLY_LIMIT = 20;
/** Most emails to one address in a day, so an AI cannot pester somebody. */
export const PERSON_EMAIL_RECIPIENT_DAILY_LIMIT = 10;
/**
 * Most drafts one person's AIs may save in an hour, and in a day. A draft
 * reaches nobody, so it spends none of the sending limits and has no
 * per-recipient one; these only stop a loop filling the Drafts folder.
 */
export const PERSON_EMAIL_DRAFT_HOURLY_LIMIT = 30;
export const PERSON_EMAIL_DRAFT_DAILY_LIMIT = 200;
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
  /** The Gmail id of the message this answers, in the sending mailbox: sent inside that thread. */
  replyTo: string | null;
  /** The Gmail id of a message in the sending mailbox this forwards, attachments and all (`personEmailForward.ts`). */
  forward: string | null;
  /**
   * Files the email carries besides a forward's: ones the person's AI
   * downloaded and keeps in their own bucket (`apps/mcp/src/tools/emailAttach.js`),
   * sent once and never kept here.
   */
  files: Array<{ filename: string; contentType: string; bytes: Uint8Array }>;
}

/** Kept equal to `apps/mcp/src/tools/emailAttach.js`. */
export const PERSON_EMAIL_MAX_FILES = 5;
export const PERSON_EMAIL_MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;

/** The files an email carries, decoded and checked, or null for anything malformed. */
function filesOf(value: unknown): PersonEmail["files"] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PERSON_EMAIL_MAX_FILES) return null;
  const files: PersonEmail["files"] = [];
  let total = 0;
  for (const item of value) {
    const raw = item as { filename?: unknown; contentType?: unknown; data?: unknown } | null;
    if (!raw || typeof raw.filename !== "string" || typeof raw.data !== "string" || typeof raw.contentType !== "string") return null;
    const filename = raw.filename.trim();
    if (filename === "" || filename.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(filename)) return null;
    if (!FILE_TYPE.test(raw.contentType) || !/^[A-Za-z0-9+/]+=*$/.test(raw.data)) return null;
    let bytes: Uint8Array;
    try {
      const binary = atob(raw.data);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } catch {
      return null;
    }
    total += bytes.length;
    if (bytes.length === 0 || total > PERSON_EMAIL_MAX_FILE_BYTES) return null;
    files.push({ filename, contentType: raw.contentType.toLowerCase(), bytes });
  }
  return files;
}

/** The headers that put a reply inside its thread (`replyHeadersOf`). */
export interface ReplyThread {
  threadId: string;
  inReplyTo: string;
  references: string[];
}

export type PersonEmailRefusal =
  | "invalid"
  | "not_allowed"
  | "no_sender"
  | "reply_not_found"
  | "forward_not_found"
  | "too_large"
  | "reconnect_required"
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
  const replyTo = raw.replyTo === undefined ? null : raw.replyTo;
  if (replyTo !== null && (typeof replyTo !== "string" || !MESSAGE_ID.test(replyTo))) return null;
  // A reply goes from the mailbox that holds the message it answers.
  if (replyTo !== null && from.length === 0) return null;
  const forward = raw.forward === undefined ? null : raw.forward;
  if (forward !== null && (typeof forward !== "string" || !MESSAGE_ID.test(forward))) return null;
  // A forward goes from the mailbox that holds it too, and is never also a reply.
  if (forward !== null && (from.length === 0 || replyTo !== null)) return null;
  const files = filesOf(raw.files);
  if (files === null) return null;
  return { from: from[0] ?? null, to, cc, subject, body, replyTo, forward, files };
}

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** One RFC 5322 msg-id, as Gmail returns it: no spaces, no line breaks. */
const MSG_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/;
const MAX_REFERENCES = 20;

/**
 * The thread a reply joins, from the metadata of the message it answers, or
 * null when that message has no usable Message-ID. Every value is checked
 * here, since they become headers of the email sent.
 */
export function replyHeadersOf(message: { threadId?: unknown; payload?: { headers?: Array<{ name?: unknown; value?: unknown }> } }): ReplyThread | null {
  const headers = message?.payload?.headers ?? [];
  const header = (name: string) =>
    String(headers.find((entry) => String(entry?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "").trim();
  const inReplyTo = header("Message-ID");
  const threadId = String(message?.threadId ?? "");
  if (!MSG_ID.test(inReplyTo) || !MESSAGE_ID.test(threadId)) return null;
  const earlier = header("References").split(/\s+/).filter((id) => MSG_ID.test(id) && id !== inReplyTo);
  return { threadId, inReplyTo, references: [...earlier.slice(-(MAX_REFERENCES - 1)), inReplyTo] };
}

/** Every address the email goes to. */
export function recipientsOf(email: PersonEmail): string[] {
  return [...email.to, ...email.cc];
}

/**
 * The mailbox an address reaches, for the per-recipient limit: Gmail ignores
 * dots and a `+tag` in its local part, and googlemail.com is gmail.com, so
 * `j.o+1@googlemail.com` is the same person as `jo@gmail.com` and shares their
 * three a day. Other domains are taken as written.
 */
export function recipientLimitKey(address: string): string {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  if (domain !== "gmail.com" && domain !== "googlemail.com") return `${local}@${domain}`;
  return `${local.split("+")[0]!.replace(/\./g, "")}@gmail.com`;
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

/** The counters one saved draft spends. */
export function personEmailDraftPolicies(userId: string) {
  return [
    { key: `person_email.draft_hour:${userId}`, limit: PERSON_EMAIL_DRAFT_HOURLY_LIMIT, windowMs: HOUR_MS, refusal: "hourly_limit" as const },
    { key: `person_email.draft_day:${userId}`, limit: PERSON_EMAIL_DRAFT_DAILY_LIMIT, windowMs: DAY_MS, refusal: "daily_limit" as const },
  ];
}

/** RFC 2047 for a header that is not plain ASCII. */
export function headerText(value: string): string {
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
export function gmailRaw(email: PersonEmail, from: string, thread: ReplyThread | null = null): string {
  const lines = [
    `From: ${from}`,
    `To: ${email.to.join(", ")}`,
    ...(email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
    `Subject: ${headerText(email.subject)}`,
    ...(thread ? [`In-Reply-To: ${thread.inReplyTo}`, `References: ${thread.references.join(" ")}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64(new TextEncoder().encode(email.body.replace(/\r?\n/g, "\r\n"))).replace(/.{76}/g, "$&\r\n"),
  ];
  return base64(new TextEncoder().encode(lines.join("\r\n"))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
