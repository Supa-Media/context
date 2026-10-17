/**
 * GETTING THE PERSON'S ATTENTION (owner, 2026-10-17;
 * `docs/decisions/texting-assistant/attention.md`).
 *
 * "another tool or subagent we should build is a grab my attention sort of
 * agent, and this should be strict on only grabbing my attention in
 * emergencies or should learn my tolerance … if i ask for a message back once
 * a feature is in prod, an agent can pull that lever."
 *
 * Any of the person's own agents pulls it with `send` action `notify`
 * (`tools/attention.js`). This file is what both halves share:
 *
 *   1. `tex/attention.md` is the person's say: how much they want to hear
 *      (`tolerance`), words that never interrupt them (`mute`), and `paused`.
 *      Tex keeps it up to date from how they answer the pings it texts.
 *   2. The gateway, never the agent, decides from it whether a ping is worth
 *      a text. One that is not is held: logged, not sent.
 *   3. Every ping is logged in `tex/attention/YYYY-MM-DD.md` with who asked,
 *      how urgent they said it was, what it said, and what became of it, so
 *      the person can see every time an agent tried to reach them.
 *   4. The control plane decides how many a day and when (never at night but
 *      an emergency), and the check-in's path texts what is waiting
 *      (`deliverAttention`, run from `heartbeat.js` on the check-in grant).
 *      Several waiting go in one text; a ping is texted once.
 */

import { readWithEtag, clock, dayOf, longDate } from "./jobLog.js";
import { appendConversation, readConversation } from "./conversation.js";
import { ATTENTION_FOLDER, ATTENTION_SETTINGS_PATH } from "./checkIns.js";

export { ATTENTION_FOLDER, ATTENTION_SETTINGS_PATH };

export const URGENCIES = ["emergency", "asked", "fyi"];
/**
 * How much the person wants to hear, from least to most. `emergencies`: only
 * those. `strict` (the default): emergencies and what they asked to be told.
 * `relaxed`: anything an agent thinks they would want.
 */
export const TOLERANCES = ["emergencies", "strict", "relaxed"];
export const DEFAULT_TOLERANCE = "strict";

const LETS_THROUGH = {
  emergencies: new Set(["emergency"]),
  strict: new Set(["emergency", "asked"]),
  relaxed: new Set(["emergency", "asked", "fyi"]),
};

export const MAX_MESSAGE_CHARS = 300;
export const MAX_WHY_CHARS = 200;
/** One text of pings, however many wait. */
export const MAX_ATTENTION_TEXT_CHARS = 1_200;
const MAX_MUTED = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The words a delivered ping is kept under in the texting conversation, in place of a question. */
export const ATTENTION_QUESTION =
  "(Not a text from them. Another of their agents asked you to get their attention, and you texted them what follows. " +
  `If their reply says whether it was worth interrupting them for, change ${ATTENTION_SETTINGS_PATH} to match and tell them what you changed.)`;

