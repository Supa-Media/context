/**
 * The event the bridge delivers to the agent Worker (plan.md, Contract A),
 * as container/map.mjs builds it. The fields marked EXTENSION there are here
 * too, so the agent can read them without guessing.
 */
export type PhotonEvent = {
  /** Photon's sequence; null for `message.status`, which the bridge makes itself (`container/delivery.mjs`). */
  seq: number | null;
  eventId: string;
  type:
    | "message.received"
    | "message.edited"
    | "message.unsent"
    | "message.read"
    | "message.reactionAdded"
    | "message.reactionRemoved"
    | "group.changed"
    | "chat.other"
    | "message.status";
  /** E.164 of Tex's dedicated line. */
  line: string;
  chat: { guid: string; kind: "dm" | "group"; name?: string };
  from?: string;
  fromMe: boolean;
  at: string;
  /** Set when Apple gave no time and `at` is the bridge's observation time. Such an event is never a dropped replay. */
  atGuessed?: true;
  /** Set on an event from a catch-up after a restart (not a live stream). The agent may use it to tell history from news. */
  replay?: true;
  message?: {
    guid: string;
    text: string;
    service?: "iMessage" | "SMS" | "RCS" | "unknown";
    replyTo?: string;
    /** The quoted message's words, looked up by the bridge (messages.get). */
    replyToText?: string;
    replyToFromMe?: boolean;
    threadRoot?: string;
    attachments?: { guid: string; name: string; mimeType: string; size: number | null; /** Apple marks it a sticker (sent as its own message). */ sticker?: true }[];
    balloonBundleId?: string;
    appUrl?: string;
    /** Another app's card, as its words (`map.mjs` `appOf`). */
    app?: { name?: string; bundle?: string; caption?: string; subcaption?: string; trailingCaption?: string; trailingSubcaption?: string; imageTitle?: string; imageSubtitle?: string; summary?: string };
    /** Native tags: the tagged address and its UTF-16 range in `text`. */
    mentions?: { address: string; start: number; length: number }[];
    /** Apple's id of the bubble or screen effect it was sent with. */
    effect?: string;
    /** A poll started, changed or voted in, told in words (`map.mjs` `pollWords`). */
    poll?: true;
  };
  reaction?: {
    kind: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "emoji" | "sticker" | "unknown";
    emoji?: string;
    targetGuid: string;
    targetPart?: number;
    targetText?: string;
    targetFromMe?: boolean;
    /** A placed sticker's own attachment guid on the line (kind "sticker"). */
    sticker?: string;
  };
  edited?: { targetGuid: string; previousText?: string };
  unsent?: { targetGuid: string };
  read?: { targetGuid: string };
  group?: { change: string; displayName?: string; address?: string };
  chatEvent?: string;
  /** One of Tex's sends read back (`container/delivery.mjs`): failed with Apple's code, or not delivered yet. */
  status?: { targetGuid: string; state: "failed" | "undelivered"; code?: number };
};
