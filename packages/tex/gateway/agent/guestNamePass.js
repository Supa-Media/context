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
import { texWords } from "./texConfig.js";

export const GUEST_NAMES_MODEL = "anthropic/claude-haiku-5-5";
/** The chat's newest text lines it reads, and the most characters of them the model is shown. */
export const LINES_READ = 30;
const MAX_CHARS = 8_000;
const MAX_LINE_CHARS = 400;
/** How recent an unnamed guest's own line must be (among the newest lines) for the pass to run at all. */
export const RECENT_GUEST_LINES = 8;
const GUEST = /^guest-[0-9a-f]{4}$/;
const MAX_NAMES_READ = 500;

const idOf = (entry) => (typeof entry?.eid === "string" ? entry.eid : entry?.id);
const labelOf = (entry) => (entry?.from?.kind === "person" && typeof entry.from.name === "string" && GUEST.test(entry.from.name) ? entry.from.name : null);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `name` is a whole word (or words) of `text`, any case. */
export function saysName(text, name) {
  if (typeof text !== "string" || name === "") return false;
  return new RegExp(`(^|[^\\p{L}\\p{M}])${escape(name)}($|[^\\p{L}\\p{M}])`, "iu").test(text);
}

/** The lines as the model reads them, oldest first: `[id] who: words`, a reply with whose text it was typed under. */
export function renderLines(lines, names) {
  const byId = new Map(lines.map((entry) => [idOf(entry), entry]));
  const who = (entry) => {
    if (entry?.from?.kind === "tex") return "Tex";
    const label = labelOf(entry);
    if (label !== null) return names.get(label) ?? label;
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
 * (label → name) and the other people's names here (handles and display names of members).
 */
export function checkedNames(found, lines, kept, others = []) {
  const byId = new Map(lines.map((entry) => [idOf(entry), entry]));
  const unnamed = new Set(lines.map(labelOf).filter((label) => label !== null && !kept.has(label)));
  const taken = new Set([...kept.values(), ...others].map((name) => cleanName(String(name)).toLowerCase()).filter(Boolean));
  const out = [];
  for (const { guest, name: said, line } of found) {
    const name = cleanName(said);
    const entry = byId.get(line);
    if (!unnamed.has(guest) || name === "" || entry === undefined || entry.from?.kind === "tex") continue;
    if (!saysName(entry.text, name)) continue;
    const own = labelOf(entry) === guest;
    const under = typeof entry.replyTo === "string" && labelOf(byId.get(entry.replyTo)) === guest;
    const byLabel = typeof entry.text === "string" && entry.text.includes(guest);
    if (!own && !under && !byLabel) continue;
    const key = name.toLowerCase();
    if (taken.has(key) || out.some((n) => n.guest === guest)) continue;
    taken.add(key);
    out.push({ guest, name, by: labelOf(entry) ?? (typeof entry.from?.name === "string" ? entry.from.name : "") });
  }
  return out;
}

/**
 * One pass over the chat's newest lines: `{outcome, kept?}`. `others`: the names of the chat's members and anyone
 * else named here, so no guest is given one of them. `request` and `words` are for tests.
 */
export async function nameGuestsFromChat({ ledger, chat, config, metadata, others = [], request = requestViaGateway, words = texWords() }) {
  if (!config || ledger === null || typeof ledger?.read !== "function" || typeof ledger?.append !== "function" || typeof chat !== "string") return { outcome: "none" };
  let lines;
  let kept;
  try {
    const [read, names] = await Promise.all([
      ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["text"], limit: LINES_READ }),
      ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["name"], limit: MAX_NAMES_READ }),
    ]);
    lines = (read?.entries ?? []).filter((entry) => typeof entry?.text === "string" && entry.text !== "").sort((a, b) => a.at - b.at);
    kept = new Map(guestNamesFrom(names?.entries ?? []).map(({ guest, name }) => [guest, name]));
  } catch {
    return { outcome: "unread" };
  }
  // Only when someone still unnamed spoke lately: a chat whose guests all have names costs no model call.
  const recent = lines.slice(-RECENT_GUEST_LINES);
  if (!recent.some((entry) => { const label = labelOf(entry); return label !== null && !kept.has(label); })) return { outcome: "nobody_unnamed" };
  const prompt = words["guest-names"];
  if (typeof prompt !== "string" || prompt === "") return { outcome: "no_prompt" };
  let found;
  try {
    const reply = await request(
      { model: GUEST_NAMES_MODEL, system: withArchitecture(prompt, "guestNames"), messages: [{ role: "user", text: `THE LINES\n\n${renderLines(lines, kept)}` }], tools: [], maxTokens: 300, effort: "low" },
      config,
      { metadata },
    );
    found = readNames(reply?.text);
  } catch {
    return { outcome: "model_failed" };
  }
  const names = checkedNames(found, lines, kept, others);
  if (names.length > 0) {
    try {
      await ledger.append(chat, names.map(({ guest, name, by }) => guestNameEntry(guest, name, { by: by === "" ? "chat" : by })));
    } catch {
      return { outcome: "unwritten", found: found.length };
    }
  }
  return { outcome: "done", found: found.length, kept: names.length };
}
