// The Messages backup, read back as a person reads texts: one Markdown file
// per conversation per month, with each picture linked beside it (board 2,
// "Your copy: Download messages", owner 2026-10-26).
//
// The bucket keeps the open form (`backup.js`): JSON lines in arrival order,
// a later record replacing an earlier one with the same `recordKey`. This
// folds that log and renders it. Nothing here does I/O; whoever reads the log
// and writes the files (the Mac app, a download) hands records in and takes
// paths and text out.

import { recordKey } from "./backup.js";

/**
 * Fold records, given in the order they arrived: the later one with the same
 * key wins, as everywhere the backup is read.
 *
 * @param {Iterable<any>} records
 */
export function foldRecords(records) {
  const latest = new Map();
  for (const record of records) {
    if (record && typeof record === "object" && typeof record.kind === "string") latest.set(recordKey(record), record);
  }
  const fold = { messages: [], reactions: [], chats: new Map(), people: new Map() };
  for (const record of latest.values()) {
    if (record.kind === "message") fold.messages.push(record);
    else if (record.kind === "reaction") fold.reactions.push(record);
    else if (record.kind === "chat") fold.chats.set(record.id, record);
    else if (record.kind === "person") fold.people.set(record.handle, record.name);
  }
  return fold;
}

// Characters no common file system takes in a name, controls, and bidi marks.
const UNSAFE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g;

/** A name that is safe as one path segment anywhere, or `fallback`. */
export function safeSegment(name, fallback = "Conversation") {
  const cleaned = String(name ?? "").replace(UNSAFE, " ").replace(/\s+/g, " ").replace(/^[.\s]+/, "").slice(0, 80).trim();
  return cleaned === "" ? fallback : cleaned;
}

function chatTitle(chat, people, fallbackId) {
  if (chat?.name) return chat.name;
  const who = (chat?.members ?? []).map((handle) => people.get(handle) ?? handle);
  return who.length > 0 ? who.join(", ") : fallbackId;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayHeading(iso) {
  const date = new Date(iso);
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function quote(text, most = 60) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > most ? `${line.slice(0, most)}…` : line;
}

/** Where a picture sits beside its transcript: `files/<id>-<name>`. */
export function fileLinkOf(file) {
  const name = safeSegment(file.name ?? "", "file");
  return `files/${file.id}-${name}`;
}

/**
 * Every transcript: `{ path, text, files }`, where `path` is
 * `<conversation>/<yyyy-mm>.md` and `files` the pictures it links, each with
 * the message id and file id that name its bytes in the bucket and the path
 * it is linked at. Conversations that two names would collide on are told
 * apart with a number, the same one in every month.
 *
 * Times are UTC: the backup keeps the instant, not the time zone it was read
 * in, and every file says so.
 *
 * With `links: false` the texts come alone: every file is named in
 * parentheses and none is listed, for a copy that does not carry the bytes
 * (the whole-workspace Download as folders).
 *
 * @param {ReturnType<typeof foldRecords>} fold
 * @param {{ links?: boolean }} [options]
 */
export function transcriptFiles(fold, { links: linked = true } = {}) {
  const { messages, reactions, chats, people } = fold;
  const byId = new Map(messages.map((message) => [message.id, message]));

  // One folder name per conversation, numbered when two would share one.
  const chatIds = [...new Set([...messages, ...reactions].map((record) => record.chat))].sort();
  const folders = new Map();
  const taken = new Map();
  for (const id of chatIds) {
    const base = safeSegment(chatTitle(chats.get(id), people, id));
    const seen = (taken.get(base.toLowerCase()) ?? 0) + 1;
    taken.set(base.toLowerCase(), seen);
    folders.set(id, seen === 1 ? base : `${base} (${seen})`);
  }

  const groups = new Map();
  for (const record of [...messages, ...reactions]) {
    if (record.kind === "reaction" && record.removed) continue;
    const key = `${record.chat}\u0000${record.at.slice(0, 7)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const out = [];
  for (const [key, records] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [chat, month] = key.split("\u0000");
    records.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const title = chatTitle(chats.get(chat), people, chat);
    const [year, mm] = month.split("-");
    const lines = [`# ${title} · ${MONTHS[Number(mm) - 1]} ${year}`, "", "Times are UTC."];
    const files = [];
    let day = null;
    for (const record of records) {
      const heading = dayHeading(record.at);
      if (heading !== day) {
        lines.push("", `**${heading}**`, "");
        day = heading;
      }
      const who = record.me ? "You" : people.get(record.from) ?? record.from ?? "Someone";
      const time = record.at.slice(11, 16);
      if (record.kind === "reaction") {
        const target = byId.get(record.target);
        lines.push(`- ${time} · ${who} ${record.reaction} ${target ? `“${quote(target.text)}”` : "a text"}`);
        continue;
      }
      if (record.unsent) {
        lines.push(`- ${time} · ${who}: (unsent)`);
        continue;
      }
      const words = String(record.text ?? "").replace(/\n/g, "  \n  ");
      const links = [];
      for (const file of record.files ?? []) {
        if (linked && typeof file.id === "string") {
          const path = fileLinkOf(file);
          files.push({ messageId: record.id, id: file.id, name: file.name ?? null, path });
          links.push(`[${file.name ?? "file"}](${encodeURI(path)})`);
        } else {
          links.push(`(${file.name ?? "a file"})`);
        }
      }
      const body = [words, ...links].filter((part) => part !== "").join(" ");
      lines.push(`- ${time} · ${who}: ${body || "(no words)"}${record.edited ? " (edited)" : ""}`);
    }
    out.push({ path: `${folders.get(chat)}/${month}.md`, text: `${lines.join("\n")}\n`, files });
  }
  return out;
}
