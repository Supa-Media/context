/**
 * The person's chat with Tex in a whole-workspace Download as folders, for its
 * owner: the one-to-one chat's ledger, the one record of everything said and
 * done in it, as one JSON file with its manifest first (owner, 2026-11-02;
 * `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 * The server hands it back a page at a time, oldest first
 * (`texLedgerExport.readChatLedgerForExport`, an empty page for anyone else).
 */

import type { ZipEntry } from "./zip";

/** Where the archive keeps it: beside the other data Context keeps, never in one of the person's folders. */
export const LEDGER_PATH = ".context/tex/ledger/texts.json";

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
export async function collectChatLedger(readPage: (after: number | undefined) => Promise<LedgerPage>): Promise<LedgerOutcome> {
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
  return { entries: [{ path: LEDGER_PATH, bytes: new TextEncoder().encode(text) }], short: false };
}
