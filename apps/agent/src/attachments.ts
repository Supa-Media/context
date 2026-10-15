/**
 * The files a person texted, made into what the gateway's `/agent` takes
 * (`apps/mcp/src/agent/attachments.js`): a picture or PDF as base64, a
 * document's words as text, or, for anything that cannot be opened, a sentence
 * saying why, so Tex says so instead of "I don't see an image".
 *
 * Downloaded here, at answer time, from Linq's presigned URL (good for an
 * hour), and never stored: the Durable Object keeps only the URL until the
 * reply goes out (`inbox.ts`).
 *
 * The bytes decide a picture's type, not the label: a phone can call a HEIC
 * photo `image/jpeg`, and the model API refuses a request whose picture is not
 * what it says, which would cost the person their whole answer. A photo the
 * model cannot read (HEIC from an iPhone camera, TIFF) or one over its 5 MB
 * ceiling is converted to a JPEG by the Images binding when the deployment has
 * one; so is a picture over 8000 pixels on a side (a long scrolling
 * screenshot), which the API refuses too. Without the binding, the model is
 * told it was a photo it couldn't open.
 */

import type { Fetch } from "./clients";
import type { InboundAttachment } from "./inbound";
import { officeText, type OfficeKind } from "./officeText";

export type GatewayAttachment =
  | { name: string; mediaType: string; data: string }
  | { name: string; mediaType: string; text: string }
  | { name: string; mediaType: string; unread: string };

/** The part of the Images binding this uses, so tests can pass a fake. */
export type ImagesLike = Pick<ImagesBinding, "input">;

export type AttachmentDeps = { fetch: Fetch; images?: ImagesLike };

