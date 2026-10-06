/**
 * The one shape of Linq's webhook this Worker acts on: a `message.received`
 * in a direct chat, from a phone number, with some text in it.
 *
 * Everything else is answered 200 and dropped — Linq retries a non-2xx, and an
 * event we will never act on should not be retried. Group chats are dropped on
 * purpose for now: a group's messages come from several people, and answering
 * one of them from a personal context would read that person's notes into a
 * room other people are in. Groups arrive with shared workspaces, deliberately.
 */

/** Longest text forwarded to the agent. The gateway caps a question at 8000. */
export const MAX_INBOUND_TEXT = 4000;

const E164 = /^\+[1-9]\d{6,14}$/;

export type Inbound =
  | {
      kind: "message";
      eventId: string;
      chatId: string;
      from: string;
      messageId: string;
      text: string;
    }
  | { kind: "ignored"; reason: "event_type" | "group" | "sender" | "service" | "empty" }
  | { kind: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Where a message's transport may be named. Linq documents a `service` of
 * `iMessage`, `RCS` or `SMS` on handles but does not show where it sits on an
 * inbound event, so every plausible place is read.
 *
 * **Only iMessage is accepted, and a message that names no service is refused.**
 * The sender's number is the whole of this Worker's authentication. Apple
 * authenticates an iMessage sender; an SMS sender number can be spoofed by
 * anyone with a cheap gateway, and a spoofed number here would be answered with
 * somebody else's notes. Fail closed: confirm the field's real location against
 * a live delivery before deploying, and narrow this list to it.
 */
function transportOf(data: Record<string, unknown>): unknown {
  const message = isRecord(data.message) ? data.message : {};
  for (const holder of [data, message, data.sender_handle, data.from_handle, message.sender_handle]) {
    if (isRecord(holder) && typeof holder.service === "string") return holder.service;
  }
  return undefined;
}

export function parseInbound(payload: unknown): Inbound {
  if (!isRecord(payload) || !nonEmptyString(payload.event_id) || !nonEmptyString(payload.event_type)) {
    return { kind: "invalid" };
  }
  if (payload.event_type !== "message.received") return { kind: "ignored", reason: "event_type" };

  const data = payload.data;
  if (!isRecord(data) || !nonEmptyString(data.chat_id) || !isRecord(data.message)) {
    return { kind: "invalid" };
  }
  const message = data.message;
  if (!nonEmptyString(message.id) || !Array.isArray(message.parts)) return { kind: "invalid" };

  if (data.is_group === true) return { kind: "ignored", reason: "group" };
  if (typeof data.from !== "string" || !E164.test(data.from)) return { kind: "ignored", reason: "sender" };
  if (transportOf(data) !== "iMessage") return { kind: "ignored", reason: "service" };

  const text = message.parts
    .filter((part): part is { type: string; value: string } =>
      isRecord(part) && part.type === "text" && typeof part.value === "string",
    )
    .map((part) => part.value)
    .join("\n")
    .trim();
  if (text.length === 0) return { kind: "ignored", reason: "empty" };

  return {
    kind: "message",
    eventId: payload.event_id,
    chatId: data.chat_id,
    from: data.from,
    messageId: message.id,
    text: text.slice(0, MAX_INBOUND_TEXT),
  };
}
