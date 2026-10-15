/**
 * What a person sent WITH their question: pictures, PDFs and documents, handed
 * to the model as the model's own content blocks rather than dropped.
 *
 * The caller (the texting Worker, `apps/agent/src/attachments.ts`) does the
 * downloading and the format work — a photo in a format the model cannot read
 * is converted there, a Word file is unpacked to its words there — so what
 * arrives here is already one of four kinds:
 *
 *     { name, mediaType, data }    a picture (JPEG, PNG, GIF, WebP) or a PDF, base64
 *     { name, mediaType, text }    a file's words (a text file, a contact card, a Word file)
 *     { name, mediaType, unread }  a file nobody could open, and why, in words for the model
 *     { name, mediaType, data }    a voice message (audio/*), base64, transcribed HERE
 *
 * Audio is the one kind this side changes: the gateway already holds the
 * transcription service (`ingestion/transcription.js`, the one meetings use,
 * with its silence filtering), so a voice message is turned into its words
 * before the model sees the turn, `{ name, mediaType, text, heard: true }`. A
 * deployment without that service, or a transcription that fails, makes it an
 * `unread` with the reason, so the model says so rather than guessing.
 *
 * This module checks each against what the model API takes (types and sizes),
 * builds the blocks, and lets the model keep a picture in a note without ever
 * holding its bytes: write_note's `images[].data` may say `attachment:N`, and
 * the bytes are put in on the way to the tool.
 *
 * Attachments live only for the turn. The saved conversation keeps their names
 * (`attachmentsLine`), never their contents.
 */

/** The most attachments one question may carry; iMessage sends a few photos at once, not dozens. */
export const MAX_ATTACHMENTS = 8;
/** Anthropic's ceiling for one picture, and write_note's (`MAX_REMOTE_IMAGE_BYTES`), so a picture seen can be kept. */
export const MAX_IMAGE_BYTES = 5_000_000;
/** A PDF reads as text and a picture per page; past this it is a book, not a text. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** A voice message, at most: the transcription service's own ceiling (`infra/transcribe-worker`). */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** A file's words, at most. */
export const MAX_TEXT_CHARS = 100_000;
/** Everything one question carries, decoded. Under the model API's own request ceiling. */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PDF = "application/pdf";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class AttachmentRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "AttachmentRefusal";
  }
}

function decodedBytes(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** A name the model can be told, never a path: one line, short. */
function cleanName(name, index) {
  const clean = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f/\\]+/g, " ").trim().slice(0, 120) : "";
  return clean || `attachment-${index + 1}`;
}

/**
 * The request body's `attachments`, checked. Absent is none; anything that is
 * not one of the kinds above, or is over a ceiling, refuses the whole question
 * with a sentence the caller can log — a caller of ours never sends one.
 */
export function readAttachments(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachmentRefusal("attachments must be a list.");
  if (raw.length > MAX_ATTACHMENTS) throw new AttachmentRefusal(`At most ${MAX_ATTACHMENTS} attachments.`);
  let total = 0;
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AttachmentRefusal("An attachment must be an object.");
    const name = cleanName(item.name, index);
    const mediaType = typeof item.mediaType === "string" ? item.mediaType.toLowerCase().slice(0, 100) : "";
    if (typeof item.unread === "string") {
      return { name, mediaType, unread: item.unread.replace(/\s+/g, " ").trim().slice(0, 300) };
    }
    if (typeof item.text === "string") {
      total += item.text.length;
      if (total > MAX_TOTAL_BYTES) throw new AttachmentRefusal("The attachments are too big.");
      return { name, mediaType: mediaType || "text/plain", text: item.text.slice(0, MAX_TEXT_CHARS) };
    }
    if (typeof item.data !== "string" || !BASE64.test(item.data) || item.data.length % 4 !== 0) {
      throw new AttachmentRefusal("An attachment needs base64 data, text, or an unread reason.");
    }
    const bytes = decodedBytes(item.data);
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new AttachmentRefusal("The attachments are too big.");
    if (IMAGE_TYPES.has(mediaType)) {
      if (bytes > MAX_IMAGE_BYTES) throw new AttachmentRefusal("A picture is at most 5 MB.");
      return { name, mediaType, data: item.data };
    }
    if (mediaType === PDF) {
      if (bytes > MAX_PDF_BYTES) throw new AttachmentRefusal("A PDF is at most 10 MB.");
      return { name, mediaType, data: item.data };
    }
    if (mediaType.startsWith("audio/")) {
      if (bytes > MAX_AUDIO_BYTES) throw new AttachmentRefusal("A voice message is at most 8 MB.");
      return { name, mediaType, data: item.data };
    }
    throw new AttachmentRefusal("Only pictures (JPEG, PNG, GIF, WebP), PDFs and audio are sent as data.");
  });
}

