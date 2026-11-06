/**
 * A note's mail, answered by the workspace object that holds the note (`docs/decisions/note-mail.md`, "The object
 * answers mail checks", decided by Dev2 2026-11-06: nothing about a note is polled from afar).
 *
 * The mail stays in the note's Markdown, so export and the backup copy carry it as before. What moves here is
 * reading it: before, every tool call that passed a mailbox read the whole note into the gateway to count new lines
 * (`mail/footer.js`), and an ask waiting for its answer read the whole note again every 1.5 seconds for up to two
 * minutes (`tools/notes/mail.js`). Now:
 *
 * - `ws.mail.since {path, name, readThrough}` → `{served, found, path?, fresh?}`: what is new for one mailbox name,
 *   as entries without their text (who, to whom, when, which kind). The footer needs no more.
 * - `ws.mail.wait {path, from, to, since, timeoutMs}` → `{served, found, answers?}`: held here until a line from `to`
 *   back to `from` (or to everyone) lands on the note, or the time is up. The object looks at its own copy's version
 *   (a local SQLite read) and parses the note only when that moves, so a waiting ask costs the gateway one call.
 *
 * Both are judged as a read is (`judgeFor`): a reader who may not see the note gets `found: false`, the same as a
 * note that is not there. Served only in a workspace whose notes live here; elsewhere `{served: false}` and the
 * gateway reads the note as before.
 */

import mail from "../../../../packages/shared/src/mail.cjs";
import { HOMES, isWorkspaceObjectKey } from "./api.js";
import { liveRowByPath } from "./rowsByPath.js";

const { EVERYONE, newFor, parseMail } = mail;

export const MAIL_OPS = Object.freeze({ SINCE: "ws.mail.since", WAIT: "ws.mail.wait" });
const OPS = new Set(Object.values(MAIL_OPS));

/** The longest one wait is held, as `MAX_ASK_WAIT_S` in `tools/notes/mail.js`. */
export const MAX_WAIT_MS = 120_000;
/** How often a held wait looks at its note's version: a local read, never a call. */
export const WAIT_LOOK_MS = 250;

export class MailAskRefused extends Error {}

export const isMailOp = (op) => OPS.has(op);

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const text = (value, max) => typeof value === "string" && value !== "" && value.length <= max;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The note at `path` this reader may see, as `{row, key}`, or `null` (missing and refused alike). */
function visibleNote(store, judge, path) {
  const row = liveRowByPath(store.sql, path);
  if (row === null || row.kind !== "file" || typeof row.storageKey !== "string" || !isWorkspaceObjectKey(row.storageKey)) return null;
  return judge.sees(row) ? { row, key: row.storageKey } : null;
}

/** The note's text and version as this object holds them, or `null`. */
function heldText(store, key) {
  const found = store.objects.get(key, {});
  if (found === null || found.body === undefined) return null;
  return { etag: found.etag, text: new TextDecoder().decode(found.body) };
}

/** Only the parts of an entry a footer or a wait needs to describe it; a wait's answers keep their words. */
const entryOf = (event, withText = false) => ({
  at: event.at,
  from: event.from,
  to: event.to,
  ...(event.app ? { app: event.app } : {}),
  ...(event.mailKind ? { mailKind: event.mailKind } : {}),
  ...(withText && typeof event.text === "string" ? { text: event.text } : {}),
});

/** Lines from `to` back to `from` (or to everyone) written after `since`: an ask's answer. */
function answersIn(textNow, { from, to, since }) {
  const after = Date.parse(since);
  return parseMail(textNow).events.filter(
    (event) =>
      event.kind === "mail" &&
      Date.parse(event.at) > after &&
      event.from !== from &&
      (to === EVERYONE || event.from === to) &&
      (event.to === from || event.to === EVERYONE),
  );
}

/**
 * Answer one mail op, or throw `MailAskRefused` for a malformed ask. `judge` is `judgeFor(rows, fields, members)`,
 * made by the caller so the rules held here decide exactly as a read's.
 * @param {{sql: object, objects: {get: Function}, rows: {home: () => string}}} store
 */
export async function serveMail(store, op, fields, judge, { now = Date.now, wait = sleep } = {}) {
  if (store.rows.home() !== HOMES.OBJECT || !store.sql) return { served: false };
  if (!text(fields.path, 1024)) throw new MailAskRefused("a mail ask names its note's path");
  const note = visibleNote(store, judge, fields.path);
  if (op === MAIL_OPS.SINCE) {
    if (typeof fields.name !== "string" || !NAME.test(fields.name)) throw new MailAskRefused("a mail ask names its mailbox's name");
    if (note === null) return { served: true, found: false };
    const held = heldText(store, note.key);
    if (held === null) return { served: true, found: false };
    const fresh = newFor(parseMail(held.text).events, fields.name, fields.readThrough ?? null);
    return { served: true, found: true, path: note.row.path, fresh: fresh.map((event) => entryOf(event)) };
  }
  // MAIL_OPS.WAIT
  if (typeof fields.from !== "string" || !NAME.test(fields.from)) throw new MailAskRefused("a wait names who is waiting");
  if (typeof fields.to !== "string" || (fields.to !== EVERYONE && !NAME.test(fields.to))) throw new MailAskRefused("a wait names who it waits on");
  if (!Number.isFinite(Date.parse(fields.since))) throw new MailAskRefused("a wait names when the ask was sent");
  const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(fields.timeoutMs) || 0));
  if (note === null) return { served: true, found: false };
  const until = now() + timeoutMs;
  let seen = null;
  for (;;) {
    // Looked up again each time, so a note moved, trashed or narrowed while the ask waits stops being answered.
    const current = visibleNote(store, judge, fields.path);
    if (current === null) return { served: true, found: false };
    const version = store.objects.head?.(current.key)?.etag ?? null;
    if (version === null || version !== seen) {
      seen = version;
      const held = heldText(store, current.key);
      if (held !== null) {
        const answers = answersIn(held.text, fields);
        if (answers.length) return { served: true, found: true, answers: answers.map((event) => entryOf(event, true)) };
      }
    }
    const left = until - now();
    if (left <= 0) return { served: true, found: true, answers: [] };
    await wait(Math.min(WAIT_LOOK_MS, left));
  }
}
