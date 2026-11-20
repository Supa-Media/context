/**
 * A GROUP CHAT'S MEMORY PAGE COPIED INTO ITS LEDGER, AND THE LEDGER READ AS
 * THE CHAT'S HISTORY FROM THEN ON (Dev, 2026-11-02, on a decision card:
 * "Retire it, one copy"; `docs/decisions/texting-assistant/chat-ledger.md`,
 * "Retiring the old copies").
 *
 * A group's memory page (`history.md` in its home, `groupMemoryNote.js`) was
 * the copy every group turn read and added to, beside the chat's ledger,
 * which holds the same texts. Its exchanges from before the ledger began are
 * copied in once, oldest first, before everything the ledger holds, and a
 * mark (`GROUP_PAGE_COPIED`) says so. From then on a group turn reads its
 * history rebuilt from the ledger (`groupLedgerHistory.js`), no turn
 * writes the page, and the page can go to the trash.
 *
 * Only what the ledger does not already hold is copied: the page's newest
 * exchanges are usually in the ledger too, so copying stops at the first of
 * Tex's answers the ledger holds. Every copied entry's id is a hash of what it
 * holds, so a copy cut short and run again keeps one copy of each.
 */

import { GROUP_BACKFILLED } from "./ledgerBackfill.js";

/** The mark a group's ledger carries once its memory page is copied in. */
export const GROUP_PAGE_COPIED = "pagecopiedv1";
/** The most entries one prepend takes (`texStore/ledger.js` `MAX_APPEND`), with room. */
const PREPEND_BATCH = 90;
/** How far into the ledger, oldest first, an answer from the page is looked for. */
const OVERLAP_READ = 2_000;

const key = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
/** Tex's answer as the ledger may hold it, its first words: one answer can be several texts there, joined on the page. */
const opening = (text) => key(text).slice(0, 60);

async function idOf(prefix, ...parts) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return `${prefix}${[...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether the group's page is copied in: its mark is among the ledger's first notes. False when it can't be read. */
export async function groupPageCopied(ledger, chat) {
  if (typeof ledger?.read !== "function") return false;
  try {
    const read = await ledger.read(chat, { kinds: ["note"], limit: 20 });
    return (read?.entries ?? []).some((entry) => entry?.id === GROUP_PAGE_COPIED);
  } catch {
    return false;
  }
}

/**
 * The page's turns (`parseGroupNote`, oldest first) as ledger entries, ending before the first of Tex's answers the
 * ledger already holds (`held`, its answers' words), timed just before `before` (the ledger's oldest entry).
 */
export async function pageEntries(turns, { held = new Set(), before = Date.now() } = {}) {
  const pairs = [];
  for (let i = 0; i + 1 < turns.length; i += 1) {
    const [asked, said] = [turns[i], turns[i + 1]];
    if (asked?.role !== "user" || said?.role !== "assistant") continue;
    if (held.has(opening(said.text))) break;
    pairs.push([asked, said]);
    i += 1;
  }
  const entries = [];
  const seen = new Map();
  let at = before - pairs.length * 4 - 4;
  for (const [asked, said] of pairs) {
    const once = `${key(asked.text)}\u0000${key(said.text)}`;
    const nth = (seen.get(once) ?? 0) + 1;
    seen.set(once, nth);
    const turn = await idOf("pg", asked.text, said.text, String(nth));
    const base = { v: 1, backfill: "page" };
    entries.push({ ...base, id: `${turn}q`, at: (at += 1), kind: "text", from: { kind: "person" }, text: String(asked.text) });
    for (const name of Array.isArray(said.tools) ? said.tools : []) entries.push({ ...base, id: await idOf("pt", turn, name), at, kind: "tool", turn, name, ok: true, ms: 0 });
    entries.push({ ...base, id: `${turn}a`, at: (at += 1), kind: "text", from: { kind: "tex" }, turn, text: String(said.text), delivered: true });
    entries.push({ ...base, id: `${turn}r`, at: (at += 1), kind: "reply", turn, text: String(said.text), clean: said.tainted !== true, ...(Array.isArray(said.sources) && said.sources.length > 0 ? { sources: said.sources } : {}) });
    at += 1;
  }
  return entries;
}

/**
 * Copy the page's turns into the group's ledger once, then mark it. Only after the chat's old event log is in (its
 * `GROUP_BACKFILLED` mark first), so the page goes before all of it. `{state}`: `done` (already), `copied`, `waiting`
 * (the log is not in yet, unless `withoutLog`), `none` (no ledger). Throws when the ledger can't be written: the page is then still read.
 */
export async function copyGroupPageIn(ledger, chat, turns, { dryRun = false, withoutLog = false } = {}) {
  if (typeof ledger?.prepend !== "function" || typeof ledger?.oldest !== "function") return { state: "none", entries: 0 };
  if (await groupPageCopied(ledger, chat)) return { state: "done", entries: 0 };
  const oldest = await ledger.oldest(chat);
  // `withoutLog`: the chat's old log was looked for everywhere and is in none of them, so the page goes in without it
  // (Dev, 2026-11-03, on a decision card: "Copy the page in now", for Crystal Care Agency's).
  if (!withoutLog && oldest !== null && oldest !== undefined && oldest.id !== GROUP_BACKFILLED) return { state: "waiting", entries: 0 };
  const read = await ledger.read(chat, { kinds: ["text"], limit: OVERLAP_READ });
  const held = new Set((read?.entries ?? []).filter((entry) => entry?.from?.kind === "tex").map((entry) => opening(entry.text)));
  const entries = await pageEntries(Array.isArray(turns) ? turns : [], { held, before: oldest?.at ?? Date.now() });
  if (dryRun) return { state: "would", entries: entries.length };
  const first = entries[0]?.at ?? oldest?.at ?? Date.now();
  entries.unshift({ v: 1, id: GROUP_PAGE_COPIED, at: Math.max(1, first - 1), kind: "note", text: "(The chat's memory page was copied in here.)", backfill: "mark" });
  let added = 0;
  for (let end = entries.length; end > 0; end -= PREPEND_BATCH) added += (await ledger.prepend(chat, entries.slice(Math.max(0, end - PREPEND_BATCH), end))).added ?? 0;
  return { state: "copied", entries: added };
}
