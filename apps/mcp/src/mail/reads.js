/**
 * Read receipts for a note's mail (Dev, 2026-11-26: "show read receipts whenever an agent reads a mail", then
 * "whenever a mail is read"). Each read is kept in the workspace object that holds the note
 * (`workspaceStore/mailReads.js`), behind the response, and only for a note with a mail block:
 *
 *   - `countAiMailRead`: an AI client's `read_note` or `fetch` that handed the note back, its mail included.
 *   - `countPersonMailRead`: a person opening the note in the app, or its Agent Mail thread (`live/mailNotesRoute.js`).
 *
 * The reader is named as it would sign mail: a person by their `@handle`, an AI client by the name it registered and
 * the `@handle` of the person whose client it is. Never throws: a read that cannot be kept never fails the read.
 */
import { normalizePath } from "../notes/paths.js";
import { objectReader } from "../store/objectLookup.js";
import { boundBotOf } from "./boundBot.js";

const MAIL_FENCE = /^ {0,3}```mail\s*$/m;
const id = (value) => (typeof value === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(value) ? value : "-");
const handle = (value) => (typeof value === "string" && /^@[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ? value : null);

/** The object client and the reader's judged fields, or null where the notes are not in an object. */
function readerOf(store) {
  const reader = objectReader(store?.objectReading ?? {});
  return reader !== null && typeof reader.client?.mail?.read === "function" ? reader : null;
}

function record(store, fields) {
  const reader = readerOf(store);
  if (reader === null) return;
  const work = Promise.resolve(fields)
    .then((ready) => reader.client.mail.read({ ...ready, ...reader.judged }))
    .catch(() => null);
  if (typeof store.defer === "function") store.defer(work);
}

/** The text a tool result handed back, joined. */
const resultText = (result) => (Array.isArray(result?.content) ? result.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "");

/** One AI read of a note's mail: a `read_note` of its mail, or any read whose answer carried a mail block. */
export function countAiMailRead(name, args, store, result) {
  try {
    if (result?.isError) return;
    const raw = name === "read_note" ? args?.path : name === "fetch" ? args?.id : undefined;
    if (typeof raw !== "string") return;
    const path = normalizePath(raw);
    if (!path) return;
    const readsMail = args?.mail !== undefined || args?.args?.mail !== undefined || MAIL_FENCE.test(resultText(result));
    if (!readsMail) return;
    const actor = store?.actor ?? {};
    // A bound bot's login reads as the bot (`tools/notes/botBind.js`, `./boundBot.js`), never as the app it connects through.
    const fields = boundBotOf(store).then((bound) => {
      const named = bound?.name ?? actor.clientName;
      const clientName = typeof named === "string" && named !== "" ? named.slice(0, 120) : null;
      return { path, by: "ai", reader: `ai:${id(actor.userId)}:${id(actor.clientId)}`, name: handle(actor.name), clientName };
    });
    record(store, fields);
  } catch {
    // A read that cannot be kept is no reason to fail the read.
  }
}

/** One person's read of a note's mail in the app: `text` is the note they opened, `name` their `@handle`. */
export function countPersonMailRead(store, path, { userId, name, text = null }) {
  try {
    if (text !== null && !MAIL_FENCE.test(text)) return;
    const who = handle(name);
    if (who === null || typeof userId !== "string" || userId === "") return;
    record(store, { path, by: "person", reader: `person:${id(userId)}`, name: who });
  } catch {
    // An open that cannot be kept is no reason to fail it.
  }
}
