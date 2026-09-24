/**
 * When lines merge into one, and when they never do. See activity.test.mjs
 * for the module overview and the sabotage-testing record.
 */

import { REFRESH_MS, applyEntry, change, claude, entryFor, iso, seyi } from "./fixtures.mjs";

export async function runActivityGroupingChecks(check) {
  const three = ["one", "two", "three"].reduce(
    (entries, name, index) =>
      applyEntry(
        entries,
        entryFor(
          change(
            "create_note",
            [`1-projects/fixes/${name}.md`],
            { team_visible: true },
            claude,
            iso(index * 60_000),
          ),
        ),
      ) || entries,
    [],
  );
  check("three notes in one folder by one hand are one line", three.length === 1);
  check("and the line counts them", three[0].n === 3);

  const twoHands = applyEntry(
    three,
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/four.md"],
        { team_visible: true },
        seyi,
        iso(4 * 60_000),
      ),
    ),
  );
  check("a second person never merges into the first", twoHands.length === 2);

  const twoClients = applyEntry(
    three,
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/five.md"],
        { team_visible: true },
        { name: "@sayo", client: "ChatGPT" },
        iso(5 * 60_000),
      ),
    ),
  );
  check(
    "one person's two clients are two hands",
    twoClients.length === 2,
  );

  const later = applyEntry(
    three,
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/six.md"],
        { team_visible: true },
        claude,
        iso(90 * 60_000),
      ),
    ),
  );
  check("work an hour and a half later is its own line", later.length === 2);

  const justCreated = [
    entryFor(change("create_note", ["1-projects/fixes/one.md"], { team_visible: true })),
  ];
  check(
    "typing into a note you just made writes nothing at all",
    applyEntry(
      justCreated,
      entryFor(
        change(
          "update_note",
          ["1-projects/fixes/one.md"],
          { team_visible: true },
          claude,
          iso(30_000),
        ),
      ),
    ) === null,
  );
  const editedLater = applyEntry(
    justCreated,
    entryFor(
      change(
        "update_note",
        ["1-projects/fixes/one.md"],
        { team_visible: true },
        claude,
        iso(REFRESH_MS + 60_000),
      ),
    ),
  );
  check(
    "and editing it an hour later is still the line that says you made it",
    editedLater.length === 1 && editedLater[0].kind === "added",
  );

  const createdAfterEditing = applyEntry(
    [entryFor(change("update_note", ["1-projects/fixes/two.md"], { team_visible: true }))],
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/two.md"],
        { team_visible: true },
        claude,
        iso(30_000),
      ),
    ),
  );
  check(
    "but a creation after a revision is a different note, and a second line",
    createdAfterEditing.length === 2,
  );

  const mixedKinds = applyEntry(
    three,
    entryFor(
      change(
        "move_note",
        ["1-projects/fixes/one.md", "1-projects/fixes/one-renamed.md"],
        { team_visible: true },
        claude,
        iso(2 * 60_000),
      ),
    ),
  );
  check("a move never merges into a run of creates", mixedKinds.length === 2);

  const publishedPrivate = applyEntry(
    [
      entryFor(
        change("create_note", ["1-projects/fixes/a.md"], { team_visible: true }),
      ),
    ],
    entryFor(
      change(
        "create_note",
        ["1-projects/fixes/b.md"],
        {},
        claude,
        iso(60_000),
      ),
    ),
  );
  check(
    "a group holding one private member is private, not team",
    publishedPrivate[0].vis === "private",
  );
}
