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
 * the next turn and the History page know. Nothing is resent.
 */

import { addEvent } from "./events";
import type { InboxStorage } from "./inbox";
import { HANDLES_KEY } from "./replyQuote";
import { E164, isRecord, sendblueChatId } from "./sendblue";

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

/** Log one status and mark a send that never went. The outcome, for the log and tests. */
export async function noteSendStatus(storage: InboxStorage, status: SendStatus, now: number): Promise<"logged" | "marked" | "unmatched"> {
  const ev = ((await storage.get<{ h: string; ev: string }[]>(HANDLES_KEY)) ?? []).find((entry) => entry.h === status.handle)?.ev;
  let outcome: "logged" | "marked" | "unmatched" = ev === undefined ? "unmatched" : "logged";
  if (ev !== undefined && NEVER_WENT.has(status.status)) {
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
