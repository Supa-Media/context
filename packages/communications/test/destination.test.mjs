// Where a channel files its days, and everything a person can type that is not
// that.
//
// SABOTAGE RECORD — each break applied to the source, the suite re-run, the
// number of checks that noticed written down. A guard nobody has checked is not
// a guard. Two of these found real gaps and the checks below them exist because
// the first run of this table said 0.
//
//   drop the trailing-pattern strip, so a pattern is not a folder  -> 3 checks failed
//   accept a dot-prefixed segment                                  -> 8 checks failed
//   accept a segment ending in .md after the strip                 -> 4 checks failed
//   drop the {date} spelling from the strip                        -> 1 check failed
//   suggest folders under any parent, not the typed one            -> 4 checks failed
//   suggest the exact folder already typed                         -> 3 checks failed
//   suggest reserved folders                                       -> 4 checks failed
//   resolve with toISOString instead of local parts                -> 0, then 1
//
// The last row is why this table is run rather than written. `toISOString`
// noticed **nothing**: CI runs in UTC, where the local date and the UTC date
// are the same date, so the check that was supposed to catch it was asserting
// a tautology. It forces `TZ` now, and a second check asserts the forcing
// worked — a guard nobody has checked is not a guard, and that included this
// one.

import {
  DATE_TOKEN,
  DESTINATION_SEGMENT_LIMIT,
  destinationPattern,
  normalizeDestinationFolder,
  resolveDestinationPattern,
  suggestDestinationFolders,
} from "../src/destination.js";

