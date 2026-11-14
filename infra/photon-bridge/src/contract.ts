/**
 * The event the bridge delivers to the agent Worker (plan.md, Contract A),
 * as container/map.mjs builds it. The fields marked EXTENSION there are here
 * too, so the agent can read them without guessing.
 */
export type PhotonEvent = {
  seq: number;
  eventId: string;
  type:
    | "message.received"
    | "message.edited"
    | "message.unsent"
    | "message.read"
    | "message.reactionAdded"
    | "message.reactionRemoved"
    | "group.changed"
    | "chat.other";
  /** E.164 of Tex's dedicated line. */
  line: string;
  chat: { guid: string; kind: "dm" | "group"; name?: string };
  from?: string;
  fromMe: boolean;
  at: string;
  message?: {
    guid: string;
    text: string;
    service?: "iMessage" | "SMS" | "RCS" | "unknown";
    replyTo?: string;
    /** The quoted message's words, looked up by the bridge (messages.get). */
    replyToText?: string;
    replyToFromMe?: boolean;
    threadRoot?: string;
    attachments?: { guid: string; name: string; mimeType: string; size: number | null }[];
    balloonBundleId?: string;
    appUrl?: string;
  };
  reaction?: {
    kind: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "emoji" | "sticker" | "unknown";
    emoji?: string;
    targetGuid: string;
    targetPart?: number;
    targetText?: string;
    targetFromMe?: boolean;
  };
  edited?: { targetGuid: string; previousText?: string };
  unsent?: { targetGuid: string };
  read?: { targetGuid: string };
  group?: { change: string; displayName?: string; address?: string };
  chatEvent?: string;
};
