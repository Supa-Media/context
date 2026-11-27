/**
 * Tex in mail (Dev, 2026-11-27: "Tex in mail should be the same flow as tex in comments I feel, its own mini tex"; its
 * access "should be the same" as a bot's private connection; `docs/decisions/note-mail.md`). A line sent to a person's
 * own Tex on a note's mail wakes their Tex store (`apps/mcp/src/mail/deliver.js`), whose alarm has the texting Worker
 * claim the run with a texting session of theirs (`apps/convex/functions/texMail.ts`) and post it here.
 *
 *  - `POST /tex/mail-run` `{ workspaceId, path, mailboxId }` → `{ outcome, sent }`. The run reads what is new for its
 *    mailbox on the note, answers it the way Tex answers in a note's comments (`noteRun.js` `runNoteRun`: the note, the
 *    mail as the thread, the person's own Tex chat, their notes, reading only), and sends the answer to whoever wrote
 *    last, from the mailbox's own "tex". Nothing new is `nothing`; the person is not texted.
 *
 * Who may: only the texting client, as the owner of a personal workspace (the session the Worker claimed), for a
 * workspace the person is a live member of, and a mailbox this grant joined as "tex" on that same note. Nothing logged
 * but the event, the outcome and the time: never the mail, the answer or a path.
 */

import mail from "../../../shared/src/mail.cjs";
import { ledgerFor } from "./ledger.js";
import { ownDispatch } from "./reflect.js";
import { grantedToolsFor } from "./sixTools.js";
import { DEFAULT_TIME_ZONE } from "./localNow.js";
import { texConfigOf, texStep } from "./texConfig.js";
import { createControlPlane } from "../../../../apps/mcp/src/controlPlane.js";
import { readNoteAs, targetOf } from "./noteRunRoute.js";

export const MAIL_RUN_PATH = "/tex/mail-run";
/** The texting client (`apps/convex/functions/textLinks.ts` `TEXTS_CLIENT_ID`). */
const TEXTS_CLIENT_ID = "context_texts";
/** Tex's name in mail (`unjoinedName` in `apps/mcp/src/tools/notes/mail.js`). */
const TEX = "tex";
const MAX_BODY_BYTES = 4_000;
const MAX_ID = 128;
const MAX_PATH = 512;
/** The mail lines shown as the thread before the new ones, and the most new ones read as the ask. */
const THREAD_LINES = 20;
const NEW_LINES = 10;
const MAX_LINE = 4_000;
const MAX_ASK = 4_000;
const MAILBOX = /^mb_[a-z0-9]{8,32}$/;

const json = (body, status = 200) => Response.json(body, { status });
const text = (value, max, min = 1) => typeof value === "string" && value.length >= min && value.length <= max;
const who = (event) => (event.app ? `${event.from} (${event.app})` : event.from);

/** The texting client, as the owner of a personal workspace. */
function texting(session) {
  return session?.actorClientId === TEXTS_CLIENT_ID && session.workspaceKind === "personal" && session.role === "owner";
}

/** The node the run answers with, or null while it is not wired (the config has no `mailRun`, or it is off). */
function nodeOf(env, deps) {
  if (typeof deps.mailRunNode === "function") return deps.mailRunNode(env);
  try {
    const step = texStep("mailRun", texConfigOf(env));
    return step?.on === true ? step : null;
  } catch {
    return null;
  }
}

/**
 * What the run is told, from the note's mail: the lines new for "tex" since its mailbox last read (from anyone but
 * Tex), as the ask, and the lines before them as the thread. `null` when nothing new waits.
 */
export function mailTurn(noteText, readThrough) {
  const { events } = mail.parseMail(typeof noteText === "string" ? noteText : "");
  const lines = events.filter((event) => event.kind === "mail");
  const fresh = mail.newFor(lines, TEX, readThrough).slice(-NEW_LINES);
  if (fresh.length === 0) return null;
  const first = lines.indexOf(fresh[0]);
  const history = lines
    .slice(0, first)
    .slice(-THREAD_LINES)
    .map((event) => ({ who: who(event).slice(0, 200), body: String(event.text).slice(0, MAX_LINE) }));
  const ask = fresh.map((event) => `${who(event)}: ${event.text}`).join("\n").slice(0, MAX_ASK);
  const last = fresh[fresh.length - 1];
  return { ask, history, to: last.from, newest: last.at };
}

