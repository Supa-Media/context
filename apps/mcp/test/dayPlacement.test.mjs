// A day that already has a note keeps it; only a new day is filed under its month.
//
// The dated tree is forward-only (`src/communications/dayPlacement.js`), and
// forward-only has exactly one way to go wrong: a day is regenerated on every
// pass, so a day that exists flat and is next written nested does not continue
// — it exists twice, under one date, in two places that both parse as that
// day. `list_channel_days` would list it twice, search would index both, and
// the Contact page linking the morning's mail would point at the copy that
// stopped growing.
//
// SABOTAGE RECORD
//
//   return the planned path always (drop the flat branch)   -> 2 checks here,
//                                                              3 with the end-to-end
//                                                              day in gmailSync.test.mjs
//   flatten any `…/2026/09/` folder, whatever the filename  -> 2 checks failed
//   decide placement off the last part, not part 1          -> 2 checks failed

import { flatDayPath, placeDayNote, placeDayParts } from "../src/communications/dayPlacement.js";

function createStore(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async get(path) {
      return files.has(path) ? { text: files.get(path) } : null;
    },
    async put(path, text) {
      files.set(path, text);
    },
  };
}

const NESTED = "0-inbox/email/name-at-example-com/2026/09/2026-09-07.md";
const FLAT = "0-inbox/email/name-at-example-com/2026-09-07.md";

export async function runDayPlacementChecks(check) {
  // -- the string transform ------------------------------------------------
  check("a dated key answers the flat key it would have been", flatDayPath(NESTED) === FLAT);
  check("a key that is already flat has no flat form to find", flatDayPath(FLAT) === null);
  check(
    "a customer folder that ends in a year and a month is not ours to flatten",
    flatDayPath("2-areas/archive/2026/09/minutes.md") === null,
  );
  check(
    "...and the file has to belong to the month it is in",
    flatDayPath("0-inbox/email/name-at-example-com/2026/09/2026-10-07.md") === null,
  );
  check("a non-string is refused without throwing", flatDayPath(undefined) === null && flatDayPath(7) === null);

  // -- one file per day: the calendar case ---------------------------------
  check(
    "a day this bucket has never seen is filed under its month",
    (await placeDayNote(createStore(), NESTED)) === NESTED,
  );
  check(
    "a day that already has a flat note goes on being that note",
    (await placeDayNote(createStore({ [FLAT]: "yesterday's pass wrote this" }), NESTED)) === FLAT,
  );
  check(
    "...and a note for a DIFFERENT day never attracts it",
    (await placeDayNote(createStore({ "0-inbox/email/name-at-example-com/2026-09-06.md": "x" }), NESTED)) === NESTED,
  );

  // -- a day in parts: the mail case ---------------------------------------
  const parts = [
    { path: NESTED, text: "part one" },
    { path: "0-inbox/email/name-at-example-com/2026/09/2026-09-07-part-2.md", text: "part two" },
  ];
  check(
    "a new day keeps every part in the tree",
    (await placeDayParts(createStore(), parts)).map((part) => part.path).join("|") ===
      `${NESTED}|0-inbox/email/name-at-example-com/2026/09/2026-09-07-part-2.md`,
  );
  check(
    "a day that already has a flat note brings ALL its parts back to it",
    (await placeDayParts(createStore({ [FLAT]: "already here" }), parts)).map((part) => part.path).join("|") ===
      `${FLAT}|0-inbox/email/name-at-example-com/2026-09-07-part-2.md`,
  );
  check(
    "...which is decided by part 1, never by a part that may not exist yet",
    (await placeDayParts(
      createStore({ "0-inbox/email/name-at-example-com/2026-09-07-part-2.md": "an orphaned part" }),
      parts,
    )).map((part) => part.path).join("|") ===
      `${NESTED}|0-inbox/email/name-at-example-com/2026/09/2026-09-07-part-2.md`,
  );
  check("nothing to place is not an error", (await placeDayParts(createStore(), [])).length === 0);
  const held = [{ path: NESTED, text: "one" }];
  await placeDayParts(createStore({ [FLAT]: "here" }), held);
  check("the parts handed in are never mutated, so a caller may still hold them", held[0].path === NESTED);
}
