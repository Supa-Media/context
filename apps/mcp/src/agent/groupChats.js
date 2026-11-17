/**
 * A PERSON'S GROUP CHATS, READ FROM THEIR 1:1 (decided by the owner, Dev2, 2026-11-17: "1:1 Tex should be able to see
 * all the groupchats i'm in (that its also connected to) and it should be able to search through any of the messages
 * in there if prompted", e.g. "summarize everything that happened in Tex dev gc last week", "which gc and when was
 * that?"; `docs/decisions/texting-assistant/group-reads-from-1to1.md`).
 *
 * When the front door's `ctx` lists the `groups` module (`texConfig.json`), a 1:1 texted turn is told the group chats
 * its person is in (`groupsPrompt`) and gets one read-only local tool, `group_chats`:
 *
 *   { op: "list" }                                   the chats, as the prompt names them;
 *   { op: "read", chat, day, part? }                 one day of a chat word for word, as `read_day` reads its own;
 *   { op: "summaries", chat, from?, to? }            that chat's day summaries, each with the call that opens the day;
 *   { op: "search", words, chat?, since? }           texts in one chat or all of them holding the words.
 *
 * Which chats: only those the control plane names on the person's own 1:1 grant (`controlPlane.texterGroups`,
 * `textGroups.homeUsers`, the rule the Tex page and the history export use), asked once a turn. A chat is opened by
 * that list's key alone, never by a key the model wrote, so no turn reads a chat its person is not in. Nothing here
 * writes to a group, and a group's turn never gets this tool.
 */

import { earlierFromLedger } from "./ledgerHistory.js";
import { renderEvents, speaker } from "./logRender.js";
import { ledgerFor } from "./ledger.js";
import { texConfigOf, texStep } from "./texConfig.js";
import { dayBefore, midnightOf, readSpan, readSummaries, READ_DAY_CHARS } from "./weekHistory.js";
import { dayOf } from "./jobLog.js";

/** The module in the front door's `ctx` that turns this on. */
export const GROUPS_MODULE = "groups";
export const GROUP_CHATS = "group_chats";
const GROUP_KEY = /^[0-9a-f]{64}$/;
const DAY_ID = /^\d{4}-\d{2}-\d{2}$/;
/** The most hits one search answers, the words kept of each, and the ledger pages it reads of each chat. */
export const MAX_HITS = 40;
const HIT_CHARS = 400;
const SEARCH_PAGES = 5;
/** The most summary characters one `summaries` call answers. */
const SUMMARY_CHARS = 60_000;

/** Whether this turn's config (a Lab draft's in a Lab test chat) has the front door read the person's groups. */
export function groupsOn(env) {
  try {
    return readsGroups(texStep("fd", texConfigOf(env)));
  } catch {
    return false;
  }
}

/**
 * Whether this turn's config wires the Cross-chat gate (`tools -> crossChatGate`): its `ask_chat` names a group from
 * the same list, so the list is read for it even when the front door doesn't read groups (Dev2, 2026-11-17: a 1:1 asked
 * to message Tex Devs, and `ask_chat` was missing because only the `groups` module read the list).
 */
export function asksOn(env) {
  try {
    const edges = texConfigOf(env)?.edges;
    return Array.isArray(edges) && edges.some((edge) => edge?.from === "tools" && edge?.to === "crossChatGate");
  } catch {
    return false;
  }
}

/** Whether a step's `ctx` lists the `groups` module. */
export const readsGroups = (step) => Array.isArray(step?.ctx) && step.ctx.includes(GROUPS_MODULE);

