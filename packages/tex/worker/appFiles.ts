/**
 * The files the in-app chat's person sends (PDF, plain text, Word): kept in the app chat's own object, by a random id,
 * the way `appPictures.ts` keeps a picture (the same pieces under a Durable Object's value cap, the same address shape,
 * the same "never served from the network": a turn reads one through the chat object's own fetch, at `APP_PICTURE_ORIGIN`).
 *
 * The kind is decided by the bytes and by the name's extension, never by a client's label: a PDF has `%PDF-` at its
 * start and is named .pdf; a Word file is a zip named .docx; a text file is named .txt, .md, .csv, .tsv or .json and its
 * bytes decode as UTF-8 with no NUL byte. Anything else is refused, so an executable or a page never reaches the model as
 * a file, and is never served to a browser as one (the route answers it as an attachment with `nosniff`).
 */

import type { InboxStorage } from "./inbox";
import { APP_PICTURE_ORIGIN } from "./appPictures";

/** The largest file kept, in bytes: what the app sends, and what a turn reads (`attachments.ts` `MAX_PDF_BYTES`). */
export const MAX_APP_FILE_BYTES = 10_000_000;
/** One stored piece, under a Durable Object's 2 MB value cap. */
const PIECE_BYTES = 1_900_000;
/** A file's name, after it is cleaned: longer names are cut, keeping their extension. */
export const MAX_APP_FILE_NAME = 120;
/** A file's id: 32 hex digits, random. */
export const APP_FILE_ID = /^[0-9a-f]{32}$/;

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** The text kinds, by extension. Each is kept as its own type; the bytes must be UTF-8 text with no NUL. */
const TEXT_TYPES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
};
/** The kinds kept: none of them is a page or a program a browser would run. */
export const APP_FILE_TYPES: ReadonlySet<string> = new Set(["application/pdf", DOCX_TYPE, ...Object.values(TEXT_TYPES)]);

type Kept = { mediaType: string; name: string; pieces: number; bytes: number; at: number };

const headKey = (id: string) => `app:file:${id}`;
const pieceKey = (id: string, index: number) => `app:filepart:${id}:${index}`;

function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A name's extension, lowercase, or "" when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * A file name as it is kept and shown: its last path part only (so `../../x.pdf` is `x.pdf`), no control or format
 * characters (a right-to-left override could hide an extension), at most `MAX_APP_FILE_NAME` characters with the
 * extension kept, and `file` when nothing is left.
 */
export function safeAppFileName(raw: string): string {
  const last = String(raw).split(/[\\/]/).pop() ?? "";
  const clean = last.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (clean === "" || clean === "." || clean === "..") return "file";
  if ([...clean].length <= MAX_APP_FILE_NAME) return clean;
  const chars = [...clean];
  const ext = extensionOf(clean);
  const tail = ext === "" ? "" : `.${ext}`;
  if (tail.length >= MAX_APP_FILE_NAME) return chars.slice(0, MAX_APP_FILE_NAME).join("");
  const stem = chars.slice(0, chars.length - tail.length).join("");
  return `${stem.slice(0, MAX_APP_FILE_NAME - tail.length)}${tail}`;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isPdf(bytes: Uint8Array): boolean {
  return [0x25, 0x50, 0x44, 0x46, 0x2d].every((value, index) => bytes[index] === value);
}

/** The first bytes of a format that is not text: a zip, a PDF, a Windows or ELF program, or a picture. */
const BINARY_SIGNATURES: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x25, 0x50, 0x44, 0x46, 0x2d],
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
];

/**
 * Plain UTF-8 text with no NUL byte, and not opening with another format's signature: the bytes decide, so a binary
 * named .txt, or a PDF or zip named .csv, is refused even where its bytes happen to be valid UTF-8.
 */
function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  if (BINARY_SIGNATURES.some((signature) => signature.every((value, index) => bytes[index] === value))) return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The kind a file is kept as, from its bytes and its name's extension, or null when it is none of the kinds kept.
 * `name` is the file's name (a path part is ignored: only its extension is read).
 */
