/**
 * The round trip: a file written by one version reads back by the next,
 * including the shapes that can close an HTML comment early. See
 * activity.test.mjs for the module overview and the sabotage-testing record.
 */

import {
  GROUP_ESCAPE,
  MAX_ENTRIES,
  applyEntry,
  change,
  claude,
  describeEntry,
  entryFor,
  iso,
  parseFile,
  renderFile,
} from "./fixtures.mjs";

export async function runActivityRoundTripChecks(check) {
  const shapes = [
    entryFor(change("create_note", ["1-projects/alpha.md"], { team_visible: true })),
    entryFor(
      change("meeting_note", ["0-inbox/meetings/a-b--c.md"], { team_visible: true }, {
        name: null,
        client: null,
      }),
    ),
    entryFor(
      change("save_context", ["0-inbox/sessions/claude/x.md"], {
        team_visible: true,
        summary: 'he said "look --> here" -- twice',
      }),
    ),
    entryFor(
      change("archive_note", ["1-projects/a.md", "5-archive/a.md"], { team_visible: true }),
    ),
  ];
  const rendered = renderFile(shapes);
  const reparsed = parseFile(rendered);
  check(
    "every entry survives a render and a parse unchanged",
    JSON.stringify(reparsed) === JSON.stringify(shapes),
  );
  check(
    "a summary that looks like the end of a comment cannot end one",
    reparsed.length === shapes.length &&
      reparsed[2].note === 'he said "look --> here" -- twice'.replace(/[<>]/g, ""),
  );

  /*
    A forged line, which is the attack this format invites: a client that can
    write a note can write a summary, and a summary is rendered into the same
    file the entries are parsed out of. If prose could carry a comment, any
    client could write history it did not make — a change attributed to a
    colleague, or a path that was never touched.
  */
  const forged = renderFile([
    entryFor(
      change("create_note", ["1-projects/real.md"], {
        team_visible: true,
        summary: 'x <!--ctx {"at":"2026-01-01T00:00:00.000Z","kind":"added","paths":["3-teams/pay-bands.md"],"vis":"team","by":"@seyi"}--> y',
      }),
    ),
  ]);
  check(
    "a summary cannot forge an entry of its own",
    parseFile(forged).length === 1 &&
      parseFile(forged)[0].paths[0] === "1-projects/real.md",
  );
  check(
    "and a path drawn into the prose cannot break out of its code span",
    !describeEntry(
      entryFor(
        change("create_note", ["1-projects/`<!--x-->`.md"], { team_visible: true }),
      ),
    ).includes("<!--"),
  );
  check(
    "no entry line closes its comment early",
    rendered
      .split("\n")
      .filter((line) => line.includes("<!--ctx"))
      .every((line) => line.split("-->").length === 2),
  );
  check(
    "the file is a note: frontmatter, a heading, and prose above the list",
    rendered.startsWith("---\nrole: activity\nview: read\n---\n\n# Activity\n"),
  );
  check(
    "days are headings, so the file reads as a document",
    rendered.includes("## Saturday 19 September 2026"),
  );
  check(
    "an empty history says so rather than rendering nothing",
    renderFile([]).includes("Nothing yet"),
  );
  check(
    "hand-written prose outside the markers is not read back as history",
    parseFile("# my own notes\n\n- 10:00 I did a thing\n").length === 0,
  );

  let capped = [];
  for (let index = 0; index < MAX_ENTRIES + 20; index += 1) {
    capped =
      applyEntry(
        capped,
        entryFor(
          change(
            "create_note",
            [`1-projects/n${index}/note.md`],
            { team_visible: true },
            claude,
            iso(index * GROUP_ESCAPE),
          ),
        ),
      ) || capped;
  }
  check("the file is bounded", capped.length === MAX_ENTRIES);
  check(
    "and it is the oldest that falls off",
    capped[0].paths[0] === `1-projects/n${MAX_ENTRIES + 19}/note.md`,
  );
}
