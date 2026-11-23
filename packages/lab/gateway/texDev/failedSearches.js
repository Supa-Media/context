/**
 * Tex's note searches that failed, read from a chat's history in one call: a search Tex ran again within two minutes
 * with no hit opened, one it gave up on (nothing opened, not searched again), and one whose first opened hit was not
 * the first. Each comes with its top hits and the notes Tex read later in that turn, which is usually the answer.
 * This is the source of the real search set (`packages/bench/benchmarks/search-real/`): before it, mining meant paging
 * `entries` a hundred at a time and working the turns out by hand.
 */

import { ledgerFor } from "../fromGateway/agent_ledger.js";
import { openChat } from "./probe.js";

export const AGAIN_MS = 120_000;
const DAY_MS = 86_400_000;
const READ_LIMIT = 5_000;
const MAX_READS = 4;
const HITS_SHOWN = 5;
const OUTCOMES = new Set(["again", "gave_up", "opened_low"]);

/** A note search, as its logged name or Tex's `search` with no mail, web or texts asked. */
function isNoteSearch(e) {
  if (e.name === "search_notes") return true;
  if (e.name !== "search") return false;
  const more = e.args?.args ?? {};
  return !(more.email || more.web || more.texts);
}

/** The note paths a tool call read. */
export function readsOf(e) {
  const a = e.args ?? {};
  if (e.name === "read_note") return typeof a.path === "string" ? [a.path] : [];
  if (e.name === "read_notes") return Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === "string") : [];
  if (e.name === "fetch") return [a.id, ...(Array.isArray(a.ids) ? a.ids : [])].filter((p) => typeof p === "string" && !/^(email|https?):/.test(p));
  return [];
}

/** The ranked note paths in a search answer: each hit is a line of its own, not indented. */
export function hitsOf(result) {
  if (typeof result !== "string") return [];
  return result.split("\n").filter((line) => /^(@[\w.-]+\/)?[^\s@][^\n]*\.[A-Za-z0-9]{1,6}$/.test(line.trim()) && !/^\s/.test(line)).map((line) => line.trim());
}

const bare = (path) => String(path).replace(/^@[\w.-]+\//, "");
const named = (path) => /^@[\w.-]+\//.test(String(path));

/** A read's place in the hits: its exact path first; a path with no workspace matches a hit by the rest of it. */
function rankOf(hits, read) {
  const exact = hits.indexOf(read);
  if (exact >= 0) return exact;
  return hits.findIndex((hit) => (named(read) && named(hit) ? false : bare(hit) === bare(read)));
}

/** Every note search in these entries (oldest first), with what happened after it. */
export function searchOutcomes(entries) {
  const byTurn = new Map();
  for (const e of entries) {
    if (e?.kind !== "tool" || typeof e.turn !== "string") continue;
    if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
    byTurn.get(e.turn).push(e);
  }
  const out = [];
  for (const [turn, list] of byTurn) {
    list.forEach((e, i) => {
      if (!isNoteSearch(e) || e.ok === false) return;
      const query = e.args?.query;
      if (typeof query !== "string" || query.trim() === "") return;
      // Another workspace's answer is never kept (`ledger.js` toolEntry): its hits are unknown, not none.
      if (e.withheld) return void out.push({ at: e.at, turn, query, outcome: "withheld" });
      const hits = hitsOf(e.result);
      const after = list.slice(i + 1);
      let opened = null;
      let next = null;
      for (const f of after) {
        if (isNoteSearch(f)) {
          // Calls of one round share its time (`turn.js` runOne): a search beside this one is not a retry of it.
          if (f.at === e.at) continue;
          if (f.at - e.at <= AGAIN_MS) next = f;
          break;
        }
        for (const path of readsOf(f)) {
          const rank = rankOf(hits, path);
          if (rank >= 0) {
            opened = { rank: rank + 1, path: hits[rank] };
            break;
          }
        }
        if (opened) break;
      }
      const read = [...new Set(after.flatMap(readsOf))].filter((p) => !bare(p).startsWith("tex/"));
      const outcome = opened ? (opened.rank === 1 ? "opened_first" : "opened_low") : next ? "again" : "gave_up";
      out.push({
        at: e.at,
        turn,
        query,
        outcome,
        ...(opened ? { openedRank: opened.rank } : {}),
        ...(outcome === "again" ? { next: next.args?.query ?? null } : {}),
        hits: hits.slice(0, HITS_SHOWN),
        hitCount: hits.length,
        read: read.slice(0, HITS_SHOWN).map((path) => ({ path, rank: rankOf(hits, path) + 1 || null })),
      });
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * `failed_searches { chat?, days?, outcome?, limit? }`: the chat's failed note searches, newest first, and how every
 * note search in the window went. A search that opened its first hit is counted, never listed.
 */
export async function failedSearchesOf(env, page, { chat: key, days, outcome, limit } = {}, { ledgerOf = ledgerFor, now = Date.now() } = {}) {
  if (outcome !== undefined && !OUTCOMES.has(outcome)) return { error: 'outcome is "again", "gave_up" or "opened_low", or left out for all three.' };
  const { chat, place, ledger } = openChat(env, page, key, ledgerOf);
  const window = Math.min(30, Math.max(1, Number.isInteger(days) ? days : 7));
  if (ledger === null) return { chat: chat.key, days: window, counts: {}, searches: [] };
  const since = now - window * DAY_MS;
  const entries = [];
  let before = Number.MAX_SAFE_INTEGER;
  let complete = true;
  for (let i = 0; i < MAX_READS; i++) {
    const read = await ledger.read(place.name, { kinds: ["tool"], before, since, limit: READ_LIMIT });
    entries.push(...(read.entries ?? []));
    if (!Number.isSafeInteger(read.before)) break;
    before = read.before;
    if (i === MAX_READS - 1) complete = false;
  }
  entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const all = searchOutcomes(entries);
  const counts = { searches: all.length };
  for (const s of all) counts[s.outcome] = (counts[s.outcome] ?? 0) + 1;
  const shown = Math.min(200, Math.max(1, Number.isInteger(limit) ? limit : 50));
  const failed = all.filter((s) => (outcome ? s.outcome === outcome : s.outcome !== "opened_first" && s.outcome !== "withheld"));
  return {
    chat: chat.key,
    days: window,
    ...(complete ? {} : { partial: `only the newest ${MAX_READS * READ_LIMIT} tool calls were read; ask fewer days for the rest` }),
    counts,
    searches: failed.slice(0, shown).map((s) => ({ ...s, at: new Date(s.at).toISOString() })),
    ...(failed.length > shown ? { more: failed.length - shown } : {}),
    note: "Real searches: rewrite one before it becomes a bench case, never verbatim (packages/bench/benchmarks/search-real/).",
  };
}
