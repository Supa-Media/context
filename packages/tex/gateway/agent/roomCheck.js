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
 *  - what this turn read from them (`roomReads`): each call that named one by `context`, an `@slug/` path or id, and
 *    what it gave back, and each hit a result names as theirs (`@slug/` lines: a search reaches every workspace).
 *    A job reports the ones it read (`roomRead`), and its report's words count as read from them;
 *  - whether the asker pointed at it (`pointedAt`): a workspace their own text names (`@slug`, or a link into it) is
 *    theirs to share, and is never held;
 *  - whether the draft carries it (`roomVerdict`): names and figures the draft shares with what was read there, that
 *    nobody in the chat or the ask already said.
 *
 * PRIVATE NOTES STAY OUT OF THE GROUP UNLESS THE ASKER NAMES ONE (Dev2, 2026-11-28: "if i tell tex a specific note even
 * if marked private it should still be able to read right" — yes). A note is private where it lives (a read says
 * `visibility: private`; a group's search marks the hit, `apps/mcp/src/tools/search.js` `PRIVATE_HIT_LABEL`). Almost
 * every note in a personal workspace is private, and almost every note in a shared one is team, so "v2l action items"
 * draws on v2l's team notes, while "share my gulag trip note" names one and may post it (`namedIn`). And a draft that
 * carries a secret read this turn (a passcode, a password, a PIN, an account number: `secretIn`) goes to the asker
 * alone whoever asked for it.
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
const ARG_KEYS = ["context", "path", "paths", "note", "notes", "id", "ids", "from", "to", "folder", "url"];
/** A hit in a search or listing that names another workspace starts its own line with `@slug/` (`tools/search.js`). */
const HIT_LINE = /^@([a-z0-9][a-z0-9-]{0,63})\/\S/i;
/** A hit in the workspace the call ran in: its path alone on its line, with no `@slug/` in front. */
const HOME_HIT = /^[a-z0-9_.-][^\s@]*\/[^\s]*\.[a-z0-9]{1,8}$/i;
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
 * What a result gave back from each workspace its hits name, by slug: every block that starts on a `@slug/` line, up to
 * the next one. A search runs in every workspace the person reaches whatever `context` it names (`search everywhere`,
 * `apps/mcp/src/search/config/nodes.js`), so its args alone never say where its hits came from (audit, 2026-11-26: a
 * search naming the chat's home answered with another workspace's notes, and nothing was kept for the check).
 */
export function hitsBySlug(text) {
  const out = new Map();
  let slug = null;
  for (const line of String(text ?? "").split("\n")) {
    const at = HIT_LINE.exec(line);
    if (at) slug = at[1].toLowerCase();
    else if (HOME_HIT.test(line) || /^(?:Searched:|A path that starts with @)/.test(line)) slug = null;
    if (slug !== null) out.set(slug, `${out.get(slug) ?? ""}\n${line}`);
  }
  return out;
}

/**
 * One turn's record of what it read from the room's closed workspaces. `wrap(callTool)` keeps each call that named one
 * and came back; `add(slugs, texts)` adds what a job read there (its report's words). Null for a turn with none.
 */
export function roomReads(group) {
  if (group === null || group === undefined) return null;
  const closed = roomSlugs(group);
  const read = new Map(); // slug -> text read there
  const held = new Map(); // a private note's key -> text read from it
  let chars = 0;
  let heldChars = 0;
  let all = ""; // every result's text, for the secret check (`secretIn`), bounded like the rest
  const keepAll = (text) => {
    if (all.length < MAX_READ_CHARS) all += `\n${String(text ?? "").slice(0, Math.min(MAX_CALL_CHARS, MAX_READ_CHARS - all.length))}`;
  };
  const keepPrivate = (key, text) => {
    const left = Math.min(MAX_CALL_CHARS, MAX_READ_CHARS - heldChars);
    const piece = left > 0 ? String(text ?? "").slice(0, left) : "";
    heldChars += piece.length;
    held.set(key, `${held.get(key) ?? ""}\n${piece}`);
  };
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
        if (result?.isError !== true) {
          const text = resultText(result);
          const called = slugsCalled(args);
          for (const slug of called) keep(slug, text);
          for (const [slug, hits] of hitsBySlug(text)) if (!called.has(slug)) keep(slug, hits);
          keepAll(text);
          // A read across several workspaces at once can't say which a bare path was in, so it is never taken for the home.
          const where = called.size === 1 ? [...called][0] : called.size > 1 ? "several" : null;
          for (const [key, words] of privateNotesIn(text, where)) keepPrivate(key, words);
        }
        return result;
      };
    },
    /** What a job read (`roomRead`: slugs, and `private:<key>` for a private note), its report's words as the text. */
    add(entries, texts) {
      const words = (Array.isArray(texts) ? texts : []).join("\n");
      keepAll(words);
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (typeof entry === "string" && entry.startsWith(PRIVATE_READ)) keepPrivate(entry.slice(PRIVATE_READ.length), words);
        else if (slugOf(entry)) keep(slugOf(entry), words);
      }
    },
    /** The closed workspaces this turn read, by slug. */
    slugs: () => [...read.keys()],
    text: (slug) => read.get(slug) ?? "",
    /** The private notes this turn read, by key (`@slug/path` or a path). */
    privateKeys: () => [...held.keys()],
    privateText: (key) => held.get(key) ?? "",
    /** Everything this turn's calls gave back, for the secret check. */
    allText: () => all,
    /** What a job's answer carries to its report: the closed workspaces and the private notes it read. */
    carried: () => [...read.keys(), ...[...held.keys()].map((key) => `${PRIVATE_READ}${key}`)],
  };
}

