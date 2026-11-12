/**
 * Sendblue's status for each send (`status_callback`, docs:
 * https://docs.sendblue.com/getting-started/sending-messages/). Every send
 * names `SENDBLUE_STATUS_URL` (`sendblue.ts` `sendCall`); Sendblue posts each
 * change of a send's status there. The docs do not say a callback is signed,
 * so the address carries a secret in its path (`statusPath`) and anything
 * else is refused.
 *
 * A status is logged as codes only: the status, the class of its error code,
 * whether it went as SMS, and our event id for the send. Never a number,
 * never words. A send that never went is marked in the chat's event log as a
 * "delivery" event that was not delivered, replying to the send's event, so
 * the next turn and the History page know. One exception is resent: a text
 * that went threaded goes again plain, once (`threadedResend.ts`), and is
 * marked only if that fails too.
 */

import { addEvent } from "./events";
import type { InboxStorage } from "./inbox";
import { HANDLES_KEY, noteHandle } from "./replyQuote";
import { groupInboxName } from "./groupInbox";
import { inboxByName } from "./objectPlace";
import { E164, isRecord, sendblueChatId, statusPath } from "./sendblue";
import { takeThreaded, type Threaded } from "./threadedResend";
import { groupLineFor, type GroupLineDeps } from "./groupLine";
import { lineFor, type LineDeps } from "./line";
import { MAX_SENT, SENT_KEY } from "./groupSay";
import { rememberText } from "./threads";

/** A status body is small; anything this big is not one. */
const MAX_BODY = 64 * 1024;

/** Statuses that mean the send never reached them. ERROR and DECLINED are the docs'; FAILED is named by the provider check, unconfirmed. */
const NEVER_WENT = new Set(["ERROR", "DECLINED", "FAILED"]);
/** Statuses as logged: the docs' list, plus READ and FAILED (unconfirmed); anything else logs as "other". */
const KNOWN = new Set(["REGISTERED", "PENDING", "DECLINED", "QUEUED", "ACCEPTED", "SENT", "DELIVERED", "READ", "ERROR", "FAILED"]);
/** Sends already marked as never went, so a retried callback marks one once. */
const FAILED_KEY = "sbfailed";
const MAX_FAILED = 50;

/** One status, as the Worker hands it to the chat's object: no words, and the numbers only to name the chat. */
export type SendStatus = {
  handle: string;
  status: string;
  /** The error code's class ("4000" for 4001), or absent with no code. */
  errorClass?: string;
  downgraded: boolean;
  /** The chat's object (the person's number, or the group's object name) and its chat id in the event log. */
  object: { kind: "person"; phone: string } | { kind: "group"; groupId: string };
  chat: string;
};

/**
 * A callback's body read strictly, or null for one we cannot place. Field
 * names: `message_handle`, `status`, `error_code`, `was_downgraded`,
 * `from_number`, `group_id` are the docs'. The recipient as `number` is the
 * send response's name and `to_number` the outbound webhook's; which one a
 * status callback carries is a guess, so both are read.
 */
export function parseSendStatus(payload: unknown): SendStatus | null {
  if (!isRecord(payload)) return null;
  const handle = payload.message_handle;
  if (typeof handle !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(handle)) return null;
  const raw = typeof payload.status === "string" ? payload.status.toUpperCase() : "";
  const status = KNOWN.has(raw) ? raw : "other";
  const code = payload.error_code;
  const errorClass = typeof code === "number" && Number.isFinite(code) ? String(Math.floor(code / 1000) * 1000) : undefined;
  const downgraded = payload.was_downgraded === true;
  const base = { handle, status, ...(errorClass !== undefined ? { errorClass } : {}), downgraded };
  const group = payload.group_id;
  if (typeof group === "string" && group !== "") return { ...base, object: { kind: "group", groupId: group }, chat: group };
  const line = payload.from_number;
  const phone = typeof payload.number === "string" ? payload.number : payload.to_number;
  if (typeof line !== "string" || !E164.test(line) || typeof phone !== "string" || !E164.test(phone)) return null;
  return { ...base, object: { kind: "person", phone }, chat: sendblueChatId(line, phone) };
}

/** Send a threaded text again, plain, into the same chat: the new message's handle, if the line names one. */
export type Resend = (sent: Threaded) => Promise<string | undefined>;

