import { describe, expect, test } from "@jest/globals";
import { CONTACTS_FOLDER, renderContactNote } from "@context/communications";
import {
  CONTACT_LETTERS,
  contactHeaderOf,
  contactsIndex,
  hidesFolderChaos,
  isContactPagePath,
} from "../features/console/communications/contactPages";
import type { FileEntry } from "../features/console/files/types";

const syncPage = renderContactNote({
  name: "Adam Okonkwo",
  identifiers: [
    { kind: "email", value: "adam@example.net" },
    { kind: "phone", value: "+15550100200" },
    { kind: "provider-user", value: "users/1234567890" },
  ],
  activity: [],
  notes: "Production lead.",
  now: "2026-09-07T18:04:11.221Z",
});

const legacyPage =
  "---\ntitle: \"Alex Example\"\nrole: communication-contact\n---\n\n" +
  "# Alex Example\n\n## Identities\n\n- iMessage: `+15551234567`\n- iMessage: `alex@example.org`\n\n" +
  "## iMessage threads\n\n- [2026-08](<../sources/imessage/alex/2026-08.md>)\n";

function entry(kind: FileEntry["kind"], path: string): FileEntry {
  return {
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

/** The contacts folder's index, which every case below expects to exist. */
function index(rows: readonly FileEntry[]) {
  const found = contactsIndex(CONTACTS_FOLDER, rows);
  if (found === null) throw new Error("the contacts folder should have an index");
  return found;
}

describe("isContactPagePath", () => {
  test.each([
    ["a flat page", `${CONTACTS_FOLDER}/adam-okonkwo.md`],
    ["a page in a letter folder", `${CONTACTS_FOLDER}/a/adam-okonkwo.md`],
    ["a page in other/", `${CONTACTS_FOLDER}/other/4155550100.md`],
    ["a legacy imported page", `${CONTACTS_FOLDER}/imessage/alex.md`],
  ])("%s is a contact page path", (_label, path) => {
    expect(isContactPagePath(path)).toBe(true);
  });

  test.each([
    ["the folder itself", CONTACTS_FOLDER],
    ["a letter folder", `${CONTACTS_FOLDER}/a`],
    ["two levels down", `${CONTACTS_FOLDER}/a/b/adam.md`],
    ["a lookalike folder", "0-inbox/contacts-old/adam.md"],
    ["a note elsewhere", "1-projects/adam.md"],
    ["a drawing in contacts", `${CONTACTS_FOLDER}/a/adam.excalidraw`],
    ["a traversal", `${CONTACTS_FOLDER}/../adam.md`],
    ["nothing", ""],
  ])("%s is not", (_label, path) => {
    expect(isContactPagePath(path)).toBe(false);
  });
});

describe("contactHeaderOf", () => {
  test("a sync page: its name and the identifiers a person recognises", () => {
    expect(contactHeaderOf(`${CONTACTS_FOLDER}/a/adam-okonkwo.md`, syncPage)).toEqual({
      name: "Adam Okonkwo",
      identifiers: [
        { kind: "email", value: "adam@example.net" },
        { kind: "phone", value: "+15550100200" },
      ],
    });
  });

  test("a flat sync page reads the same as one in a letter folder", () => {
    expect(contactHeaderOf(`${CONTACTS_FOLDER}/adam-okonkwo.md`, syncPage)).toEqual(
      contactHeaderOf(`${CONTACTS_FOLDER}/a/adam-okonkwo.md`, syncPage),
    );
  });

  test("a legacy imported iMessage page", () => {
    expect(contactHeaderOf(`${CONTACTS_FOLDER}/imessage/alex.md`, legacyPage)).toEqual({
      name: "Alex Example",
      identifiers: [
        { kind: "imessage", value: "+15551234567" },
        { kind: "imessage", value: "alex@example.org" },
      ],
    });
  });

  test("the same identifier written twice is one chip", () => {
    const twice = legacyPage.replace("- iMessage: `alex@example.org`", "- iMessage: `+15551234567`");
    expect(contactHeaderOf(`${CONTACTS_FOLDER}/imessage/alex.md`, twice)?.identifiers).toHaveLength(1);
  });

  test("a page with no heading falls back to its title, then its file name", () => {
    const noHeading = legacyPage.replace("# Alex Example\n\n", "");
    expect(contactHeaderOf(`${CONTACTS_FOLDER}/imessage/alex.md`, noHeading)?.name).toBe("Alex Example");
    const bare = "---\nrole: communication-contact\n---\n\n- iMessage: `+15551234567`\n";
    expect(contactHeaderOf(`${CONTACTS_FOLDER}/imessage/alex-b.md`, bare)?.name).toBe("alex-b");
  });

  test("a contact-shaped note outside the contacts folder gets no header", () => {
    expect(contactHeaderOf("1-projects/adam.md", syncPage)).toBeNull();
  });

  test("an ordinary note inside the contacts folder gets no header", () => {
    // Somebody's own note filed beside the pages, or an about note: the
    // frontmatter decides, never the folder alone.
    expect(contactHeaderOf(`${CONTACTS_FOLDER}/a/todo.md`, "# Call Adam\n\n- email: adam@example.net\n")).toBeNull();
    expect(
      contactHeaderOf(`${CONTACTS_FOLDER}/a/todo.md`, "---\ntype: \"meeting\"\n---\n\n# Adam\n"),
    ).toBeNull();
  });

  test("no path, no header", () => {
    expect(contactHeaderOf(null, syncPage)).toBeNull();
  });
});

describe("contactsIndex", () => {
  const rows = [
    entry("folder", `${CONTACTS_FOLDER}/imessage`),
    entry("folder", `${CONTACTS_FOLDER}/other`),
    entry("folder", `${CONTACTS_FOLDER}/m`),
    entry("folder", `${CONTACTS_FOLDER}/a`),
    entry("file", `${CONTACTS_FOLDER}/zed.md`),
  ];

  test("every letter, A to Z, then other, last", () => {
    const { letters } = index(rows);
    expect(letters.map((letter) => letter.label)).toEqual([
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "Other",
    ]);
    expect(CONTACT_LETTERS.at(-1)).toBe("other");
  });

  test("a letter with a folder opens it; one without has nowhere to go", () => {
    const { letters } = index(rows);
    const byLabel = new Map(letters.map((letter) => [letter.label, letter.path]));
    expect(byLabel.get("A")).toBe(`${CONTACTS_FOLDER}/a`);
    expect(byLabel.get("M")).toBe(`${CONTACTS_FOLDER}/m`);
    expect(byLabel.get("Other")).toBe(`${CONTACTS_FOLDER}/other`);
    expect(byLabel.get("B")).toBeNull();
  });

  test("legacy folders and flat pages stay ordinary rows, in listing order", () => {
    expect(index(rows).rest.map((row) => row.path)).toEqual([
      `${CONTACTS_FOLDER}/imessage`,
      `${CONTACTS_FOLDER}/zed.md`,
    ]);
  });

  test("a file named like a letter is a page, not a letter", () => {
    const { letters, rest } = index([entry("file", `${CONTACTS_FOLDER}/a.md`)]);
    expect(letters.every((letter) => letter.path === null)).toBe(true);
    expect(rest).toHaveLength(1);
  });

  test("any other folder has no index", () => {
    expect(contactsIndex("1-projects", rows)).toBeNull();
    expect(contactsIndex(`${CONTACTS_FOLDER}/a`, rows)).toBeNull();
  });
});

describe("hidesFolderChaos", () => {
  test("the contacts folder and its letter folders are not scored", () => {
    expect(hidesFolderChaos(CONTACTS_FOLDER)).toBe(true);
    expect(hidesFolderChaos(`${CONTACTS_FOLDER}/a`)).toBe(true);
    expect(hidesFolderChaos(`${CONTACTS_FOLDER}/other`)).toBe(true);
  });

  test("everything else keeps its chip", () => {
    expect(hidesFolderChaos("0-inbox")).toBe(false);
    expect(hidesFolderChaos(`${CONTACTS_FOLDER}/imessage`)).toBe(false);
    expect(hidesFolderChaos(`${CONTACTS_FOLDER}/a/b`)).toBe(false);
    expect(hidesFolderChaos("1-projects/a")).toBe(false);
  });
});
