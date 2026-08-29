/**
 * LINK EXTRACTION — an authorization input, tested as one.
 *
 * A share permits reading the entry note plus the notes it links to, so this
 * function decides what a share reaches. Everything it over-reports is a note
 * handed to somebody the owner did not mean to hand it to, which is why the
 * tests below are mostly about what it must *not* return.
 *
 * The over-reporting failures are the interesting ones and each has a concrete
 * attack behind it:
 *
 *  - A path mentioned in prose is not a link. If it were, an owner writing "see
 *    1-projects/salaries.md" in a shared note would be sharing it.
 *  - A path inside a code fence is not a link. Otherwise anybody with `editor`
 *    on a context could widen a share they are inside by pasting a code sample.
 *  - `../` must never climb out of the bucket, and must never be *clamped* into
 *    something the author did not write.
 *  - `privacy.md` and `.history/` are never link targets, whatever was typed.
 */

import { describe, expect, test } from "vitest";
import { linkedNotePaths, resolveLinkTarget } from "../functions/lib/noteLinks";

const FROM = "1-projects/transition/overview.md";

describe("what counts as a link", () => {
  test("a markdown link to a sibling note", () => {
    expect(linkedNotePaths("See [the proposal](proposal.md).", FROM)).toEqual([
      "1-projects/transition/proposal.md",
    ]);
  });

  test("a wikilink, with and without a label", () => {
    expect(linkedNotePaths("[[proposal]] and [[proposal-b|the other one]]", FROM)).toEqual(
      ["1-projects/transition/proposal.md", "1-projects/transition/proposal-b.md"],
    );
  });

  test("a wikilink with a heading anchor points at the note", () => {
    expect(linkedNotePaths("[[proposal#Budget]]", FROM)).toEqual([
      "1-projects/transition/proposal.md",
    ]);
  });

  test("a root-relative link", () => {
    expect(linkedNotePaths("[x](/2-areas/org-chart.md)", FROM)).toEqual([
      "2-areas/org-chart.md",
    ]);
  });

  test("a parent-relative link", () => {
    expect(linkedNotePaths("[x](../other/plan.md)", FROM)).toEqual([
      "1-projects/other/plan.md",
    ]);
  });

  test("a link with a title keeps the path and drops the title", () => {
    expect(linkedNotePaths('[x](proposal.md "The Proposal")', FROM)).toEqual([
      "1-projects/transition/proposal.md",
    ]);
  });

  test("duplicates collapse, and the note never links to itself", () => {
    const text = "[a](proposal.md) [b](proposal.md) [c](overview.md) [[proposal]]";
    expect(linkedNotePaths(text, FROM)).toEqual(["1-projects/transition/proposal.md"]);
  });

  test("the order is the order they appear", () => {
    const text = "[a](one.md) then [b](two.md) then [c](three.md)";
    expect(linkedNotePaths(text, FROM)).toEqual([
      "1-projects/transition/one.md",
      "1-projects/transition/two.md",
      "1-projects/transition/three.md",
    ]);
  });
});

describe("what must never count as a link", () => {
  test("a path mentioned in prose is not a link", () => {
    const text = "The numbers are in 1-projects/salaries.md — ask me for access.";
    expect(linkedNotePaths(text, FROM)).toEqual([]);
  });

  /**
   * The privilege-escalation case. An `editor` who cannot change `privacy.md`
   * can still edit a shared note; if a fenced example counted, they could paste
   * one and widen the share they are inside.
   */
  test("a link inside a fenced code block is not a link", () => {
    const text = [
      "Here is how you link to something:",
      "",
      "```markdown",
      "[[private-salaries]]",
      "[x](../../2-areas/private-thing.md)",
      "```",
      "",
      "[the real one](proposal.md)",
    ].join("\n");
    expect(linkedNotePaths(text, FROM)).toEqual(["1-projects/transition/proposal.md"]);
  });

  test("a tilde fence counts as a fence", () => {
    const text = "~~~\n[[private-salaries]]\n~~~\n";
    expect(linkedNotePaths(text, FROM)).toEqual([]);
  });

  test("an unterminated fence swallows the rest of the note", () => {
    const text = "[real](proposal.md)\n\n```\n[[private-salaries]]\n[x](secrets.md)\n";
    expect(linkedNotePaths(text, FROM)).toEqual(["1-projects/transition/proposal.md"]);
  });

  test("a link inside inline code is not a link", () => {
    expect(linkedNotePaths("Write `[[private-salaries]]` to link.", FROM)).toEqual([]);
  });

  test("an external URL is not a note", () => {
    const text = "[a](https://example.invalid/x.md) [b](//example.invalid/y.md)";
    expect(linkedNotePaths(text, FROM)).toEqual([]);
  });

  test("a dangerous scheme is dropped rather than resolved", () => {
    const text = "[a](javascript:alert(1)) [b](data:text/html,x) [c](mailto:x@y.invalid)";
    expect(linkedNotePaths(text, FROM)).toEqual([]);
  });

  test("a link that climbs past the bucket root is refused, not clamped", () => {
    // Clamping would turn this into `passwd.md`, a path the author never wrote.
    expect(resolveLinkTarget("../../../../../passwd", FROM)).toBeNull();
  });

  /**
   * The root `privacy.md` only. A note somebody happens to have called
   * `privacy.md` inside a project folder is an ordinary note, and refusing it
   * would be this module inventing a reserved name the rest of the product does
   * not have — `isPlumbing` matches the root key exactly, and so must this.
   */
  test("the access map is never a link target", () => {
    expect(linkedNotePaths("[x](/privacy.md)", FROM)).toEqual([]);
    expect(linkedNotePaths("[x](../../privacy.md)", FROM)).toEqual([]);
    expect(linkedNotePaths("[[privacy]]", FROM)).toEqual([
      "1-projects/transition/privacy.md",
    ]);
  });

  test("nothing under a dot-folder is a link target", () => {
    expect(linkedNotePaths("[x](/.history/1-projects/overview.md)", FROM)).toEqual([]);
  });

  test("a non-note file is not a link target", () => {
    const text = "[a](slides.pdf) [b](/3-resources/photo.png)";
    expect(linkedNotePaths(text, FROM)).toEqual([]);
  });

  test("an empty or fragment-only target resolves to nothing", () => {
    expect(resolveLinkTarget("", FROM)).toBeNull();
    expect(resolveLinkTarget("#heading", FROM)).toBeNull();
    expect(resolveLinkTarget("   ", FROM)).toBeNull();
  });
});

describe("bounds", () => {
  test("a note with more links than the cap contributes the head of the document", () => {
    const text = Array.from({ length: 500 }, (_, i) => `[x](note-${i}.md)`).join(" ");
    const links = linkedNotePaths(text, FROM);
    expect(links.length).toBeLessThanOrEqual(200);
    expect(links[0]).toBe("1-projects/transition/note-0.md");
  });

  /**
   * Both patterns are module-level literals with `lastIndex` state. If a call
   * left that mid-string, the next note would silently lose its first links —
   * which, on an authorization input, reads as "the share stopped working".
   */
  test("repeated calls do not leak regex state", () => {
    const text = "[a](one.md) [b](two.md) [[three]]";
    const first = linkedNotePaths(text, FROM);
    const second = linkedNotePaths(text, FROM);
    expect(second).toEqual(first);
    expect(second).toHaveLength(3);
  });
});