/** `readAttachments` for one `/agent` turn: none on a routine's run, a refusal as its sentence, voice messages heard. */
export async function turnAttachments(raw, runner, { transcribe = null, callerId = "" } = {}) {
  if (runner) return { attachments: [], refusal: null };
  let attachments;
  try {
    attachments = readAttachments(raw);
  } catch (error) {
    if (!(error instanceof AttachmentRefusal)) throw error;
    return { attachments: [], refusal: error.message };
  }
  return { attachments: await hearVoiceMessages(attachments, transcribe, callerId), refusal: null };
}

const isAudio = (attachment) => typeof attachment.data === "string" && attachment.mediaType.startsWith("audio/");

/** What the transcription service heard, as one paragraph, or "" for nothing. */
function heardText(payload) {
  if (typeof payload?.text === "string" && payload.text.trim()) return payload.text.replace(/\s+/g, " ").trim();
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  return segments
    .map((segment) => (typeof segment?.text === "string" ? segment.text.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

/**
 * Every voice message replaced by its words (or by why there are none). The
 * audio goes to the service and nowhere else: not logged, not kept, and the
 * caller is named to it only as `callerId`, which the forwarder hashes.
 */
export async function hearVoiceMessages(attachments, transcribe, callerId) {
  if (!attachments.some(isAudio)) return attachments;
  return await Promise.all(
    attachments.map(async (attachment) => {
      if (!isAudio(attachment)) return attachment;
      const { name, mediaType } = attachment;
      if (typeof transcribe !== "function") {
        return { name, mediaType, unread: "It is a voice message, and voice messages can't be transcribed on this server. Ask them to type it." };
      }
      try {
        const text = heardText(await transcribe({ audioBase64: attachment.data, mimeType: mediaType, callerId: String(callerId) }));
        if (!text) return { name, mediaType, unread: "It is a voice message with no words you could make out. Ask them to say it again or type it." };
        return { name, mediaType, text: text.slice(0, MAX_TEXT_CHARS), heard: true };
      } catch {
        return { name, mediaType, unread: "It is a voice message, and transcribing it failed. Ask them to send it again or type it." };
      }
    }),
  );
}

const isPicture = (attachment) => typeof attachment.data === "string" && IMAGE_TYPES.has(attachment.mediaType);

/** What the model is told about the attachments, ahead of the person's words. */
function describe(attachments) {
  const lines = attachments.map((attachment, index) => {
    const n = index + 1;
    if (typeof attachment.unread === "string") return `${n}. ${attachment.name}: could not be opened. ${attachment.unread}`;
    if (isPicture(attachment)) return `${n}. ${attachment.name}: a picture, shown above.`;
    if (attachment.mediaType === PDF) return `${n}. ${attachment.name}: a PDF, shown above.`;
    if (attachment.heard) return `${n}. ${attachment.name}: a voice message; what they said is transcribed above. Answer it as if they had typed it.`;
    return `${n}. ${attachment.name}: a file, its text shown above.`;
  });
  const pictures = attachments.filter(isPicture);
  return [
    `They sent ${attachments.length === 1 ? "this attachment" : `these ${attachments.length} attachments`} with this text:`,
    ...lines,
    ...(pictures.length > 0
      ? [
          'To keep a picture in a note, pass write_note images: [{ name: "<a file name>.jpg", data: "attachment:<number>" }] and embed it by that name; never type out its bytes.',
        ]
      : []),
  ].join("\n");
}

/** The Anthropic content blocks for one user turn: the attachments, then what to make of them, then the words. */
export function anthropicAttachmentBlocks(attachments, text) {
  const blocks = [];
  for (const attachment of attachments) {
    if (isPicture(attachment)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: attachment.mediaType, data: attachment.data } });
    } else if (attachment.mediaType === PDF && typeof attachment.data === "string") {
      blocks.push({ type: "document", source: { type: "base64", media_type: PDF, data: attachment.data }, title: attachment.name });
    } else if (typeof attachment.text === "string") {
      const title = attachment.heard ? `${attachment.name} (voice message, transcribed)` : attachment.name;
      blocks.push({ type: "document", source: { type: "text", media_type: "text/plain", data: attachment.text || "(empty)" }, title });
    }
  }
  blocks.push({ type: "text", text: `${describe(attachments)}\n\n${text || "(No words, just the attachments.)"}` });
  return blocks;
}

