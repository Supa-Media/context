/**
 * `notify_me` (`send` action `notify`): one of the person's own agents asks
 * Tex to text them, because something needs them now or because they asked
 * to be told (`agent/attention.js`; docs/decisions/texting-assistant/attention.md).
 *
 * Nothing is texted here. In order:
 *
 *   1. the person's settings (`tex/attention.md`) decide whether this ping is
 *      worth a text at all: a ping they would not want is held, not sent;
 *   2. the control plane (`/gateway/attention/ask`, through
 *      `store.requestAttention`) clears the owner of their own personal
 *      workspace off this connection's token, and for a ping that goes,
 *      counts it against the day and says when it may go, never sooner than
 *      half a minute away;
 *   3. the ping is logged in `tex/attention/YYYY-MM-DD.md` as waiting (or
 *      held, or over the limit), well inside that half minute, and the
 *      person's check-in row then delivers what is waiting.
 *
 * It only ever reaches the person this connection belongs to, on their own
 * linked phones; it names nobody. The agent is told what became of the ping
 * in words it can pass on.
 */

import { toolError, toolText } from "./results.js";
import { toolReadNote } from "./notes/read.js";
import { toolWriteNote } from "./notes/write.js";
import { readWithEtag, appendLogEntry, clock } from "../agent/jobLog.js";
import {
  ATTENTION_SETTINGS_PATH,
  MAX_MESSAGE_CHARS,
  MAX_WHY_CHARS,
  URGENCIES,
  WAITING,
  attentionEntry,
  attentionHeading,
  attentionPath,
  heldBecause,
  oneLine,
  pingId,
  readAttentionSettings,
} from "../agent/attention.js";

const NOT_YOURS =
  "Not sent: only the person themselves can be notified, from a connection to their own personal workspace with full access " +
  "(not a shared workspace; leave `context` out).";

function when(epochMs, timeZone) {
  try {
    return clock(epochMs, timeZone);
  } catch {
    return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}

/** Read and write the session's own notes through the tools' own gates, as `jobLog.js` expects. */
function notesOf(store, scope, rules, overrides) {
  return async (name, args) => {
    if (name === "read_note") return await toolReadNote(store, scope, rules, overrides, args.path);
    if (name === "write_note") return await toolWriteNote(store, scope, rules, overrides, args);
    throw new Error(`unexpected ${name}`);
  };
}

export async function toolNotifyMe(store, scope, rules, overrides, args) {
  // The owner's: anything below the private tier is refused before the
  // control plane is asked, which refuses it again.
  if (scope !== "private") return toolError(NOT_YOURS);
  if (typeof store?.requestAttention !== "function") return toolError("Not sent: notifications are not available on this deployment.");
  const message = oneLine(args?.message, MAX_MESSAGE_CHARS + 1);
  if (message === "" || message.length > MAX_MESSAGE_CHARS) {
    return toolError(`invalid: message must be 1 to ${MAX_MESSAGE_CHARS} characters, the text they will read`);
  }
  if (!URGENCIES.includes(args?.urgency)) return toolError('invalid: urgency must be "emergency", "asked" or "fyi"');
  const why = args?.why === undefined ? "" : oneLine(args.why, MAX_WHY_CHARS);
  const urgency = args.urgency;
  const from = oneLine(store.actor?.client ?? "", 60) || "One of your agents";

  const notes = notesOf(store, scope, rules, overrides);
  const settingsNote = await readWithEtag(notes, ATTENTION_SETTINGS_PATH);
  const held = heldBecause(readAttentionSettings(settingsNote?.body ?? ""), { urgency, message, why, from });

  // Who may notify, and their time zone, before anything is written: a caller
  // who may not ask writes nothing anywhere.
  let asked;
  try {
    asked = await store.requestAttention(urgency, held === null);
  } catch {
    return toolError("Not sent: the request could not be sent just now. Try again later.");
  }
  if (asked === null || asked === undefined) return toolError(NOT_YOURS);
  if (asked.status === "not_texting") {
    return toolError("Not sent: Tex texts only someone who has linked a phone, and this person has none, or texting is paused.");
  }

  const now = Date.now();
  const id = pingId();
  const path = attentionPath(now, asked.timeZone);
  const status = held ?? (asked.status === "limit" ? "not sent: daily limit" : WAITING);
  const logged = await appendLogEntry(
    notes,
    path,
    attentionEntry({ id, now, timeZone: asked.timeZone, from, urgency, message, why, status }),
    attentionHeading(now, asked.timeZone),
  );

  if (held !== null) {
    const reason = held === "paused"
      ? "they have paused pings"
      : held.startsWith("muted")
        ? `they muted "${held.slice("muted: ".length)}"`
        : `their tolerance is ${held.slice("held: ".length)}, which does not let ${urgency} pings through`;
    return toolText(
      `Held, not texted: ${reason} (${ATTENTION_SETTINGS_PATH}). It is logged in ${path}` +
        (logged ? "" : " (the log could not be written)") +
        ". Don't send it again another way; if it matters more than that, say so in the conversation you are in.",
    );
  }
  if (asked.status === "limit") {
    return toolError(
      `Not sent: today's ${urgency === "emergency" ? "emergencies are" : "pings are"} used up. It is logged in ${path}; ` +
        "tell them in the conversation you are in instead.",
    );
  }
  if (!logged) {
    // Armed with nothing to deliver: the delivery finds nothing waiting and texts nothing.
    return toolError("Not sent: the ping could not be logged in their workspace just now. Try again later.");
  }
  if (asked.status === "later") {
    return toolText(
      `Accepted: Tex will text it to them at ${when(asked.dueAt, asked.timeZone)} their time (night, or spaced after their last ping). ` +
        `Logged in ${path}. Send it once; anything else waiting then goes in the same text.`,
    );
  }
  return toolText(`Accepted: Tex will text it to them within a minute or two. Logged in ${path}. Send it once.`);
}
