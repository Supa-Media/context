/**
 * A MOVED NOTE LEAVES A FORWARDING ADDRESS — `src/forwarding.js`.
 *
 * `links.js` already rewrites every reference *inside* the bucket when
 * something moves. What it cannot reach is a reference somebody else is
 * holding: a share link already pasted into a thread, a deep link in a chat
 * log, a path an agent remembered. Those are not in any file we can rewrite,
 * so the only thing that can save them is the bucket remembering where the
 * note went.
 *
 * That is this ledger. It is small, it is plumbing, and it is **not** a
 * reference index: nothing here stores who points at what. It stores where
 * things went, which is the one fact a holder of a stale path needs.
 *
 * Four properties make it safe enough to consult automatically:
 *
 * 1. **A folder move is one entry, not one per file.** A nine-thousand-note
 *    folder rename must not write nine thousand rows, so a folder entry
 *    forwards a whole subtree by prefix — and matches on a segment boundary,
 *    so `2-areas-old/x.md` is never carried by a rule written for `2-areas`.
 * 2. **Chains collapse as they are recorded.** a→b then b→c leaves a→c, so a
 *    path that has moved five times resolves in one hop and a cycle cannot be
 *    built.
 * 3. **The most specific rule wins, never the newest.** An exact entry outranks
 *    a folder entry, because a note moved out of a folder that later moved has
 *    two answers and only one is where the note is — and between two folder
 *    rules that both contain a path, the longer prefix wins for the same
 *    reason.
 * 4. **It is bounded and it degrades honestly.** Past the cap the oldest
 *    entries are dropped, so the ledger cannot grow without limit and an old
 *    forwarding address expires rather than the file becoming unreadable.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite.
 *
 *   exact entries no longer outranking folder entries                          3
 *   folder matching by `startsWith` rather than on a segment boundary          2
 *   `collapse` dropped from `addForwarding` (chains left uncollapsed)          2
 *   folder rules resolved by recency rather than by longest prefix             1
 *   the self-entry drop removed (a cycle becomes a stuck forward)              1
 *
 * The fourth row is the one this discipline was worth running for. The first
 * attempt at it — scanning the entries oldest-first instead of newest-first —
 * failed **nothing**, because `addForwarding` already supersedes an older rule
 * for the same path, so a scan direction that looked load-bearing was not.
 * Chasing that zero found the case where order genuinely decides — a subfolder
 * that moved out before its parent was renamed — and found the implementation
 * answering it by recency, which is wrong. The check exists because a sabotage
 * that failed nothing was investigated rather than deleted. One FAIL is thin
 * cover, and it is the honest number: exactly one check can tell the two rules
 * apart, because a bucket only reaches the case when a subfolder is moved out
 * before its parent is renamed.
 */

import {
  FORWARDING_ENTRY_CAP,
  FORWARDING_PATH,
  addForwarding,
  forwardPath,
  parseForwarding,
  serializeForwarding,
} from "../src/forwarding.js";

const EMPTY = { version: 1, entries: [] };

/** Record one batch of moves against a state, at a fixed clock. */
function record(state, moves, at = 1_000) {
  return addForwarding(state, moves, { now: at });
}