function unquote(value) {
  return value.trim().replace(/^["']|["']$/g, "").trim();
}

/** `[a, b]` or `a, b` as a list of lowercased words. */
function listOf(value) {
  const inner = value.trim().replace(/^\[|\]$/g, "");
  return inner
    .split(",")
    .map((word) => unquote(word).toLowerCase())
    .filter((word) => word !== "" && word.length <= 60)
    .slice(0, MAX_MUTED);
}

/**
 * `tex/attention.md` read as settings. A note that is missing, unreadable or
 * says something unknown is the defaults: strict, nothing muted, not paused.
 */
export function readAttentionSettings(text) {
  const raw = typeof text === "string" ? text.replace(/^\ufeff/, "") : "";
  const lines = raw.split(/\r?\n/);
  const settings = { tolerance: DEFAULT_TOLERANCE, mute: [], paused: false };
  if (lines[0]?.trim() !== "---") return settings;
  const end = lines.findIndex((line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."));
  if (end < 0) return settings;
  for (const line of lines.slice(1, end)) {
    const match = /^\s*(tolerance|mute|paused)\s*:\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === "tolerance" && TOLERANCES.includes(unquote(value).toLowerCase())) settings.tolerance = unquote(value).toLowerCase();
    if (key === "mute") settings.mute = listOf(value);
    if (key === "paused") settings.paused = /^(true|yes|on)$/i.test(unquote(value));
  }
  return settings;
}

/** The muted word a ping contains, or null. Whole words only, so "ci" never mutes "decision". */
export function mutedWord(settings, ...texts) {
  const haystack = ` ${texts.filter(Boolean).join(" ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  for (const word of settings.mute) {
    const needle = ` ${word.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
    if (needle.trim() !== "" && haystack.includes(needle)) return word;
  }
  return null;
}

/**
 * Why a ping is held rather than texted, or null when it goes. Decided here
 * from the person's own settings, never by the agent asking.
 */
export function heldBecause(settings, { urgency, message, why, from }) {
  if (settings.paused) return "paused";
  if (!LETS_THROUGH[settings.tolerance].has(urgency)) return `held: ${settings.tolerance}`;
  if (urgency !== "emergency") {
    const word = mutedWord(settings, message, why, from);
    if (word !== null) return `muted: ${word}`;
  }
  return null;
}

/** One line, no Markdown that could fake a log line, within `max`. */
export function oneLine(text, max) {
  const flat = String(text ?? "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\*\*/g, "")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A short id for one ping: what the log marks texted. */
export function pingId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `p_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Today's log: `tex/attention/2026-10-17.md`, dated in their zone. */
export function attentionPath(now, timeZone) {
  return `${ATTENTION_FOLDER}/${dayOf(now, timeZone)}.md`;
}

export function attentionHeading(now, timeZone) {
  return (
    `# Agents asking for your attention, ${longDate(now, timeZone)}\n\n` +
    "Every time one of your agents asked Tex to text you, and what became of it. " +
    `Change how much you hear in \`${ATTENTION_SETTINGS_PATH}\` (\`tolerance: emergencies\`, \`strict\` or \`relaxed\`, ` +
    "`mute:` words, `paused: true`), or just tell Tex.\n"
  );
}

/** What became of a ping, as the log says it. `waiting` is the one delivery looks for. */
export const WAITING = "waiting";

/** One ping's part of the day's log. */
export function attentionEntry({ id, now, timeZone, from, urgency, message, why, status }) {
  const lines = [
    `## ${clock(now, timeZone)} · ${oneLine(from, 60)}`,
    "",
    `**Ping:** ${id} · ${urgency} · ${status}`,
    `**Message:** ${message}`,
  ];
  if (why) lines.push(`**Why:** ${why}`);
  return `${lines.join("\n")}\n`;
}

const PING_LINE = /^\*\*Ping:\*\* (p_[0-9a-f]{12}) · (emergency|asked|fyi) · (.+)$/;

/**
 * The pings still waiting in one log body, in order: id, who asked, how
 * urgent, what it said. Read only from lines this file wrote; a message is
 * one line by construction.
 */
export function waitingPings(body) {
  const lines = String(body ?? "").split("\n");
  const found = [];
  let from = null;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^## [^·]+ · (.+)$/.exec(lines[i]);
    if (heading) from = heading[1].trim();
    const ping = PING_LINE.exec(lines[i]);
    if (!ping || ping[3].trim() !== WAITING) continue;
    const message = /^\*\*Message:\*\* (.+)$/.exec(lines[i + 1] ?? "");
    if (!message) continue;
    found.push({ id: ping[1], urgency: ping[2], from: from ?? "one of your agents", message: message[1].trim(), line: i });
  }
  return found;
}

/** Mark `ids` in a log body with what became of them. */
export function markPings(body, ids, status) {
  const wanted = new Set(ids);
  return String(body ?? "")
    .split("\n")
    .map((line) => {
      const ping = PING_LINE.exec(line);
      if (!ping || !wanted.has(ping[1]) || ping[3].trim() !== WAITING) return line;
      return `**Ping:** ${ping[1]} · ${ping[2]} · ${status}`;
    })
    .join("\n");
}

/** The one text the waiting pings make: the person reads who asked, and what. */
export function attentionText(pings) {
  const ordered = [...pings].sort((a, b) => (a.urgency === "emergency" ? 0 : 1) - (b.urgency === "emergency" ? 0 : 1));
  const said = (ping) => `${ping.urgency === "emergency" ? "Urgent, " : ""}${ping.from}: ${ping.message}`;
  const text =
    ordered.length === 1 ? said(ordered[0]) : `From your agents:\n${ordered.map((ping) => `- ${said(ping)}`).join("\n")}`;
  return text.length > MAX_ATTENTION_TEXT_CHARS ? `${text.slice(0, MAX_ATTENTION_TEXT_CHARS - 1)}…` : text;
}

/**
 * The check-in's delivery of waiting pings: no model. Reads today's and
 * yesterday's logs (a ping held overnight is dated the day before), marks
 * what it texts, and only then answers the text, so a retry or a second claim
 * never sends a ping twice. Pings waiting when the person has since paused
 * them are marked held instead. A log that changed under it is re-read once.
 */
export async function deliverAttention(dispatch, store, { now, timeZone }) {
  const settings = readAttentionSettings((await readWithEtag(dispatch, ATTENTION_SETTINGS_PATH))?.body ?? "");
  const days = [...new Set([attentionPath(now - DAY_MS, timeZone), attentionPath(now, timeZone)])];
  const sending = [];
  for (const path of days) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const log = await readWithEtag(dispatch, path);
      if (log === null || log.missing) break;
      const waiting = waitingPings(log.body);
      if (waiting.length === 0) break;
      const ids = waiting.map((ping) => ping.id);
      const status = settings.paused ? "paused" : `texted ${clock(now, timeZone)}`;
      const written = await dispatch("write_note", {
        path,
        content: markPings(log.body, ids, status),
        expected_etag: log.etag,
      }).catch(() => null);
      if (written && written.isError !== true) {
        if (!settings.paused) sending.push(...waiting);
        break;
      }
    }
  }
  if (sending.length === 0) return null;
  const text = attentionText(sending);
  try {
    // Their reply is answered with the ping in front of the turn, which is how Tex learns their tolerance.
    // An agent chose these words, so the turn that follows treats them as untrusted.
    await appendConversation(store, "texts", await readConversation(store, "texts"), ATTENTION_QUESTION, text, { tainted: true });
  } catch {
    // A history that could not be written costs the reply some context, never the ping.
  }
  return { text, count: sending.length };
}
