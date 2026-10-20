/**
 * A picture from the person's notes, served at a short-lived address so a
 * line that only takes addresses (Sendblue) can fetch it.
 *
 * Linq took the bytes as an upload; Sendblue only fetches a `media_url`. So
 * the bytes wait in the sender's own Durable Object under a random 256-bit
 * token, at `<this Worker>/media/<object id>/<token>.<ext>`, for
 * `MEDIA_FOR_MS`, and are then deleted. The address is handed to Sendblue
 * only, the same as a message's text; nothing lists it and nothing else
 * links to it. The object id is opaque (not the phone number).
 */

import type { InboxStorage } from "./inbox";
import type { Picture } from "./line";

/** Long enough for Sendblue to fetch it, short enough not to linger. */
export const MEDIA_FOR_MS = 30 * 60 * 1000;
/**
 * A Durable Object's stored value is capped at 2 MB, and a photo the image
 * model makes is often bigger, so the bytes are kept in pieces under that cap.
 * A picture over the whole cap is not sent.
 */
export const CHUNK_BYTES = 1_900_000;
export const MAX_HOSTED_BYTES = 8_000_000;

type Hosted = { mediaType: string; at: number; chunks: number };

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  // Tex's contact card on the dedicated line (`card.ts`).
  "text/vcard": "vcf",
};
export const TOKEN = /^[0-9a-f]{64}$/;
export const OBJECT_ID = /^[0-9a-f]{64}$/;
const mediaKey = (token: string) => `media:${token}`;
const chunkKey = (token: string, index: number) => `mediachunk:${token}:${index}`;

/** A plain loop: `Uint8Array.from(string, fn)` walks a multi-megabyte photo by iterator, seconds of CPU. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keep the picture and say its address. Throws when there is no address to give or it is too big. */
export async function hostPicture(
  storage: InboxStorage,
  origin: string | undefined,
  objectId: string,
  picture: Picture,
  now: number,
): Promise<string> {
  const extension = EXTENSIONS[picture.mediaType];
  if (!origin || !extension || !OBJECT_ID.test(objectId)) throw new Error("cannot host this picture");
  const bytes = decodeBase64(picture.data);
  if (bytes.byteLength > MAX_HOSTED_BYTES) throw new Error("picture too big to host");
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const chunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
  try {
    for (let index = 0; index < chunks; index++) {
      await storage.put<Uint8Array>(chunkKey(token, index), bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
    }
    // Written last, so a picture is never served half kept.
    await storage.put<Hosted>(mediaKey(token), { mediaType: picture.mediaType, at: now, chunks });
  } catch (error) {
    // Pieces with no entry would never be pruned.
    for (let index = 0; index < chunks; index++) await storage.delete(chunkKey(token, index)).catch(() => undefined);
    throw error;
  }
  return `${origin}/media/${objectId}/${token}.${extension}`;
}

/** The picture at `token`, while it is still kept; 404 otherwise, the same for every miss. */
export async function serveMedia(storage: InboxStorage, token: string, now: number): Promise<Response> {
  const hosted = TOKEN.test(token) ? await storage.get<Hosted>(mediaKey(token)) : undefined;
  if (!hosted || typeof hosted.chunks !== "number" || now - hosted.at > MEDIA_FOR_MS) return new Response(null, { status: 404 });
  const pieces: Uint8Array[] = [];
  for (let index = 0; index < hosted.chunks; index++) {
    const piece = await storage.get<Uint8Array>(chunkKey(token, index));
    if (!piece) return new Response(null, { status: 404 });
    pieces.push(piece);
  }
  const bytes = new Uint8Array(pieces.reduce((n, piece) => n + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return new Response(bytes, {
    headers: { "content-type": hosted.mediaType, "cache-control": "private, no-store" },
  });
}

/** Delete what has expired, and wake again for whatever is still kept. Called when the queue is empty. */
export async function pruneMedia(storage: InboxStorage, now: number): Promise<void> {
  const kept = await storage.list<Hosted>({ prefix: "media:" });
  let left = false;
  for (const [key, hosted] of kept) {
    if (now - hosted.at > MEDIA_FOR_MS) {
      const token = key.slice("media:".length);
      for (let index = 0; index < (hosted.chunks ?? 0); index++) await storage.delete(chunkKey(token, index));
      await storage.delete(key);
    } else left = true;
  }
  if (!left) return;
  // Never push back an alarm already set sooner: a text that arrived
  // meanwhile, or a "your notes are ready" text owed (`ready.ts`).
  const at = now + MEDIA_FOR_MS + 1_000;
  const current = storage.getAlarm === undefined ? null : await storage.getAlarm();
  if ((current === null || current === undefined || current > at) && (await storage.list({ prefix: "pending:" })).size === 0) {
    await storage.setAlarm(at);
  }
}

/** The Worker's address, as a webhook reached it: where hosted pictures are served from. */
export const ORIGIN_KEY = "origin";

export function workerOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}
