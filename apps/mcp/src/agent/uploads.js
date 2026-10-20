/**
 * THE FILES TEX CAN PUT INTO A PAGE (Dev, 2026-10-20: "why can't you attach
 * the receipt yourself?"). A site asked for a receipt file and Tex told him
 * its browser could not use the file picker. A person attaches what they
 * have, so Tex attaches what the person has in Context, and nothing else:
 *
 *  - a file in their notes, by its path (a PDF a mail sync saved, a document);
 *  - a picture they texted or a note shows, by the note and the image, as
 *    `read_image` reads it;
 *  - an email's attachment, by the email's `email:` id and its number;
 *  - an email itself, printed to a PDF (`textPdf.js`), for a confirmation
 *    that came as an email with nothing attached.
 *
 * Every one is read through the session's own dispatcher first, so the
 * privacy engine and the mail grant decide exactly as they do for a read:
 * a file the person could not open is "not found" here too. The bytes go
 * to the browser and nowhere else: never to the model, never kept.
 */

import { getWithLegacyFallback } from "../storageLayout.js";
import { normalizePath } from "../notes/paths.js";
import { parseEmailId, REFUSED } from "../tools/emailRead.js";
import { readableFileType, typeOfFile, MAX_FILE_BYTES } from "../tools/readFile.js";
import { textPdf } from "./textPdf.js";

const GENERIC_TYPE = "application/octet-stream";
/** `read_file`'s refusals that come only after the privacy engine let the file be seen (`readFile.js`). */
const AFTER_SEEN = /^(reading files is not available|this file is |this file could not be read|no words could be taken)/;

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A file name a page may be shown: its last part, no control characters or slashes. */
export function uploadName(name, fallback = "file") {
  const leaf = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return clean || fallback;
}

function fromBytes(name, bytes, type) {
  if (bytes.byteLength > MAX_FILE_BYTES) return { error: `that file is over the ${MAX_FILE_BYTES / 1024 / 1024} MB a page is given` };
  return { file: { name, type: type || typeOfFile(name, bytes) || GENERIC_TYPE, data: base64(bytes) } };
}

function failed(result) {
  return result?.isError === true || !Array.isArray(result?.content);
}

/** Words for an email printed: who, when, what, then the email. */
export function printedEmail(message) {
  const head = [
    `From: ${message.from ?? ""}`,
    `To: ${message.to ?? ""}`,
    `Date: ${message.date ?? ""}`,
    `Subject: ${message.subject ?? ""}`,
  ];
  return `${head.join("\n")}\n\n${String(message.body ?? "")}`;
}

async function fromEmail(source, attachment, store) {
  const parsed = parseEmailId(source);
  if (parsed === null) return { error: "an email is named by its email:<address>/<id> id, as search_email gave it" };
  if (typeof store?.email?.read !== "function") return { error: REFUSED.not_allowed };
  let answer;
  try {
    answer = await store.email.read(parsed.address, parsed.messageId, attachment === undefined ? undefined : { attachment });
  } catch {
    answer = { ok: false, refused: "unavailable" };
  }
  if (!answer?.ok) return { error: REFUSED[answer?.refused] ?? REFUSED.unavailable };
  if (attachment !== undefined) {
    let bytes;
    try {
      bytes = Uint8Array.from(atob(String(answer.attachment?.data ?? "")), (ch) => ch.charCodeAt(0));
    } catch {
      return { error: REFUSED.unavailable };
    }
    return fromBytes(uploadName(answer.attachment?.filename, "attachment"), bytes);
  }
  const subject = String(answer.message?.subject ?? "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 80);
  return fromBytes(`${subject || "email"}.pdf`, textPdf(printedEmail(answer.message ?? {})), "application/pdf");
}

async function fromPicture(note, image, dispatch) {
  const result = await dispatch("read_image", { note, image });
  const picture = failed(result) ? null : result.content.find((part) => part?.type === "image" && typeof part.data === "string");
  if (!picture) return { error: "that picture was not found in that note" };
  const bytes = Uint8Array.from(atob(picture.data), (ch) => ch.charCodeAt(0));
  return fromBytes(uploadName(image, "picture"), bytes, picture.mimeType);
}

async function fromNotes(path, dispatch, store) {
  if (path.startsWith("@")) return { error: "only a file in their own workspace can be put into a page" };
  const key = normalizePath(path);
  if (!key || readableFileType(key) === null) {
    return { error: "file is a PDF, Word, Excel, CSV or picture file in their notes, an email: id, or a picture with its note" };
  }
  // Read as the person first: the privacy engine decides, and a hidden file is "not found".
  // Only that refusal stops it: a file seen but not turned into words (no converter) is still theirs.
  const read = await dispatch("read_file", { path: key });
  const said = Array.isArray(read?.content) ? read.content.map((part) => part?.text ?? "").join(" ") : "";
  const seen = Array.isArray(read?.content) && (read.isError !== true || AFTER_SEEN.test(said.trim()));
  if (!seen) return { error: "not found" };
  const object = await getWithLegacyFallback(store, key);
  if (!object) return { error: "not found" };
  return fromBytes(uploadName(key), new Uint8Array(await object.arrayBuffer()), readableFileType(key));
}

/**
 * The file an upload step names, read as the person: `{ file: { name, type, data } }`
 * or `{ error }` in words the model is shown.
 *
 * @param {{ file?: unknown, attachment?: unknown, note?: unknown }} step
 * @param {{ dispatch: (name: string, args: object) => Promise<object>, store: object }} deps
 */
export async function resolveUpload(step, { dispatch, store }) {
  const source = typeof step?.file === "string" ? step.file.trim() : "";
  if (!source) return { error: "an upload step needs file: a file's path in their notes, an email: id, or a picture's name with its note" };
  const attachment = step.attachment;
  if (attachment !== undefined && (!Number.isInteger(attachment) || attachment < 1 || attachment > 100)) {
    return { error: "attachment is the attachment's number as the email lists it: 1 for the first" };
  }
  try {
    if (source.startsWith("email:")) return await fromEmail(source, attachment, store);
    if (typeof step.note === "string" && step.note.trim()) return await fromPicture(step.note.trim(), source, dispatch);
    return await fromNotes(source, dispatch, store);
  } catch {
    return { error: "that file could not be read just now" };
  }
}