export async function runForwardingChecks(check) {
  /* -- the path it lives at ----------------------------------------------- */

  check(
    "the ledger is plumbing under .context/, never a note",
    FORWARDING_PATH.startsWith(".context/") && !FORWARDING_PATH.endsWith(".md")
  );

  /* -- (1) a note forwards ------------------------------------------------ */

  {
    const state = record(EMPTY, [
      { from: "1-projects/foo.md", to: "4-archive/1-projects/foo.md", kind: "note" },
    ]);
    check(
      "a moved note forwards to where it went",
      forwardPath(state, "1-projects/foo.md") === "4-archive/1-projects/foo.md"
    );
    check(
      "a path nothing has moved is returned unchanged",
      forwardPath(state, "1-projects/bar.md") === "1-projects/bar.md"
    );
    check(
      "the destination forwards to itself rather than looping",
      forwardPath(state, "4-archive/1-projects/foo.md") === "4-archive/1-projects/foo.md"
    );
  }

  /* -- (1b) a folder forwards a whole subtree ----------------------------- */

  {
    const state = record(EMPTY, [{ from: "2-areas", to: "5-areas", kind: "folder" }]);
    check(
      "a folder move is one entry, not one per file",
      state.entries.length === 1
    );
    check(
      "a note under a moved folder forwards by prefix",
      forwardPath(state, "2-areas/apps/context/overview.md") ===
        "5-areas/apps/context/overview.md"
    );
    check(
      "the folder itself forwards",
      forwardPath(state, "2-areas") === "5-areas"
    );
    check(
      "a sibling whose name merely starts the same is not carried",
      forwardPath(state, "2-areas-old/x.md") === "2-areas-old/x.md"
    );
    check(
      "a deeper folder rename carries every level beneath it",
      forwardPath(
        record(EMPTY, [{ from: "2-areas/apps", to: "2-areas/tools", kind: "folder" }]),
        "2-areas/apps/context/notes/deep.md"
      ) === "2-areas/tools/context/notes/deep.md"
    );
  }

  /* -- (2) chains collapse ------------------------------------------------ */

  {
    let state = record(EMPTY, [{ from: "a.md", to: "b.md", kind: "note" }], 1);
    state = record(state, [{ from: "b.md", to: "c.md", kind: "note" }], 2);
    check(
      "a chain resolves to the end of the chain",
      forwardPath(state, "a.md") === "c.md"
    );
    check(
      "and it was collapsed when it was recorded, not walked at resolve time",
      state.entries.some((entry) => entry.from === "a.md" && entry.to === "c.md")
    );
  }

  {
    let state = record(EMPTY, [{ from: "a.md", to: "b.md", kind: "note" }], 1);
    state = record(state, [{ from: "b.md", to: "a.md", kind: "note" }], 2);
    check(
      "a note moved back where it started forwards nowhere, not in a circle",
      forwardPath(state, "a.md") === "a.md" && forwardPath(state, "b.md") === "a.md"
    );
    check(
      "and the entry that would have been a self-loop is dropped",
      state.entries.every((entry) => entry.from !== entry.to)
    );
  }

  /* -- (3) an exact entry outranks a folder entry ------------------------- */

  {
    let state = record(EMPTY, [{ from: "2-areas", to: "5-areas", kind: "folder" }], 1);
    state = record(
      state,
      [{ from: "2-areas/apps/x.md", to: "1-projects/x.md", kind: "note" }],
      2
    );
    check(
      "the note that left the folder before it moved forwards to where the note is",
      forwardPath(state, "2-areas/apps/x.md") === "1-projects/x.md"
    );
    check(
      "and its neighbours still follow the folder",
      forwardPath(state, "2-areas/apps/y.md") === "5-areas/apps/y.md"
    );
  }

  {
    // Two folder rules, both containing the path, and the newer one is the
    // wrong answer. `2-areas/apps` left for `1-projects/apps` first; `2-areas`
    // was renamed afterwards. The rule that says more about the path is the
    // older one, so recency cannot be what decides this.
    let state = record(
      EMPTY,
      [{ from: "2-areas/apps", to: "1-projects/apps", kind: "folder" }],
      1
    );
    state = record(state, [{ from: "2-areas", to: "5-areas", kind: "folder" }], 2);
    check(
      "the more specific folder rule wins over the newer one",
      forwardPath(state, "2-areas/apps/context/overview.md") ===
        "1-projects/apps/context/overview.md"
    );
    check(
      "and a sibling the specific rule does not cover still follows the rename",
      forwardPath(state, "2-areas/health/log.md") === "5-areas/health/log.md"
    );
  }

  {
    // The other order: the folder moves *after* a note left it. The note's own
    // entry still wins, because the folder rule never applied to it.
    let state = record(
      EMPTY,
      [{ from: "2-areas/apps/x.md", to: "1-projects/x.md", kind: "note" }],
      1
    );
    state = record(state, [{ from: "2-areas", to: "5-areas", kind: "folder" }], 2);
    check(
      "a later folder move does not recapture a note that had already left",
      forwardPath(state, "2-areas/apps/x.md") === "1-projects/x.md"
    );
  }

  /* -- (4) bounded, and honest when it overflows -------------------------- */

  {
    let state = EMPTY;
    for (let index = 0; index < FORWARDING_ENTRY_CAP + 50; index += 1) {
      state = record(state, [{ from: `old/${index}.md`, to: `new/${index}.md`, kind: "note" }], index);
    }
    check(
      "the ledger is capped rather than growing without limit",
      state.entries.length === FORWARDING_ENTRY_CAP
    );
    check(
      "the newest forwarding addresses are the ones kept",
      forwardPath(state, `old/${FORWARDING_ENTRY_CAP + 49}.md`) ===
        `new/${FORWARDING_ENTRY_CAP + 49}.md`
    );
    check(
      "and the oldest expired rather than corrupting the file",
      forwardPath(state, "old/0.md") === "old/0.md"
    );
  }

  /* -- parsing is total --------------------------------------------------- */

  {
    check(
      "a round trip through JSON preserves what was recorded",
      forwardPath(
        parseForwarding(
          serializeForwarding(record(EMPTY, [{ from: "a.md", to: "b.md", kind: "note" }]))
        ),
        "a.md"
      ) === "b.md"
    );
    check(
      "an absent ledger parses to an empty one",
      parseForwarding(null).entries.length === 0 && parseForwarding("").entries.length === 0
    );
    check(
      "a corrupt ledger parses to an empty one rather than throwing",
      parseForwarding("{not json").entries.length === 0 &&
        parseForwarding('{"version":1,"entries":"nope"}').entries.length === 0
    );
    check(
      "an entry missing a half is discarded, and its neighbours survive",
      (() => {
        const parsed = parseForwarding(
          JSON.stringify({
            version: 1,
            entries: [
              { from: "a.md", kind: "note", at: 1 },
              { from: "c.md", to: "d.md", kind: "note", at: 2 },
              { from: "", to: "e.md", kind: "note", at: 3 },
            ],
          })
        );
        return parsed.entries.length === 1 && forwardPath(parsed, "c.md") === "d.md";
      })()
    );
    check(
      "a future version is not guessed at",
      parseForwarding(JSON.stringify({ version: 99, entries: [{ from: "a.md", to: "b.md" }] }))
        .entries.length === 0
    );
  }

  /* -- a path is never forwarded outside the bucket ----------------------- */

  {
    const state = parseForwarding(
      JSON.stringify({
        version: 1,
        entries: [{ from: "a.md", to: "../../etc/passwd", kind: "note", at: 1 }],
      })
    );
    check(
      "an entry that climbs out of the bucket is discarded on read",
      state.entries.length === 0 && forwardPath(state, "a.md") === "a.md"
    );
  }
}
