/**
 * A GROUP CHAT'S ROSTER OF NAMES FOR ITS GUESTS (Dev2, 2026-11-12).
 *
 * Someone in a chat with no Context account linked to the number they text from is known to Tex by a label
 * (`guest-1a2b`, `groupNames.js`). When someone here said who a guest was, Tex was told to add it to the chat's about
 * note, and the lines it read, the chat's list and the judge still showed the label: Tex went on saying the label to
 * people who had told it the name. Asked how Tex should keep a name, Dev2 chose the chat's own roster.
 *
 * So a name is kept in the chat's ledger, the chat's one copy (`chat-ledger.md`), as a `name` entry
 * `{guest, name, by?}`: the newest per guest is that guest's name. Every group turn reads them beside its history
 * (`groupTurn.js` `readGroupMemory`), and the list, the chat's lines, who tagged it and its earlier history show the
 * name, with the number beside it; the judge reads them as facts (`textsDecide.js` `nowFacts`). A name is a person's
 * text: it is kept to the letters and marks names use (`cleanName`), so it can't carry an instruction.
 */

import { cleanName } from "./groupNames.js";

export const NAME_GUEST = "name_guest";

/** The `send` action it is shown as (`sixTools.js`). */
export const GUEST_NAME_SEND_ACTIONS = {
  name_guest: {
    tool: NAME_GUEST,
    summary: "In a group chat, keep the name of someone shown by a guest label once someone here says who they are, so you and everyone here call them by it.",
  },
};

const GUEST = /^guest-[0-9a-f]{4}$/;
/** The most name entries a turn reads: a chat renames its guests far less often than this. */
const MAX_READ = 500;
const MAX_NAMES = 64;
const MAX_BY = 64;

