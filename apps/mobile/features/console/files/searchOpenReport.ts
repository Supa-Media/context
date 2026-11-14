/**
 * Pairs one search on this device with its first open and with the next search, for the search quality log
 * (`apps/convex/functions/searchTimings.ts`). The app sends no identity: the pairing is the row id the control
 * plane returned for the search, kept here, and the server checks the caller is a member of that row's workspace.
 *
 * - A search starts: `searchStarted(now, query)` returns the callback that receives the row id once the answer is
 *   recorded (`reportScreen`). If the previous search is less than 60 s old and nothing in it was opened, it was
 *   followed by another: when the new query only extends or trims the old one, the person was still typing and the
 *   old row is taken out of the counts (`reportAgain` with `refined`); otherwise it is re-searched (`reportAgain`).
 *   A previous search whose row id has not arrived yet is settled when it does. The query never leaves the device.
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
  /**
   * The search `row` names was followed by another within 60 s, with nothing opened. `refined`: the next one only
   * extended or trimmed its query, so it was one search still being typed, not a search of its own.
   */
  reportAgain: (row: string, refined: boolean) => unknown;
}

export interface SearchOpenReporter {
  /**
   * A search has started. The returned callback takes the id of the row its answer was recorded as, or null
   * when it was not (a refusal). Only the latest search is open to a tap.
   */
  searchStarted: (now: number, query?: string) => (row: string | null) => void;
  /** A result was opened at this 1-based position in the list shown. */
  opened: (position: number) => void;
}

interface Search {
  at: number;
  query: string | null;
  row: string | null;
  opened: boolean;
  position: number | null;
  /** Set when the next search came within the window with nothing opened here: how this one ended. */
  followed: "again" | "refined" | null;
}

const normal = (query: string | undefined): string | null =>
  typeof query === "string" ? query.trim().toLowerCase().replace(/\s+/g, " ") : null;

/** One query only extends or trims the other: the same search, still being typed. */
export function refines(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return false;
  return before.startsWith(after) || after.startsWith(before);
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
    searchStarted: (now, query) => {
      const previous = latest;
      const asked = normal(query);
      if (previous !== null && !previous.opened && previous.followed === null && now - previous.at <= AGAIN_WINDOW_MS) {
        previous.followed = refines(previous.query, asked) ? "refined" : "again";
        if (previous.row !== null) {
          const row = previous.row;
          const refined = previous.followed === "refined";
          send(() => ports.reportAgain(row, refined));
        }
      }
      const search: Search = { at: now, query: asked, row: null, opened: false, position: null, followed: null };
      latest = search;
      return (row) => {
        search.row = row;
        if (row === null) return;
        if (search.position !== null) send(() => ports.reportOpen(row, search.position as number));
        else if (search.followed !== null) {
          const refined = search.followed === "refined";
          send(() => ports.reportAgain(row, refined));
        }
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