/** How a job's `roomRead` names a private note it read, beside the slugs (`packages/tex/worker/roomRead.ts`). */
export const PRIVATE_READ = "private:";
const PRIVATE_HIT = /^\s+\(private note\)\s*$/;
const READ_HEAD = /^etag: \S+\npath: (\S+)\nvisibility: (\w+)/;

/**
 * The private notes in one result, by key, each with the text it gave of them: a read's notes whose `visibility` is
 * private (`apps/mcp/src/tools/notes/read.js`), and a search's hits marked `(private note)`. `where` is the workspace
 * the call named, put in front of a read's bare path. The chat's own home never counts: it is the room's memory.
 */
export function privateNotesIn(text, where = null) {
  const found = privateNotesAt(text, where);
  // The chat's own home is the room's: a bare path (no `@slug/`) is in it, as is anything under `tex/groups/`.
  for (const key of [...found.keys()]) if (!key.startsWith("@") || /^@[a-z0-9-]+\/tex\/groups\//i.test(key)) found.delete(key);
  return found;
}

function privateNotesAt(text, where) {
  const out = new Map();
  const words = String(text ?? "");
  for (const block of words.split(/\n(?=etag: )/)) {
    const head = READ_HEAD.exec(block.replace(/^\s+/, ""));
    if (head && head[2] === "private") out.set(where && !head[1].startsWith("@") ? `@${where}/${head[1]}` : head[1], block);
  }
  let key = null;
  let lines = [];
  const close = () => {
    if (key !== null && lines.some((line) => PRIVATE_HIT.test(line))) out.set(key, `${out.get(key) ?? ""}\n${lines.join("\n")}`);
  };
  for (const line of words.split("\n")) {
    if (HIT_LINE.test(line) || HOME_HIT.test(line)) {
      close();
      key = line.trim();
      lines = [];
    } else if (key !== null && /^\s+\S/.test(line)) lines.push(line);
    else {
      close();
      key = null;
      lines = [];
    }
  }
  close();
  return out;
}

/** A note's naming words: its file name's and its first heading's, without dates or sentence words. */
function namingWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !COMMON.test(word));
}

/**
 * Whether the asker's own text names this note: its path or a link to it, every word of its file name, or every word
 * of its first heading. A search's words alone never do ("v2l action items" names no note called "v2l plans").
 */
