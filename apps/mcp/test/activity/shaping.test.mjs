/**
 * How a line is shaped: what it carries, and how it reads. See
 * activity.test.mjs for the module overview and the sabotage-testing record.
 */

import { change, claude, describeEntry, entryFor, seyi } from "./fixtures.mjs";

export async function runActivityShapingChecks(check) {
  const folderMove = entryFor(
    change("move_folder", ["1-projects/triage", "1-projects/backlog/triage"], {
      count: 6,
      team_visible: true,
    }),
  );
  check("a folder move carries its object count", folderMove?.n === 6);
  check(
    "a folder move reads as one sentence about many notes",
    describeEntry(folderMove).includes("6 notes"),
  );

  const bulk = entryFor(
    change(
      "move_notes",
      ["a/one.md", "b/one.md", "a/two.md", "b/two.md"],
      { count: 2, team_visible: true },
    ),
  );
  check(
    "a bulk move keeps the destinations rather than the sources",
    bulk?.paths.join(",") === "b/one.md,b/two.md",
  );

  check(
    "a change with no team flag is recorded as private rather than assumed public",
    entryFor(change("create_note", ["1-projects/alpha.md"], {}))?.vis === "private",
  );

  check(
    "an agent's own sentence rides along when it sent one",
    entryFor(
      change("create_note", ["1-projects/alpha.md"], {
        team_visible: true,
        summary: "  screenshots of   the editor bugs\n",
      }),
    )?.note === "screenshots of the editor bugs",
  );

  check(
    "a person and their client read as a possessive",
    describeEntry(
      entryFor(change("create_note", ["1-projects/alpha.md"], { team_visible: true })),
    ).startsWith("@sayo's Claude added"),
  );

  check(
    "a person acting in the console is just their name",
    describeEntry(
      entryFor(
        change("file.create", ["1-projects/alpha.md"], { team_visible: true }, seyi),
      ),
    ).startsWith("@seyi added"),
  );

  check(
    "a meeting landing names no actor, because nobody wrote it",
    describeEntry(
      entryFor(
        change("meeting_note", ["0-inbox/meetings/steering.md"], { team_visible: true }, {
          name: null,
          client: null,
        }),
      ),
    ).startsWith("A meeting landed"),
  );
}
