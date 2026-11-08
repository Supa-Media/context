/**
 * The person's chat with Tex in a whole-workspace Download as folders, for its
 * owner: the one-to-one chat's ledger, the one record of everything said and
 * done in it, as one JSON file with its manifest first (owner, 2026-11-02;
 * `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 * The server hands it back a page at a time, oldest first
 * (`texLedgerExport.readChatLedgerForExport`, an empty page for anyone else).
 * Each group chat the person is one of the people of rides beside it, one file
 * each (`groupLedgerPath`); the server lists them, and only for the person's
 * own personal workspace (`listChatLedgersForExport`).
 */

import type { ZipEntry } from "./zip";

/** Where the archive keeps it: beside the other data Context keeps, never in one of the person's folders. */
export const LEDGER_PATH = ".context/tex/ledger/texts.json";
/** A group chat's, by its key (64 hex characters, so it is a safe file name). */
export const groupLedgerPath = (key: string) => `.context/tex/ledger/groups/${key}.json`;
const GROUP_KEY = /^[0-9a-f]{64}$/;

/**
 * The read-only history file in a Tex folder (`tex/history.ledger.json`, and a
 * chat home's), a view of the same ledger this archive writes whole
 * (`apps/mcp/src/texStore/historyView.js`). A whole-workspace download leaves it
 * out so the chat leaves once, whole, never a second, cut copy beside it.
 */
// The conversations file beside it is a view of the same chat, so it is left out the same way and opens as its page.
const HISTORY_VIEW = /^tex\/(?:groups\/[^/]+\/)?(?:history|conversations)\.ledger\.json$/;
export const isHistoryView = (path: string) => HISTORY_VIEW.test(path);

/** Pages read at most: fifty entries each, far past any chat. A longer one is said to be short, never left out unsaid. */
export const MOST_LEDGER_PAGES = 20_000;

export interface LedgerPage {
  manifest: string | null;
  lines: readonly string[];
  next: number | null;
}

export interface LedgerOutcome {
  entries: ZipEntry[];
  /** True when the ledger could not be read to its end, so none of it is in the archive. */
  short: boolean;
}

/** The whole ledger as one file, `{"manifest": …, "entries": [ … ]}`; nothing at all when it could not be read to the end. */
export async function collectChatLedger(readPage: (after: number | undefined) => Promise<LedgerPage>, path: string = LEDGER_PATH): Promise<LedgerOutcome> {
  const lines: string[] = [];
  let manifest: string | null = null;
  let after: number | undefined;
  try {
    for (let page = 0; ; page += 1) {
      if (page >= MOST_LEDGER_PAGES) return { entries: [], short: true };
      const answer = await readPage(after);
      manifest = answer.manifest ?? manifest;
      lines.push(...answer.lines);
      if (answer.next === null) break;
      // A page that does not move would be read for ever: said to be short instead.
      if (answer.next === after) return { entries: [], short: true };
      after = answer.next;
    }
  } catch {
    return { entries: [], short: true };
  }
  if (manifest === null) return { entries: [], short: false };
  const text = `{"manifest":${manifest},"entries":[\n${lines.join(",\n")}\n]}\n`;
  return { entries: [{ path, bytes: new TextEncoder().encode(text) }], short: false };
}

/**
 * The person's chat with Tex and each of their group chats with Tex, each its
 * own file; `short` when any of them, or the list of groups, could not be read
 * to the end (that one is left out, the rest kept).
 */
export async function collectChatLedgers(
  listGroups: () => Promise<{ chats: readonly string[] }>,
  readPage: (chat: string | undefined, after: number | undefined) => Promise<LedgerPage>,
): Promise<LedgerOutcome> {
  const own = await collectChatLedger((after) => readPage(undefined, after));
  let groups: readonly string[];
  try {
    groups = (await listGroups()).chats.filter((key) => GROUP_KEY.test(key));
  } catch {
    return { entries: own.entries, short: true };
  }
  const entries = [...own.entries];
  let short = own.short;
  for (const key of groups) {
    const group = await collectChatLedger((after) => readPage(key, after), groupLedgerPath(key));
    entries.push(...group.entries);
    short ||= group.short;
  }
  return { entries, short };
}
