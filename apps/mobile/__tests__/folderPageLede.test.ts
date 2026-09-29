/** A project's lede: the first paragraph of prose in its front note, as plain words. */

import { describe, expect, test } from "@jest/globals";
import { ledeSource, noteLede, setNoteLede } from "../features/console/files/folderPage/lede";

describe("a note's lede", () => {
  test("is the first paragraph after the frontmatter and the title", () => {
    const text = "---\nstatus: active\n---\n# Custom domains\n\nLet a workspace publish\non a domain it owns.\n\nSecond paragraph.\n";
    expect(noteLede(text)).toBe("Let a workspace publish on a domain it owns.");
  });

  test("passes over fences, lists and quotes to reach prose", () => {
    const text = "# P\n\n```list\nfrom: p\n```\n\n- a\n- b\n\n> quoted\n\nThe real sentence.";
    expect(noteLede(text)).toBe("The real sentence.");
  });

  test("keeps the words of links and emphasis and drops the marks", () => {
    expect(noteLede("See [the plan](https://example.invalid) and [[notes|our notes]], **now** `today`.")).toBe(
      "See the plan and our notes, now today.",
    );
  });

  test("is null for a note with no prose", () => {
    expect(noteLede("---\nstatus: active\n---\n")).toBeNull();
    expect(noteLede("# Only a title\n")).toBeNull();
    expect(noteLede("")).toBeNull();
  });

  test("is capped", () => {
    const lede = noteLede("word ".repeat(200))!;
    expect(lede.length).toBeLessThanOrEqual(320);
    expect(lede.endsWith("…")).toBe(true);
  });
});

describe("editing a note's lede", () => {
  const NOTE = "---\nstatus: active\n---\n# Custom domains\n\nLet a workspace publish\non [a domain](https://example.invalid) it owns.\n\nSecond paragraph.\n";

  test("the field is filled with the paragraph as written, links kept", () => {
    expect(ledeSource(NOTE)).toBe("Let a workspace publish on [a domain](https://example.invalid) it owns.");
    expect(ledeSource("# Only a title\n")).toBe("");
  });

  test("replaces exactly that paragraph and leaves the rest byte for byte", () => {
    const changed = setNoteLede(NOTE, "Publish on your own domain.");
    expect(changed).toEqual({
      text: "---\nstatus: active\n---\n# Custom domains\n\nPublish on your own domain.\n\nSecond paragraph.\n",
    });
    expect(noteLede((changed as { text: string }).text)).toBe("Publish on your own domain.");
  });

  test("passes over a list block to the prose, as reading does", () => {
    const text = "# P\n\n```list\nfrom: p\n```\n\nOld words.\n";
    expect(setNoteLede(text, "New words.")).toEqual({ text: "# P\n\n```list\nfrom: p\n```\n\nNew words.\n" });
  });

  test("a note with no prose gets one after its frontmatter and title", () => {
    expect(setNoteLede("---\nstatus: active\n---\n# Web\n", "What it is for.")).toEqual({
      text: "---\nstatus: active\n---\n# Web\n\nWhat it is for.\n",
    });
    expect(setNoteLede("---\nstatus: active\n---\n", "What it is for.")).toEqual({
      text: "---\nstatus: active\n---\n\nWhat it is for.\n",
    });
    expect(setNoteLede("# Web\n\n- a\n- b\n", "What it is for.")).toEqual({ text: "# Web\n\nWhat it is for.\n\n- a\n- b\n" });
    expect(setNoteLede("", "What it is for.")).toEqual({ text: "What it is for.\n" });
  });

  test("is one paragraph, however it was typed", () => {
    const changed = setNoteLede("# P\n\nOld.\n", "First line\n\nsecond line\n") as { text: string };
    expect(changed.text).toBe("# P\n\nFirst line second line\n");
  });

  test("emptied, removes the paragraph and its gap", () => {
    expect(setNoteLede("# P\n\nOld.\n\nNext.\n", "")).toEqual({ text: "# P\n\nNext.\n" });
    expect(setNoteLede("# P\n", "")).toEqual({ text: "# P\n" });
  });

  test("keeps Windows line endings and a byte-order mark", () => {
    expect(setNoteLede("﻿# P\r\n\r\nOld.\r\n", "New.")).toEqual({ text: "﻿# P\r\n\r\nNew.\r\n" });
  });

  test("refuses a note whose frontmatter never closes", () => {
    expect(setNoteLede("---\nstatus: active\n# P\n", "New.")).toEqual({ error: "the note’s frontmatter is not closed" });
  });
});

describe("a lede edit cannot become anything but a lede", () => {
  test("words that would open frontmatter, a heading or a list are refused", () => {
    const refused = { error: "those words would not read as a description" };
    expect(setNoteLede("Old.\n\n---\nfolder: private\n---\n", "---")).toEqual(refused);
    expect(setNoteLede("# P\n\nOld.\n", "# Another title")).toEqual(refused);
    expect(setNoteLede("# P\n\nOld.\n", "- a list")).toEqual(refused);
    expect(setNoteLede("# P\n\nOld.\n", "```")).toEqual(refused);
    // Removing the paragraph above a `---` would make it the top of the note.
    expect(setNoteLede("Old.\n\n---\nfolder: private\n---\n", "")).toEqual(refused);
  });
});
