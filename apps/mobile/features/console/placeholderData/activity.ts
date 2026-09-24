/**
 * What the demo context's `activity.md` says, once.
 *
 * Both the rendered file in `NOTE_BODIES` and the console's own activity view
 * are built from this array, so the page can never show a row the file does
 * not contain. One row carries an agent's summary and one does not, because
 * those are the two shapes a row has and a demo that shows one of them is a
 * demo of half the feature.
 *
 * Dated to the rest of the demo's world — `1-projects/context-lc.md` is
 * `updated: 2026-08-26` — rather than to `Date.now()`, so the page reads as a
 * context somebody worked in on a particular day rather than one that mints
 * fresh history every time the marketing page is loaded.
 */
export const DEMO_ACTIVITY = [
  {
    at: "2026-08-26T09:12:00.000Z",
    kind: "added",
    paths: ["1-projects/dc-chapter.md"],
    n: 1,
    vis: "team" as const,
    by: "@seyi",
    via: "Claude",
    note: "notes from the chapter call",
  },
  {
    at: "2026-08-26T08:40:00.000Z",
    kind: "revised",
    paths: ["1-projects/context-lc.md"],
    n: 1,
    vis: "team" as const,
    by: "@seyi",
    via: null,
    note: null,
  },
];
