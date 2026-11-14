/**
 * A chat's texting line, reached through the Worker instead of with line keys (`lineCalls.ts`). The gateway has
 * no Sendblue, Whapi or Linq keys, so its chat object builds its `Line` and `GroupLine` here: each method is one
 * RPC call on the Worker's `TexRoutines.lineCall` / `groupLineCall`, and the answer is unwrapped the way the
 * Worker's own line would have thrown it.
 *
 * Error mapping, so callers see what they see from a local line:
 * - a `ServiceError` comes back as a `ServiceError` with the same service and status (`isRefusal` in `carousel.ts`
 *   reads the status: a 4xx is a refusal, a 429 is not);
 * - `Absent` (the Worker's line has no such method, e.g. `sendCarousel` on Linq) becomes an Error with status 400,
 *   which is a refusal: callers already handle a line without carousels or cards that way;
 * - any other failure is an Error with the same name and message, and its status when it had one.
 *
 * A remote line serves one chat, so its methods use the chat it was built for; the `chatId` a caller passes is that chat.
 * `remoteGroupLine` is synchronous: its two webhook flags come from `groupLineFlags`, the same rule `groupLineFor`
 * uses to pick the real line, so nothing is asked of the Worker before a turn can start.
 */

import { ServiceError } from "./clients";
import type { Line, Picture } from "./line";
import type { Media } from "./outgoing";
import type { AppCard } from "./appCards";
import { groupLineFlags, type GroupLine, type GroupPlace } from "./groupLine";
import type { CallError, GroupLineCall, LineCall, LineCallResult } from "./lineCalls";

/** The one RPC the gateway needs from the Worker's `TexRoutines` (a service binding stub satisfies it). */
export type LineRpc = { lineCall(call: LineCall): Promise<LineCallResult> };
export type GroupLineRpc = { groupLineCall(call: GroupLineCall): Promise<LineCallResult> };

const SERVICES: readonly string[] = ["linq", "sendblue", "whapi", "control_plane", "gateway"];

/** The value a call answered with, or the error the Worker's line threw, rebuilt the way a local line would throw it. */
export function unwrapLineCall(result: LineCallResult): unknown {
  if (result.ok) return result.value;
  const { name, message, status, service } = result.error;
  if (name === "ServiceError" && service !== null && SERVICES.includes(service)) throw new ServiceError(service as ServiceError["service"], status);
  if (name === "Absent") throw Object.assign(new Error(message), { name, status: 400 });
  throw Object.assign(new Error(message), { name, status });
}

/** Drops trailing `undefined` arguments, so an optional argument not given is not sent as `null`. */
function withoutTrailingUndefined(args: unknown[]): unknown[] {
  const out = [...args];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

/** The chat's `Line`, every method one call on the Worker's line (`lineCalls.ts`). */
export function remoteLine(rpc: LineRpc, inbox: string, chatId: string): Line {
  const call = (method: string, ...args: unknown[]): Promise<unknown> =>
    rpc.lineCall({ inbox, chatId, method, args: withoutTrailingUndefined(args) }).then(unwrapLineCall);
  return {
    sendText: (_chatId, text, key, replyTo) => call("sendText", text, key, replyTo) as Promise<string | undefined>,
    sendMedia: (_chatId, media: Media, key, replyTo) => call("sendMedia", media, key, replyTo).then(() => undefined),
    sendAppCard: (_chatId, card: AppCard, replyTo) => call("sendAppCard", card, replyTo).then(() => undefined),
    sendCarousel: (_chatId, urls: string[], replyTo) => call("sendCarousel", urls, replyTo).then(() => undefined),
    uploadPicture: (picture: Picture) => call("uploadPicture", picture) as Promise<Media>,
    startTyping: () => call("startTyping").then(() => undefined),
    markRead: (_chatId, messageId) => call("markRead", messageId).then(() => undefined),
    acknowledge: (_chatId, messageId, emoji) => call("acknowledge", messageId, emoji).then(() => undefined),
    shareContactCard: () => call("shareContactCard") as Promise<boolean>,
    shareProfile: (_chatId, refresh) => call("shareProfile", refresh) as ReturnType<Line["shareProfile"]>,
  };
}

/** The group's `GroupLine`, every method one call on the Worker's group line; the flags are `groupLineFlags` (synchronous). */
export function remoteGroupLine(rpc: GroupLineRpc, inbox: string, groupId: string): GroupLine {
  const call = (method: string, ...args: unknown[]): Promise<unknown> =>
    rpc.groupLineCall({ inbox, groupId, method, args: withoutTrailingUndefined(args) }).then(unwrapLineCall);
  return {
    ...groupLineFlags(groupId),
    sendText: (place: GroupPlace, text, replyTo) => call("sendText", place, text, replyTo) as Promise<string | undefined>,
    sendMedia: (place: GroupPlace, url, replyTo) => call("sendMedia", place, url, replyTo).then(() => undefined),
    react: (place: GroupPlace, messageId, emoji) => call("react", place, messageId, emoji).then(() => undefined),
    readMembers: (place: GroupPlace) => call("readMembers", place) as Promise<string[] | null>,
    readOwnMessage: (place: GroupPlace, messageId) => call("readOwnMessage", place, messageId) as Promise<string | null>,
  };
}
