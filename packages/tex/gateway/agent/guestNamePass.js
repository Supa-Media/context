/**
 * A GROUP CHAT'S GUEST NAMES, READ FROM THE CHAT ITSELF (Dev2, 2026-11-27: the launch-day rehearsal showed Tex calling
 * Diego by his number while Tunde wrote "Diego you said 2 hrs right?" under his text; Dev2 OK'd "the Learn node reads
 * names from the chat" beside members' phone contacts).
 *
 * After a group turn, the chat's newest lines are read once by a small model (`guest-names` prompt module) only when
 * someone here is still unnamed and spoke in them, and a name it finds is kept in the chat's ledger as a `name` entry
 * `by: "chat"` (`groupGuestNames.js`), where every turn, the judge and the app read names. Code holds the model to
 * what it can check:
 *
 *  - the guest is one of the lines' unnamed labels, and has no name yet (a name said by someone, a correction, the
 *    about note or a member's contacts is never replaced);
 *  - the line it cites is one of those lines, is not the guest's own unless it says the name (their own "it's Kemi"),
 *    and has the name in its words, as a whole word;
 *  - a reply in it was typed under that guest's text, or it names the guest's label, or it is the guest's own line:
 *    a name said to the room ties to nobody;
 *  - no two guests get one name, and no guest gets a name someone here already has.
 *
 * Its output is counts, never a name or a line's words. It never throws.
 */

import { requestViaGateway } from "./aiGateway.js";
import { cleanName } from "./groupNames.js";
import { guestNameEntry, guestNamesFrom } from "./groupGuestNames.js";
import { withArchitecture } from "./texArchitecture.js";
import { texEffort, texModel, texWords } from "./texConfig.js";

export const GUEST_NAMES_MODEL = "anthropic/claude-haiku-5-5";
/** The chat's newest text lines it reads, and the most characters of them the model is shown. */
export const LINES_READ = 30;
const MAX_CHARS = 8_000;
const MAX_LINE_CHARS = 400;
/** How recent an unnamed guest's own line must be (among the newest lines) for the pass to run at all. */
export const RECENT_GUEST_LINES = 8;
const GUEST = /^guest-[0-9a-f]{4}$/;
const MAX_NAMES_READ = 500;
const NODE = "guestNames";
/**
 * Words people use to name themselves. A guest whose name someone else gave is read again only when a recent line
 * of their own has one of these, so a chat whose guests are all named still costs no model call on most turns.
 */
const SELF_WORDS = /\b(i'?m|i am|it'?s|its|this is|call me|my name|name'?s|here)\b/i;

/** The guests named only by someone else so far: their own word can still name them (`guestNamesFrom`). */
export function openGuests(entries) {
  const named = new Set();
  const own = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== "name" || typeof entry.guest !== "string" || !GUEST.test(entry.guest)) continue;
    named.add(entry.guest);
    if (entry.by === entry.guest) own.add(entry.guest);
  }
  return new Set([...named].filter((guest) => !own.has(guest)));
}

/**
 * The step's model and effort in this config (a Lab draft's included), main's shelf default when it has no such step.
 * Its effort is `off` there: a JSON answer with thinking on spent the 300 tokens thinking and answered nothing (Lab,
 * 2026-11-27: two passes over a chat that named its guest found no name).
 */
export function guestNamesSetup(tex) {
  try {
    return { model: texModel(NODE, tex), ...texEffort(NODE, tex) };
  } catch {
    return { model: GUEST_NAMES_MODEL, effort: "low", thinking: "off" };
  }
}

const idOf = (entry) => (typeof entry?.eid === "string" ? entry.eid : entry?.id);
const labelOf = (entry) => (entry?.from?.kind === "person" && typeof entry.from.name === "string" && GUEST.test(entry.from.name) ? entry.from.name : null);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `name` is a whole word (or words) of `text`, any case. */
export function saysName(text, name) {
  if (typeof text !== "string" || name === "") return false;
  return new RegExp(`(^|[^\\p{L}\\p{M}])${escape(name)}($|[^\\p{L}\\p{M}])`, "iu").test(text);
}

