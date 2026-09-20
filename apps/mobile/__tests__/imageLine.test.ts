/**
 * THE IMAGE LINE — the grammar, and the two things it refuses to do.
 *
 * Every case here is a string case, which is the point of the module being
 * pure: the interesting failures are "a paragraph got treated as a row" and "a
 * resize ate somebody's alias", and neither needs a DOM to provoke.
 *
 * The two refusals worth reading first:
 *
 *  - **prose with an image in it is not a row.** If `parseImageLine` ever
 *    returns a line for a sentence, dragging an image would reflow a paragraph.
 *  - **an alias is not a width.** Obsidian uses the same slot for a display
 *    name, so `![[a.png|the sketch]]` has no width and a resize must keep the
 *    name.
 */

import { describe, expect, test } from "@jest/globals";
import {
  embedFor,
  embedsIn,
  isImageLine,
  joinRows,
  lineWithAlign,
  lineWithWidth,
  parseImageLine,
  withWidth,
} from "../features/console/files/imageLine";

describe("what counts as an image line", () => {
  test("one wikilink embed, with and without a width", () => {
    expect(parseImageLine("![[a.png]]")?.images).toEqual([
      { form: "wiki", target: "a.png", alt: "", width: null, from: 0, to: 10 },
    ]);
    expect(parseImageLine("![[a.png|320]]")?.images[0].width).toBe(320);
  });

  test("several embeds on one line are a row, in written order", () => {
    const line = parseImageLine("![[a.png|320]] ![[b.png|240]]");
    expect(line?.images.map((image) => image.target)).toEqual(["a.png", "b.png"]);
    expect(line?.images.map((image) => image.width)).toEqual([320, 240]);
  });

  test("a sentence with an image in it is not a row", () => {
    expect(parseImageLine("Here is ![[a.png]] in a sentence")).toBeNull();
    expect(parseImageLine("![[a.png]] and then some words")).toBeNull();
    expect(isImageLine("see ![[a.png]]")).toBe(false);
  });

  test("a line with no embed is not a row", () => {
    expect(parseImageLine("just words")).toBeNull();
    expect(parseImageLine("")).toBeNull();
  });

  test("a link is not an embed, because the bang is what makes one", () => {
    expect(parseImageLine("[[a.png]]")).toBeNull();
    expect(parseImageLine("[a](b.png)")).toBeNull();
  });

  test("the inline form is read too, and mixed rows keep their order", () => {
    const line = parseImageLine("![alt|320](a.png) ![[b.png]]");
    expect(line?.images.map((image) => image.form)).toEqual(["inline", "wiki"]);
    expect(line?.images[0]).toMatchObject({ alt: "alt", width: 320, target: "a.png" });
  });
});

describe("an alias is not a width", () => {
  test("a word in the alias slot stays an alias", () => {
    const line = parseImageLine("![[a.png|the sketch]]");
    expect(line?.images[0]).toMatchObject({ alt: "the sketch", width: null });
  });

  test("an alias and a width keep each other", () => {
    const line = parseImageLine("![[a.png|the sketch|320]]");
    expect(line?.images[0]).toMatchObject({ alt: "the sketch", width: 320 });
    expect(withWidth(line!.images[0], 480)).toBe("![[a.png|the sketch|480]]");
  });

  test("a resize of an aliased embed does not eat the alias", () => {
    expect(lineWithWidth("![[a.png|the sketch]]", 0, 480)).toBe("![[a.png|the sketch|480]]");
  });

  test("a width that is not a positive integer is not a width", () => {
    expect(parseImageLine("![[a.png|0]]")?.images[0]).toMatchObject({ alt: "0", width: null });
    expect(parseImageLine("![[a.png|30%]]")?.images[0]).toMatchObject({ width: null });
    expect(parseImageLine("![[a.png|-40]]")?.images[0]).toMatchObject({ width: null });
  });
});