export function namedIn(question, key, text = "") {
  const asked = String(question ?? "").toLowerCase();
  if (asked.trim() === "") return false;
  // The note's path without its workspace or its kind's ending (a note, a sheet, a page alike).
  const path = String(key ?? "").replace(/^@[a-z0-9-]+\//i, "").replace(/(?:\.[a-z0-9]{1,8})+$/i, "").toLowerCase();
  if (path !== "" && asked.includes(path)) return true;
  const said = new Set(namingWords(asked));
  const every = (words) => words.length > 0 && words.every((word) => said.has(word));
  const stem = path.split("/").pop() ?? "";
  if (every(namingWords(stem))) return true;
  const heading = /^#\s+(.+)$/m.exec(String(text ?? ""));
  return heading !== null && every(namingWords(heading[1]));
}

/** Words that say what follows is a secret. */
const SECRET_WORD = /\b(?:pass(?:word|code|phrase)s?|pins?|pin code|passcodes?|security code|one[- ]time code|otp|2fa code|backup codes?|recovery codes?|ssn|social security(?: number)?|account (?:number|no\.?|#)|routing (?:number|no\.?)|card number|cvv|cvc|seed phrase|private key|api key)\b/i;
/** A value: four or more characters with a digit in them, or a long run of letters and digits without spaces. */
const SECRET_VALUE = /^(?=[^\s]*\d)[^\s,;]{4,}$|^[A-Za-z0-9!@#$%^&*_+=?-]{8,}$/;

/**
 * Whether a draft carries a secret this turn read: a secret word, then within a few words a value (`SECRET_VALUE`)
 * that something read this turn holds and nobody in the room already said. Code only; nothing a model decides.
 */
export function secretIn(draft, readText, seen = new Set()) {
  const words = String(draft ?? "");
  const read = String(readText ?? "");
  if (read === "" || !SECRET_WORD.test(words)) return false;
  for (const match of words.matchAll(new RegExp(SECRET_WORD.source, "gi"))) {
    const after = words.slice(match.index + match[0].length, match.index + match[0].length + 60);
    for (const raw of after.split(/\s+/).slice(0, 6)) {
      const value = raw.replace(/^[:=("'“”‘’`*-]+|[)"'“”‘’`*.,;:!?]+$/g, "");
      if (value.length < 4 || !SECRET_VALUE.test(value)) continue;
      if (seen.has(value.toLowerCase()) || seen.has(value.replace(/[,]/g, ""))) continue;
      if (read.includes(value)) return true;
    }
  }
  return false;
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
  if (reads === null || reads === undefined) return { chars: 0, pointed: 0, carried: 0, private: 0, named: 0 };
  const seen = seenInRoom({ history, question, group });
  const said = tokensOf(draft);
  let chars = 0, pointed = 0, carried = 0;
  for (const slug of reads.slugs()) {
    chars += reads.text(slug).trim().length;
    if (pointedAt(question, slug)) { pointed += 1; continue; }
    const there = tokensOf(reads.text(slug));
    carried = Math.max(carried, [...said].filter((token) => there.has(token) && !seen.has(token)).length);
  }
  let named = 0;
  const keys = typeof reads.privateKeys === "function" ? reads.privateKeys() : [];
  for (const key of keys) {
    if (namedIn(question, key, reads.privateText(key))) { named += 1; continue; }
    const there = tokensOf(reads.privateText(key));
    carried = Math.max(carried, [...said].filter((token) => there.has(token) && !seen.has(token)).length);
  }
  return { chars, pointed, carried, private: keys.length, named };
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
  // A private note's text, unless the asker named that note (Dev2, 2026-11-28).
  const notes = [];
  const keys = typeof reads.privateKeys === "function" ? reads.privateKeys() : [];
  for (const key of keys) {
    if (namedIn(question, key, reads.privateText(key))) continue;
    const there = tokensOf(reads.privateText(key));
    const carried = [...said].filter((token) => there.has(token) && !seen.has(token));
    if (carried.length >= HOLD_AT) {
      notes.push(key);
      shared += carried.length;
    }
  }
  // A secret read this turn, whoever asked and whatever named it.
  const everything = [...reads.slugs().map((slug) => reads.text(slug)), ...keys.map((key) => reads.privateText(key)), typeof reads.allText === "function" ? reads.allText() : ""].join("\n");
  const secret = secretIn(draft, everything, seen);
  if (from.length === 0 && notes.length === 0 && !secret) return null;
  return { from, cantOpen: cantOpen(group, from), shared, private: notes, secret };
}

/**
 * What the front door is told when its draft is held, as data: the draft went to the asker alone (or could not), from
 * which workspaces, and who here can't open them. What to say in the group is the model's own (Training).
 */
export function heldFacts(verdict, { asker = "", sent = false } = {}) {
  return JSON.stringify({
    held_from_group: {
      read_from: verdict.from.map((slug) => `@${slug}`),
      ...(verdict.from.length > 0 ? { cant_open_here: verdict.cantOpen.length > 0 ? verdict.cantOpen : "not everyone here" } : {}),
      draft_sent_privately_to: sent && asker ? `@${asker}` : null,
      asker_pointed_at_it: false,
      ...(verdict.private?.length > 0 ? { private_notes_not_named: verdict.private, private_notes_open_by_name: true } : {}),
      ...(verdict.secret === true ? { carries_a_secret: true } : {}),
    },
  });
}
