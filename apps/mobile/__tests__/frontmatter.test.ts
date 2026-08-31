/**
 * Frontmatter, read for display and never written back.
 *
 * The module under test exists so a captured note stops opening on a screenful
 * of `captured:` / `source:` / `trust:` instead of on the note. That makes it a
 * reader of somebody's file, in an editor whose buffer is written back to their
 * own bucket, so the test that matters most is not about titles at all: it is
 * that cutting a file in two and joining it again returns the same bytes.
 *
 * That property is asserted over a table rather than one example on purpose.
 * Every entry below is a shape that has a plausible way of losing a byte —
 * CRLF, a fence that never closes, an empty block, a body that is itself full
 * of `---` — and a single happy-path case would pass for all of them while
 * proving none.
 */

import { describe as group, expect, test } from "@jest/globals";
import {
  frontmatterTitle,
  noteHeading,
  noteHeadingSource,
  properties,
  splitNote,
} from "../features/console/files/frontmatter";

/** A realistic captured-email header, of the kind that fills a phone screen. */
const CAPTURED = [
  "---",
  'captured: "2026-08-29T02:51:47.360Z"',
  'source: "email"',
  'trust: "untrusted"',
  "subject: 'Re: lunch on Thursday'",
  "visibility: private",
  "---",
  "",
  "Body starts here.",
  "",
].join("\n");

const ROUND_TRIP: ReadonlyArray<{ name: string; source: string }> = [
  { name: "no frontmatter at all", source: "# Just a note\n\nProse.\n" },
  { name: "a normal block", source: CAPTURED },
  {
    name: "CRLF line endings",
    source: "---\r\ntitle: Windows\r\n---\r\n\r\nBody.\r\n",
  },
  {
    name: "an opening fence that never closes",
    source: "---\ntitle: Truncated\nand then the file just stops\n",
  },
  { name: "an empty block", source: "---\n---\n" },
  { name: "an empty block with nothing after it", source: "---\n---" },
  {
    name: "a body full of horizontal rules",
    source: "---\ntitle: Rules\n---\n\nOne\n\n---\n\nTwo\n\n---\n\nThree\n",
  },
  { name: "a body that opens with a horizontal rule", source: "---\n\nOnly prose.\n" },
  { name: "the empty string", source: "" },
  { name: "a bare fence and nothing else", source: "---" },
  { name: "no trailing newline", source: "---\ntitle: Terse\n---\nBody" },
];

group("splitNote", () => {
  test.each(ROUND_TRIP)("round-trips $name", ({ source }) => {
    const { frontmatter, body } = splitNote(source);
    expect(frontmatter + body).toBe(source);
  });

  test("the body is the file's own suffix, not a rewrite of it", () => {
    // The round trip above is only true because `stripFrontmatter` returns a
    // suffix; state that separately so a change that normalises line endings
    // fails here with a readable message rather than as a mystery elsewhere.
    for (const { source } of ROUND_TRIP) {
      const { body } = splitNote(source);
      expect(source.endsWith(body)).toBe(true);
    }
  });

  test("a note with no frontmatter has none, rather than an empty-looking one", () => {
    const source = "Just prose.\n";
    expect(splitNote(source)).toEqual({ frontmatter: "", body: source });
  });

  test("the fences belong to the frontmatter and the body starts after them", () => {
    const { frontmatter, body } = splitNote(CAPTURED);
    expect(frontmatter.startsWith("---\n")).toBe(true);
    expect(frontmatter.trimEnd().endsWith("---")).toBe(true);
    expect(body).toBe("\nBody starts here.\n");
  });

  test("an unterminated fence is body text, not a block", () => {
    // Better to show a stray `---` than to swallow the whole note into a
    // Properties row nobody opened.
    const source = "---\ntitle: Truncated\nand then the file just stops\n";
    expect(splitNote(source).frontmatter).toBe("");
    expect(splitNote(source).body).toBe(source);
  });
});

