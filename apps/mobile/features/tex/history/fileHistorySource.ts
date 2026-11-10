/**
 * A history file's text as a Tex page source, for a history someone shared with
 * you (Dev2, 2026-11-10: "Open it as Tex's chat"). Pure.
 *
 * Your own history reads through your own Tex page routes (`HistoryFileView`),
 * which refuse a chat that is not yours. A shared one comes from the grant's
 * read instead (`shares.readGrantedNote`): the file's JSON as the chat's Tex
 * object renders it (`apps/mcp/src/texStore/historyView.js`,
 * `{manifest, view, entries}`, oldest first). This answers `ledger` from that
 * text the way the gateway's raw view answers it (`http/texPage/ledger.js`):
 * filtered by kind, day and job, newest first, a page at a time. Everything
 * else a Tex page asks for is not this reader's, and nothing is live: the file
 * is the chat as it was when it was opened.
 */

import { dayKey } from "./historyLines";
import type { Read, TexPageSource } from "../page/texPageSource";
import type { LedgerEntry, LedgerManifest, LedgerQuery } from "../page/texPageTypes";
import { readLedgerPage } from "../page/texPageLedger";

/** Entries one page answers, as the gateway's raw view does (`RAW_PAGE`). */
export const FILE_PAGE = 100;

/** The file's manifest and entries, oldest first, or null when the text is not a history file. */
export function readHistoryFile(text: string): { manifest: LedgerManifest | null; entries: LedgerEntry[] } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || !Array.isArray((body as { entries?: unknown }).entries)) return null;
  const page = readLedgerPage(body);
  return page === null ? null : { manifest: page.manifest, entries: page.entries };
}

function matches(e: LedgerEntry, query: LedgerQuery): boolean {
  if (query.kinds !== undefined && query.kinds.length > 0 && !(query.kinds as string[]).includes(e.kind)) return false;
  if (query.day !== undefined && dayKey(e.at) !== query.day) return false;
  if (query.job !== undefined) return e.jobId === query.job || (e.kind === "job" && e.job === query.job);
  if (query.jobs === false && e.jobId !== undefined && e.jobId !== null) return false;
  return true;
}

/** A source that reads one history file's text, and nothing else. */
export function fileHistorySource(text: string): TexPageSource {
  const file = readHistoryFile(text);
  const notYours = async () => ({ kind: "notYours" as const });
  return {
    overview: notYours,
    job: notYours,
    list: notYours,
    act: async () => ({ ok: false, error: "read_only" }),
    sees: notYours,
    machines: notYours,
    live: () => null,
    async ledger(_chat, query): Promise<Read<{ manifest: LedgerManifest | null; entries: LedgerEntry[]; older?: number }>> {
      if (file === null) return { kind: "failed" };
      // A position in the file stands for the ledger's `seq`: `before` names the oldest entry already shown.
      const before = query.before ?? Number.MAX_SAFE_INTEGER;
      const kept: number[] = [];
      for (let i = Math.min(before, file.entries.length) - 1; i >= 0 && kept.length <= FILE_PAGE; i -= 1) {
        if (matches(file.entries[i]!, query)) kept.push(i);
      }
      const page = kept.slice(0, FILE_PAGE);
      const older = kept.length > FILE_PAGE ? page[page.length - 1] : undefined;
      return { kind: "ok", value: { manifest: file.manifest, entries: page.map((i) => file.entries[i]!), ...(older !== undefined ? { older } : {}) } };
    },
  };
}
