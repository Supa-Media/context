/**
 * WHAT A GROUP CAN'T OPEN DOESN'T GO TO THE GROUP UNASKED (Dev2, 2026-11-26).
 *
 * A group turn reads the asker's own shared workspaces (`docs/decisions/texting-assistant/asker-reach.md`), so a turn
 * can read a workspace that somebody else in the room is not in. On 2026-11-26 a group was made with Tex in it, its
 * asker said "summarize the action items for them" with nothing pointed at, and a background job picked a meeting in
 * one of the asker's workspaces that two of the people there couldn't open. Its takeaways went to the group. Dev2 chose
 * a check right before send: an answer carrying what was read from a workspace someone in the room can't open is held.
 *
 * This module holds the facts that check reads, in code, never a model's judgment:
 *
 *  - which workspaces the room can't all open (`roomSlugs`): the asker's workspaces the whole chat does not share
 *    (`group.unshared`, from the control plane) and every workspace somebody is named as kept out of (`group.blocked`);
 *  - what this turn read from them (`roomReads`): each call that named one by `context` or by an `@slug/` path, and
 *    what it gave back. A job reports the ones it read (`roomRead`), and its report's words count as read from them;
 *  - whether the asker pointed at it (`pointedAt`): a workspace their own text names (`@slug`, or a link into it) is
 *    theirs to share, and is never held;
 *  - whether the draft carries it (`roomVerdict`): names and figures the draft shares with what was read there, that
 *    nobody in the chat or the ask already said.
 *
 * What is held goes to the asker alone, in their own chat with Tex (`privateAside.js`, a held aside); what the group is
 * told, and how, is the model's own, from the facts it is handed (`heldFacts`) and Training. Never a line written here.
 */

/**
 * Most text kept per turn of what was read from the room's closed workspaces, and per call: each call keeps its own
 * share, so one wide search's results never crowd out the note read after it (a Lab test chat, 2026-11-26: a search
 * filled the whole turn's room, the roles note read next kept nothing, and the draft that carried it passed).
 */
export const MAX_READ_CHARS = 240_000;
export const MAX_CALL_CHARS = 30_000;
/** Shared names and figures it takes to hold a draft: one alone is too often a word anybody could say. */
export const HOLD_AT = 2;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
const ARG_KEYS = ["context", "path", "paths", "note", "notes", "from", "to", "folder", "url"];
/** Capitalised words that start sentences and name nothing, never counted as a name. */
const COMMON = /^(?:about|action|after|all|also|and|any|april|august|before|but|com|context|december|done|each|eight|every|february|first|five|for|four|friday|from|hello|here|hey|hi|how|http|https|i|if|ill|im|into|it|item|items|its|ive|january|july|june|just|last|lc|march|may|meeting|meetings|monday|new|next|nine|no|not|note|notes|november|october|okay|one|or|our|over|please|saturday|september|seven|six|so|some|summary|sunday|sure|ten|tex|than|thank|thanks|that|the|their|them|then|there|these|they|this|those|three|thursday|today|tomorrow|tonight|tuesday|two|under|we|wednesday|what|when|where|which|while|who|whom|whose|why|with|without|www|yeah|yes|yesterday|you|your)$/;

function slugOf(value) {
  const words = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  return SLUG.test(words) ? words : null;
}

/** The workspaces somebody in the room can't open, by slug. Empty for a 1:1, and for a chat whose people share all. */
export function roomSlugs(group) {
  if (group === null || group === undefined) return new Set();
  const out = new Set();
  for (const slug of Array.isArray(group.unshared) ? group.unshared : []) if (slugOf(slug)) out.add(slugOf(slug));
  for (const entry of Array.isArray(group.blocked) ? group.blocked : []) if (slugOf(entry?.slug)) out.add(slugOf(entry.slug));
  return out;
}

/** Who in the room is named as kept out of a workspace, by handle or the chat's own label. */
export function cantOpen(group, slugs) {
  const want = new Set(slugs);
  const who = (Array.isArray(group?.blocked) ? group.blocked : []).filter((entry) => want.has(entry?.slug)).map((entry) => (entry.why === "no_account" ? String(entry.who) : `@${entry.who}`));
  return [...new Set(who)];
}

/** Every workspace a call names: its `context`, or a path, note or link that starts with `@slug/`. */
export function slugsCalled(args) {
  const out = new Set();
  const look = (value, depth) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string") {
      const words = value.trim();
      const at = /^@([a-z0-9][a-z0-9-]{0,63})(?:\/|$)/i.exec(words) ?? /context\.lc\/@([a-z0-9][a-z0-9-]{0,63})(?:\/|\b)/i.exec(words);
      if (at) out.add(at[1].toLowerCase());
      return;
    }
    if (Array.isArray(value)) return void value.slice(0, 50).forEach((entry) => look(entry, depth + 1));
    if (typeof value === "object") for (const key of ARG_KEYS) if (key in value) look(value[key], depth + 1);
    if (typeof value === "object" && value.args && typeof value.args === "object") look(value.args, depth + 1);
  };
  look(args, 0);
  return out;
}

