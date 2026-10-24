/**
 * A FILE THEY TEXTED, KEPT SO A LATER TEXT OR A JOB CAN READ IT AGAIN
 * (the owner's review of a chat, 2026-10-24).
 *
 * The owner texted Tex a Rocket Money export (a CSV) for a spending
 * breakdown. Its words reached that one turn and nothing else: the saved
 * conversation kept its name with "Seen only on that turn", the background
 * job doing the breakdown never had it, and every later text said "send it
 * again". Asked twice to resend, the owner refused, and Tex ended by asking
 * him to email the file to himself.
 *
 * So a file that came with a text (its words, or a PDF's bytes) is kept the
 * way a file Tex's browser downloads is (`downloads.js`): in the person's own
 * bucket under `.context/agent/downloads/`, for 30 days, named by a
 * `download:` id. The turn is told the id, the saved conversation keeps it,
 * and any later turn or job reads the file again with `read_file` (or
 * `read_note`, or `fetch`) and that id; `send_email`'s `attach` takes it
 * as it takes a download. A picture is not kept here: today's transcript
 * already stores it, and `read_image` shows it again (`transcript.js`).
 *
 * A long file is read in parts: `download:<id>@<from>` starts at that
 * character, and each part says where the next one starts, so a job can go
 * through every row of an export rather than the first 100,000 characters.
 *
 * What is read is someone else's words as much as any file is, so a read
 * marks the turn untrusted (`onRead`), as `read_file` does through the
 * dispatcher (`privacy/egress.js`).
 */

import { keepDownload, readDownload } from "./downloads.js";
import { MAX_FILE_CHARS, QUOTATION, fileWords, typeOfFile } from "../tools/readFile.js";
import { toolError, toolText } from "../tools/results.js";

/** `download:<id>`, optionally `@<from>`: where in a kept file's words to start. */
const REF = /^(download:\d{13}-[sl]-[a-f0-9]{32})(?:@(\d{1,9}))?$/;
const PDF = "application/pdf";
const TEXT_TYPE = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml)$)/;
/** Files whose words are rows of figures: what a breakdown is added up from. */
const TABLE = /\.(?:csv|tsv)$/i;

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A text file's type as it is kept: its own when that reads as words (`text/csv`), else plain text (a Word file's words). */
function textType(mediaType) {
  const type = String(mediaType ?? "").split(";")[0].trim().toLowerCase();
  return TEXT_TYPE.test(type) ? type : "text/plain";
}

const keepable = (attachment) =>
  (typeof attachment?.text === "string" && attachment.heard !== true) || (attachment?.mediaType === PDF && typeof attachment?.data === "string");

/**
 * The attachments, each file among them kept and carrying `kept: { id,
 * keptFor }`. Best effort: a file that could not be kept is still shown to
 * this turn, and is named as seen only on it.
 */
export async function keepSentFiles(store, attachments) {
  if (!Array.isArray(attachments) || !attachments.some(keepable)) return attachments;
  return await Promise.all(
    attachments.map(async (attachment) => {
      if (!keepable(attachment)) return attachment;
      const text = typeof attachment.text === "string";
      try {
        const kept = await keepDownload(store, {
          name: attachment.name,
          type: text ? textType(attachment.mediaType) : PDF,
          data: text ? utf8Base64(attachment.text || " ") : attachment.data,
        });
        return kept?.id ? { ...attachment, kept: { id: kept.id, keptFor: kept.keptFor } } : attachment;
      } catch {
        return attachment;
      }
    }),
  );
}

/** A kept file's reference, `{ id, from }`, or null when the value names none. */
export function keptRef(value) {
  const match = typeof value === "string" ? REF.exec(value.trim()) : null;
  return match ? { id: match[1], from: match[2] === undefined ? 0 : Number(match[2]) } : null;
}

/** How many rows a table's words hold (its header line not counted), and its header. */
function tableFacts(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return { rows: Math.max(0, lines.length - 1), header: (lines[0] ?? "").slice(0, 500) };
}

/** One kept file's words as a tool answer, from `from`, in parts of `MAX_FILE_CHARS`. */
export async function readKeptFile(store, ai, ref, { now } = {}) {
  const read = await readDownload(store, ref.id, now === undefined ? {} : { now });
  if (read.error) return toolError(read.error);
  const { name, type } = read.file;
  const bytes = fromBase64(read.file.data);
  const head = [`file: ${name}`, `id: ${ref.id}`, "kind: file", `type: ${type}`, "trust: untrusted"];
  if (TEXT_TYPE.test(type)) {
    const text = new TextDecoder().decode(bytes);
    if (ref.from >= text.length && text.length > 0) return toolError(`${ref.id} has ${text.length} characters; nothing starts at ${ref.from}`);
    const to = Math.min(text.length, ref.from + MAX_FILE_CHARS);
    head.push(`characters: ${ref.from} to ${to} of ${text.length}`);
    if (TABLE.test(name)) {
      const { rows, header } = tableFacts(text);
      head.push(`rows: ${rows} (not counting the header)`, `header: ${header}`);
    }
    if (to < text.length) head.push(`more: read_file with path "${ref.id}@${to}" reads the next part; read every part before you total anything`);
    return toolText(`${head.join("\n")}\n\n${QUOTATION}\n\n${text.slice(ref.from, to)}`);
  }
  const readAs = typeOfFile(name, bytes) ?? (type === PDF ? PDF : null);
  if (readAs === null) return toolError(`${ref.id} is a ${type} file: it can be attached to an email or put into a page, not read`);
  const words = await fileWords(ai, name, readAs, bytes);
  if (words.error) return toolError(`${words.error}: ${ref.id}`);
  return toolText(`${head.join("\n")}\n\n${QUOTATION}\n\n${words.text}`);
}

/** Which argument of which tool can name a kept file. */
const READERS = { read_file: "path", read_note: "path", fetch: "id" };

/**
 * `read_file` (or `read_note`, or `fetch`) with a `download:` id reads that
 * kept file from this bucket; anything else goes on to the dispatcher as it
 * was. `onRead` marks the turn as having read someone else's words.
 */
export function withKeptFiles(store, onRead, callTool) {
  return async (name, args) => {
    const field = READERS[name];
    const ref = field ? keptRef(args?.[field]) : null;
    if (ref === null) return callTool(name, args);
    onRead?.();
    return await readKeptFile(store, store?.ai, ref);
  };
}
