/**
 * Tex's own sends as Photon tells of them, for the chat's `send` step (`providerTiming.ts`; Dev2, 2026-11-14: the send
 * node "should show the lag and any logs or any error messages from the provider ... whether it's Photon"). Photon has
 * no delivery callback; its event log does carry the two things that stand for one:
 *
 * - `message.received` from Tex's own side (`fromMe`): Apple has the text, at Apple's own time: "sent".
 * - `message.read` by the other party: they read one of Tex's texts, at their read time: "read".
 * - `message.status`, which the bridge makes by reading each send back (`infra/photon-bridge/container/delivery.mjs`):
 *   "failed" with Apple's error code (FAILED: marked, and a threaded text sent again plain, as Sendblue's ERROR is),
 *   or "undelivered" when it had still not reached their phone minutes later (shown on the send step, nothing more).
 *
 * Each becomes a `SendStatus` for the chat's object (`/send-status`, as Sendblue's status callback is), carrying the
 * provider's time and never the text's words. Anything else is null and goes on as an event.
 */

import { photonChatId, photonGroupId } from "./photon";
import { providerError, sendReportOf } from "./providerTiming";
import type { SendStatus } from "./sendblueStatus";

const E164 = /^\+[1-9]\d{6,14}$/;
const DM_GUID = /^any;-;(\+[1-9]\d{6,14})$/;
const GROUP_GUID = /^any;\+;[^\s;]{1,72}$/;
const GUID = /^\S{1,120}$/;

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/** The chat's object and chat id, from the chat's guid: a 1:1 by the other party's phone in it, a group by its guid. */
function placeOf(line: string, chat: unknown): Pick<SendStatus, "object" | "chat"> | null {
  if (!isRecord(chat) || typeof chat.guid !== "string") return null;
  const dm = DM_GUID.exec(chat.guid);
  if (chat.kind === "dm" && dm !== null) return { object: { kind: "person", phone: dm[1] }, chat: photonChatId(line, dm[1]) };
  if (chat.kind === "group" && GROUP_GUID.test(chat.guid)) {
    const groupId = photonGroupId(chat.guid);
    return { object: { kind: "group", groupId }, chat: groupId };
  }
  return null;
}

/** A Photon event that tells of one of Tex's sends, as the chat's object takes a send status; null for every other event. */
export function photonSendStatusOf(body: unknown): SendStatus | null {
  if (!isRecord(body) || typeof body.line !== "string" || !E164.test(body.line)) return null;
  let handle: unknown;
  let status: "sent" | "read" | "failed" | "undelivered";
  let code: unknown;
  if (body.type === "message.status" && isRecord(body.status) && (body.status.state === "failed" || body.status.state === "undelivered")) {
    handle = body.status.targetGuid;
    status = body.status.state;
    code = body.status.code;
  } else if (body.type === "message.received" && body.fromMe === true) {
    handle = isRecord(body.message) ? body.message.guid : undefined;
    status = "sent";
  } else if (body.type === "message.read" && body.fromMe === false) {
    handle = isRecord(body.read) ? body.read.targetGuid : undefined;
    status = "read";
  } else return null;
  if (typeof handle !== "string" || !GUID.test(handle)) return null;
  const place = placeOf(body.line, body.chat);
  if (place === null) return null;
  const error = status === "failed" ? (providerError(code) ?? { code: "failed" }) : status === "undelivered" ? { code: "not_delivered" } : undefined;
  return {
    handle,
    line: body.line,
    status: status.toUpperCase(),
    downgraded: false,
    ...place,
    report: sendReportOf("photon", handle, status === "undelivered" ? "other" : status, { providerAt: body.at }, error),
  };
}