/**
 * The resend, by the chat's own line: a group's keeps the new handle among Tex's sent texts and a 1:1's beside its
 * words, so a reply under the resent text reaches Tex as one under the first would have (`groupSay.ts`, `threads.ts`).
 */
export function resendPlain(storage: InboxStorage, deps: LineDeps & GroupLineDeps, now: () => number): Resend {
  return async (sent) => {
    if (sent.place.kind === "group") {
      const handle = await groupLineFor(deps, sent.place.groupId).sendText({ line: sent.place.line, groupId: sent.place.groupId }, sent.text);
      if (handle !== undefined) {
        const kept = (await storage.get<string[]>(SENT_KEY)) ?? [];
        await storage.put(SENT_KEY, [...kept.filter((entry) => entry !== handle), handle].slice(-MAX_SENT));
      }
      return handle;
    }
    const handle = await lineFor(deps, sent.place.chatId).sendText(sent.place.chatId, sent.text, `resend:${sent.h}`);
    await rememberText(storage, sent.place.chatId, handle, sent.text, now());
    return handle;
  };
}

/** Log one status, resend plain a threaded text that never went, and mark any other send that never went. The outcome, for the log and tests. */
export async function noteSendStatus(storage: InboxStorage, status: SendStatus, now: number, resend?: Resend): Promise<"logged" | "marked" | "resent" | "unmatched"> {
  const ev = ((await storage.get<{ h: string; ev: string }[]>(HANDLES_KEY)) ?? []).find((entry) => entry.h === status.handle)?.ev;
  let outcome: "logged" | "marked" | "resent" | "unmatched" = ev === undefined ? "unmatched" : "logged";
  const threaded = NEVER_WENT.has(status.status) && resend !== undefined ? await takeThreaded(storage, status.handle, now) : undefined;
  if (threaded !== undefined && resend !== undefined) {
    try {
      // The same event, a new message: a reply under the resent text, and its own status, find what it said.
      const handle = await resend(threaded);
      if (ev !== undefined) await noteHandle(storage, handle, ev);
      outcome = "resent";
    } catch {
      // The plain send failed too: marked below as never went.
    }
  }
  if (outcome !== "resent" && ev !== undefined && NEVER_WENT.has(status.status)) {
    const failed = (await storage.get<string[]>(FAILED_KEY)) ?? [];
    if (!failed.includes(ev)) {
      await addEvent(storage, { at: now, chat: status.chat, from: { kind: "tex" }, kind: "delivery", delivered: false, reason: "failed", replyTo: ev });
      await storage.put(FAILED_KEY, [...failed, ev].slice(-MAX_FAILED));
      outcome = "marked";
    }
  }
  console.log(JSON.stringify({ event: "sendblue_status", status: status.status, ...(status.errorClass ? { error_class: status.errorClass } : {}), downgraded: status.downgraded, ...(ev ? { ev } : {}), outcome }));
  return outcome;
}

/** Whether two strings match, hashed first so the time taken says nothing of either. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * `POST /sendblue/status/<secret>`: one send's status (`sendblueStatus.ts`).
 * Only the configured path is taken; any other is a 404, as an unknown route
 * is. A body we cannot place still gets a 200, so Sendblue does not retry it.
 */
export async function sendblueStatus(request: Request, inboxes: DurableObjectNamespace, statusUrl: string | undefined, url: URL): Promise<Response> {
  const expected = statusPath(statusUrl);
  if (expected === null || !(await sameSecret(expected, url.pathname))) {
    console.log(JSON.stringify({ event: "sendblue_webhook", outcome: "unsigned", reason: "status" }));
    return new Response(null, { status: 404 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response(null, { status: 413 });
  let status: SendStatus | null = null;
  try {
    status = parseSendStatus(JSON.parse(raw));
  } catch {
    status = null;
  }
  if (status === null) {
    console.log(JSON.stringify({ event: "sendblue_webhook", outcome: "invalid", reason: "status" }));
    return new Response(null, { status: 200 });
  }
  const name = status.object.kind === "group" ? groupInboxName(status.object.groupId) : status.object.phone;
  const result = await inboxByName(inboxes, name).fetch("https://inbox/send-status", { method: "POST", body: JSON.stringify(status) });
  return new Response(null, { status: result.ok ? 200 : 503 });
}
