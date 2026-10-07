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

export function parseInbound(payload: unknown): Inbound {
  if (!isRecord(payload) || !nonEmptyString(payload.event_id) || !nonEmptyString(payload.event_type)) {
    return { kind: "invalid" };
  }
  if (payload.event_type !== "message.received") return { kind: "ignored", reason: "event_type" };

  const data = payload.data;
  if (!isRecord(data) || !isRecord(data.chat) || !nonEmptyString(data.id) ||
      !Array.isArray(data.parts) || !isRecord(data.sender_handle)) {
    return { kind: "invalid" };
  }
  const chat = data.chat;
  const sender = data.sender_handle;
  if (!nonEmptyString(chat.id)) return { kind: "invalid" };

  // A live Linq delivery puts the group flag on data.chat. Never infer a
  // direct chat from any other field: the reply goes to this chat's ID.
  if (chat.is_group !== false) return { kind: "ignored", reason: "group" };
  if (typeof sender.handle !== "string" || !E164.test(sender.handle)) {
    return { kind: "ignored", reason: "sender" };
  }
  // Both transport fields are present on the observed event. Require them to
  // agree so an SMS sender cannot reach a phone-linked person's Context.
  if (data.service !== "iMessage" || sender.service !== "iMessage") {
    return { kind: "ignored", reason: "service" };
  }

  const text = data.parts
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
    chatId: chat.id,
    from: sender.handle,
    messageId: data.id,
    text: text.slice(0, MAX_INBOUND_TEXT),
  };
}