function resultText(result) {
  return (Array.isArray(result?.content) ? result.content : []).map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/**
 * One turn's record of what it read from the room's closed workspaces. `wrap(callTool)` keeps each call that named one
 * and came back; `add(slugs, texts)` adds what a job read there (its report's words). Null for a turn with none.
 */
export function roomReads(group) {
  const closed = roomSlugs(group);
  if (closed.size === 0) return null;
  const read = new Map(); // slug -> text read there
  let chars = 0;
  const keep = (slug, text) => {
    if (!closed.has(slug)) return;
    const left = Math.min(MAX_CALL_CHARS, MAX_READ_CHARS - chars);
    const piece = left > 0 ? String(text ?? "").slice(0, left) : "";
    chars += piece.length;
    read.set(slug, `${read.get(slug) ?? ""}\n${piece}`);
  };
  return {
    closed,
    wrap(callTool) {
      return async (name, args) => {
        const result = await callTool(name, args);
        if (result?.isError !== true) for (const slug of slugsCalled(args)) keep(slug, resultText(result));
        return result;
      };
    },
    add(slugs, texts) {
      for (const slug of Array.isArray(slugs) ? slugs : []) if (slugOf(slug)) keep(slugOf(slug), (Array.isArray(texts) ? texts : []).join("\n"));
    },
    /** The closed workspaces this turn read, by slug. */
    slugs: () => [...read.keys()],
    text: (slug) => read.get(slug) ?? "",
  };
}

/** Whether the asker's own text points at a workspace: names it (`@slug`) or links into it. */
export function pointedAt(question, slug) {
  const words = String(question ?? "").toLowerCase();
  const at = new RegExp(`(?:^|[^a-z0-9-])@${slug.replace(/[-]/g, "\\-")}(?![a-z0-9-])`);
  return at.test(words);
}

/** The names and figures in a text: capitalised words that aren't sentence words, and numbers of two digits or more. */
export function tokensOf(text) {
  const out = new Set();
  const words = String(text ?? "");
  for (const match of words.matchAll(/\b[A-Z][a-zA-Z'’-]{2,}\b/g)) {
    const word = match[0].replace(/['’]s$/, "").toLowerCase();
    if (word.length >= 3 && !COMMON.test(word.replace(/['’]/g, ""))) out.add(word);
  }
  for (const match of words.matchAll(/\d[\d,.:/$%-]*\d|\$\d+/g)) out.add(match[0].replace(/[,]/g, ""));
  return out;
}

/** Everything the room already has: the chat's own lines, the ask, and the people's names. */
export function seenInRoom({ history = [], question = "", group = null }) {
  const lines = (Array.isArray(history) ? history : []).map((turn) => (typeof turn?.text === "string" ? turn.text : "")).join("\n");
  const names = [...(Array.isArray(group?.names) ? group.names.map((entry) => `${entry?.name ?? ""} ${entry?.handle ?? ""}`) : []), ...(Array.isArray(group?.people) ? group.people : []), ...(Array.isArray(group?.guests) ? group.guests : [])].join(" ");
  const chat = Array.isArray(group?.chat) ? group.chat.map((entry) => (typeof entry === "string" ? entry : String(entry?.text ?? ""))).join("\n") : "";
  const seen = tokensOf(`${lines}\n${question}\n${chat}`);
  for (const name of names.split(/\s+/)) if (name.length >= 3) seen.add(name.toLowerCase());
  return seen;
}

/**
 * How a draft measures against what was read, as counts for the step's log: the text read from closed workspaces, how
 * many of them the asker pointed at, and the most names and figures the draft shares with one of the others.
 */
export function roomTally({ draft, reads, group, question = "", history = [] }) {
  if (reads === null || reads === undefined) return { chars: 0, pointed: 0, carried: 0 };
  const seen = seenInRoom({ history, question, group });
  const said = tokensOf(draft);
  let chars = 0, pointed = 0, carried = 0;
  for (const slug of reads.slugs()) {
    chars += reads.text(slug).trim().length;
    if (pointedAt(question, slug)) { pointed += 1; continue; }
    const there = tokensOf(reads.text(slug));
    carried = Math.max(carried, [...said].filter((token) => there.has(token) && !seen.has(token)).length);
  }
  return { chars, pointed, carried };
}

/**
 * Whether a draft carries what was read from a workspace the room can't all open, and the asker didn't point at.
 * Null when it doesn't; otherwise the facts: which workspaces, who can't open them, and how many names it shares.
 */
export function roomVerdict({ draft, reads, group, question = "", history = [] }) {
  if (reads === null || reads === undefined || typeof draft !== "string" || draft.trim() === "") return null;
  const seen = seenInRoom({ history, question, group });
  const said = tokensOf(draft);
  const from = [];
  let shared = 0;
  for (const slug of reads.slugs()) {
    if (pointedAt(question, slug)) continue;
    const there = tokensOf(reads.text(slug));
    const carried = [...said].filter((token) => there.has(token) && !seen.has(token));
    if (carried.length >= HOLD_AT) {
      from.push(slug);
      shared += carried.length;
    }
  }
  if (from.length === 0) return null;
  return { from, cantOpen: cantOpen(group, from), shared };
}

/**
 * What the front door is told when its draft is held, as data: the draft went to the asker alone (or could not), from
 * which workspaces, and who here can't open them. What to say in the group is the model's own (Training).
 */
export function heldFacts(verdict, { asker = "", sent = false } = {}) {
  return JSON.stringify({
    held_from_group: {
      read_from: verdict.from.map((slug) => `@${slug}`),
      cant_open_here: verdict.cantOpen.length > 0 ? verdict.cantOpen : "not everyone here",
      draft_sent_privately_to: sent && asker ? `@${asker}` : null,
      asker_pointed_at_it: false,
    },
  });
}
