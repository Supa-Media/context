/**
 * The stickers people stuck in a chat, kept so Tex can stick the same ones back (Dev2, 2026-11-25: "Tex should learn how
 * to reuse stickers that people in the chat have used ... use them mainly for reactions").
 *
 * Photon's line hands a placed sticker's own attachment (`photonInbound.ts`, the bridge's `reaction.sticker`). Each is
 * kept here under a short id, in this chat's own object, and its reaction reads "sticker s1a2b3c on …" in the chat's
 * record, so Tex sees who used which sticker on what. Tex answers a text with one by that id (the Tapback step, while
 * its "Chat stickers" setting is on); the Worker sticks it only when this chat kept that id (`stickerOf`), so a sticker
 * from another chat can never be named into this one. Photon has no sticker-only send: a sticker always goes on a text.
 *
 * What it keeps: at most `MAX_STICKERS` stickers per chat, the newest, each its id, its attachment guid on the line and
 * when it was last used. Pure but for the storage it is handed.
 */

import type { InboxStorage } from "./inbox";
import type { Reaction } from "./reactions";

export const STICKERS_KEY = "stickers";
export const MAX_STICKERS = 30;
const ID = /^s[0-9a-z]{6}$/;
const MAX_GUID = 200;

type Kept = { id: string; guid: string; at: number };

/** A sticker's short id from its attachment guid: "s" and six base-36 characters of its FNV-1a hash. Stable per guid. */
export function stickerId(guid: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < guid.length; i += 1) {
    hash ^= guid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `s${hash.toString(36).padStart(6, "0").slice(-6)}`;
}

/** Whether words are a sticker id as Tex names one. */
export function isStickerId(said: unknown): said is string {
  return typeof said === "string" && ID.test(said);
}

/** The words a kept sticker reads as in a reaction's line ("sticker s1a2b3c on Tex's message …", `reactionLine`). */
export const stickerWords = (id: string): string => `sticker ${id}`;

/**
 * Keep a sticker someone stuck in this chat, and answer the reaction as its line should read: its emoji is the
 * sticker's id. A reaction with no sticker, a taken-back one, or one whose keeping failed is answered as it came.
 */
export async function keepSticker(storage: InboxStorage, reaction: Reaction, now: number): Promise<Reaction> {
  if (reaction.removed) return reaction;
  const id = await keepGuid(storage, reaction.sticker, now);
  // A sticker not kept is still read as a sticker, only never stuck again.
  return id === null ? reaction : { ...reaction, emoji: stickerWords(id) };
}

/** Keep one sticker by its attachment guid on the line; its id, or null when there is none or keeping it failed. */
async function keepGuid(storage: InboxStorage, guid: unknown, now: number): Promise<string | null> {
  if (typeof guid !== "string" || guid === "" || guid.length > MAX_GUID) return null;
  const id = stickerId(guid);
  try {
    const kept = (await storage.get<Kept[]>(STICKERS_KEY)) ?? [];
    const rest = kept.filter((item) => item.id !== id);
    await storage.put<Kept[]>(STICKERS_KEY, [...rest, { id, guid, at: now }].slice(-MAX_STICKERS));
  } catch {
    return null;
  }
  return id;
}

/**
 * Keep the stickers sent as a message of their own (Photon's `stickers`, Apple's `isSticker`), as a stuck one is, and
 * answer the message with each one's id after its words ("[sticker s1a2b3c]"), so Tex can name it on its tapback.
 * The guids never go further than this chat's object: the message comes back without them.
 */
export async function keepSentStickers<M extends { text: string; stickers?: string[] }>(storage: InboxStorage, message: M, now: number): Promise<M> {
  const { stickers, ...rest } = message;
  if (stickers === undefined) return message;
  const ids: string[] = [];
  for (const guid of stickers.slice(0, 4)) {
    const id = await keepGuid(storage, guid, now);
    if (id !== null) ids.push(id);
  }
  if (ids.length === 0) return rest as M;
  const words = ids.map((id) => `[${stickerWords(id)}]`).join(" ");
  return { ...rest, text: rest.text === "" ? words : `${rest.text} ${words}` } as M;
}

/** The attachment guid of a sticker this chat kept, by its id; null for any id this chat never kept. */
export async function stickerOf(storage: InboxStorage, id: unknown): Promise<string | null> {
  if (!isStickerId(id)) return null;
  const kept = (await storage.get<Kept[]>(STICKERS_KEY).catch(() => undefined)) ?? [];
  return kept.find((item) => item.id === id)?.guid ?? null;
}
