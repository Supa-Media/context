/**
 * A SEND-BACK IS WRITTEN FROM THE TURN'S LEDGER (Dev2, 2026-11-05: "when
 * judges send something back ... it should know his entire history. I tried to
 * reply with this, but the judges said this. It should just read the ledger
 * ... and based off the ledger, try to tweak its response. It should know ...
 * the tool calls that it already did").
 *
 * Before this, a send-back put the rejected draft into the conversation as
 * something Tex had said, then the notice. On 2026-11-05 (14:47-15:02Z, Dev2's
 * own chat) the model read the draft as sent, and each rewrite dropped the
 * answer it had found; one send-back made it save a second, unasked email
 * draft. Now the draft never appears as said. The model is shown, in one note
 * built from the same entries the chat's ledger keeps (`turn.js` `tell`):
 * every action it already took this turn, every draft it wrote, each marked
 * NOT sent with the checks that held it and why, and is asked to revise its
 * latest draft rather than start over. A write it already made this turn,
 * the same call with the same arguments, is not run again on a rewrite
 * (`repeatedWrite`).
 */

import { BROWSE_TOOL } from "./browse.js";
import { RECHECK_FROM, RECHECK_REPLACES } from "./recheck.js";

/** The most of one draft the note quotes: a texted reply is far shorter, so this cuts nothing real. */
const DRAFT_CHARS = 4_000;

/** Said first when a text came in while it wrote: the draft never went, and one reply answers everything. */
export const LATE_FROM = "[Your draft quoted below has NOT been sent. They texted more while you wrote it, at the end of this message. Write one reply that answers all of it.]\n\n";

/** Said to a write the model repeats after a send-back, in band, like every other refusal in the turn. */
export const ALREADY_DONE =
  "Not run: you already did this earlier this turn (see the note above), and a rewrite after a check never repeats an action. " +
  "Write your reply from what that call already did.";

/**
 * Writes that are one thing to one audience whatever their wording: a second
 * email or draft to the same people from the same account, after a
 * send-back, is the same email reworded (the 14:47 turn saved one reworded).
 * Keyed by the tool, then the arguments that name who it reaches.
 */
const SAME_TARGET = {
  send_email: ["to", "from", "account", "thread", "threadId", "reply_to"],
  save_email_draft: ["to", "from", "account", "thread", "threadId", "reply_to"],
};

/**
 * The note the model reads after a send-back: every action the turn took
 * (from its ledger entries, `tool` events in order), every draft held back so
 * far with what held it, the notice, and the ask to revise the latest one.
 * `drafts` are `{ draft, judges?, by?, why? }`, oldest first.
 */
export function sendBackNote({ entries = [], drafts = [], notice, from = RECHECK_FROM }) {
  const done = [];
  let browsed = false;
  for (const entry of entries) {
    if (entry?.kind !== "tool") continue;
    const state = entry.held === true ? "held for their yes" : entry.ok === false ? `failed${entry.reason ? `: ${entry.reason}` : ""}` : "done";
    done.push(`- ${String(entry.name ?? "?")} ${clip(argsText(entry.args), 200)} (${state})`);
    if (entry.ok !== false && entry.name === BROWSE_TOOL) browsed = true;
  }
  const lines = [
    "This turn so far, from its ledger:",
    done.length === 0 ? "Actions you took: none." : "Actions you took (already done; their results are above, so don't do them again):",
    ...done,
    ...(browsed ? ["Browser steps above already happened on the real site: never click, submit, order or pay again for this rewrite."] : []),
    "",
    ...drafts.flatMap((entry, i) => [`Draft ${i + 1}, NOT sent (they have never seen it):`, quote(entry.draft), `Held back by: ${heldBy(entry)}`, ""]),
    ...(notice ? ["What the checks need from your latest draft:", notice, ""] : []),
    `Revise draft ${drafts.length}: keep its answer and everything in it they still need, and change only what ${notice ? "the checks name" : "their new text changes"}. Don't start over, and don't redo an action above.`,
  ];
  return from + lines.join("\n") + RECHECK_REPLACES;
}

