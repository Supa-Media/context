/**
 * Pictures Tex texts back (`apps/mcp/src/agent/outgoingPictures.js` decides
 * which): read from the gateway's answer, and sent as photos after its words.
 *
 * A picture from the person's notes arrives as bytes and is uploaded to Linq
 * first (`POST /attachments`, then a PUT of the bytes), so it never needs an
 * address anyone could open; only the attachment's id is kept for the send,
 * which is what lets a retry after a failed send stay small enough for the
 * inbox's storage. A picture on the web goes by its address, which Linq
 * fetches. A picture that cannot be uploaded or sent becomes one sentence
 * saying so, never a failed answer.
 */

import type { ImagesLike } from "./attachments";
import { LINQ_API, MAX_REPLY_TEXT, ServiceError, type Fetch } from "./clients";

export type OutgoingPicture = { name: string; mediaType: string; data: string } | { url: string };

/** A picture ready to send: an attachment uploaded to Linq, or an address the line fetches. */
export type Media = { attachment_id: string } | { url: string };

/** What the inbox sends after the words: a text, or a media part ready for the line. */
export type SendPart = string | { media: Media };

export const MAX_OUTGOING_PICTURES = 4;
const SENDABLE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Under this a picture goes as it is: a poster's sharp edges stay PNG. */
export const SHRINK_OVER_BYTES = 1_000_000;
const SHRUNK_EDGE = 2048;

/**
 * A big photo as a JPEG through Cloudflare Images, so it sends quickly and
 * fits where it is kept (`media.ts`). The image model answers in PNG, often
 * past 2 MB for a photo. Small pictures, GIFs (which may move) and anything
 * Images refuses go unchanged; without the binding nothing is shrunk.
 */
export async function shrinkPicture(
  images: ImagesLike | undefined,
  picture: { name: string; mediaType: string; data: string },
): Promise<{ name: string; mediaType: string; data: string }> {
  if (!images || picture.mediaType === "image/gif" || picture.data.length * 0.75 <= SHRINK_OVER_BYTES) return picture;
  try {
    const result = await images
      .input(new Blob([bytesOf(picture.data)]).stream())
      .transform({ width: SHRUNK_EDGE, height: SHRUNK_EDGE, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 85 });
    const out = new Uint8Array(await result.response().arrayBuffer());
    if (out.byteLength === 0 || out[0] !== 0xff || out[1] !== 0xd8) return picture;
    let binary = "";
    for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
    const dot = picture.name.lastIndexOf(".");
    return { name: `${dot > 0 ? picture.name.slice(0, dot) : picture.name}.jpg`, mediaType: "image/jpeg", data: btoa(binary) };
  } catch {
    return picture;
  }
}

export const PICTURE_FAILED = "I couldn't send that picture just now.";

/** The `pictures` of a gateway answer, checked. Anything malformed is dropped, never thrown. */
export function readPictures(raw: unknown): OutgoingPicture[] {
  if (!Array.isArray(raw)) return [];
  const out: OutgoingPicture[] = [];
  for (const item of raw.slice(0, MAX_OUTGOING_PICTURES)) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (typeof value.url === "string") {
      try {
        const url = new URL(value.url);
        if (url.protocol === "https:" && !url.username && !url.password && value.url.length <= 2000) out.push({ url: url.href });
      } catch {
        // not an address
      }
      continue;
    }
    if (
      typeof value.data === "string" &&
      BASE64.test(value.data) &&
      typeof value.mediaType === "string" &&
      SENDABLE.has(value.mediaType)
    ) {
      const name = typeof value.name === "string" && /^[\w.-]{1,80}$/.test(value.name) ? value.name : "picture";
      out.push({ name, mediaType: value.mediaType, data: value.data });
    }
  }
  return out;
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Upload one picture's bytes to Linq; its attachment id. */
export async function uploadLinqPicture(
  fetcher: Fetch,
  apiKey: string,
  picture: { name: string; mediaType: string; data: string },
): Promise<string> {
  const bytes = bytesOf(picture.data);
  let created: Response;
  try {
    created = await fetcher(`${LINQ_API}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: picture.name, content_type: picture.mediaType, size_bytes: bytes.byteLength }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ServiceError("linq", null);
  }
  if (!created.ok) throw new ServiceError("linq", created.status);
  const answer = (await created.json().catch(() => null)) as Record<string, unknown> | null;
  const id = answer?.attachment_id;
  const upload = answer?.upload_url;
  const headers = answer?.required_headers;
  if (typeof id !== "string" || typeof upload !== "string" || !upload.startsWith("https://")) throw new ServiceError("linq", created.status);
  const required: Record<string, string> = {};
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) if (typeof value === "string") required[key] = value;
  }
  let put: Response;
  try {
    // The presigned address is Linq's storage, not Linq's API: no API key goes to it.
    put = await fetcher(upload, { method: "PUT", headers: required, body: bytes, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ServiceError("linq", null);
  }
  if (!put.ok) throw new ServiceError("linq", put.status);
  return id;
}

/**
 * The answer's words and pictures as what the inbox sends, pictures last. A
 * picture whose upload failed is one sentence instead, said once.
 */
export async function partsFor(
  texts: string[],
  pictures: OutgoingPicture[],
  upload: (picture: { name: string; mediaType: string; data: string }) => Promise<Media>,
): Promise<SendPart[]> {
  const parts: SendPart[] = [...texts];
  let failed = false;
  for (const picture of pictures) {
    if ("url" in picture) {
      parts.push({ media: { url: picture.url } });
      continue;
    }
    try {
      parts.push({ media: await upload(picture) });
    } catch {
      failed = true;
    }
  }
  if (failed) parts.push(PICTURE_FAILED);
  return parts;
}

/** Send one media part. */
export async function sendLinqMedia(
  fetcher: Fetch,
  apiKey: string,
  chatId: string,
  media: Media,
  idempotencyKey: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(`${LINQ_API}/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { parts: [{ type: "media", ...media }], idempotency_key: idempotencyKey.slice(0, 255) } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ServiceError("linq", null);
  }
  if (!response.ok) throw new ServiceError("linq", response.status);
}

/** What the simulator's log shows for a picture. */
export function describePart(part: SendPart): string {
  if (typeof part === "string") return part.slice(0, MAX_REPLY_TEXT);
  return "url" in part.media ? `[picture: ${part.media.url}]` : "[picture]";
}