export function sniffAppFile(bytes: Uint8Array, name: string): string | null {
  const ext = extensionOf(safeAppFileName(name));
  if (ext === "pdf") return isPdf(bytes) ? "application/pdf" : null;
  if (ext === "docx") return isZip(bytes) ? DOCX_TYPE : null;
  const text = TEXT_TYPES[ext];
  return text !== undefined && isPlainText(bytes) ? text : null;
}

/**
 * Keeps a file's bytes and answers its id, or null when they are empty, too big, or not a kind kept under their name.
 * The name is cleaned first (`safeAppFileName`), and what is kept is the cleaned name.
 */
export async function keepAppFile(storage: InboxStorage, bytes: Uint8Array, name: string, now: number): Promise<string | null> {
  const safe = safeAppFileName(name);
  const mediaType = sniffAppFile(bytes, safe);
  if (mediaType === null || bytes.byteLength === 0 || bytes.byteLength > MAX_APP_FILE_BYTES) return null;
  const id = randomId();
  const pieces = Math.max(1, Math.ceil(bytes.byteLength / PIECE_BYTES));
  try {
    for (let index = 0; index < pieces; index++) await storage.put<Uint8Array>(pieceKey(id, index), bytes.slice(index * PIECE_BYTES, (index + 1) * PIECE_BYTES));
    // Written last, so a file is never read half kept.
    await storage.put<Kept>(headKey(id), { mediaType, name: safe, pieces, bytes: bytes.byteLength, at: now });
  } catch (error) {
    for (let index = 0; index < pieces; index++) await storage.delete(pieceKey(id, index)).catch(() => false);
    throw error;
  }
  return id;
}

/** A kept file's kind, name and bytes, or null for an id this chat does not keep. */
export async function readAppFile(storage: InboxStorage, id: string): Promise<{ mediaType: string; name: string; bytes: Uint8Array } | null> {
  if (!APP_FILE_ID.test(id)) return null;
  const kept = await storage.get<Kept>(headKey(id));
  if (!kept || typeof kept.pieces !== "number" || typeof kept.name !== "string" || !APP_FILE_TYPES.has(kept.mediaType)) return null;
  const bytes = new Uint8Array(kept.bytes);
  let offset = 0;
  for (let index = 0; index < kept.pieces; index++) {
    const piece = await storage.get<Uint8Array>(pieceKey(id, index));
    if (!piece || offset + piece.byteLength > bytes.byteLength) return null;
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return offset === bytes.byteLength ? { mediaType: kept.mediaType, name: kept.name, bytes } : null;
}

/** Deletes a kept file, every piece of it (taken back): nothing is left to read or to serve. */
export async function forgetAppFile(storage: InboxStorage, id: string): Promise<void> {
  if (!APP_FILE_ID.test(id)) return;
  const kept = await storage.get<Kept>(headKey(id));
  await storage.delete(headKey(id));
  for (let index = 0; index < (kept?.pieces ?? 0); index++) await storage.delete(pieceKey(id, index));
}

/** The address a turn reads a kept file at: its id, then its cleaned name, encoded as one path part. */
export function appFileUrl(id: string, name: string): string {
  return `${APP_PICTURE_ORIGIN}/file/${id}/${encodeURIComponent(safeAppFileName(name))}`;
}

/** The id an app file's address names, or null for any other address. */
export function appFileIdOf(url: string): string | null {
  const match = /^https:\/\/app-chat\.invalid\/file\/([0-9a-f]{32})\/[^/?#]+$/.exec(url);
  return match ? match[1]! : null;
}

/** A turn's fetch of an app file's address, from this chat's own store: 404 for any file it does not keep. */
export async function serveAppFile(storage: InboxStorage, url: string): Promise<Response> {
  const id = appFileIdOf(url);
  const kept = id === null ? null : await readAppFile(storage, id);
  if (kept === null) return new Response(null, { status: 404 });
  return new Response(kept.bytes, { headers: { "content-type": kept.mediaType, "content-length": String(kept.bytes.byteLength) } });
}
