/**
 * A `moved` line carries `[from, to]` pairs for the console map's replay.
 *
 * `paths` cannot carry them: a bulk move keeps only its destinations, a
 * grouped line holds several moves, and every reader forwards `paths` to where
 * the note is now. The pairs are history — written once, never forwarded —
 * and filtered on both ends per reader. See `movePairsOf` in
 * `packages/shared/src/activity.cjs`.
 *
 * Sabotage record: dropping the pair filter in `visibleEntries` reddens
 * "a member does not receive a pair whose old folder is private now";
 * dropping `moves` from `decodeEntry` reddens "the pairs survive the file".
 */

import {
  applyEntry,
  change,
  entryFor,
  iso,
  parseFile,
  renderFile,
  visibleEntries,
} from "./fixtures.mjs";

export async function runActivityMovePairChecks(check) {
  const single = entryFor(
    change("move_note", ["1-projects/a.md", "2-areas/a.md"], { team_visible: true }),
  );
  check(
    "a single move records where it came from and went",
    JSON.stringify(single?.moves) === JSON.stringify([["1-projects/a.md", "2-areas/a.md"]]),
  );

  const bulk = entryFor(
    change("move_notes", ["a/one.md", "b/one.md", "a/two.md", "b/two.md"], {
      count: 2,
      team_visible: true,
    }),
  );
  check(
    "a bulk move keeps every pair, though its paths keep only destinations",
    JSON.stringify(bulk?.moves) ===
      JSON.stringify([
        ["a/one.md", "b/one.md"],
        ["a/two.md", "b/two.md"],
      ]),
  );

  const console = entryFor(
    change("file.move", ["1-projects/x.md", "4-archive/x.md"], { team_visible: true }),
  );
  check(
    "a console move records its pair the same way",
    console?.moves?.[0]?.join(">") === "1-projects/x.md>4-archive/x.md",
  );

  const crossContext = entryFor(
    change("move_note", ["1-projects/left.md"], { team_visible: true }),
  );
  check(
    "a cross-context move names one path, so it carries no pair",
    crossContext !== null && crossContext.moves === undefined,
  );

  check(
    "a line that is not a move carries no pairs",
    entryFor(change("create_note", ["1-projects/new.md"], { team_visible: true }))?.moves ===
      undefined,
  );

  // Two moves in a chain inside the window are one line, with both pairs.
  const first = entryFor(
    change("move_note", ["1-projects/a.md", "2-areas/a.md"], { team_visible: true }),
  );
  const second = entryFor(
    change(
      "move_note",
      ["2-areas/a.md", "3-resources/a.md"],
      { team_visible: true },
      undefined,
      iso(60_000),
    ),
  );
  const merged = applyEntry([first], second);
  check(
    "a chained move merges onto one line and keeps both pairs, oldest first",
    merged?.length === 1 &&
      JSON.stringify(merged[0].moves) ===
        JSON.stringify([
          ["1-projects/a.md", "2-areas/a.md"],
          ["2-areas/a.md", "3-resources/a.md"],
        ]),
  );

  const parsed = parseFile(renderFile([bulk, single], ""));
  check(
    "the pairs survive the file, hyphens and all",
    JSON.stringify(parsed.map((entry) => entry.moves)) ===
      JSON.stringify([bulk.moves, single.moves]),
  );
  check(
    "a line written before pairs existed reads back without them",
    parseFile(renderFile([{ ...single, moves: undefined }], ""))[0].moves === undefined,
  );

  // As every reader hands it over: `paths` forwarded to where the note is now.
  const history = [{ ...single, paths: ["2-areas/a.md", "2-areas/a.md"] }];
  const notPrivateNow = (path) => !path.startsWith("1-projects/");
  const member = visibleEntries(history, { owner: false, canSee: notPrivateNow });
  check(
    "a member does not receive a pair whose old folder is private now",
    member.length === 1 && member[0].moves === undefined,
  );
  check(
    "and keeps the line itself, which its forwarded paths already cleared",
    member[0]?.paths.join(",") === history[0].paths.join(","),
  );
  check(
    "a member who can see both ends receives the pair",
    visibleEntries(history, { owner: false, canSee: () => true })[0]?.moves?.length === 1,
  );
  check(
    "the owner always receives the pairs",
    visibleEntries(history, { owner: true })[0]?.moves?.length === 1,
  );
}
