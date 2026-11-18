/**
 * READ THE RECORD BEFORE ANSWERING ABOUT IT (2026-11-17, tightened 2026-11-18).
 *
 * The front door's words already say a note, a page, their mail and their
 * calendar are the record, and memory loses. A notice on a narrow phrasing
 * of the ask, satisfied by any search, did not move the Dev score: the ask
 * is often a link, a follow-up about a page just sent, or "did he send it",
 * and a search of something else counted as the read.
 *
 * This one looks at the ask and the calls, not at how the reply is phrased.
 * A named link (a `context://` note, or an https page in the ask or the
 * short question after it) is read only when a call's arguments name that
 * link. A mail ask needs a mail read, a note or budget ask a note read, a
 * "what's on" ask a calendar read. Anything else the older pattern already
 * caught is still any read. A general question does not. The chat is not in
 * it: a check-in says "if nothing needs the chat", and that is not an ask
 * to read the record.
 *
 * Named links are also opened before the model speaks (`prefetchNamedRecords`),
 * so the first round already has the text. The notice is what remains when
 * that open did not happen.
 */

/**
 * Their ask is to read a record, not a mention of one in passing.
 * "the chat" is left out: a check-in says "if nothing needs the chat", and that is not an ask to read the record.
 * "note" and "page" count only with a determiner right against them ("the note", "my page").
 * "note the tulips" is a verb, and "the status page" is a web page, not the record.
 */
const ABOUT_RECORD =
  /\b(?:what(?:'s| is| does| did)|read|check|look (?:at|in|up))\b[^?\n]{0,80}\b(?:notes|pages|emails?|e-mails?|gmail|inbox|mail|calendar|(?:my|your|their|our|the|a|an|this|that)\s+(?:note|page))\b/i;

/** "Did he ever send a resume", "check my email": the answer is in mail, whether or not they said "read". */
const MAIL_ASK =
  /\b(?:did|has|have)\s+\S+(?:\s+\S+){0,4}\s+(?:send|sent|email(?:ed)?|attach(?:ed)?)\b|\b(?:my|our|the)\s+(?:inbox|emails?|e-mails?|gmail)\b/i;

/** "What we budgeted", "in the notes": the answer is a note they keep. */
const NOTE_ASK = /\b(?:in (?:my|our|the) notes|what we (?:wrote|budgeted|have written)|the budget|budget note)\b/i;

/** "What's on today", "what's on this weekend": the answer is the calendar. */
const CALENDAR_ASK = /\bwhat(?:'s| is) on (?:today|tomorrow|tonight|this weekend|the calendar|for )\b/i;

const CONTEXT_LINK = /context:\/\/[^\s)>\]]+/gi;
const WEB_LINK = /https?:\/\/[^\s)>\]]+/gi;
/** A message that is only a page address, scheme or not. A sentence is not one. */
const BARE_PAGE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i;

const MAIL_READ = /^(?:search_email|read_email)$/;
const NOTE_READ = /^(?:search|fetch|orient|search_notes|read_note|read_notes|read_file|related_notes)$/;
const CALENDAR_READ = /^(?:read_calendar|list_events)$/;
const ANY_READ =
  /^(?:search|fetch|orient|search_notes|read_note|read_notes|read_image|read_file|search_email|read_email|read_calendar|list_events|read_texts|list_texts|search_texts|read_day|read_thread|group_chats|read_back|open_page|browse|search_web|related_notes)$/;

export const RECORD_READ_NOTICE =
  "Before this goes: this asks about their notes, a page, their mail or their calendar, and you have not read any of it this turn. " +
  "Search or fetch the record first, then answer from what it says. Do not answer from memory.";

const stripTrail = (link) => link.replace(/[.,;:!?]+$/, "");

