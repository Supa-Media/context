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
 * Read body `{ accessToken, expectedWorkspaceId, address, id }` answers
 * `{ ok: true, message: { address, id, threadId, date, from, to, subject, body, attachments } }`.
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
  const results: Array<Record<string, string>> = [];
  let failed = 0;
  for (const mailbox of claimed.mailboxes) {
    if (results.length >= limit) break;
    const token = await tokenFor(ctx, mailbox);
    if (token === null) {
      failed += 1;
      continue;
    }
    try {
      const q = body.outsideSync === true ? outsideSyncQuery(query, mailbox) : query;
      const { ids } = await listMessageIds({ fetchImpl: timeoutFetch, accessToken: token, query: q, pageToken: undefined, maxResults: limit - results.length });
      for (const id of ids) {
        const message = await getMessageHeaders({ fetchImpl: timeoutFetch, accessToken: token, id }).catch((error: unknown) => {
          if (error instanceof GmailApiError && error.status === 404) return null;
          throw error;
        });
        if (message === null) continue;
        const headers = message?.payload?.headers ?? [];
        results.push({
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
  log({ route: "search", outcome: "ok", results: results.length, mailboxes: claimed.mailboxes.length, failed });
  // Each mailbox's folder, so the gateway searches the synced notes too; a
  // Gmail that did not answer leaves those still worth searching.
  const mailboxes = claimed.mailboxes.map(({ address, folder }: Mailbox) => ({ address, folder }));
  return json({ ok: true, results, mailboxes, ...(failed > 0 ? { incomplete: true } : {}) });
}

export async function gatewayPersonMailReadHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const address = addressField(body);
  const id = typeof body.id === "string" ? body.id : "";
  if (accessToken === null || expected === null) return json({ ok: false, refused: "not_allowed" });
  if (!address || !MESSAGE_ID.test(id)) return json({ ok: false, refused: "invalid" });

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
  log({ route: "read", outcome: "ok" });
  return json({
    ok: true,
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
      attachments: (event.attachments ?? []).map((attachment: { filename?: string; contentType?: string; size?: number }) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        ...(Number.isFinite(attachment.size) ? { size: attachment.size } : {}),
      })),
    },
  });
}
