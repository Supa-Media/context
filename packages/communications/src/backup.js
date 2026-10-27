// The Messages backup contract: what the Mac app sends, and what the gateway
// keeps, when a person's texts are copied into their own storage.
//
// `docs/decisions/communications/messages-backup.md` carries the argument.
// The short form: a text is not a note. The Mac app turns each row of
// `chat.db` into one record, the gateway writes records into the person's
// bucket under `BACKUP_PREFIX` (hidden plumbing, so no listing, notes search
// or map ever shows them), and an AI reads them only when it asks for them.
//
// Both sides import this file, so the shape a record may take is said once.
// The gateway never trusts the Mac's word for it: every record it is sent
// goes through `normalizeBackupRecord`, which keeps the fields named here and
// nothing else, and refuses a record rather than repairing one.
//
// Nothing here does I/O.

/** Bumped when a record stops meaning what it meant. */
export const BACKUP_VERSION = 1;

/** Where a batch is posted, under the gateway's origin (and its `@name` selector, which this route refuses). */
export const MESSAGES_BACKUP_ROUTE = "/messages/imessage/batch";

/** Every object the backup keeps lives under this key prefix in the person's bucket. */
export const BACKUP_PREFIX = ".context/messages/imessage/";

/**
 * Where one picture or document is posted: `<route>/<folder>/<id>`, the body
 * its bytes. `folder` is `digestId` of the message's id and `id` is
 * `digestId` of Apple's id for the file, so the same file always lands on the
 * same key (a retry overwrites itself), and an unsent message's files are
 * everything under its one folder.
 */
export const MESSAGES_BACKUP_FILE_ROUTE = "/messages/imessage/file";

/** A file's id, and its message's folder: the first 32 hex characters of a SHA-256. */
export const FILE_ID = /^[0-9a-f]{32}$/;

/** The record kinds, and the key each is folded by: a later record with the same kind and key replaces an earlier one. */
export const RECORD_KINDS = Object.freeze(["message", "reaction", "chat", "person"]);

/** Limits a batch is held to, on both sides. The Mac splits to fit; the gateway refuses what does not. */
export const LIMITS = Object.freeze({
  /** Records in one batch. */
  records: 2000,
  /** Bytes of one batch's JSON body. */
  bodyBytes: 4 * 1024 * 1024,
  /** Characters of one message's text. A longer one is cut, and says so with `cut: true`. */
  text: 20_000,
  /** Apple's ids (a message or chat guid), a handle, a chat name, a file name. */
  id: 200,
  name: 300,
  /** Members of one chat; files on one message. */
  members: 200,
  files: 40,
  /** Bytes of one copied file. Anything larger stays on the Mac (owner's pick, 2026-10-26). */
  fileBytes: 25 * 1024 * 1024,
});

/** Tapback names, from `associated_message_type` 2000–2005. Anything else Apple adds is `reacted`. */
export const REACTIONS = Object.freeze(["loved", "liked", "disliked", "laughed", "emphasized", "questioned", "reacted"]);