group("properties", () => {
  test("reads a captured-email block the way the row will print it", () => {
    expect(properties(splitNote(CAPTURED).frontmatter)).toEqual([
      { key: "captured", value: "2026-08-29T02:51:47.360Z" },
      { key: "source", value: "email" },
      { key: "trust", value: "untrusted" },
      { key: "subject", value: "Re: lunch on Thursday" },
      { key: "visibility", value: "private" },
    ]);
  });

  test("a colon inside a value survives whole", () => {
    // The first colon splits; every later one is the value's business. An ISO
    // timestamp is the common case and a URL is the other one.
    expect(properties('---\nurl: "https://example.invalid/a:b"\n---\n')).toEqual([
      { key: "url", value: "https://example.invalid/a:b" },
    ]);
  });

  test("fence lines, blank lines and prose are skipped", () => {
    expect(properties("---\n\ntitle: Kept\n\nnot a property line\n---\n")).toEqual([
      { key: "title", value: "Kept" },
    ]);
  });

  test("only surrounding quotes go; quotes inside the value stay", () => {
    expect(properties(`---\na: "x"\nb: 'y'\nc: he said "no"\nd: "unbalanced\n---\n`)).toEqual([
      { key: "a", value: "x" },
      { key: "b", value: "y" },
      { key: "c", value: 'he said "no"' },
      { key: "d", value: '"unbalanced' },
    ]);
  });

  test("a value this reader does not understand is returned as raw text", () => {
    // Deliberately not YAML: a flow map is shown as what it says in the file.
    // This is display-only, so being shallow costs a slightly ugly row, and
    // being clever would cost somebody's note the day we ever wrote one back.
    expect(properties("---\ntags: [one, two]\n---\n")).toEqual([
      { key: "tags", value: "[one, two]" },
    ]);
  });

  test("no frontmatter is no properties", () => {
    expect(properties("")).toEqual([]);
    expect(properties(splitNote("Just prose.\n").frontmatter)).toEqual([]);
  });
});

group("frontmatterTitle", () => {
  test("title wins over subject and name", () => {
    expect(frontmatterTitle("---\nname: N\nsubject: S\ntitle: T\n---\n")).toBe("T");
  });

  test("subject is what an ingested email has instead", () => {
    expect(frontmatterTitle(splitNote(CAPTURED).frontmatter)).toBe("Re: lunch on Thursday");
  });

  test("subject beats name, and name is the last of the three", () => {
    expect(frontmatterTitle("---\nname: N\nsubject: S\n---\n")).toBe("S");
    expect(frontmatterTitle("---\nname: N\n---\n")).toBe("N");
  });

  test("an empty value is not a title", () => {
    // Present but blank is the same as absent: the caller must be free to fall
    // through to the heading or the filename rather than print nothing.
    expect(frontmatterTitle('---\ntitle: ""\nsubject: Real\n---\n')).toBe("Real");
    expect(frontmatterTitle("---\ntitle:   \n---\n")).toBeNull();
  });

  test("null when the block says nothing about a name", () => {
    expect(frontmatterTitle("---\nsource: email\n---\n")).toBeNull();
    expect(frontmatterTitle("")).toBeNull();
  });
});

