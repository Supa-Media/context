/**
 * `POST /gateway/email/search` and `POST /gateway/email/read`: a person's
 * mail, read live from their own Gmail, for what their synced notes do not
 * hold (`functions/personMail.ts`,
 * `docs/decisions/communications/reading-mail.md`).
 *
 * Search body `{ accessToken, expectedWorkspaceId, query, limit?, address?, outsideSync? }`
 * answers `{ ok: true, results: [{ address, id, threadId, date, from, to, subject, snippet }],
 * mailboxes: [{ address, folder }], incomplete? }`.
 * With `outsideSync`, each mailbox is searched only before it was connected
 * and after its last pass, because the gateway has already searched the
 * notes for everything in between.
 *
 * Read body `{ accessToken, expectedWorkspaceId, address, id, attachment? }` answers
 * `{ ok: true, message: { address, id, threadId, date, from, to, subject, body, attachments } }`.
 * With `attachment` (1 for the message's first), the answer also carries that
 * attachment's bytes, `attachment: { filename, contentType, data }` (base64),
 * for the gateway to read its words: Gmail's own copy, so an attachment the
 * sync never stored can still be read. Over `MAX_ATTACHMENT_BYTES` is
 * `too_large`.
 *
 * Either answers `{ ok: false, refused }`. Nothing read here is stored or
 * logged: a log line carries an outcome and a count, never an address, a
 * subject or a word of a message.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import {
  GmailApiError,
  getAttachmentBytes,
  getMessageHeaders,
  getMessageOrNull,
  gmailMessageToEvent,
  headerValue,
  listMessageIds,
} from "../../../../mcp/src/communications/gmailSync.js";
import { timeoutFetch } from "../filesFns/forwardSyncSupport";

export const MAX_MAIL_QUERY = 500;
export const MAX_MAIL_RESULTS = 10;
/** How much of one message's body a read returns. */
export const MAX_MAIL_BODY = 20_000;
/** The overlap kept at the sync's newer edge, for a message that landed just before a pass. */
const EDGE_OVERLAP_MS = 60 * 60 * 1000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The most one attachment read carries back: the gateway reads files up to 10 MB (`tools/readFile.js`). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_INDEX = 100;

type EventAttachment = { filename?: string; contentType?: string; size?: number; attachmentId?: string };

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

type Mailbox = {
  connectionId: Id<"googleConnections">;
  address: string;
  folder: string;
  syncedFrom: number;
  syncedThrough?: number;
};

function log(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ event: "person_mail", ...fields }));
}

async function claim(ctx: ActionCtx, accessToken: string, expectedWorkspaceId: string, address: string | null) {
  return await ctx.runMutation(internal.functions.personMail.claimPersonMailRead, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId,
    address,
  });
}

async function tokenFor(ctx: ActionCtx, mailbox: Mailbox): Promise<string | null> {
  const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, {
    connectionId: mailbox.connectionId,
  });
  return minted?.accessToken ?? null;
}

function addressField(body: Record<string, unknown>): string | null | undefined {
  if (body.address === undefined || body.address === null) return null;
  if (typeof body.address !== "string" || body.address.length > 254 || !body.address.includes("@")) return undefined;
  return body.address.trim().toLowerCase();
}

/**
 * The person's query, limited to the part of the mailbox the notes do not hold.
 *
 * Gmail's `{a b}` is "a or b", and `before:`/`after:` take seconds since the
 * epoch, so this asks for mail before the connection or after its last pass.
 * A mailbox no pass has read yet holds nothing in the notes, so it is
 * searched whole.
 */
export function outsideSyncQuery(query: string, mailbox: Pick<Mailbox, "syncedFrom" | "syncedThrough">): string {
  if (mailbox.syncedThrough === undefined) return query;
  const before = Math.floor(mailbox.syncedFrom / 1000);
  const after = Math.floor((mailbox.syncedThrough - EDGE_OVERLAP_MS) / 1000);
  return `(${query}) {before:${before} after:${after}}`;
}

