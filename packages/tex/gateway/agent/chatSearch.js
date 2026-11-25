/**
 * SEARCH THIS CHAT'S OWN HISTORY (Dev2, 2026-11-25: "Tex can't search its own chat history", from the 2026-11-12
 * durable-memory audit; `docs/decisions/texting-assistant/chat-search.md`).
 *
 * A turn sees its chat's last days word for word and each older day's summary (`weekHistory.js`), and `read_day` opens
 * one day by its date. Nothing found a line by what was said: "when did I tell you about the flight?" meant guessing a
 * day. `search_chat` looks through every text the chat's ledger keeps for whole words, and can narrow by who said it
 * and by days; each hit names its day, time and speaker, and the `day:` fetch that opens that day.
 *
 * It reads only this chat's own ledger, the one `read_day` reads, with the same grant, so it sees nothing the turn's
 * history could not show. It is offered only when the front door's `ctx` lists the `chatSearch` module (`texConfig.json`),
 * so it ships on the shelf and a Lab draft wires it in.
 *
 * The matching (`findTexts`) is shared with the group search a 1:1 runs over its person's group chats (`groupChats.js`).
 */

import { earlierFromLedger } from "./ledgerHistory.js";
import { speaker } from "./logRender.js";
import { dayOf } from "./jobLog.js";
import { texConfigOf, texStep } from "./texConfig.js";
import { dayBefore, midnightOf, readSpan } from "./weekHistory.js";

/** The module in the front door's `ctx` that offers the tool. */
export const CHAT_SEARCH_MODULE = "chatSearch";
export const SEARCH_CHAT = "search_chat";
/** The most hits one search answers, the words kept of each, and the ledger pages (2,000 entries each) it reads. */
export const MAX_HITS = 40;
export const HIT_CHARS = 400;
export const SEARCH_PAGES = 15;
const DAY_ID = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a step's `ctx` lists the module. */
export const readsChatSearch = (step) => Array.isArray(step?.ctx) && step.ctx.includes(CHAT_SEARCH_MODULE);

/** Whether this turn's config (a Lab draft's in a Lab test chat) offers the search. */
export function chatSearchOn(env) {
  try {
    return readsChatSearch(texStep("fd", texConfigOf(env)));
  } catch {
    return false;
  }
}

