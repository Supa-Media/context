/**
 * `nextFile`, the cheap path that writes without reading the whole history.
 * See activity.test.mjs for the module overview and the sabotage-testing
 * record.
 */

import { REFRESH_MS, change, claude, iso, nextFile, parseFile } from "./fixtures.mjs";

export async function runActivityCheapPathChecks(check) {
  const firstSave = nextFile(
    "",
    change("update_note", ["3-teams/week-one.md"], { team_visible: true }),
  );
  check("the first save of a session writes a file", Boolean(firstSave));

  const resave = nextFile(
    firstSave.text,
    change(
      "update_note",
      ["3-teams/week-one.md"],
      { team_visible: true },
      claude,
      iso(REFRESH_MS - 1000),
    ),
  );
  check(
    "a re-save inside the refresh window writes nothing at all",
    resave === null,
  );

  const staleResave = nextFile(
    firstSave.text,
    change(
      "update_note",
      ["3-teams/week-one.md"],
      { team_visible: true },
      claude,
      iso(REFRESH_MS + 1000),
    ),
  );
  check(
    "a re-save past the refresh window moves the line's clock",
    staleResave !== null && parseFile(staleResave.text)[0].at === iso(REFRESH_MS + 1000),
  );
  check(
    "and does not add a second line for the same note",
    staleResave !== null && parseFile(staleResave.text).length === 1,
  );

  // Past the refresh window, so the only thing that can stop this write is the
  // substance test itself. Inside it, a re-save writes nothing for a reason
  // that has nothing to do with how much changed.
  const unsubstantial = nextFile(
    firstSave.text,
    change(
      "update_note",
      ["3-teams/week-one.md"],
      { team_visible: true, previous_bytes: 100, content_bytes: 101 },
      claude,
      iso(REFRESH_MS + 60_000),
    ),
  );
  check("an unsubstantial change writes nothing", unsubstantial === null);
}
