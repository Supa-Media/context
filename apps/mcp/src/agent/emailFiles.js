/**
 * A PICTURE THEY TEXTED, ATTACHED TO AN EMAIL (a review of a chat,
 * 2026-10-27). The person texted a screenshot and asked for a Gmail draft to
 * a support team with it attached. `attach` took only `download:` ids, so Tex
 * opened Gmail in its browser and tried the web uploader, which saved the
 * draft with the wrong picture and then an empty file, and it ended by telling
 * them to tap the paperclip themselves.
 *
 * So `send_email` and `save_email_draft` take what Tex already holds, in the
 * words it was given it, and the bytes go in through the Gmail API like any
 * downloaded file's:
 *
 *  - `"attachment:N"`: a file sent with this text (the N-th, as the turn
 *    lists them);
 *  - `"<image> in <note>"`: a picture an earlier text sent, as the saved
 *    conversation names it (`attachmentsLine`), or one any note shows;
 *  - a file in their notes by its path, as a browse upload step takes it.
 *
 * An email's own attachments are not named here: those go on with `forward`,
 * from the mailbox they are in, which the gate already shows by name.
 *
 * Each is read through the very `callTool` it wraps (`uploads.js`), so the
 * privacy engine, and a group chat's own limits, decide exactly as they do
 * for `read_image` or `read_file`,
 * then kept as a download (`downloads.js`) and handed on as its `download:`
 * id: the gate shows the person the file by name, the held email keeps an id
 * a 👍 can still send, and the control plane gets the bytes. The same file
 * named twice in one turn is kept once.
 */

import { keepDownload } from "./downloads.js";
import { resolveUpload } from "./uploads.js";
import { toolError } from "../tools/results.js";

const EMAIL_TOOLS = new Set(["send_email", "save_email_draft"]);
const ATTACHMENT = /^attachment:(\d{1,2})$/i;
const PICTURE_IN_NOTE = /^(?:image\s+)?(\S+\.(?:png|jpe?g|gif|webp|heic|heif))\s+in\s+(\S.*\.md)$/i;

const isDownload = (value) => typeof value === "string" && value.trim().startsWith("download:");

/** What one `attach` entry names, as an upload step (`uploads.js`), or `{ sent: N }` for this text's own file. */
export function attachSource(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const sent = ATTACHMENT.exec(raw);
  if (sent) return { sent: Number(sent[1]) };
  const picture = PICTURE_IN_NOTE.exec(raw);
  if (picture) return { file: picture[1], note: picture[2].trim() };
  if (raw.startsWith("email:")) return { error: "an email's attachments go on with forward, not attach" };
  return { file: raw };
}

/** A file sent with this text, as `{ file }` to keep, `{ id }` when already kept, or `{ error }`. */
function sentFile(attachments, n) {
  const attachment = attachments[n - 1];
  if (!attachment || attachment.carried) return { error: "not a file sent with this text" };
  if (attachment.kept?.id) return { id: attachment.kept.id };
  if (typeof attachment.data !== "string") return { error: "it came as words, not a file" };
  return { file: { name: attachment.name, type: attachment.mediaType, data: attachment.data } };
}

/**
 * `callTool` with every `attach` entry of an email that is not already a
 * `download:` id turned into one, or the refusal saying which entry failed.
 */
export function withEmailFiles({ store, attachments = [] }, callTool) {
  const dispatch = (name, args) => callTool(name, args);
  const kept = new Map();
  const keep = async (value) => {
    const key = String(value).trim();
    if (kept.has(key)) return kept.get(key);
    const source = attachSource(key);
    if (source === null) return { error: "an attach entry is empty" };
    if (source.error) return { error: `${key}: ${source.error}` };
    const found = source.sent !== undefined ? sentFile(attachments, source.sent) : await resolveUpload(source, { dispatch, store });
    if (found.id) return { id: found.id };
    if (!found.file) return { error: `${key}: ${found.error ?? "not found"}` };
    const saved = await keepDownload(store, found.file).catch(() => ({ error: "it could not be kept just now" }));
    if (!saved?.id) return { error: `${key}: ${saved?.error ?? "it could not be kept just now"}` };
    kept.set(key, { id: saved.id });
    return { id: saved.id };
  };
  return async (name, args) => {
    if (!EMAIL_TOOLS.has(name) || args?.attach === undefined || args.attach === null) return callTool(name, args);
    const list = typeof args.attach === "string" ? [args.attach] : args.attach;
    if (!Array.isArray(list) || list.every(isDownload)) return callTool(name, args);
    const ids = [];
    for (const value of list) {
      if (isDownload(value)) {
        ids.push(value.trim());
        continue;
      }
      if (typeof value !== "string") return callTool(name, args); // left for the tool to refuse in its own words
      const made = await keep(value);
      if (made.error) return toolError(`${name === "send_email" ? "Not sent" : "Not saved"}: could not attach ${made.error}.`);
      ids.push(made.id);
    }
    return callTool(name, { ...args, attach: ids });
  };
}