const newId = () => `name${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

function text(words, isError = false) {
  return { content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) };
}

/** One name as a ledger entry; `by` is who said it, a handle or a guest label. */
export function guestNameEntry(guest, name, { by = "", turn = null, at = Date.now() } = {}) {
  const said = typeof by === "string" ? by.replace(/[^a-z0-9-]/g, "").slice(0, MAX_BY) : "";
  return { v: 1, id: newId(), at, kind: "name", ...(turn ? { turn } : {}), guest, name, ...(said ? { by: said } : {}), text: `${guest} is ${name}` };
}

/** The newest name for each guest, from `name` entries read newest first. */
export function guestNamesFrom(entries) {
  const seen = new Set();
  const names = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== "name" || typeof entry.guest !== "string" || !GUEST.test(entry.guest) || seen.has(entry.guest)) continue;
    seen.add(entry.guest);
    const name = cleanName(entry.name);
    if (name !== "") names.push({ guest: entry.guest, name });
    if (names.length >= MAX_NAMES) break;
  }
  return names;
}

/** The chat's guest names from its ledger, newest per guest; none when it can't be read. */
export async function readGuestNames(ledger, chat) {
  if (ledger === null || ledger === undefined || typeof ledger.read !== "function") return [];
  try {
    const read = await ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["name"], limit: MAX_READ });
    return guestNamesFrom(read?.entries ?? []);
  } catch (error) {
    console.log(JSON.stringify({ event: "group_guest_names_unread", reason: String(error?.name ?? "error").slice(0, 40) }));
    return [];
  }
}

/** A name as an about note writes one: up to three capitalised words. */
const NOTE_NAME = String.raw`(\p{Lu}[\p{L}\p{M}'’.-]*(?:[ ]\p{Lu}[\p{L}\p{M}'’.-]*){0,2})`;
const LABEL = String.raw`(guest-[0-9a-f]{4})`;
/** "guest-1a2b is Sam", "guest-1a2b: Sam", "guest-1a2b (Sam)", and "Sam (guest-1a2b)". */
const ABOUT_PATTERNS = [
  { re: new RegExp(`${LABEL}\\s*(?:is|=|:|-|–|—)\\s*${NOTE_NAME}`, "gu"), label: 1, name: 2 },
  { re: new RegExp(`${LABEL}\\s*\\(\\s*${NOTE_NAME}`, "gu"), label: 1, name: 2 },
  { re: new RegExp(`${NOTE_NAME}\\s*\\(\\s*${LABEL}\\s*\\)`, "gu"), label: 2, name: 1 },
];
/** Words an about note puts where a name would go that are no name. */
const NOT_A_NAME = /^(?:Not|Unknown|Unconfirmed|Confirmed|Probably|Maybe|The|A|An)$/;

/**
 * The guests here that the chat's about note names, the last mention per guest, before names were kept on the chat
 * (Dev2, 2026-11-12: after #3218 Tex still showed Boba and Instinct by label, their names only in the about note,
 * because nothing had called name_guest). Only labels in this chat; names cleaned as any (`cleanName`).
 */
export function namesInAbout(about, guests) {
  if (typeof about !== "string" || about === "" || !Array.isArray(guests) || guests.length === 0) return [];
  const here = new Set(guests);
  const found = [];
  for (const { re, label, name } of ABOUT_PATTERNS) {
    for (const match of about.matchAll(re)) {
      const said = cleanName(match[name]).split(" ").filter((word) => !NOT_A_NAME.test(word)).join(" ");
      if (here.has(match[label]) && said !== "" && !/['’]s$/.test(said)) found.push({ at: match.index, guest: match[label], name: said });
    }
  }
  const last = new Map();
  for (const entry of found.sort((a, b) => a.at - b.at)) last.set(entry.guest, entry.name);
  return [...last].map(([guest, name]) => ({ guest, name }));
}

/** A promise settled later, for names the history read waits on before the about note is read (`groupTurn.js`). */
export function laterNames() {
  let settle = () => {};
  const promise = new Promise((resolve) => (settle = resolve));
  return { promise, settle: (names) => Promise.resolve(names).then(settle, () => settle([])) };
}

/**
 * The chat's guest names: the ledger's, and for a guest it has none for, the about note's, which are kept in the
 * ledger then (behind the turn, `by: "about"`), so the judge and every later turn read them from the one copy.
 */
export async function guestNamesWithAbout(kept, about, group, ledger) {
  const [names, note] = await Promise.all([Promise.resolve(kept).catch(() => []), Promise.resolve(about).catch(() => null)]);
  const known = new Set(names.map((entry) => entry.guest));
  const added = namesInAbout(note, group?.guests).filter((entry) => !known.has(entry.guest));
  if (added.length > 0 && typeof ledger?.append === "function" && typeof group?.key === "string") {
    void Promise.resolve()
      .then(() => ledger.append(group.key, added.map((entry) => guestNameEntry(entry.guest, entry.name, { by: "about" }))))
      .then(() => console.log(JSON.stringify({ event: "group_guest_names_from_about", count: added.length })))
      .catch(() => {});
  }
  return [...names, ...added];
}

/** The judge's facts: each guest here by label and name, one line. */
export function guestNameFacts(names) {
  const kept = Array.isArray(names) ? names : [];
  return kept.length === 0 ? [] : [`People here known by a guest label, by name: ${kept.map(({ guest, name }) => `${guest} is ${name}`).join("; ")}.`];
}

/**
 * The tool for one group turn, or null outside a group chat: `group` is the turn's (`groupTurn.js`) and `ledger` the
 * chat's own ledger (`store.texLedger(group.key)`), which keeps the name.
 */
export function guestNameTool({ group, ledger }) {
  if (group === null || group === undefined || ledger === null || ledger === undefined || typeof ledger.append !== "function") return null;
  return {
    tool: {
      name: NAME_GUEST,
      description:
        "Keep the name of someone in this chat you know only by a guest label (guest-1a2b), once someone here says who they are " +
        "(\"that's my brother Sam\"), or they say it themselves. From then on the chat's list, its lines and who tagged you name them, with their number. " +
        "A new name for the same guest replaces the old one.",
      inputSchema: {
        type: "object",
        properties: {
          guest: { type: "string", description: "Their guest label, exactly as shown: guest- and four letters or digits." },
          name: { type: "string", description: "The name the chat gave them, as a person would say it (\"Sam\", \"Sam Rivers\")." },
        },
        required: ["guest", "name"],
      },
    },
    call: async (args) => {
      const guest = typeof args?.guest === "string" ? args.guest.trim().toLowerCase() : "";
      const here = Array.isArray(group.guests) ? group.guests : [];
      if (!GUEST.test(guest) || !here.includes(guest)) {
        return text(`Not kept: ${guest || "that"} isn't a guest label in this chat. The guests here are ${here.length > 0 ? here.join(", ") : "none"}.`, true);
      }
      const name = cleanName(args?.name);
      if (name === "") return text("Not kept: give the name as a person would say it, letters only.", true);
      const by = group.from || group.asker || "";
      try {
        await ledger.append(group.key, [guestNameEntry(guest, name, { by })]);
      } catch (error) {
        console.log(JSON.stringify({ event: "group_guest_name_failed", reason: String(error?.name ?? "error").slice(0, 40) }));
        return text("Not kept: the chat's record couldn't be written just now. Call them by that name in your answer anyway.", true);
      }
      group.guestNames = [{ guest, name }, ...(Array.isArray(group.guestNames) ? group.guestNames.filter((entry) => entry.guest !== guest) : [])];
      console.log(JSON.stringify({ event: "group_guest_named" }));
      return text(`Kept: ${guest} is ${name} in this chat. Call them ${name} from now on; don't mention you saved it unless asked.`);
    },
  };
}