/** `POST /tex/mail-run` (`APP_ROUTES`): one Tex-in-mail run. */
export async function handleMailRun(request, store, session, _path, env, _ctx = null, deps = {}) {
  try {
    return await serveRun(request, store, session, env, deps);
  } catch (error) {
    console.log(JSON.stringify({ event: "mail_run", outcome: "unreachable", error: String(error?.name ?? "error").slice(0, 40) }));
    return json({ outcome: "unreachable" }, 503);
  }
}

async function serveRun(request, store, session, env, deps) {
  if (!texting(session)) return json({ error: "forbidden" }, 403);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const { workspaceId, path, mailboxId } = body ?? {};
  if (!text(workspaceId, MAX_ID) || !text(path, MAX_PATH) || !text(mailboxId, 40) || !MAILBOX.test(mailboxId)) return json({ error: "bad_request" }, 400);
  const target = targetOf(session, workspaceId);
  if (target === null) return json({ error: "forbidden" }, 403);
  // The mailbox is this grant's own "tex", on this same note: the control plane answers only the grant that joined it.
  const box = typeof store?.mail?.get === "function" ? await store.mail.get(mailboxId).catch(() => null) : null;
  if (!box || box.name !== TEX || box.workspaceId !== target.workspaceId || box.path !== path) return json({ error: "forbidden" }, 403);
  const node = nodeOf(env, deps);
  if (node === null) return json({ outcome: "not_wired" }, 503);

  const dispatch = (deps.dispatchFor ?? ((s, x) => ownDispatch(s, x, env)))(store, session);
  const readStarted = Date.now();
  const note = await readNoteAs(dispatch, path, target.context);
  if (note === null) return json({ error: "not_readable" }, 404);
  const turn = mailTurn(note.note, box.readThrough);
  const started = (deps.now ?? Date.now)();
  if (turn === null) {
    console.log(JSON.stringify({ event: "mail_run", outcome: "nothing" }));
    return json({ outcome: "nothing", sent: false });
  }
  // Read through the newest line this run answers, so the next line, and only it, wakes the next run.
  await store.mail.read(mailboxId, turn.newest).catch(() => {});

  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  const runNoteRun = deps.runNoteRun ?? (await import("./noteRun.js")).runNoteRun;
  let result;
  try {
    result = await runNoteRun({
      env,
      controlPlane,
      session,
      dispatch,
      offered: await (deps.offeredFor ?? ((s, x) => grantedToolsFor(s, x, { texts: true })))(session, store),
      ledger: (deps.ledgerOf ?? ((owner) => ledgerFor(env, owner)))({ person: session.workspaceId }) ?? null,
      workspace: target.context ?? null,
      path,
      noteText: note.note,
      anchor: { text: "", before: "", after: "" },
      ask: turn.ask,
      history: turn.history,
      pending: null,
      audience: note.audience,
      node,
      cell: null,
      now: started,
      timeZone: DEFAULT_TIME_ZONE,
      noteReadMs: Date.now() - readStarted,
    });
  } catch (error) {
    result = { outcome: "failed", error: String(error?.name ?? "Error") };
  }
  const outcome = result?.outcome ?? "failed";
  const answer = outcome === "answered" && typeof result.answer === "string" ? result.answer.trim() : "";
  let sent = false;
  if (answer !== "") {
    // From the mailbox's own grant, unjoined, so the line is signed "tex"; `used` is what a line in a mail folder must say.
    const written = await dispatch("write_note", { path, mail: { text: answer, to: turn.to, used: 0 }, ...(target.context ? { context: target.context } : {}) }).catch(() => null);
    sent = written !== null && written?.isError !== true;
  }
  console.log(JSON.stringify({ event: "mail_run", outcome, sent, ms: (deps.now ?? Date.now)() - started }));
  return json({ outcome, sent });
}