/** Apple's services a text can travel on. Anything else is kept as `other`. */
export const SERVICES = Object.freeze(["iMessage", "SMS", "RCS", "other"]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// Bidi overrides and C0 controls other than tab and newline. A name or id is
// shown to a person and to a model; neither should be steered by bytes it
// cannot see. Message text keeps its newlines, and nothing else is taken out.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

function oneLine(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(INVISIBLE, "").replace(/[\t\n\r]+/g, " ").trim();
  if (cleaned === "") return null;
  return cleaned.slice(0, max);
}

function iso(value) {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

function handle(value) {
  return oneLine(value, LIMITS.id);
}

function service(value) {
  return SERVICES.includes(value) ? value : "other";
}

function files(value) {
  if (!Array.isArray(value)) return [];
  const kept = [];
  for (const file of value.slice(0, LIMITS.files)) {
    if (typeof file !== "object" || file === null) continue;
    const name = oneLine(file.name, LIMITS.name);
    const type = oneLine(file.type, 100);
    const bytes = Number.isSafeInteger(file.bytes) && file.bytes >= 0 ? file.bytes : null;
    const id = typeof file.id === "string" && FILE_ID.test(file.id) ? file.id : null;
    if (name === null && type === null) continue;
    kept.push({
      ...(id !== null ? { id } : {}),
      ...(name !== null ? { name } : {}),
      ...(type !== null ? { type } : {}),
      ...(bytes !== null ? { bytes } : {}),
    });
  }
  return kept;
}

/**
 * One record as the gateway will keep it, or `null` when it is not one.
 *
 * Fields that are not named here are dropped, never carried: the bucket holds
 * what this contract says and nothing a client chose to add.
 *
 * @param {unknown} raw
 */
export function normalizeBackupRecord(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (raw.v !== BACKUP_VERSION) return null;
  switch (raw.kind) {
    case "message": {
      const id = handle(raw.id);
      const chat = handle(raw.chat);
      const at = iso(raw.at);
      if (id === null || chat === null || at === null) return null;
      const me = raw.me === true;
      const from = me ? null : handle(raw.from);
      const unsent = raw.unsent === true;
      const full = unsent || typeof raw.text !== "string" ? "" : raw.text.replace(/\u0000/g, "");
      const text = full.slice(0, LIMITS.text);
      const kept = files(raw.files);
      const edited = iso(raw.edited);
      const replyTo = handle(raw.replyTo);
      return {
        v: BACKUP_VERSION,
        kind: "message",
        id,
        chat,
        at,
        me,
        ...(from !== null ? { from } : {}),
        text,
        ...(full.length > text.length ? { cut: true } : {}),
        service: service(raw.service),
        ...(edited !== null ? { edited } : {}),
        ...(unsent ? { unsent: true } : {}),
        ...(replyTo !== null ? { replyTo } : {}),
        ...(kept.length > 0 && !unsent ? { files: kept } : {}),
      };
    }
    case "reaction": {
      const id = handle(raw.id);
      const chat = handle(raw.chat);
      const at = iso(raw.at);
      const target = handle(raw.target);
      if (id === null || chat === null || at === null || target === null) return null;
      const me = raw.me === true;
      const from = me ? null : handle(raw.from);
      return {
        v: BACKUP_VERSION,
        kind: "reaction",
        id,
        chat,
        at,
        me,
        ...(from !== null ? { from } : {}),
        target,
        reaction: REACTIONS.includes(raw.reaction) ? raw.reaction : "reacted",
        ...(raw.removed === true ? { removed: true } : {}),
      };
    }
    case "chat": {
      const id = handle(raw.id);
      if (id === null) return null;
      const name = oneLine(raw.name, LIMITS.name);
      const members = Array.isArray(raw.members)
        ? [...new Set(raw.members.map(handle).filter((member) => member !== null))].slice(0, LIMITS.members)
        : [];
      return {
        v: BACKUP_VERSION,
        kind: "chat",
        id,
        ...(name !== null ? { name } : {}),
        members,
        service: service(raw.service),
      };
    }
    case "person": {
      const address = handle(raw.handle);
      const name = oneLine(raw.name, LIMITS.name);
      if (address === null || name === null) return null;
      return { v: BACKUP_VERSION, kind: "person", handle: address, name };
    }
    default:
      return null;
  }
}

/** The key a record folds by: a later record with the same key replaces an earlier one. */
export function recordKey(record) {
  return record.kind === "person" ? `person:${record.handle}` : `${record.kind}:${record.id}`;
}

/**
 * The 32-hex-character name the backup gives an id of Apple's: a message's
 * files folder, or a file. A digest because Apple's ids carry `:` and `/`,
 * and so a key says nothing about the conversation it came from.
 *
 * @param {string} text
 */
export async function digestId(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Where a message's files live, one key each under it. */
export function filesFolderKeyOf(folder) {
  if (!FILE_ID.test(folder)) throw new TypeError("not a files folder");
  return `${BACKUP_PREFIX}files/${folder}/`;
}

/** Where one file's bytes live. */
export function fileKeyOf(folder, id) {
  if (!FILE_ID.test(id)) throw new TypeError("not a file id");
  return `${filesFolderKeyOf(folder)}${id}`;
}

/** `{ folder, id }` for a file route path, or null when the path is not one. */
export function parseFileRoute(path) {
  if (typeof path !== "string" || !path.startsWith(`${MESSAGES_BACKUP_FILE_ROUTE}/`)) return null;
  const [folder, id, ...rest] = path.slice(MESSAGES_BACKUP_FILE_ROUTE.length + 1).split("/");
  if (rest.length > 0 || !FILE_ID.test(folder ?? "") || !FILE_ID.test(id ?? "")) return null;
  return { folder, id };
}

const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4v", "avi", "mkv", "webm", "3gp", "3g2", "hevc", "mpg", "mpeg", "wmv"]);

/** Whether a file is a video, by its type or, when that says nothing, its name. Videos are off (owner's pick). */
export function isVideoFile(file) {
  const type = typeof file?.type === "string" ? file.type.toLowerCase() : "";
  if (type.startsWith("video/")) return true;
  const name = typeof file?.name === "string" ? file.name.toLowerCase() : "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTENSIONS.has(name.slice(dot + 1));
}

/** `YYYY-MM` of a dated record (UTC), the month file it is folded into. */
export function monthOf(record) {
  return typeof record?.at === "string" ? record.at.slice(0, 7) : null;
}

/**
 * Check a whole batch body. Answers `{ ok: true, records, dropped }` or
 * `{ ok: false, reason }`; `dropped` counts records that were not records.
 *
 * @param {unknown} body Parsed JSON.
 */
export function readBackupBatch(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "invalid" };
  if (body.v !== BACKUP_VERSION) return { ok: false, reason: "version" };
  if (!Array.isArray(body.records)) return { ok: false, reason: "invalid" };
  if (body.records.length === 0) return { ok: false, reason: "empty" };
  if (body.records.length > LIMITS.records) return { ok: false, reason: "too_many" };
  const records = [];
  let dropped = 0;
  for (const raw of body.records) {
    const record = normalizeBackupRecord(raw);
    if (record === null) dropped += 1;
    else records.push(record);
  }
  return { ok: true, records, dropped };
}