/** Gmail's snippet is HTML-escaped text. */
function unescapeSnippet(text: unknown): string {
  return String(text ?? "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function dateOf(message: { internalDate?: unknown }): string {
  const at = Number(message?.internalDate);
  return Number.isFinite(at) ? new Date(at).toISOString() : "";
}

export async function gatewayPersonMailSearchHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const address = addressField(body);
  const limit = Number.isInteger(body.limit) ? Math.min(Math.max(body.limit as number, 1), MAX_MAIL_RESULTS) : MAX_MAIL_RESULTS;
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  if (query === "" || query.length > MAX_MAIL_QUERY || address === undefined) return json({ ok: false, refused: "invalid" });

  const claimed = await claim(ctx, accessToken, expected, address);
  if (!claimed.ok) {
    log({ route: "search", outcome: "refused", reason: claimed.refused });
    return json({ ok: false, refused: claimed.refused });
  }
  // Every mailbox is searched, each for its share of the results, and the
  // answers are taken in turn: filling the limit from the first mailbox left
  // a person's other Gmails unsearched (2026-10-20).
  const share = Math.ceil(limit / Math.max(claimed.mailboxes.length, 1));
  const perMailbox: Array<Array<Record<string, string>>> = [];
  let failed = 0;
  for (const mailbox of claimed.mailboxes) {
    const found: Array<Record<string, string>> = [];
    perMailbox.push(found);
    const token = await tokenFor(ctx, mailbox);
    if (token === null) {
      failed += 1;
      continue;
    }
    try {
      const q = body.outsideSync === true ? outsideSyncQuery(query, mailbox) : query;
      const { ids } = await listMessageIds({ fetchImpl: timeoutFetch, accessToken: token, query: q, pageToken: undefined, maxResults: share });
      for (const id of ids) {
        const message = await getMessageHeaders({ fetchImpl: timeoutFetch, accessToken: token, id }).catch((error: unknown) => {
          if (error instanceof GmailApiError && error.status === 404) return null;
          throw error;
        });
        if (message === null) continue;
        const headers = message?.payload?.headers ?? [];
        found.push({
          address: mailbox.address,
          id: String(message.id ?? id),
          threadId: String(message.threadId ?? ""),
          date: dateOf(message),
          from: headerValue(headers, "From"),
          to: headerValue(headers, "To"),
          subject: headerValue(headers, "Subject"),
          snippet: unescapeSnippet(message.snippet),
        });
      }
    } catch (error) {
      failed += 1;
      log({ route: "search", outcome: "gmail_error", status: error instanceof GmailApiError ? error.status : 0 });
    }
  }
  const results: Array<Record<string, string>> = [];
  for (let turn = 0; results.length < limit && perMailbox.some((found) => turn < found.length); turn += 1) {
    for (const found of perMailbox) if (turn < found.length && results.length < limit) results.push(found[turn]!);
  }
  log({ route: "search", outcome: "ok", results: results.length, mailboxes: claimed.mailboxes.length, failed });
  // Each mailbox's folder, where its synced day notes are.
  const mailboxes = claimed.mailboxes.map(({ address, folder }: Mailbox) => ({ address, folder }));
  return json({ ok: true, results, mailboxes, ...(failed > 0 ? { incomplete: true } : {}) });
}

export async function gatewayPersonMailReadHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const address = addressField(body);
  const id = typeof body.id === "string" ? body.id : "";
  const wanted = body.attachment;
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  if (!address || !MESSAGE_ID.test(id)) return json({ ok: false, refused: "invalid" });
  if (wanted !== undefined && (!Number.isInteger(wanted) || (wanted as number) < 1 || (wanted as number) > MAX_ATTACHMENT_INDEX)) {
    return json({ ok: false, refused: "invalid" });
  }

  const claimed = await claim(ctx, accessToken, expected, address);
  if (!claimed.ok) {
    log({ route: "read", outcome: "refused", reason: claimed.refused });
    return json({ ok: false, refused: claimed.refused });
  }
  const mailbox = claimed.mailboxes[0]!;
  const token = await tokenFor(ctx, mailbox);
  if (token === null) return json({ ok: false, refused: "unavailable" });
  let message;
  try {
    message = await getMessageOrNull({ fetchImpl: timeoutFetch, accessToken: token, id });
  } catch (error) {
    log({ route: "read", outcome: "gmail_error", status: error instanceof GmailApiError ? error.status : 0 });
    return json({ ok: false, refused: "unavailable" });
  }
  if (message === null) return json({ ok: false, refused: "not_found" });
  const event = gmailMessageToEvent(message, { mailboxSlug: "live" });
  const format = (entry: { name?: string; address?: string }) =>
    entry?.name ? `${entry.name} <${entry.address ?? ""}>` : (entry?.address ?? "");
  const attachments: EventAttachment[] = event.attachments ?? [];
  let attachment: { filename: string; contentType: string; data: string } | undefined;
  if (wanted !== undefined) {
    const chosen = attachments[(wanted as number) - 1];
    if (!chosen?.attachmentId) return json({ ok: false, refused: "not_found" });
    if (Number.isFinite(chosen.size) && (chosen.size as number) > MAX_ATTACHMENT_BYTES) return json({ ok: false, refused: "too_large" });
    let bytes: Uint8Array;
    try {
      bytes = await getAttachmentBytes({ fetchImpl: timeoutFetch, accessToken: token, messageId: id, attachmentId: chosen.attachmentId });
    } catch (error) {
      log({ route: "attachment", outcome: "gmail_error", status: error instanceof GmailApiError ? error.status : 0 });
      return json({ ok: false, refused: error instanceof GmailApiError && error.status === 404 ? "not_found" : "unavailable" });
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) return json({ ok: false, refused: "too_large" });
    attachment = { filename: chosen.filename ?? "attachment", contentType: chosen.contentType ?? "", data: base64(bytes) };
  }
  log({ route: attachment ? "attachment" : "read", outcome: "ok" });
  return json({
    ok: true,
    ...(attachment ? { attachment } : {}),
    message: {
      address: mailbox.address,
      id: event.messageId,
      threadId: event.threadId,
      date: event.sentAt,
      from: format(event.from),
      to: (event.to ?? []).map(format).join(", "),
      subject: event.subject,
      body: String(event.body ?? "").slice(0, MAX_MAIL_BODY),
      truncated: String(event.body ?? "").length > MAX_MAIL_BODY,
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        ...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
      })),
    },
  });
}
