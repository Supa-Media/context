/**
 * Forwarding one of the person's own emails, its attachments with it
 * (`docs/decisions/communications/sending-email.md`, the owner, 2026-10-21).
 *
 * On 2026-10-21 Tex offered to send an Anthropic receipt on to the person's
 * bookkeeping address, then could not: an email it sent had no attachments,
 * and nothing could forward one. A forward names the email by its Gmail id in
 * the sending mailbox, as a reply does, so it can only ever forward the
 * person's own mail. The gateway shows them the email's subject, sender and
 * attachment names before their yes (`apps/mcp/src/tools/emailGate.js`);
 * this side reads the message again with the sending connection's own token
 * and builds the email: their words, the forwarded email's headers and text
 * below them, and each of its attachments, as Gmail's own forward does.
 *
 * Nothing read here is kept or logged.
 */

import { GmailApiError, LIVE_RETRY_MS, getAttachmentBytes, getMessageOrNull, gmailMessageToEvent } from "../../../mcp/src/communications/gmailSync.js";
import type { PersonEmail } from "./personEmail";

/** The most attachment bytes one forward carries: under Gmail's 35 MB message once base64 has grown it. */
export const MAX_FORWARD_BYTES = 20 * 1024 * 1024;
export const MAX_FORWARD_FILES = 20;
/** How much of the forwarded email's own text goes below the person's words. */
export const MAX_FORWARDED_TEXT = 20_000;

export interface ForwardedFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface Forwarded {
  from: string;
  to: string;
  date: string;
  subject: string;
  text: string;
  files: ForwardedFile[];
}

type Part = { filename?: unknown; mimeType?: unknown; body?: { data?: unknown; attachmentId?: unknown; size?: unknown }; parts?: unknown };

function* filesOf(part: Part | undefined): Generator<Part> {
  if (!part || typeof part !== "object") return;
  if (typeof part.filename === "string" && part.filename.trim() !== "") yield part;
  if (Array.isArray(part.parts)) for (const child of part.parts) yield* filesOf(child as Part);
}

function bytesOfBase64Url(data: string): Uint8Array {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function named(entry: { name?: string; address?: string } | undefined): string {
  if (!entry) return "";
  return entry.name ? `${entry.name} <${entry.address ?? ""}>` : (entry.address ?? "");
}

/**
 * The email to forward, read from the sending mailbox, or the refusal:
 * `forward_not_found` when Gmail has no such message (or one of its files),
 * `too_large` past the limits, `unavailable` when Gmail did not answer.
 */
export async function readForwarded(
  fetchImpl: typeof fetch,
  accessToken: string,
  id: string,
): Promise<{ ok: true; forwarded: Forwarded } | { ok: false; refused: "forward_not_found" | "too_large" | "unavailable" }> {
  let message;
  try {
    message = await getMessageOrNull({ fetchImpl, accessToken, id, delaysMs: LIVE_RETRY_MS });
  } catch {
    return { ok: false, refused: "unavailable" };
  }
  if (message === null) return { ok: false, refused: "forward_not_found" };
  const event = gmailMessageToEvent(message, { mailboxSlug: "live" });
  const parts = [...filesOf(message?.payload as Part)];
  if (parts.length > MAX_FORWARD_FILES) return { ok: false, refused: "too_large" };
  const files: ForwardedFile[] = [];
  let total = 0;
  for (const part of parts) {
    const declared = Number(part.body?.size);
    if (Number.isFinite(declared) && total + declared > MAX_FORWARD_BYTES) return { ok: false, refused: "too_large" };
    let bytes: Uint8Array;
    try {
      if (typeof part.body?.data === "string") bytes = bytesOfBase64Url(part.body.data);
      else if (typeof part.body?.attachmentId === "string") {
        bytes = await getAttachmentBytes({ fetchImpl, accessToken, messageId: id, attachmentId: part.body.attachmentId, delaysMs: LIVE_RETRY_MS });
      } else return { ok: false, refused: "forward_not_found" };
    } catch (error) {
      return { ok: false, refused: error instanceof GmailApiError && error.status === 404 ? "forward_not_found" : "unavailable" };
    }
    total += bytes.length;
    if (total > MAX_FORWARD_BYTES) return { ok: false, refused: "too_large" };
    files.push({ filename: String(part.filename), contentType: String(part.mimeType ?? ""), bytes });
  }
  return {
    ok: true,
    forwarded: {
      from: named(event.from),
      to: (event.to ?? []).map(named).join(", "),
      date: event.sentAt,
      subject: String(event.subject ?? ""),
      text: String(event.body ?? "").slice(0, MAX_FORWARDED_TEXT),
      files,
    },
  };
}

/** No line breaks, controls or quotes in a header value we did not write. */
function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069"\\]/g, " ").replace(/\s+/g, " ").trim();
}

const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;

/** `Content-Type` and `Content-Disposition` for one file: a plain ASCII name, and the real one per RFC 2231. */
export function fileHeaders(file: Pick<ForwardedFile, "filename" | "contentType">): string[] {
  const name = headerSafe(file.filename).slice(0, 200) || "attachment";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  const type = CONTENT_TYPE.test(file.contentType) ? file.contentType.toLowerCase() : "application/octet-stream";
  const extended = ascii === name ? "" : `; filename*=UTF-8''${encodeURIComponent(name)}`;
  return [`Content-Type: ${type}; name="${ascii}"`, `Content-Disposition: attachment; filename="${ascii}"${extended}`, "Content-Transfer-Encoding: base64"];
}

/** The person's words, then the forwarded email as Gmail lays one out. */
export function forwardBody(body: string, forwarded: Forwarded): string {
  return [
    body,
    "",
    "---------- Forwarded message ---------",
    `From: ${headerSafe(forwarded.from)}`,
    `Date: ${headerSafe(forwarded.date)}`,
    `Subject: ${headerSafe(forwarded.subject)}`,
    `To: ${headerSafe(forwarded.to)}`,
    "",
    forwarded.text,
  ].join("\n");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function wrapped(bytes: Uint8Array): string {
  return base64(bytes).replace(/.{76}/g, "$&\r\n");
}

/**
 * The whole message, as bytes for Gmail's upload endpoint (`message/rfc822`):
 * multipart/mixed, the text first, then each file. `headers` are the ones
 * `gmailRaw` writes (From, To, Cc, Subject), each already checked.
 */
export function forwardMime(headers: string[], body: string, files: ForwardedFile[], boundary: string): Uint8Array {
  const lines = [
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapped(new TextEncoder().encode(body.replace(/\r?\n/g, "\r\n"))),
  ];
  for (const file of files) lines.push(`--${boundary}`, ...fileHeaders(file), "", wrapped(file.bytes));
  lines.push(`--${boundary}--`, "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

/** A boundary no base64 line or header can contain. */
export function newBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `=_ctx_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The headers of the email itself, as `gmailRaw` writes them. */
export function forwardHeaders(email: PersonEmail, from: string, subjectHeader: string): string[] {
  return [`From: ${from}`, `To: ${email.to.join(", ")}`, ...(email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []), `Subject: ${subjectHeader}`];
}