export function runDestinationChecks(check) {
  // -- the folder rule

  check(
    "a plain folder is a folder",
    normalizeDestinationFolder("2-areas/communications").folder === "2-areas/communications",
  );
  check(
    "a whole pattern answers with its folder, so no caller strips the day file itself",
    normalizeDestinationFolder("2-areas/communications/YYYY-MM-DD.md").folder ===
      "2-areas/communications",
  );
  check(
    "the legacy {date} spelling is accepted on the way in",
    normalizeDestinationFolder("0-inbox/calendar/{date}.md").folder === "0-inbox/calendar",
  );
  check(
    "...and is never produced, so the two spellings converge on the next save",
    destinationPattern("0-inbox/calendar") === "0-inbox/calendar/YYYY-MM-DD.md" &&
      !destinationPattern("x").includes("{date}"),
  );
  check("the token is the one the pattern carries", DATE_TOKEN === "YYYY-MM-DD");
  check(
    "surrounding whitespace is not a different folder",
    normalizeDestinationFolder("  0-inbox/calendar  ").folder === "0-inbox/calendar",
  );
  check(
    "a leading and trailing slash are not a different folder either",
    normalizeDestinationFolder("/0-inbox/calendar/").folder === "0-inbox/calendar",
  );

  // -- what it refuses, and with what to do about it

  const empty = normalizeDestinationFolder("");
  check("nothing typed is a refusal", empty.ok === false);
  check(
    "...and the message says what to do rather than what is wrong",
    empty.message === "Choose a folder where synced files should land.",
  );
  check("the bucket root is not a folder a channel may fill", normalizeDestinationFolder("/").ok === false);
  check(
    "traversal is refused rather than resolved",
    normalizeDestinationFolder("2-areas/../../etc").ok === false,
  );
  check(
    "...and so is a backslash, which is a segment on one platform and a separator on another",
    normalizeDestinationFolder("2-areas\\comms").ok === false,
  );
  check(
    "normalizeRoot throws and this never does — the refusal is a value a field can render",
    (() => {
      try {
        return normalizeDestinationFolder("..").ok === false;
      } catch {
        return false;
      }
    })(),
  );
  check(
    "a note is not a folder to file inside",
    normalizeDestinationFolder("1-projects/board-update.md").ok === false,
  );
  check(
    "...and that refusal names the two shapes that would work",
    normalizeDestinationFolder("1-projects/board-update.md").message ===
      "Use a folder, or a pattern ending in /YYYY-MM-DD.md.",
  );
  check(
    "plumbing is reserved — a day note nobody can see is still on their bill",
    normalizeDestinationFolder(".audit/mail").ok === false &&
      normalizeDestinationFolder(".audit/mail").code === "DESTINATION_RESERVED",
  );
  check(
    "...at any depth, not just the first segment",
    normalizeDestinationFolder("0-inbox/.hidden/mail").code === "DESTINATION_RESERVED",
  );
  check(
    "the manifest is not a folder",
    normalizeDestinationFolder("privacy.md/mail").code === "DESTINATION_RESERVED",
  );
  check(
    "a segment longer than the limit is refused",
    normalizeDestinationFolder(`0-inbox/${"x".repeat(DESTINATION_SEGMENT_LIMIT + 1)}`).ok === false,
  );
  check(
    "...and one exactly at the limit is not",
    normalizeDestinationFolder(`0-inbox/${"x".repeat(DESTINATION_SEGMENT_LIMIT)}`).ok === true,
  );
  check(
    "a non-string is a refusal rather than a crash",
    normalizeDestinationFolder(undefined).ok === false && normalizeDestinationFolder(7).ok === false,
  );
  check(
    "every refusal carries a code and a sentence worth showing",
    ["", "..", "a.md", ".x", "x\\y"].every((value) => {
      const result = normalizeDestinationFolder(value);
      return (
        result.ok === false &&
        typeof result.code === "string" &&
        result.code.length > 0 &&
        typeof result.message === "string" &&
        result.message.trim().endsWith(".")
      );
    }),
  );
  check(
    "...and no refusal quotes the input back, which would be a reflection",
    /*
      `normalizeRoot` throws messages that include the offending value. Those
      must not reach a caller: this message is rendered into a settings panel
      and, for the control plane, into a `ConvexError`.
    */
    ["../<script>", "x\\<img>", ".<b>", "<i>.md"].every((value) => {
      const result = normalizeDestinationFolder(value);
      return result.ok === false && !result.message.includes("<");
    }),
  );

  // -- what a pattern writes, which is the half the field was missing

  check(
    "a pattern resolves to the key it writes on the day",
    resolveDestinationPattern("2-areas/comms/YYYY-MM-DD.md", new Date(2026, 8, 12)) ===
      "2-areas/comms/2026-09-12.md",
  );
  check(
    "a bare folder resolves too, so the preview works while somebody is still typing",
    resolveDestinationPattern("2-areas/comms", new Date(2026, 0, 5)) ===
      "2-areas/comms/2026-01-05.md",
  );
  /*
    21:30 on the 12th in a timezone behind UTC is the 13th to `toISOString` and
    the 12th to everybody who was there.

    **This check was vacuous when it was written, and the sabotage table is
    what found it.** Swapping the local date parts for `toISOString` failed
    zero checks, because CI and this container both run in UTC — where the two
    agree by definition, so a check that merely built a late-evening `Date` was
    asserting nothing at all. Forcing `TZ` for the duration is what makes the
    difference exist to be measured; the guard is restored afterwards so no
    later check inherits a timezone it did not ask for.
  */
  const realTZ = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const evening = new Date(2026, 8, 12, 21, 30);
    check(
      "the suite can actually tell the two apart, or the check below means nothing",
      evening.toISOString().slice(0, 10) === "2026-09-13",
    );
    check(
      "the day is the day the person had, not the UTC one",
      resolveDestinationPattern("x/y", evening) === "x/y/2026-09-12.md",
    );
  } finally {
    if (realTZ === undefined) delete process.env.TZ;
    else process.env.TZ = realTZ;
  }
  check(
    "months and days are padded, so a listing sorts",
    resolveDestinationPattern("x/y", new Date(2026, 0, 2)) === "x/y/2026-01-02.md",
  );
  check(
    "a pattern that is not one resolves to nothing rather than to a guess",
    resolveDestinationPattern(".plumbing", new Date(2026, 8, 12)) === null,
  );
  check(
    "an unusable date resolves to nothing rather than to NaN in a filename",
    resolveDestinationPattern("x/y", new Date("nonsense")) === null &&
      resolveDestinationPattern("x/y", "2026-09-12") === null,
  );

  // -- completion

  const TREE = [
    "0-inbox",
    "0-inbox/calendar",
    "0-inbox/email",
    "0-inbox/meetings",
    "1-projects",
    "2-areas",
    "2-areas/communications",
    "2-areas/comms-archive",
    "2-areas/hiring",
    ".audit",
    ".audit/mail",
  ];

  check(
    "typing a parent offers what is directly under it",
    JSON.stringify(suggestDestinationFolders("2-areas/", TREE)) ===
      JSON.stringify(["2-areas/communications", "2-areas/comms-archive", "2-areas/hiring"]),
  );
  check(
    "typing a stem narrows to the folders that start with it",
    JSON.stringify(suggestDestinationFolders("2-areas/comm", TREE)) ===
      JSON.stringify(["2-areas/communications", "2-areas/comms-archive"]),
  );
  check(
    "a stem matches at the start of a name, never in the middle",
    suggestDestinationFolders("2-areas/archive", TREE).length === 0,
  );
  check(
    "completion is case-insensitive, because a folder list is not a password",
    JSON.stringify(suggestDestinationFolders("2-AREAS/Comm", TREE)) ===
      JSON.stringify(["2-areas/communications", "2-areas/comms-archive"]),
  );
  check(
    "an empty field offers the roots",
    JSON.stringify(suggestDestinationFolders("", TREE)) ===
      JSON.stringify(["0-inbox", "1-projects", "2-areas"]),
  );
  check(
    "a committed parent is never undone by a suggestion from another one",
    suggestDestinationFolders("2-areas/comm", TREE).every((path) => path.startsWith("2-areas/")),
  );
  check(
    "reserved folders are never offered — an autocomplete its own validator refuses is worse than none",
    suggestDestinationFolders("", TREE).includes(".audit") === false &&
      suggestDestinationFolders(".", TREE).length === 0,
  );
  check(
    "the folder already typed in full is not offered back",
    suggestDestinationFolders("2-areas/hiring", TREE).includes("2-areas/hiring") === false,
  );
  check(
    "...and its siblings are not offered either, because that value is finished",
    suggestDestinationFolders("2-areas/hiring", TREE).length === 0,
  );
  check(
    "a trailing pattern does not stop completion, so an existing binding can be edited",
    JSON.stringify(suggestDestinationFolders("2-areas/comm/YYYY-MM-DD.md", TREE)) ===
      JSON.stringify(["2-areas/communications", "2-areas/comms-archive"]),
  );
  check(
    /*
      A complete binding suggests nothing, and that is the "exact match is
      finished" rule arriving through the pattern strip rather than an
      oversight: `2-areas/YYYY-MM-DD.md` strips to `2-areas`, which is a folder
      the person has finished typing. One more keystroke opens its children,
      which is the check below.
    */
    "a complete pattern offers nothing, because its folder is already whole",
    suggestDestinationFolders("2-areas/YYYY-MM-DD.md", TREE).length === 0,
  );
  check(
    "...and one more separator opens that folder's children",
    JSON.stringify(suggestDestinationFolders("2-areas/", TREE)) ===
      JSON.stringify(["2-areas/communications", "2-areas/comms-archive", "2-areas/hiring"]),
  );
  check(
    "the limit is honoured, so a wide tree does not become a wall of chips",
    suggestDestinationFolders("", TREE, 2).length === 2,
  );
  check(
    "a tree with nothing in it suggests nothing rather than throwing",
    suggestDestinationFolders("2-areas/", []).length === 0 &&
      suggestDestinationFolders(undefined, TREE).length === 3,
  );
  check(
    "junk in the tree is skipped rather than offered",
    suggestDestinationFolders("", [null, 7, "", "1-projects"]).length === 1,
  );
  check(
    "every suggestion is a value the validator then accepts",
    suggestDestinationFolders("", TREE)
      .concat(suggestDestinationFolders("2-areas/", TREE))
      .every((path) => normalizeDestinationFolder(path).ok === true),
  );
}
