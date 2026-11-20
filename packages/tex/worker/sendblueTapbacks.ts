/**
 * A tapback as Sendblue may deliver it, read before anything else of the
 * payload decides it is not a message (Dev2, 2026-10-22: three 👍 on asks,
 * none of which reached anything, and "please make sure we are actually
 * counting the default 👍 from apple"). Its receive webhook is documented only
 * for messages, so every shape a tapback could plausibly take is read:
 *
 * - words, as Messages writes it for a phone that can't show one ("Liked
 *   “…”"), whatever `message_type`, `service` or `is_outbound` say;
 * - a reaction of its own: a `message_type` naming a reaction or tapback, or a
 *   `reaction`, `reaction_type` or `tapback` field, with Sendblue's own words
 *   for it (`like`, `love`, the six its send-reaction API takes) and the
 *   message it was on named by `reply_to` or `associated_message_handle`.
 *   That message's words are read from Sendblue before it is queued
 *   (`index.ts`), as an inline reply's are.
 *
 * Each payload that is not a plain message is logged by its shape (its keys
 * and `message_type`, never its words or numbers), so the next 👍 that reaches
 * nothing says which shape it came in.
 */

import { readRemovedTapback, readTapback, type Reaction, type Tapback } from "./reactions";
import { TAPBACK, handleOf } from "./sendblue";

/** Sendblue's names for a tapback (its send-reaction API's six, and the forms Messages uses). */
const SENDBLUE_NAMES: Record<string, Tapback> = {
  like: "Liked",
  liked: "Liked",
  thumbsup: "Liked",
  thumbs_up: "Liked",
  love: "Loved",
  loved: "Loved",
  heart: "Loved",
  dislike: "Disliked",
  disliked: "Disliked",
  laugh: "Laughed at",
  laughed: "Laughed at",
  haha: "Laughed at",
  emphasize: "Emphasized",
  emphasized: "Emphasized",
  emphasis: "Emphasized",
  question: "Questioned",
  questioned: "Questioned",
  "\u{1F44D}": "Liked",
  "❤": "Loved",
};

/** A tapback Sendblue reports on its own, before the words of the message it was on are read. */
export type BareTapback = { how: Tapback; removed?: true; on: string };

/** What a payload's tapback is: one read from words, one named apart (its message still to read), or none. */
export type SendblueTapback = { reaction: Reaction } | { bare: BareTapback } | null;

function nameOf(value: unknown): { how: Tapback; removed?: true } | null {
  if (typeof value !== "string") return null;
  const word = value.normalize("NFKC").trim().toLowerCase().replace(/️/gu, "");
  const removed = /^(?:-|remove[ds]?[ _]?)/u.test(word);
  const how = SENDBLUE_NAMES[word.replace(/^(?:-|remove[ds]?[ _]?)/u, "")];
  return how === undefined ? null : { how, ...(removed ? { removed: true as const } : {}) };
}

/** The handle of the message a reaction was on, wherever Sendblue names it. */
function reactedOn(payload: Record<string, unknown>): string | undefined {
  for (const key of ["associated_message_handle", "associated_message_guid", "reacted_to", "target_message_handle"]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "" && value.length <= 200) return value;
  }
  return handleOf(payload.reply_to) ?? handleOf(payload.associated_message) ?? handleOf(payload.reaction_to);
}

/** A tapback in this payload, in any shape it may come in; null for anything else. */
export function sendblueTapback(payload: Record<string, unknown>): SendblueTapback {
  const text = typeof payload.content === "string" ? payload.content.trim() : "";
  if (TAPBACK.test(text) && !payload.media_url) {
    const reaction = readTapback(text) ?? readRemovedTapback(text);
    return reaction === null ? null : { reaction };
  }
  const type = typeof payload.message_type === "string" ? payload.message_type.toLowerCase() : "";
  const named = nameOf(payload.reaction) ?? nameOf(payload.reaction_type) ?? nameOf(payload.tapback);
  const typed = /reaction|tapback/u.test(type);
  if (named === null && !typed) return null;
  const how = named ?? nameOf(text);
  const on = reactedOn(payload);
  if (how === null || on === undefined) return null;
  return { bare: { ...how, on } };
}

/** A payload that is not a plain message, by its shape only: which keys, which `message_type`, how long its words. */
export function logShape(payload: Record<string, unknown>, outcome: string): void {
  const text = typeof payload.content === "string" ? payload.content.trim() : "";
  console.log(
    JSON.stringify({
      event: "sendblue_shape",
      outcome,
      message_type: typeof payload.message_type === "string" ? payload.message_type.slice(0, 40) : null,
      service: typeof payload.service === "string" ? payload.service.slice(0, 20) : null,
      keys: Object.keys(payload).sort().slice(0, 60),
      // A tapback's first word only ("Liked"), never the words it was on.
      first: TAPBACK.test(text) ? text.split(/\s/u)[0].slice(0, 20) : null,
      length: text.length,
    }),
  );
}

