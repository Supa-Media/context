/**
 * Reports which search result a person opened, once per search.
 *
 * A search arms the reporter; the first result opened after it is reported
 * with its 1-based position in the list shown, and the reporter disarms until
 * the next search. A second open of the same search reports nothing, so the
 * position histogram counts what a person chose, not how often they clicked.
 *
 * The report is fire and forget: a failure is swallowed, because a timing
 * must never be the reason an open fails.
 */
export interface SearchOpenReporter {
  /** A new search has started: the next open is reported. */
  rearm: () => void;
  /** A result was opened at this 1-based position. */
  opened: (position: number) => void;
}

export function createSearchOpenReporter(
  report: (position: number) => unknown,
): SearchOpenReporter {
  let armed = true;
  return {
    rearm: () => {
      armed = true;
    },
    opened: (position) => {
      if (!armed) return;
      armed = false;
      try {
        void Promise.resolve(report(position)).catch(() => {});
      } catch {
        // Never the reason an open fails.
      }
    },
  };
}