/** The person's group chats from the control plane, kept to well-formed rows, or null when it can't say. */
export async function readTexterGroups(controlPlane, session) {
  if (typeof controlPlane?.texterGroups !== "function" || typeof session?.accessToken !== "string") return null;
  const listed = await controlPlane.texterGroups(session.accessToken, session.workspaceId);
  if (!Array.isArray(listed)) return null;
  return listed
    .filter((g) => g && typeof g.key === "string" && GROUP_KEY.test(g.key) && typeof g.name === "string")
    .map((g) => ({ key: g.key, name: g.name.replace(/[\s\u0000-\u001f"]+/g, " ").trim().slice(0, 120) || "Group chat", people: (Array.isArray(g.people) ? g.people : []).filter((p) => typeof p === "string").slice(0, 30), lastSeenAt: Number.isFinite(g.lastSeenAt) ? g.lastSeenAt : 0 }));
}

/** How one chat is named to the model: its name, its people and the id to pass. */
const chatLine = (g) => `- ${g.name}${g.people.length > 0 ? ` (with ${g.people.map((p) => (p === "Someone" ? p : `@${p}`)).join(", ")})` : ""}: chat "${g.key.slice(0, 12)}"`;

/**
 * What the prompt says (`turnPrompt.js` `context/groups`): the chats sorted by name, so the cached prefix holds while
 * they talk. "" when there are none or the list could not be read.
 */
export function groupsPrompt(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return "";
  const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name));
  return (
    `\n\nThe group chats they are in with you, which you can read from here (only read: what is said there stays there, and you answer in that chat only when someone there asks): ` +
    `fetch {"id": "groups:<chat>"} reads one (args { day } word for word, { from, to } each day's summary, { words } a search) and search { query, args: { groups: true } } searches them all. Use it when they ask about one of these chats or about something said "in a group chat", and say which chat and when.\n` +
    sorted.map(chatLine).join("\n")
  );
}

const answer = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** The chat the model named, by its id (any unique start of the key, at least 6 characters) or by its name, else null. */
export function pickChat(groups, named) {
  const want = String(named ?? "").trim().toLowerCase().replace(/^"|"$/g, "");
  if (want === "") return null;
  if (/^[0-9a-f]{6,64}$/.test(want)) {
    const found = groups.filter((g) => g.key.startsWith(want));
    if (found.length === 1) return found[0];
  }
  const exact = groups.filter((g) => g.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const plain = (s) => s.replace(/\b(gc|group ?chat|chat|the)\b/g, "").replace(/[^a-z0-9@]+/g, " ").trim();
  const loose = groups.filter((g) => plain(g.name.toLowerCase()).includes(plain(want)) || plain(want).includes(plain(g.name.toLowerCase())));
  return loose.length === 1 && plain(want).length >= 3 ? loose[0] : null;
}

/** The words a chat's lines are shown in: the transcript of another chat, with no "(not answered)" marks of its own. */
function transcriptOf(entries, key, timeZone, before = Number.MAX_SAFE_INTEGER) {
  const view = earlierFromLedger(entries, key, { before, chars: Number.MAX_SAFE_INTEGER, fade: false, grant: null });
  const text = renderEvents(view.events, { timeZone, tools: view.tools, facts: view.facts, lulls: true }).replace(/ {3}\(not answered\)/g, "");
  return { text, events: view.events };
}

const terms = (words) => [...new Set(String(words ?? "").toLowerCase().split(/[^\p{L}\p{N}@']+/u).filter((w) => w.length > 1))].slice(0, 12);

/**
 * The `group_chats` local tool for one turn. `groups` is the control plane's list; `ledgerOf(key)` opens a chat's
 * ledger (`ledger.js` `ledgerFor`); `timeZone` the person's, for days.
 */
export function groupChatsTool({ groups, ledgerOf, timeZone = "UTC", onRead = () => {}, now = Date.now, log = (line) => console.log(line) }) {
  const listing = () => (groups.length === 0 ? "You are in no group chats with them." : `Their group chats with you:\n${[...groups].sort((a, b) => a.name.localeCompare(b.name)).map(chatLine).join("\n")}`);
  const unknown = (named) => answer(`No group chat of theirs matches "${String(named ?? "").slice(0, 80)}". ${listing()}`, true);

  async function read({ chat, day, part }) {
    const g = pickChat(groups, chat);
    if (g === null) return unknown(chat);
    if (typeof day !== "string" || !DAY_ID.test(day.trim())) return answer('Name the day as YYYY-MM-DD, like fetch {"id": "groups:<chat>", "args": {"day": "2026-11-08"}}.', true);
    const d = day.trim();
    const until = midnightOf(dayBefore(d, -1), timeZone);
    const { entries } = await readSpan(ledgerOf(g.key), g.key, { since: midnightOf(d, timeZone), until });
    const { text } = transcriptOf(entries, g.key, timeZone, until);
    if (text === "") return answer(`Nothing was texted in ${g.name} on ${d}.`);
    const parts = Math.max(1, Math.ceil(text.length / READ_DAY_CHARS));
    const n = Number.isSafeInteger(part) && part > 0 ? part : 1;
    if (n > parts) return answer(`${d} has ${parts} part${parts === 1 ? "" : "s"}.`, true);
    const more = n < parts ? `\n\n(Part ${n} of ${parts}. The rest: fetch {"id": "groups:${g.key.slice(0, 12)}", "args": {"day": "${d}", "part": ${n + 1}}}.)` : "";
    return answer(`${g.name}, ${d}, word for word ("You" is you, Tex, in that chat):\n\n${text.slice((n - 1) * READ_DAY_CHARS, n * READ_DAY_CHARS)}${more}`);
  }

  async function summaries({ chat, from, to }) {
    const g = pickChat(groups, chat);
    if (g === null) return unknown(chat);
    const fromDay = typeof from === "string" && DAY_ID.test(from.trim()) ? from.trim() : null;
    const toDay = typeof to === "string" && DAY_ID.test(to.trim()) ? to.trim() : null;
    const kept = (await readSummaries(ledgerOf(g.key), g.key, { before: Number.MAX_SAFE_INTEGER, fromDay, chars: SUMMARY_CHARS })).filter((s) => toDay === null || s.day <= toDay);
    const today = dayOf(now(), timeZone);
    const lines = kept.map((s) => `- ${s.day}: ${s.text.replace(/\s+/g, " ").trim()} (Word for word: fetch {"id": "groups:${g.key.slice(0, 12)}", "args": {"day": "${s.day}"}}.)`);
    const note = `A day is summed up after it ends, so today (${today}) and the days just before it may have no summary yet: read those word for word.`;
    return answer(lines.length === 0 ? `${g.name} has no day summaries${fromDay || toDay ? " in those days" : ""} yet. ${note}` : `${g.name}, each day as summed up after it ended, oldest first:\n${lines.join("\n")}\n\n${note}`);
  }

  async function search({ words, chat, since }) {
    const want = terms(words);
    if (want.length === 0) return answer('Say what to look for: search {"query": "texas trip", "args": {"groups": true}}.', true);
    const targets = chat === undefined || chat === null || String(chat).trim() === "" ? groups : [pickChat(groups, chat)].filter(Boolean);
    if (targets.length === 0) return unknown(chat);
    const sinceAt = typeof since === "string" && DAY_ID.test(since.trim()) ? midnightOf(since.trim(), timeZone) : 0;
    const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
    const found = [];
    let looked = 0;
    for (const g of targets) {
      const { entries } = await readSpan(ledgerOf(g.key), g.key, { since: sinceAt, pages: SEARCH_PAGES }).catch(() => ({ entries: [] }));
      const { events } = transcriptOf(entries, g.key, timeZone);
      looked += events.length;
      for (const e of events) {
        const text = String(e.text ?? "");
        const low = text.toLowerCase();
        const hits = want.filter((w) => low.includes(w)).length;
        if (hits > 0) found.push({ g, e, text, hits });
      }
    }
    const all = found.filter((f) => f.hits === want.length);
    const shown = (all.length > 0 ? all : found).sort((a, b) => b.hits - a.hits || b.e.at - a.e.at).slice(0, MAX_HITS);
    log(JSON.stringify({ event: "tex_group_search", chats: targets.length, texts: looked, hits: found.length, whole: all.length, shown: shown.length }));
    if (shown.length === 0) return answer(`No text in ${targets.length === 1 ? targets[0].name : `their ${targets.length} group chats`} holds ${want.map((w) => `"${w}"`).join(" or ")}${sinceAt ? ` since ${since}` : ""}.`);
    const lines = shown.map(({ g, e, text }) => `- ${g.name} · ${day.format(new Date(e.at))} ${time.format(new Date(e.at))} · ${speaker(e.from)}: ${text.replace(/[\s\u0000-\u001f]+/g, " ").slice(0, HIT_CHARS)} (that day: fetch {"id": "groups:${g.key.slice(0, 12)}", "args": {"day": "${dayOf(e.at, timeZone)}"}})`);
    const partial = all.length === 0 ? ` None held every word, so these hold some of them.` : "";
    return answer(`${shown.length} of ${found.length} matching texts, best first.${partial}\n${lines.join("\n")}`);
  }

  return {
    tool: {
      name: GROUP_CHATS,
      description:
        "Read the group chats they are in with you (read only). " +
        'op "list": the chats. op "search" {words, chat?, since?}: their texts holding the words, in one chat or all, newest and best first, each with its chat, day, time and who said it. ' +
        'op "summaries" {chat, from?, to?}: each day of a chat as summed up after it ended. op "read" {chat, day, part?}: one day of a chat word for word. ' +
        'Name a chat by its id from the list or by its name. For "what happened in X last week" read the summaries for those days and read word for word the recent days that have none.',
      inputSchema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["list", "search", "summaries", "read"] },
          chat: { type: "string", description: "The chat's id from the list, or its name." },
          words: { type: "string", description: "search: the words to look for." },
          since: { type: "string", description: "search: only texts from this day on, YYYY-MM-DD." },
          day: { type: "string", description: "read: the day, YYYY-MM-DD." },
          part: { type: "integer", description: "read: which part of a long day, from 1." },
          from: { type: "string", description: "summaries: the first day, YYYY-MM-DD." },
          to: { type: "string", description: "summaries: the last day, YYYY-MM-DD." },
        },
        required: ["op"],
      },
    },
    call: async (args) => {
      const op = String(args?.op ?? "list");
      const began = Date.now();
      try {
        // Other people's words reach this turn: it is read as untrusted from here on, as a read email is (`privacy/egress.js`).
        if (op !== "list") onRead();
        const result = op === "list" ? answer(listing()) : op === "read" ? await read(args) : op === "summaries" ? await summaries(args) : op === "search" ? await search(args) : answer('op is one of "list", "search", "summaries", "read".', true);
        log(JSON.stringify({ event: "tex_group_chats", op, ok: result.isError !== true, ms: Date.now() - began }));
        return result;
      } catch (error) {
        log(JSON.stringify({ event: "tex_group_chats", op, failed: String(error?.name ?? "error").slice(0, 40), ms: Date.now() - began }));
        return answer("Their group chats could not be read just now.", true);
      }
    },
  };
}

/** The tool and the prompt's list for one turn, or null: `ledgerFor` opens each chat's own ledger in Tex's store. */
export function groupChatsForTurn({ env, groups, timeZone, onRead }) {
  if (!Array.isArray(groups)) return null;
  return { prompt: groupsPrompt(groups), tool: groupChatsTool({ groups, ledgerOf: (key) => ledgerFor(env, { chat: key }), timeZone, onRead }) };
}