group("noteHeading", () => {
  test("the frontmatter's title is the first answer", () => {
    expect(noteHeading("---\ntitle: Quarterly plan\n---\n\n# Something else\n", "1-projects/q.md")).toBe(
      "Quarterly plan",
    );
  });

  test("otherwise the body names itself", () => {
    expect(noteHeading("# Lunch on Thursday\n\nProse.\n", "0-inbox/email/3efac11d.md")).toBe(
      "Lunch on Thursday",
    );
    expect(noteHeading("---\nsource: email\n---\n\n#   Spaced out   \n", "a/b.md")).toBe(
      "Spaced out",
    );
  });

  test("only a level-1 heading counts, and a closing run of hashes is not the title", () => {
    expect(noteHeading("## Subheading\n\nProse.\n", "notes/thing.md")).toBe("thing");
    expect(noteHeading("# Titled #\n", "notes/thing.md")).toBe("Titled");
    // No space before the hash means it is part of the text, not a closer.
    expect(noteHeading("# C#\n", "notes/thing.md")).toBe("C#");
  });

  test("a hash inside fenced code is not a heading", () => {
    // A note holding a shell script would otherwise be titled after its
    // shebang comment.
    const source = "```sh\n# !/bin/sh\necho hi\n```\n\n# The real title\n";
    expect(noteHeading(source, "2-areas/snippets.md")).toBe("The real title");
  });

  test("and last, the filename, without its extension", () => {
    // The case the whole chain exists for: a captured note named after the
    // hash of its own contents.
    expect(noteHeading("Prose with no heading.\n", "0-inbox/email/3efac11d4eead8832e5b1236.md")).toBe(
      "3efac11d4eead8832e5b1236",
    );
    expect(noteHeading("", "todo.md")).toBe("todo");
    expect(noteHeading("", "0-inbox/no-extension")).toBe("no-extension");
  });

  test("it keeps falling back rather than printing nothing", () => {
    // A blank heading row reads as a broken screen rather than as an unnamed
    // note, so a basename that is *only* an extension is printed as itself and
    // a path with no basename is printed as the path.
    expect(noteHeading("", ".md")).toBe(".md");
    expect(noteHeading("", "0-inbox/")).toBe("0-inbox/");
    // The one input it cannot rescue is the one that supplied no name at all;
    // pinned so the floor is a stated fact rather than an assumption.
    expect(noteHeading("", "")).toBe("");
  });
});

group("noteHeadingSource — which rung named the note", () => {
  // The inline title is drawn from `noteHeading`; when that came from the
  // body's own `# H1`, drawing it would show the same string twice on the
  // first screen. These pin which case is which.
  test("frontmatter title wins, and the body keeps its heading", () => {
    const note = '---\ntitle: "Run of show"\n---\n\n# Run of show\n\nBody.\n';
    expect(noteHeadingSource(note)).toBe("frontmatter");
    // The body is untouched — the H1 is still there to render.
    expect(splitNote(note).body).toContain("# Run of show");
  });

  test("a body heading names the note, so the title steps aside", () => {
    const note = "# Build decisions\n\nTenancy is bucket-level.\n";
    expect(noteHeadingSource(note)).toBe("heading");
    expect(noteHeading(note, "notes/context-lc.md")).toBe("Build decisions");
  });

  test("no title and no heading falls through to the filename", () => {
    const note = "Just a paragraph, no heading at all.\n";
    expect(noteHeadingSource(note)).toBe("filename");
    expect(noteHeading(note, "0-inbox/email/3efac11d.md")).toBe("3efac11d");
  });

  test("a heading inside a fence does not name the note", () => {
    const note = "```sh\n# not a heading\n```\n\ntext\n";
    expect(noteHeadingSource(note)).toBe("filename");
  });

  test("the heading need not be the first line", () => {
    const note = "\n\nintro paragraph\n\n# The real heading\n";
    expect(noteHeadingSource(note)).toBe("heading");
    expect(noteHeading(note, "notes/x.md")).toBe("The real heading");
  });

  test("nothing here ever alters the file", () => {
    // The whole reason the title steps aside instead of the heading being
    // stripped: on a phone the body IS the editor's buffer.
    for (const note of [
      '---\ntitle: "T"\n---\n# T\nbody\n',
      "# H\nbody\n",
      "plain\n",
      "\r\n# CRLF\r\nbody\r\n",
      "# no trailing newline",
    ]) {
      const { frontmatter, body } = splitNote(note);
      noteHeadingSource(note);
      expect(frontmatter + body).toBe(note);
    }
  });
});