/** `context://@workspace/projects/x.md` is the note `projects/x.md`. */
export function contextNotePath(link) {
  const rest = String(link).replace(/^context:\/\//, "");
  const at = /^@[A-Za-z0-9-]+\/(.+)$/.exec(rest);
  return at ? at[1] : rest;
}

/** The `context://` notes and https pages named in `text`, in order, duplicates dropped. */
export function recordTargets(text) {
  const raw = String(text ?? "");
  const named = [];
  for (const match of raw.matchAll(CONTEXT_LINK)) named.push(stripTrail(match[0]));
  for (const match of raw.matchAll(WEB_LINK)) named.push(stripTrail(match[0]));
  return [...new Set(named)];
}

/** A message that is nothing but a page address, with a scheme added when it had none. */
function pageLine(text) {
  const line = String(text ?? "").trim();
  if (!BARE_PAGE.test(line)) return "";
  return /^https?:\/\//i.test(line) ? stripTrail(line) : `https://${stripTrail(line)}`;
}

/**
 * The text the gate and the prefetch read. A link in the ask counts. A short
 * question after a message that is itself a link counts too: that is the
 * page they just sent. A later question does not reopen every old link.
 */
export function recordAskText(question, earlier = "") {
  const asked = String(question ?? "");
  if (recordTargets(asked).length > 0) return asked;
  const last = String(earlier ?? "")
    .split(/\n\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1) ?? "";
  const page = pageLine(last) || (recordTargets(last)[0] ?? "");
  if (page !== "" && asked.length <= 160 && asked.includes("?")) return `${page}\n${asked}`;
  return asked;
}

/** Whether the ask is about a record Tex can open. */
export function asksForTheRecord(question) {
  const asked = String(question ?? "");
  return recordTargets(asked).length > 0 || ABOUT_RECORD.test(asked) || MAIL_ASK.test(asked) || NOTE_ASK.test(asked) || CALENDAR_ASK.test(asked);
}

const argsText = (step) => {
  try {
    return JSON.stringify(step?.args ?? step?.arguments ?? {});
  } catch {
    return "";
  }
};

/** Whether `step` opened this named link, not some other record. */
function openedTarget(step, target) {
  const blob = argsText(step);
  if (blob.includes(target)) return true;
  if (!target.startsWith("context://")) return false;
  const path = contextNotePath(target);
  return path.length > 3 && blob.includes(path);
}

/**
 * Whether the calls opened the record this ask is about.
 * A named link needs that link. A mail ask needs mail. A note ask needs a
 * note. A calendar ask needs the calendar. An ask the older pattern caught
 * and none of those name is any read, as before.
 */
export function readTheRecord(question, steps) {
  const list = Array.isArray(steps) ? steps : [];
  const asked = String(question ?? "");
  const targets = recordTargets(asked);
  if (targets.length > 0) return targets.every((target) => list.some((step) => openedTarget(step, target)));
  const needMail = MAIL_ASK.test(asked);
  const needNote = NOTE_ASK.test(asked);
  const needCalendar = CALENDAR_ASK.test(asked);
  if (!needMail && !needNote && !needCalendar) return list.some((step) => ANY_READ.test(String(step?.name ?? "")));
  if (needMail && !list.some((step) => MAIL_READ.test(String(step?.name ?? "")))) return false;
  if (needNote && !list.some((step) => NOTE_READ.test(String(step?.name ?? "")))) return false;
  if (needCalendar && !list.some((step) => CALENDAR_READ.test(String(step?.name ?? "")))) return false;
  return true;
}

/** The send-back, or null when the ask is not about a record or a matching read already happened. */
export function recordReadNotice(question, steps) {
  if (!asksForTheRecord(question) || readTheRecord(question, steps)) return null;
  return RECORD_READ_NOTICE;
}

const PREFETCH_CHARS = 2_000;

function resultText(result) {
  if (typeof result === "string") return result;
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Open the named links in `text` before the model speaks, at most two.
 * `dispatch(name, args)` is the turn's own tool caller. A failed open is
 * skipped: the notice still holds the model to the read. Returns the text
 * to put ahead of the ask, and the steps the record check counts as reads.
 */
export async function prefetchNamedRecords(dispatch, text) {
  if (typeof dispatch !== "function") return { preface: "", steps: [] };
  const steps = [];
  const chunks = [];
  for (const target of recordTargets(text).slice(0, 2)) {
    const call = target.startsWith("context://")
      ? { name: "read_note", args: { path: contextNotePath(target) } }
      : { name: "open_page", args: { url: target } };
    let result = null;
    try {
      result = await dispatch(call.name, call.args);
    } catch {
      result = null;
    }
    if (result?.isError === true) continue;
    const body = resultText(result).trim().slice(0, PREFETCH_CHARS);
    if (body === "") continue;
    steps.push({ name: call.name, args: call.args, ok: true });
    chunks.push(`Already read ${target}:\n${body}`);
  }
  return { preface: chunks.join("\n\n"), steps };
}
