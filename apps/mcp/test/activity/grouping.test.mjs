/**
 * When lines merge into one, and when they never do. See activity.test.mjs
 * for the module overview and the sabotage-testing record.
 */

import { REFRESH_MS, applyEntry, change, claude, describeEntry, entryFor, iso, parseFile, renderFile, seyi } from "./fixtures.mjs";

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

  // The app's own console writes through the gateway under a client name of
  // its own, and it is still the person's hand (the owner, 2026-10-12).
  const inApp = { name: "@seyi", client: "Context (this app)" };
  const appEdit = entryFor(change("create_note", ["1-projects/fixes/readme.md"], { team_visible: true }, inApp));
  check("an edit made in the app names no client", appEdit.via === null);
  check(
    "and reads as the person, never as the app",
    describeEntry(appEdit) === "@seyi added `1-projects/fixes/readme.md`",
  );
  const sameHand = applyEntry(
    [entryFor(change("create_note", ["1-projects/fixes/a.md"], { team_visible: true }, seyi))],
    appEdit,
  );
  check("so it merges with the person's own line", sameHand.length === 1);

  // Lines written before that rule carry the console's name in the file.
  const old = parseFile(renderFile([{ ...appEdit, via: "Context (this app)" }]));
  check("an older line from the app reads back as the person", old.length === 1 && old[0].via === null);

  // The texting assistant's client was "Texts (iMessage)" until it took Tex's
  // name (the owner, 2026-10-14); lines from before read as Tex.
  const texted = parseFile(renderFile([{ ...appEdit, via: "Texts (iMessage)" }]));
  check("an older line from the texting assistant reads back as Tex", texted.length === 1 && texted[0].via === "Tex");
  check(
    "and is drawn as the person's Tex",
    describeEntry(texted[0]) === "@seyi's Tex added `1-projects/fixes/readme.md`",
  );
}
