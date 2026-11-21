/**
 * The person's chat with Tex in the Context app, as the Lab's "You" reads it (in-app Tex section A4; Lab = tex_dev
 * parity, `packages/lab/gateway/texDev/probe.js` `chatsOf` lists it the same way). It is no history file of its own: the
 * app chat writes to the 1:1's (`me`), each entry it wrote marked `via: "app"`, so the Lab reads the 1:1 and keeps the
 * app's texts.
 */
import type { LedgerEntry } from "../fromApp/texPageTypes";

/** The Lab's key for the app chat. */
export const APP_CHAT = "app";
/** Whether a chat key is the person's own 1:1 (their texts, or the app's). */
export const isOneToOne = (key: string): boolean => key === "me" || key === APP_CHAT;
/** The history file a chat key reads: the app chat's is the 1:1's. */
export const ledgerChatOf = (key: string): string => (key === APP_CHAT ? "me" : key);

/** The app chat shows only the texts sent and answered in the app; every other entry (steps, replies' timing) is kept. */
export function onlyOfChat(key: string, entries: LedgerEntry[]): LedgerEntry[] {
  return key === APP_CHAT ? entries.filter((e) => e.kind !== "text" || (e as { via?: unknown }).via === "app") : entries;
}

/** The picker's chats with the app chat right after the 1:1; none without a 1:1. */
export function withAppChat<T extends { key: string; name: string }>(chats: T[]): (T | { key: string; name: string })[] {
  const at = chats.findIndex((c) => c.key === "me");
  return at < 0 ? chats : [...chats.slice(0, at + 1), { key: APP_CHAT, name: "Tex in the app" }, ...chats.slice(at + 1)];
}