/**
 * The lines as the model reads them, oldest first: `[id] who: words`, a reply with whose text it was typed under. A
 * guest whose name someone else gave (`open`) shows it with their label, so their own word can still name them.
 */
export function renderLines(lines, names, open = new Set()) {
  const byId = new Map(lines.map((entry) => [idOf(entry), entry]));
  const who = (entry) => {
    if (entry?.from?.kind === "tex") return "Tex";
    const label = labelOf(entry);
    if (label !== null) return names.has(label) && open.has(label) ? `${names.get(label)} (${label})` : names.get(label) ?? label;
    return typeof entry?.from?.name === "string" && entry.from.name !== "" ? entry.from.name : "someone";
  };
  const out = [];
  for (const entry of lines) {
    const to = typeof entry.replyTo === "string" ? byId.get(entry.replyTo) : undefined;
    const under = to === undefined ? "" : ` (reply to [${idOf(to)}])`;
    out.push(`[${idOf(entry)}] ${who(entry)}${under}: ${String(entry.text ?? "").replace(/\s+/g, " ").slice(0, MAX_LINE_CHARS)}`);
  }
  let text = out.join("\n");
  while (text.length > MAX_CHARS && out.length > 1) text = (out.shift(), out.join("\n"));
  return text;
}

/**
 * Each guest's label by the hash of their number (`from.who` on every line), from the turn's numbers
 * (`groupNames.js` `numbersOf`). A guest's first text in a chat is kept before the chat's people are read, so it
 * carries no label (`worker/groupTurn.ts` `logGroupInbound` runs before `keepNames`); this ties it to them.
 */
export async function guestHashes(numbers) {
  const out = new Map();
  for (const { who, phone } of Array.isArray(numbers) ? numbers : []) {
    if (typeof who !== "string" || !GUEST.test(who) || typeof phone !== "string" || phone === "") continue;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(phone));
    out.set([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""), who);
  }
  return out;
}

/** A line with no name, from a guest whose number's hash is known, named by their label. */
export function withLabels(lines, hashes) {
  if (!(hashes instanceof Map) || hashes.size === 0) return lines;
  return lines.map((entry) => {
    if (entry?.from?.kind !== "person" || typeof entry.from.name === "string" || !hashes.has(entry.from.who)) return entry;
    return { ...entry, from: { ...entry.from, name: hashes.get(entry.from.who) } };
  });
}

/** The model's answer as `[{guest, name, line}]`; anything else is none. */
export function readNames(answer) {
  const text = String(answer ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return (Array.isArray(parsed?.names) ? parsed.names : []).filter((n) => n && typeof n.guest === "string" && typeof n.name === "string" && typeof n.line === "string").slice(0, 16);
  } catch {
    return [];
  }
}

/**
 * The names code lets through, from what the model said (`found`), the lines it was shown, the chat's kept names
 * (label → name), the other people's names here (handles and display names of members) and the guests whose kept name
 * someone else gave (`open`): what a guest says about themselves wins over it (Dev2, 2026-11-27, after asking two other
 * assistants how they keep names), and only their own line can change it.
 */
