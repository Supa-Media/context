/**
 * What Tex sends into a group, and how each part is logged (`events.ts`);
 * moved out of `groupInbox.ts` whole, so the queue stays under its size limit.
 */

import { ServiceError } from "./clients";
import { MAX_CANDIDATES } from "./decide";
import { addEvent, kindOf, type EventReason, type TexEvent } from "./events";
import { groupLineFor, type GroupLineDeps, type GroupPlace } from "./groupLine";
import { PICTURE_FAILED, shrinkPicture, type OutgoingPicture } from "./outgoing";
import type { ImagesLike } from "./attachments";
import type { Picture } from "./line";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";
import { sha256Hex } from "./groupChat";

/** The handles of Tex's last thirty texts in this group, so an inline reply to one wakes it. */
export const SENT_KEY = "gsent";
export const MAX_SENT = 30;

type GroupSayDeps = GroupLineDeps & { now: () => number; images?: ImagesLike; hostPicture?: (picture: Picture) => Promise<string> };

/** A part a handed turn sent, by turn and position, as the hash of what it was (`groupTurnRun.ts`). */
const PART_PREFIX = "gpart:";
/** The handed turn sending now in this chat, and the position of its next part. */
const sending = new WeakMap<InboxStorage, { turn: string; next: number }>();

/** While a handed turn runs (`turn`), each part it sends is remembered; null ends that. */
export function sendingFor(storage: InboxStorage, turn: string | null): void {
  if (turn === null) sending.delete(storage);
  else sending.set(storage, { turn, next: 0 });
}

/** Forget what a handed turn sent, once it is over. */
export async function dropParts(storage: InboxStorage, turn: string): Promise<void> {
  for (const key of (await storage.list({ prefix: `${PART_PREFIX}${turn}:` })).keys()) await storage.delete(key);
}

/**
 * Send one part, unless the same turn already sent this same part at this
 * same position: a workflow retry runs the turn again (`groupTurnWorkflow.ts`),
 * and what reached the chat the first time is not sent twice.
 */
async function once(storage: InboxStorage, part: string, send: () => Promise<void>): Promise<void> {
  const scope = sending.get(storage);
  if (scope === undefined) return await send();
  const key = `${PART_PREFIX}${scope.turn}:${scope.next++}`;
  const hash = await sha256Hex(part);
  if ((await storage.get<string>(key)) === hash) return;
  await send();
  await storage.put(key, hash);
}

/** One line per outcome, never a number, a name or the words. */
function log(outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: "group_turn", outcome, ...(reason ? { reason } : {}) }));
}

/**
 * How a text Tex sends is logged (`events.ts`): a turn's, with its turn and
 * what it covers; a fixed line (`system`), with no turn, as the system's.
 */
export type SayMeta = { turn?: string; covers?: string[]; people?: string; system?: true; reason?: EventReason };

/** One text into the group, threaded under the message it answers, remembered so a reply to it wakes Tex, and logged. */
export async function say(storage: InboxStorage, deps: GroupSayDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId">, text: string, meta: SayMeta = {}): Promise<void> {
  await once(storage, `text:${text}`, () => sayNow(storage, deps, message, text, meta));
}

async function sayNow(storage: InboxStorage, deps: GroupSayDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId">, text: string, meta: SayMeta): Promise<void> {
  const place: GroupPlace = { line: message.line, groupId: message.groupId };
  const handle = await groupLineFor(deps, message.groupId).sendText(place, text, message.messageId);
  await logOut(storage, deps, message.groupId, { kind: kindOf(text), text, delivered: true }, meta);
  if (handle === undefined) return;
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  await storage.put(SENT_KEY, [...sent.filter((entry) => entry !== handle), handle].slice(-MAX_SENT));
}

export async function logOut(storage: InboxStorage, deps: GroupSayDeps, chat: string, part: Pick<TexEvent, "kind" | "text" | "delivered" | "reason">, meta: SayMeta): Promise<void> {
  // Only a turn's own words are Tex's; anything else Tex sends is the system's.
  const turn = meta.system ? undefined : meta.turn;
  await addEvent(storage, {
    at: deps.now(),
    chat,
    from: { kind: turn ? "tex" : "system" },
    ...part,
    ...(turn ? { turn } : {}),
    ...(turn && meta.covers?.length ? { covers: meta.covers.slice(-MAX_CANDIDATES) } : {}),
    ...(meta.people ? { people: meta.people } : {}),
    ...(meta.reason ? { reason: meta.reason } : {}),
  });
}

/** One picture into the chat; one the app refuses becomes a line saying so, as in a 1:1 text. */
export async function sendPicture(storage: InboxStorage, deps: GroupSayDeps, message: GroupMessage, picture: OutgoingPicture, meta: SayMeta): Promise<void> {
  await once(storage, `picture:${"url" in picture ? picture.url : `${picture.name}:${picture.data}`}`, () => sendPictureNow(storage, deps, message, picture, meta));
}

async function sendPictureNow(storage: InboxStorage, deps: GroupSayDeps, message: GroupMessage, picture: OutgoingPicture, meta: SayMeta): Promise<void> {
  let url: string | null = null;
  try {
    url = "url" in picture ? picture.url : deps.hostPicture ? await deps.hostPicture(await shrinkPicture(deps.images, picture)) : null;
    if (url === null) throw new ServiceError("sendblue", 400);
    await groupLineFor(deps, message.groupId).sendMedia({ line: message.line, groupId: message.groupId }, url, message.messageId);
    await logOut(storage, deps, message.groupId, { kind: "picture", text: url, delivered: true }, meta);
  } catch (error) {
    // The words already went: throwing would answer the whole turn again (three "Here's the one-pager"s and
    // then "I couldn't answer that one", 2026-10-26), so a picture that won't send is said once, never retried.
    log("picture_failed", error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "host");
    await logOut(storage, deps, message.groupId, { kind: "picture", delivered: false, reason: url === null ? "upload_failed" : "send_refused" }, meta);
    await say(storage, deps, message, PICTURE_FAILED, { system: true });
  }
}