/**
 * The same turn for a model that takes words only (the Workers AI fallback):
 * a file's text comes along, a picture or PDF is named as one it cannot see,
 * so it says so rather than inventing what was in it.
 */
export function plainAttachmentText(attachments, text) {
  const parts = attachments.map((attachment, index) => {
    const n = index + 1;
    if (attachment.heard) return `${n}. ${attachment.name}, a voice message; they said:\n${attachment.text.slice(0, 20_000)}`;
    if (typeof attachment.text === "string") return `${n}. ${attachment.name}:\n${attachment.text.slice(0, 20_000)}`;
    if (typeof attachment.unread === "string") return `${n}. ${attachment.name}: could not be opened. ${attachment.unread}`;
    return `${n}. ${attachment.name}: you cannot see this one on this model; say so if they ask about it.`;
  });
  return `They sent attachments with this text:\n${parts.join("\n")}\n\n${text || "(No words, just the attachments.)"}`;
}

/**
 * The line the saved conversation keeps instead of the attachments, so a later
 * text ("what was in that photo?") knows something was sent, and the model can
 * say it no longer has it. A voice message is the exception: its words are the
 * person's own message, said instead of typed, so they are kept as a typed one
 * would be (bounded), and "what did I just say?" has an answer.
 */
export const MAX_SAVED_VOICE_CHARS = 2000;

export function attachmentsLine(attachments) {
  if (attachments.length === 0) return "";
  const line = `[Sent with this text: ${attachments.map((attachment) => attachment.name).join(", ")}. Seen only on that turn.]`;
  const said = attachments
    .filter((attachment) => attachment.heard)
    .map((attachment) => `[Voice message ${attachment.name}: "${attachment.text.slice(0, MAX_SAVED_VOICE_CHARS)}"]`);
  return [line, ...said].join("\n");
}

const REFERENCE = /^attachment:(\d+)$/;

/**
 * write_note `images[].data: "attachment:N"` becomes that picture's bytes on
 * the way to the tool, so a texted photo can be kept in a note without the
 * model ever repeating it. Anything else passes through untouched; a number
 * that names no picture is left for write_note to refuse.
 */
export function withAttachmentImages(attachments, callTool) {
  if (!attachments.some(isPicture)) return callTool;
  return (name, args) => {
    if (name !== "write_note" || !Array.isArray(args?.images)) return callTool(name, args);
    const images = args.images.map((image) => {
      const ref = typeof image?.data === "string" ? REFERENCE.exec(image.data.trim()) : null;
      const attachment = ref ? attachments[Number(ref[1]) - 1] : undefined;
      if (!attachment || !isPicture(attachment)) return image;
      return { ...image, data: `data:${attachment.mediaType};base64,${attachment.data}` };
    });
    return callTool(name, { ...args, images });
  };
}
