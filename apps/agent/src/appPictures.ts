/**
 * The in-app chat's pictures (`appChat.ts`): the person's, sent from the app, and Tex's, sent back to it. Kept in the
 * app chat's own object, by a random id, for as long as the chat keeps them (Dev2, 2026-11-16: a chat's pictures are
 * kept by id in its own object). Nothing is served at a public address: the app reads a picture through the gateway's
 * `/tex/app-chat` route (`op: "picture"`), as its owner, and a turn reads one through the chat object's own fetch, at
 * `APP_PICTURE_ORIGIN`, a name no network resolves.
 *
 * A Durable Object's stored value is capped at 2 MB, so the bytes are kept in pieces under that cap, as `media.ts`
 * keeps a hosted picture's. Only the four kinds of picture a browser draws and none can carry a script are kept.
 */

import type { InboxStorage } from "./inbox";
import type { Picture } from "./line";

/** The address a turn fetches an app picture at: never a real host, so a picture can only be read from its own chat. */
export const APP_PICTURE_ORIGIN = "https://app-chat.invalid";
/** The largest picture kept, after the app has shrunk it. */
export const MAX_APP_PICTURE_BYTES = 5_000_000;
/** One stored piece, under a Durable Object's 2 MB value cap. */
const PIECE_BYTES = 1_900_000;
/** The kinds kept: none of them can carry a script. */
export const APP_PICTURE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
/** A picture's id: 32 hex digits, random. */
export const APP_PICTURE_ID = /^[0-9a-f]{32}$/;

type Kept = { mediaType: string; pieces: number; bytes: number; at: number };

const headKey = (id: string) => `app:pic:${id}`;
const pieceKey = (id: string, index: number) => `app:picpart:${id}:${index}`;

function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The picture's kind read from its first bytes, or null when they are none of the four kept: the bytes decide, never a label. */
export function sniffPictureType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

/** Keeps a picture's bytes and answers its id, or null when they are empty, too big, or not one of the kept kinds. */
export async function keepAppPicture(storage: InboxStorage, bytes: Uint8Array, now: number): Promise<string | null> {
  const mediaType = sniffPictureType(bytes);
  if (mediaType === null || bytes.byteLength === 0 || bytes.byteLength > MAX_APP_PICTURE_BYTES) return null;
  const id = randomId();
  const pieces = Math.max(1, Math.ceil(bytes.byteLength / PIECE_BYTES));
  try {
    for (let index = 0; index < pieces; index++) await storage.put<Uint8Array>(pieceKey(id, index), bytes.slice(index * PIECE_BYTES, (index + 1) * PIECE_BYTES));
    // Written last, so a picture is never read half kept.
    await storage.put<Kept>(headKey(id), { mediaType, pieces, bytes: bytes.byteLength, at: now });
  } catch (error) {
    for (let index = 0; index < pieces; index++) await storage.delete(pieceKey(id, index)).catch(() => false);
    throw error;
  }
  return id;
}

/** A kept picture's kind and bytes, or null for an id this chat does not keep. */
export async function readAppPicture(storage: InboxStorage, id: string): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
  if (!APP_PICTURE_ID.test(id)) return null;
  const kept = await storage.get<Kept>(headKey(id));
  if (!kept || typeof kept.pieces !== "number" || !APP_PICTURE_TYPES.has(kept.mediaType)) return null;
  const bytes = new Uint8Array(kept.bytes);
  let offset = 0;
  for (let index = 0; index < kept.pieces; index++) {
    const piece = await storage.get<Uint8Array>(pieceKey(id, index));
    if (!piece || offset + piece.byteLength > bytes.byteLength) return null;
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return offset === bytes.byteLength ? { mediaType: kept.mediaType, bytes } : null;
}

/** Deletes a kept picture, every piece of it (a text taken back): nothing is left to read or to serve. */
export async function forgetAppPicture(storage: InboxStorage, id: string): Promise<void> {
  if (!APP_PICTURE_ID.test(id)) return;
  const kept = await storage.get<Kept>(headKey(id));
  await storage.delete(headKey(id));
  for (let index = 0; index < (kept?.pieces ?? 0); index++) await storage.delete(pieceKey(id, index));
}

/** The address a turn reads a kept picture at (`APP_PICTURE_ORIGIN`): its id and its kind's extension. */
export function appPictureUrl(id: string, mediaType: string): string {
  return `${APP_PICTURE_ORIGIN}/pic/${id}.${EXTENSION[mediaType] ?? "jpg"}`;
}

/** The id an app picture's address names, or null for any other address. */
export function appPictureIdOf(url: string): string | null {
  const match = /^https:\/\/app-chat\.invalid\/pic\/([0-9a-f]{32})\.(?:jpg|png|gif|webp)$/.exec(url);
  return match ? match[1]! : null;
}

/** A turn's fetch of an app picture's address, from this chat's own store: 404 for any picture it does not keep. */
export async function serveAppPicture(storage: InboxStorage, url: string): Promise<Response> {
  const id = appPictureIdOf(url);
  const kept = id === null ? null : await readAppPicture(storage, id);
  if (kept === null) return new Response(null, { status: 404 });
  return new Response(kept.bytes, { headers: { "content-type": kept.mediaType, "content-length": String(kept.bytes.byteLength) } });
}

/** Tex's own picture, as its line keeps it (`appLine` `uploadPicture`): its address, or "" when it is none of the kept kinds. */
export async function keepTexPicture(storage: InboxStorage, picture: Picture, now: number): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(picture.data);
  } catch {
    return "";
  }
  const id = await keepAppPicture(storage, bytes, now);
  if (id === null) return "";
  return appPictureUrl(id, sniffPictureType(bytes) ?? "image/jpeg");
}
