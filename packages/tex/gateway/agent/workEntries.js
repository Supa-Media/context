/**
 * THE ADVISOR'S ASKS, THE MAIL CHECKER'S VERDICTS AND JOBS, IN THE CHAT'S
 * LEDGER (Dev2, 2026-11-02: one record per chat, every view rebuilt from it;
 * `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 * The ledger (`ledger.js`) keeps what a turn said and did; these are the
 * entries for three things a turn's own steps don't show: how the advisor
 * judged each part of a job, what the Mail checker made of an email and how
 * the person settled it, and the jobs a turn started. (An ask the model makes
 * is its `ask_advisor` tool entry already, never written twice.) The "What Tex is working on" page reads them from the ledger
 * like everything else (its Behind the scenes section); nothing here keeps a
 * second copy.
 *
 * Never in the way of a reply: the writer never throws, and its writes are
 * waited for after the answer has gone (`texEntryPoint.js`).
 */

import { storeLedger } from "./ledger.js";

const MAX_LINE = 200;
/** The advisor's thinking kept on its entry, at most (`ledger.js` `MAX_WORDS_CHARS`). */
const MAX_THINKING = 32_000;
const newId = () => crypto.randomUUID().replace(/-/g, "");
const squash = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const cut = (value, max) => {
  const text = squash(value);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const turnOf = (turn) => (typeof turn === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(turn) ? { turn } : {});

/** The session's ledger writer, made once per request and shared by every part of the turn; null when the chat keeps none. */
export function chatLedger(store, session) {
  if (session.ledger === undefined) session.ledger = storeLedger(store, session);
  return session.ledger;
}

/** An `advisor` entry: what the everyday model asked with, the answer, how much of the turn it read, how long. */
export function advisorEntry({ question, answer, thinking = "", steps = 0, ms = 0 }, { turn = null, job = null, check = false, at = Date.now() } = {}) {
  return { v: 1, id: newId(), at, kind: "advisor", ...turnOf(turn), ...(job ? { jobTitle: job } : {}), ...(check ? { check: true } : {}), question: String(question ?? ""), answer: String(answer ?? ""), ...(typeof thinking === "string" && thinking.trim() ? { thinking: thinking.slice(0, MAX_THINKING) } : {}), steps, ms: Math.max(0, Math.round(ms)) };
}

/** The id a held email's check is kept under, so its settling names it (`settledMail`). */
export const heldCheckId = (askId) => `mc${String(askId).replace(/[^A-Za-z0-9]/g, "").slice(0, 60)}`;

/** A `mail_check` entry. `verdict`: sent, waiting or stopped; `ref`: the check a settling answers. */
export function mailEntry(email, { verdict, why = "", answer = "", from = "your texts", id = newId(), ref = null, ask = null, turn = null, at = Date.now() }) {
  return {
    v: 1,
    id,
    at,
    kind: "mail_check",
    ...turnOf(turn),
    to: cut([...(email?.to ?? []), ...(email?.cc ?? [])].join(", "), MAX_LINE),
    subject: cut(email?.subject, MAX_LINE),
    verdict,
    why: cut(why, MAX_LINE),
    ...(typeof answer === "string" && answer.trim() ? { answer: answer.trim().slice(0, 2_000) } : {}),
    from,
    ...(ask ? { ask } : {}),
    ...(ref ? { ref } : {}),
  };
}

/** What the Mail checker's verdict reads as: stopped on its "no", waiting while held for their yes, sent on their yes to an offer. */
export function mailVerdict(checked, options = {}) {
  const said = typeof checked?.answer === "string" && checked.answer ? { answer: checked.answer } : {};
  return { ...verdictOf(checked, options), ...said };
}

function verdictOf(checked, { held = false, sent = false }) {
  if (sent) return { verdict: "sent", why: "They agreed to it in the chat" };
  if (checked?.verdict === "no") return { verdict: "stopped", why: checked.reason || "It went against what they said" };
  if (held) return { verdict: "waiting", why: checked?.reason || "Waiting for their yes" };
  return { verdict: "stopped", why: checked?.reason ?? "" };
}

/** A `job` entry: the job's id (the one the texting Worker runs it under), its title, and its state. */
export function jobEntry({ id, title }, state, { turn = null, advice = null, at = Date.now() } = {}) {
  return { v: 1, id: newId(), at, kind: "job", ...turnOf(turn), job: String(id), ...(title ? { title: cut(title, 120) } : {}), state, ...(advice ? { advice: cut(advice, 600) } : {}) };
}

/**
 * A `job` entry for a job's report as the chat's own turn was handed it: its title, state and the job's own words
 * (`report`), written before the model sees it. On 2026-11-05 Tex texted that it "can't read" a computer job's report
 * and nobody could tell what the turn had been given (Dev2 chose to log it).
 */
export function reportEntry(report, { turn = null, at = Date.now() } = {}) {
  const words = (report?.texts ?? []).join("\n\n").slice(0, 4_000);
  return { ...jobEntry({ id: report?.id ?? "report", title: report?.title }, report?.state, { turn, at }), report: words };
}

/** An email the Mail checker read, written to the ledger; a session with no ledger keeps nothing. */
export function recordMail(session, email, { verdict, why, answer = "", ask = null }) {
  const ledger = session?.ledger;
  if (!ledger) return;
  const work = session.ledgerWork ?? {};
  try {
    ledger.write(mailEntry(email, { verdict, why, answer, from: work.from, turn: work.turn, ...(ask ? { id: heldCheckId(ask), ask } : {}) }));
  } catch {
    // The ledger's line costs the ledger, never the email.
  }
}

/**
 * A held email, settled (`tools/approvals.js` `settlePending`): a new
 * `mail_check` entry, sent or stopped, whose `ref` is the check written when
 * it was held. The ledger is appended to, never rewritten.
 */
export async function settledMail(store, record, action, result) {
  const ledger = store?.ledger;
  if (!ledger || record?.tool !== "send_email") return;
  const args = record.args && typeof record.args === "object" ? record.args : {};
  const verdict =
    action === "approve" && result?.isError !== true ? { verdict: "sent", why: "They said yes" } : action === "approve" ? { verdict: "stopped", why: "It could not be sent" } : { verdict: "stopped", why: "They said no" };
  const email = { to: listOf(args.to), cc: listOf(args.cc), subject: args.subject };
  ledger.write(mailEntry(email, { ...verdict, from: record.actor?.clientId === "context_texts_group" ? "the group" : "your texts", ref: heldCheckId(record.id), ask: record.id }));
  await ledger.flush();
}

/** The jobs a turn started, as `job` entries under the ids the Worker runs them by (`background.js` `startedJobs`). */
export function startedJobEntries(started, { turn = null } = {}) {
  return (Array.isArray(started) ? started : []).filter((job) => typeof job?.id === "string").map((job) => jobEntry(job, "started", { turn }));
}

const VERDICT_WORDS = { done: "Done.", keep_going: "Not yet: keep going.", waiting: "Waiting on them.", stuck: "Stuck." };

/**
 * A job's part checked by the advisor against its finish line (`jobCheck.js`):
 * an `advisor` entry (marked `check`) with the verdict and advice, and a `job`
 * entry with the state it left the job in.
 */
export async function jobChecked(session, { job, steps = 0, turn = null }, run) {
  const asked = Date.now();
  // The advisor's thinking goes to the chat's history only, never to the Worker with the answer.
  const { thinking = "", ...fields } = (await run()) ?? {};
  const ledger = session?.ledger;
  if (ledger && job && typeof fields?.verdict === "string") {
    ledger.write([
      advisorEntry({ question: `Is the job "${cut(job.title, 120)}" done?`, answer: [VERDICT_WORDS[fields.verdict] ?? fields.verdict, fields.advice].filter(Boolean).join(" "), thinking, steps, ms: Date.now() - asked }, { turn, job: job.title, check: true }),
      jobEntry(job, fields.verdict, { turn, advice: fields.advice }),
    ]);
    await ledger.flush(); // a job's part answers its own Worker, not a person: written before it does
  }
  return fields;
}

const listOf = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : []);
