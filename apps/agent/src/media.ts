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
/** A Durable Object's stored value is capped at 2 MB; a bigger picture is not sent. */
export const MAX_HOSTED_BYTES = 1_900_000;

type Hosted = { mediaType: string; bytes: Uint8Array; at: number };

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
  const bytes = Uint8Array.from(atob(picture.data), (c) => c.charCodeAt(0));
  if (bytes.byteLength > MAX_HOSTED_BYTES) throw new Error("picture too big to host");
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await storage.put<Hosted>(mediaKey(token), { mediaType: picture.mediaType, bytes, at: now });
  return `${origin}/media/${objectId}/${token}.${extension}`;
}

/** The picture at `token`, while it is still kept; 404 otherwise, the same for every miss. */
export async function serveMedia(storage: InboxStorage, token: string, now: number): Promise<Response> {
  const hosted = TOKEN.test(token) ? await storage.get<Hosted>(mediaKey(token)) : undefined;
  if (!hosted || now - hosted.at > MEDIA_FOR_MS) return new Response(null, { status: 404 });
  return new Response(hosted.bytes, {
    headers: { "content-type": hosted.mediaType, "cache-control": "private, no-store" },
  });
}

/** Delete what has expired, and wake again for whatever is still kept. Called when the queue is empty. */
export async function pruneMedia(storage: InboxStorage, now: number): Promise<void> {
  const kept = await storage.list<Hosted>({ prefix: "media:" });
  let left = false;
  for (const [key, hosted] of kept) {
    if (now - hosted.at > MEDIA_FOR_MS) await storage.delete(key);
    else left = true;
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