/**
 * The refusal for a call on a rewrite round that repeats a write this turn
 * already made, or null: the same tool with the same arguments, or for an
 * email (`SAME_TARGET`) the same tool to the same people however it is
 * worded. Same tool, other arguments otherwise runs: one tool covers many
 * actions (`write_note` saves, comments, mails), and a check may ask for
 * exactly that (the page notice's "write it again as a page", the rest of
 * three calendar events). `isWrite(name)` says whether a tool changes
 * anything (its MCP annotations); `entries` are the turn's ledger entries.
 */
export function repeatedWrite({ name, args, entries, isWrite }) {
  if (!isWrite(name)) return null;
  const key = (value) => (SAME_TARGET[name] ? canonical(pick(value, SAME_TARGET[name])) : canonical(value));
  const same = key(args);
  const earlier = entries.some((entry) => entry?.kind === "tool" && entry.name === name && (entry.ok !== false || entry.held === true) && key(entry.args) === same);
  return earlier ? ALREADY_DONE : null;
}

function pick(args, keys) {
  const out = {};
  for (const name of keys) {
    const value = args?.[name];
    if (value === undefined || value === null || value === "") continue;
    out[name] = Array.isArray(value) ? value.map((item) => String(item).trim().toLowerCase()).sort() : typeof value === "string" ? value.trim().toLowerCase() : value;
  }
  return out;
}

/** Arguments as text with their keys in order, so the same call compares equal however it was written. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The turn's ledger as `turn.js` keeps it: `keep` every told event (the
 * `tool` and `judge` ones are kept); `sendBack(notice, draft)` for the note a
 * send-back pushes and `lateText(draft, words)` for the one a text that came
 * in mid-reply pushes, both remembering the draft, so a later note shows
 * every one even when no judge entry was told (a code check without the
 * reply gates); and `refusal(name, args)` for a call after either that
 * repeats a write (an offered tool marked `readOnlyHint: false`, as every MCP
 * write is, and not one `ranHere`: the browser and the turn's own local tools
 * may run again, and the note tells it what the browser already did; agent
 * tools with no annotations, like `job_status`, are not writes here).
 */
export function turnLedger({ tools = [], ranHere = () => false } = {}) {
  const entries = [];
  const drafts = [];
  const writes = new Set((tools ?? []).filter((tool) => tool?.annotations?.readOnlyHint === false).map((tool) => tool.name));
  const hold = (draft, why) => {
    const judged = entries.findLast((entry) => entry?.kind === "judge" && entry.went === false && entry.draft === String(draft ?? ""));
    drafts.push({ draft, judges: judged?.judges ?? [], by: judged?.by ?? "code", why });
  };
  return {
    entries,
    keep(event) {
      if (event?.kind === "tool" || event?.kind === "judge") entries.push(event);
    },
    sendBack(notice, draft) {
      hold(draft, null);
      return sendBackNote({ entries, drafts, notice });
    },
    lateText(draft, words) {
      hold(draft, "they texted more while you wrote it");
      return `${sendBackNote({ entries, drafts, notice: null, from: LATE_FROM })}\n\nTheir new text:\n\n${words}`;
    },
    refusal(name, args) {
      if (drafts.length === 0) return null;
      return repeatedWrite({ name, args, entries, isWrite: (tool) => writes.has(tool) && !ranHere(tool) });
    },
  };
}

function heldBy(entry) {
  if (entry.why) return entry.why;
  const judges = Array.isArray(entry.judges) ? entry.judges.filter((judge) => judge?.passed === false) : [];
  if (judges.length > 0) return judges.map((judge) => `${String(judge.id).replaceAll("_", " ")} (${judge.yes} against ${judge.at})`).join(", ");
  return entry.by === "code" ? "a code check" : "the checks named below";
}

function quote(text) {
  const body = clip(String(text ?? ""), DRAFT_CHARS);
  return body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function argsText(args) {
  try {
    return typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    return "";
  }
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