export function checkedNames(found, lines, kept, others = [], open = new Set(), aliases = new Map()) {
  const byId = new Map(lines.map((entry) => [idOf(entry), entry]));
  const unnamed = new Set(lines.map(labelOf).filter((label) => label !== null && !kept.has(label)));
  const out = [];
  const key = (name) => cleanName(String(name)).toLowerCase();
  // Each guest's names, the other names they go by included (`guestNamesFrom`): no one else is given one, and a guest
  // may take one of their own back.
  const namesOf = new Map([...kept].map(([guest, name]) => [guest, new Set([name, ...(aliases.get(guest) ?? [])].map(key))]));
  const othersTaken = new Set(others.map(key).filter(Boolean));
  const takenFor = (guest, name) => othersTaken.has(name) || [...namesOf].some(([other, names]) => other !== guest && names.has(name)) || out.some((n) => n.name.toLowerCase() === name);
  for (const { guest, name: said, line } of found) {
    const name = cleanName(said);
    const entry = byId.get(line);
    if (name === "" || entry === undefined || entry.from?.kind === "tex") continue;
    if (!saysName(entry.text, name)) continue;
    const own = labelOf(entry) === guest;
    if (!unnamed.has(guest) && !(own && open.has(guest))) continue;
    const under = typeof entry.replyTo === "string" && labelOf(byId.get(entry.replyTo)) === guest;
    const byLabel = typeof entry.text === "string" && entry.text.includes(guest);
    if (!own && !under && !byLabel) continue;
    if (takenFor(guest, name.toLowerCase()) || out.some((n) => n.guest === guest)) continue;
    out.push({ guest, name, by: labelOf(entry) ?? (typeof entry.from?.name === "string" ? entry.from.name : "") });
  }
  return out;
}

/**
 * One pass over the chat's newest lines: `{outcome, kept?}`. `others`: the names of the chat's members and anyone
 * else named here, so no guest is given one of them. `hashes`: guests' labels by number hash (`guestHashes`). `request` and `words` are for tests.
 */
export async function nameGuestsFromChat({ ledger, chat, config, metadata, others = [], hashes = new Map(), request = requestViaGateway, words = texWords() }) {
  if (!config || ledger === null || typeof ledger?.read !== "function" || typeof ledger?.append !== "function" || typeof chat !== "string") return { outcome: "none" };
  let lines;
  let kept;
  let open;
  let aliases;
  try {
    const [read, names] = await Promise.all([
      ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["text"], limit: LINES_READ }),
      ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["name"], limit: MAX_NAMES_READ }),
    ]);
    lines = withLabels((read?.entries ?? []).filter((entry) => typeof entry?.text === "string" && entry.text !== "").sort((a, b) => a.at - b.at), hashes);
    const named = guestNamesFrom(names?.entries ?? []);
    kept = new Map(named.map(({ guest, name }) => [guest, name]));
    aliases = new Map(named.map(({ guest, aliases: also }) => [guest, also ?? []]));
    open = openGuests(names?.entries ?? []);
  } catch {
    return { outcome: "unread" };
  }
  // Only when someone still unnamed spoke lately, or someone named by others may have named themselves: a chat whose
  // guests all have names costs no model call.
  const recent = lines.slice(-RECENT_GUEST_LINES);
  const worth = (entry) => {
    const label = labelOf(entry);
    return label !== null && (!kept.has(label) || (open.has(label) && SELF_WORDS.test(String(entry.text ?? ""))));
  };
  if (!recent.some(worth)) return { outcome: "nobody_unnamed" };
  const prompt = words["guest-names"];
  if (typeof prompt !== "string" || prompt === "") return { outcome: "no_prompt" };
  let found;
  try {
    const reply = await request(
      { ...guestNamesSetup(config.tex), system: withArchitecture(prompt, "guestNames"), messages: [{ role: "user", text: `THE LINES\n\n${renderLines(lines, kept, open)}` }], tools: [], maxTokens: 300 },
      config,
      { metadata },
    );
    found = readNames(reply?.text);
  } catch {
    return { outcome: "model_failed" };
  }
  const names = checkedNames(found, lines, kept, others, open, aliases);
  if (names.length > 0) {
    try {
      await ledger.append(chat, names.map(({ guest, name, by }) => guestNameEntry(guest, name, { by: by === "" ? "chat" : by })));
    } catch {
      return { outcome: "unwritten", found: found.length };
    }
  }
  return { outcome: "done", found: found.length, kept: names.length };
}
