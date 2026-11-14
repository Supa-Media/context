/**
 * Pairs one search on this device with its first open and with the next search, for the search quality log
 * (`apps/convex/functions/searchTimings.ts`). The app sends no identity: the pairing is the row id the control
 * plane returned for the search, kept here, and the server checks the caller is a member of that row's workspace.
 *
 * - A search starts: `searchStarted(now)` returns the callback that receives the row id once the answer is
 *   recorded (`reportScreen`). If the previous search was answered, is less than 60 s old and nothing in it was
 *   opened, it is re-searched: `reportAgain` is sent for that previous row.
 * - A result is opened at a 1-based position: the first open of the latest search is reported with
 *   `reportOpen`. A second open of the same search reports nothing, so the histogram counts what a person chose.
 *   A tap that comes before the row id arrives is held and sent with it.
 *
 * Fire and forget: a failed report is swallowed, because a timing must never fail a search or an open.
 */

export const AGAIN_WINDOW_MS = 60_000;

export interface SearchOpenPorts {
  /** The first open of the search `row` names, at this 1-based place. */
  reportOpen: (row: string, position: number) => unknown;
  /** The search `row` names was followed by another within 60 s, with nothing opened. */
  reportAgain: (row: string) => unknown;
}

export interface SearchOpenReporter {
  /**
   * A search has started. The returned callback takes the id of the row its answer was recorded as, or null
   * when it was not (a refusal). Only the latest search is open to a tap.
   */
  searchStarted: (now: number) => (row: string | null) => void;
  /** A result was opened at this 1-based position in the list shown. */
  opened: (position: number) => void;
}

interface Search {
  at: number;
  row: string | null;
  opened: boolean;
  position: number | null;
}

function send(call: () => unknown): void {
  try {
    void Promise.resolve(call()).catch(() => {});
  } catch {
    // Never the reason a search or an open fails.
  }
}

export function createSearchOpenReporter(ports: SearchOpenPorts): SearchOpenReporter {
  let latest: Search | null = null;
  return {
    searchStarted: (now) => {
      const previous = latest;
      if (previous !== null && previous.row !== null && !previous.opened && now - previous.at <= AGAIN_WINDOW_MS) {
        const row = previous.row;
        send(() => ports.reportAgain(row));
      }
      const search: Search = { at: now, row: null, opened: false, position: null };
      latest = search;
      return (row) => {
        search.row = row;
        if (row !== null && search.position !== null) send(() => ports.reportOpen(row, search.position as number));
      };
    },
    opened: (position) => {
      const search = latest;
      if (search === null || search.opened) return;
      search.opened = true;
      search.position = position;
      if (search.row !== null) {
        const row = search.row;
        send(() => ports.reportOpen(row, position));
      }
    },
  };
}