/** Most bytes one file may be downloaded at. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** The gateway's ceilings (`apps/mcp/src/agent/attachments.js`), kept in step. */
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 100_000;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
/** A converted photo's longest side: plenty to read a receipt, small enough to send. */
const CONVERTED_EDGE = 2048;

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "vcf", "ics", "xml", "html", "htm", "log", "yaml", "yml"]);
const TEXT_TYPES = new Set(["application/json", "application/xml", "application/x-yaml", "application/yaml"]);
const OFFICE: Record<string, OfficeKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** What the bytes are, by their first few: the four picture types the model reads, and PDF. */
export function sniff(bytes: Uint8Array): string | null {
  const at = (i: number, ...expected: number[]) => expected.every((value, j) => bytes[i + j] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return null;
}

/** The model API's longest side for a picture; past it the whole request is refused. */
export const MAX_IMAGE_EDGE = 8000;

/**
 * A picture's width and height from its header, or null when it can't be told.
 * A long scrolling screenshot is small in bytes and huge in pixels.
 */
export function dimensions(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === "image/png") return { width: view.getUint32(16), height: view.getUint32(20) };
    if (type === "image/gif") return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (type === "image/webp") {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8X") {
        const read24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
        return { width: read24(24) + 1, height: read24(27) + 1 };
      }
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      return null;
    }
    if (type === "image/jpeg") {
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1];
        // Start of frame (baseline, progressive, ...), not DHT, JPG or DAC.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
        }
        at += 2 + view.getUint16(at + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** A picture the model takes as it is: its size and, where the header says, its sides. */
function fitsModel(bytes: Uint8Array, type: string): boolean {
  if (bytes.length > MAX_IMAGE_BYTES) return false;
  const size = dimensions(bytes, type);
  return size === null || (size.width <= MAX_IMAGE_EDGE && size.height <= MAX_IMAGE_EDGE);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function download(fetcher: Fetch, url: string): Promise<Uint8Array | "too_big" | null> {
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!response.ok || !response.body) return null;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    await response.body.cancel();
    return "too_big";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        return "too_big";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** A photo the model cannot take, as a JPEG it can, or null. */
async function toJpeg(images: ImagesLike | undefined, bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!images) return null;
  try {
    const result = await images
      .input(new Blob([bytes]).stream())
      .transform({ width: CONVERTED_EDGE, height: CONVERTED_EDGE, fit: "scale-down" })
      .output({ format: "image/jpeg", quality: 85 });
    const out = new Uint8Array(await result.response().arrayBuffer());
    return sniff(out) === "image/jpeg" && fitsModel(out, "image/jpeg") ? out : null;
  } catch {
    return null;
  }
}

function renamed(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

async function prepareOne(item: InboundAttachment, index: number, deps: AttachmentDeps): Promise<GatewayAttachment> {
  const name = item.filename.trim() || `attachment-${index + 1}`;
  const ext = extension(name);
  const type = item.mimeType || "";
  const unread = (why: string): GatewayAttachment => ({ name, mediaType: type, unread: why });

  if (type.startsWith("audio/") || ["caf", "m4a", "mp3", "amr", "wav"].includes(ext)) {
    return unread("It is a voice message or recording, and Tex can't listen to audio yet. Ask them to type it.");
  }
  if (type.startsWith("video/") || ["mov", "mp4", "m4v"].includes(ext)) {
    return unread("It is a video, and Tex can't watch videos yet. A screenshot of the part that matters would work.");
  }
  if (item.size !== null && item.size > MAX_DOWNLOAD_BYTES) {
    return unread(`It is ${megabytes(item.size)}, over the ${megabytes(MAX_DOWNLOAD_BYTES)} Tex can open.`);
  }
  const bytes = await download(deps.fetch, item.url);
  if (bytes === "too_big") return unread(`It is over the ${megabytes(MAX_DOWNLOAD_BYTES)} Tex can open.`);
  if (bytes === null) return unread("The download failed. Ask them to send it again.");

  const sniffed = sniff(bytes);
  if (sniffed === "application/pdf") {
    if (bytes.length > MAX_PDF_BYTES) return unread(`It is a ${megabytes(bytes.length)} PDF, over the ${megabytes(MAX_PDF_BYTES)} Tex can read.`);
    return { name, mediaType: sniffed, data: toBase64(bytes) };
  }
  if (sniffed !== null && fitsModel(bytes, sniffed)) return { name, mediaType: sniffed, data: toBase64(bytes) };
  if (sniffed !== null || type.startsWith("image/") || ["heic", "heif", "tif", "tiff", "bmp", "avif"].includes(ext)) {
    const jpeg = await toJpeg(deps.images, bytes);
    if (jpeg !== null) return { name: renamed(name, "jpg"), mediaType: "image/jpeg", data: toBase64(jpeg) };
    return unread("It is a photo in a format or size Tex couldn't open. A screenshot of it would work.");
  }
  const office = OFFICE[type] ?? (ext === "docx" || ext === "pptx" || ext === "xlsx" ? ext : undefined);
  if (office) {
    const text = await officeText(bytes, office);
    return text === null ? unread("The document could not be read.") : { name, mediaType: type || office, text };
  }
  if (type.startsWith("text/") || TEXT_TYPES.has(type) || TEXT_EXTENSIONS.has(ext)) {
    return { name, mediaType: type || "text/plain", text: new TextDecoder().decode(bytes).slice(0, MAX_TEXT_CHARS) };
  }
  return unread(`Tex can't open ${ext ? `.${ext}` : "this kind of"} files yet.`);
}

function weight(attachment: GatewayAttachment): number {
  if ("data" in attachment) return Math.floor((attachment.data.length * 3) / 4);
  if ("text" in attachment) return attachment.text.length;
  return 0;
}

/**
 * Every file texted with one message, in order. Never throws: a file that
 * could not be read becomes a sentence for the model, so the person still
 * gets an answer about the rest.
 */
export async function prepareAttachments(list: InboundAttachment[], deps: AttachmentDeps): Promise<GatewayAttachment[]> {
  const out: GatewayAttachment[] = [];
  let total = 0;
  for (const [index, item] of list.entries()) {
    let prepared: GatewayAttachment;
    try {
      prepared = await prepareOne(item, index, deps);
    } catch {
      prepared = { name: item.filename || `attachment-${index + 1}`, mediaType: item.mimeType, unread: "It could not be read." };
    }
    if (total + weight(prepared) > MAX_TOTAL_BYTES) {
      prepared = { name: prepared.name, mediaType: prepared.mediaType, unread: "Too much was sent at once; ask them to send this one again on its own." };
    }
    total += weight(prepared);
    out.push(prepared);
  }
  return out;
}