/** The words to look for: lower case, deduplicated, one letter dropped, at most 12. */
export const terms = (words) => [...new Set(String(words ?? "").toLowerCase().split(/[^\p{L}\p{N}@']+/u).filter((w) => w.length > 1))].slice(0, 12);

const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The events holding any of `want`, each with how many it holds. Whole words, with a plain ending ("texas's", "trips",
 * "traveling"), never inside another word ("trip" in "tripleseat").
 */
export function findTexts(events, want) {
  const patterns = want.map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(w)}(?:s|es|'s|ing|ed|er)?(?![\\p{L}\\p{N}])`, "u"));
  const found = [];
  for (const e of events) {
    const text = String(e.text ?? "");
    const low = text.toLowerCase();
    const hits = patterns.filter((p) => p.test(low)).length;
    if (hits > 0) found.push({ e, text, hits });
  }
  return found;
}

/**
 * The hits to show: those holding every word when any do, else those holding some; most words, then newest, first, or
 * oldest first when `oldest` ("when did I first…": the newest-first cut at `MAX_HITS` could drop the first one).
 */
export function bestHits(found, want, { oldest = false } = {}) {
  const all = found.filter((f) => f.hits === want.length);
  const shown = (all.length > 0 ? all : found).sort((a, b) => b.hits - a.hits || (oldest ? a.e.at - b.e.at : b.e.at - a.e.at)).slice(0, MAX_HITS);
  return { all, shown };
}

/** What the six's `search` says of it when the turn holds it (`sixTools.js` `searchTool`). */
export const HISTORY_SEARCH_LINE =
  "\n\nThis chat's own history, every text back to its first: search with args { history: true, who, since, until, oldest } when they ask when or whether something was said here, or before asking them what the chat may already hold; each hit names its day, time and who said it.";

/** `search { query, args: { history: true, who, since, until } }` as the `search_chat` call it is. */
export function historySearchCall(call) {
  const { who, since, until, oldest } = call.args;
  return { name: SEARCH_CHAT, args: { words: call.query, ...(who !== undefined ? { who } : {}), ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}), ...(oldest === true ? { oldest: true } : {}) } };
}

const answer = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
const dayArg = (value) => (typeof value === "string" && DAY_ID.test(value.trim()) ? value.trim() : null);

/**
 * `search_chat` for one turn: `ledger` and `chat` as `read_day` gets them (`texEntryPoint/readTheHistory.js`), `grant` the
 * turn's, `timeZone` the chat's.
 */
export function chatSearchTool({ ledger, chat, timeZone = "UTC", grant = null, onRead = () => {}, log = (line) => console.log(line) }) {
  return {
    tool: {
      name: SEARCH_CHAT,
      description:
        "Search this chat's whole history, every text back to its first, for words: when they ask when or whether something was said here " +
        '("when did I tell you about…", "what was that place we talked about", "did she say…"), or before you ask them something the chat may already hold. ' +
        "Whole words, so try the plain word they would have used, and a second search with other words if the first finds nothing. " +
        "Each hit names its day, time and who said it, and the fetch that opens that day word for word.",
      inputSchema: {
        type: "object",
        properties: {
          words: { type: "string", description: "The words to look for." },
          who: { type: "string", description: "Only texts from this person (a name or handle as the chat shows it), or \"you\" for your own." },
          since: { type: "string", description: "Only texts from this day on, YYYY-MM-DD." },
          until: { type: "string", description: "Only texts up to and including this day, YYYY-MM-DD." },
          oldest: { type: "boolean", description: "Oldest first, for when something was first said. Newest first when left out." },
        },
        required: ["words"],
      },
    },
    call: async (args) => {
      const began = Date.now();
      const want = terms(args?.words);
      if (want.length === 0) return answer('Say what to look for: {"words": "atlanta flight"}.', true);
      const sinceDay = dayArg(args?.since);
      const untilDay = dayArg(args?.until);
      const since = sinceDay ? midnightOf(sinceDay, timeZone) : 0;
      const until = untilDay ? midnightOf(dayBefore(untilDay, -1), timeZone) : null;
      const who = typeof args?.who === "string" ? args.who.trim().toLowerCase().replace(/^@/, "") : "";
      try {
        const { entries, whole } = await readSpan(ledger, chat, { since, until, pages: SEARCH_PAGES });
        const view = earlierFromLedger(entries, chat, { before: until ?? Number.MAX_SAFE_INTEGER, chars: Number.MAX_SAFE_INTEGER, fade: false, grant });
        const events = who === "" ? view.events : view.events.filter((e) => speaker(e.from).toLowerCase().replace(/^@/, "").includes(who));
        const found = findTexts(events, want);
        const oldest = args?.oldest === true;
        const { all, shown } = bestHits(found, want, { oldest });
        if (found.length > 0) onRead();
        log(JSON.stringify({ event: "tex_chat_search", entries: entries.length, whole, texts: events.length, hits: found.length, whole_hits: all.length, shown: shown.length, ms: Date.now() - began }));
        const scope = `${who ? ` from ${args.who.trim()}` : ""}${sinceDay ? ` since ${sinceDay}` : ""}${untilDay ? ` up to ${untilDay}` : ""}`;
        const reach = whole ? "" : " (only the newest part of a very long chat was searched: narrow it with since and until for older days)";
        if (shown.length === 0) return answer(`No text in this chat${scope} holds ${want.map((w) => `"${w}"`).join(" or ")}${reach}.`);
        const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" });
        const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
        const lines = shown.map(({ e, text }) => `- ${day.format(new Date(e.at))} ${time.format(new Date(e.at))} · ${speaker(e.from)}: ${text.replace(/[\s\u0000-\u001f]+/g, " ").slice(0, HIT_CHARS)} (that day: fetch {"id": "day:${dayOf(e.at, timeZone)}"})`);
        const partial = all.length === 0 ? " None held every word, so these hold some of them." : "";
        return answer(`${shown.length} of ${found.length} matching texts in this chat${scope}, ${oldest ? "oldest" : "newest"} first.${partial}${reach}\n${lines.join("\n")}`);
      } catch (error) {
        log(JSON.stringify({ event: "tex_chat_search", failed: String(error?.name ?? "error").slice(0, 40), ms: Date.now() - began }));
        return answer("This chat's history could not be searched just now.", true);
      }
    },
  };
}