describe("resizing writes one number", () => {
  test("a width is added, replaced and removed", () => {
    expect(lineWithWidth("![[a.png]]", 0, 320)).toBe("![[a.png|320]]");
    expect(lineWithWidth("![[a.png|320]]", 0, 480)).toBe("![[a.png|480]]");
    expect(lineWithWidth("![[a.png|320]]", 0, null)).toBe("![[a.png]]");
  });

  test("only the image that was dragged changes", () => {
    expect(lineWithWidth("![[a.png|320]] ![[b.png|320]]", 1, 200)).toBe(
      "![[a.png|320]] ![[b.png|200]]",
    );
  });

  test("the inline form keeps its own shape", () => {
    expect(lineWithWidth("![alt](a.png)", 0, 320)).toBe("![alt|320](a.png)");
    expect(lineWithWidth("![alt|320](a.png)", 0, null)).toBe("![alt](a.png)");
  });

  test("an image that is no longer there is a no-op, not a throw", () => {
    expect(lineWithWidth("![[a.png]]", 4, 320)).toBe("![[a.png]]");
    expect(lineWithWidth("just words", 0, 320)).toBe("just words");
  });

  test("the embed this editor writes", () => {
    expect(embedFor("a.png", null)).toBe("![[a.png]]");
    expect(embedFor("a.png", 480)).toBe("![[a.png|480]]");
    expect(embedFor("a.png", 480, "inline")).toBe("![|480](a.png)");
  });
});

describe("alignment is a comment, and left writes nothing", () => {
  test("center and right are written as a directive", () => {
    expect(lineWithAlign("![[a.png|320]]", "center")).toBe(
      "![[a.png|320]] <!-- context: align=center -->",
    );
    expect(parseImageLine("![[a.png|320]] <!-- context: align=center -->")?.align).toBe("center");
    expect(parseImageLine("![[a.png]] <!-- context: align=right -->")?.align).toBe("right");
  });

  test("left removes the directive, because absent is what every other file looks like", () => {
    expect(lineWithAlign("![[a.png]] <!-- context: align=center -->", "left")).toBe("![[a.png]]");
    expect(lineWithAlign("![[a.png]]", "left")).toBe("![[a.png]]");
  });

  test("changing the alignment does not stack directives", () => {
    const centered = lineWithAlign("![[a.png]]", "center");
    expect(lineWithAlign(centered, "right")).toBe("![[a.png]] <!-- context: align=right -->");
  });

  test("a key this version does not know survives an alignment change", () => {
    const line = "![[a.png]] <!-- context: caption=below align=center -->";
    expect(lineWithAlign(line, "right")).toBe(
      "![[a.png]] <!-- context: caption=below align=right -->",
    );
    expect(lineWithAlign(line, "left")).toBe("![[a.png]] <!-- context: caption=below -->");
  });

  test("a directive is not text, so the line is still a row", () => {
    expect(isImageLine("![[a.png]] <!-- context: align=center -->")).toBe(true);
    expect(parseImageLine("![[a.png]] <!-- context: align=center -->")?.directive).toEqual({
      from: 11,
      to: 41,
    });
  });

  test("an unknown alignment is left, not a crash", () => {
    expect(parseImageLine("![[a.png]] <!-- context: align=diagonal -->")?.align).toBe("left");
  });
});

describe("a drag beside another image joins two rows", () => {
  test("the embed moves, width and all", () => {
    expect(joinRows("![[a.png|320]]", "![[b.png|240]]", 0)).toEqual({
      onto: "![[a.png|320]] ![[b.png|240]]",
      from: "",
    });
  });

  test("dropping onto a row of two makes three, and the source keeps the rest", () => {
    expect(joinRows("![[a.png]] ![[b.png]]", "![[c.png]] ![[d.png]]", 0)).toEqual({
      onto: "![[a.png]] ![[b.png]] ![[c.png]]",
      from: "![[d.png]]",
    });
  });

  test("a drop onto a paragraph is refused rather than rewriting it", () => {
    expect(joinRows("a sentence", "![[b.png]]", 0)).toBeNull();
    expect(joinRows("![[a.png]]", "a sentence", 0)).toBeNull();
    expect(joinRows("![[a.png]]", "![[b.png]]", 3)).toBeNull();
  });
});

describe("embedsIn, on the lines that are not rows", () => {
  test("it still finds the image inside a sentence, for the reader that needs one", () => {
    expect(embedsIn("see ![[a.png|320]] here").map((image) => image.target)).toEqual(["a.png"]);
  });

  test("an inline embed inside a wikilink embed is not counted twice", () => {
    expect(embedsIn("![[a.png]]").length).toBe(1);
  });
});
