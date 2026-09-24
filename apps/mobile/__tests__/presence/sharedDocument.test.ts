/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { createSharedDoc, mergeExternalText, seedSharedDoc } from "../../features/console/presence/sharedDoc";
import { pair } from "./fixtures";

describe("the shared document", () => {
  /**
   * TWO EDITORS, ONE NOTE.
   *
   * These wire two documents to each other the way the room does — whatever
   * one produces, the other applies — and assert the thing the feature is for:
   * both people type at once and both keep every character.
   */

  test("a letter typed in one editor appears in the other", () => {
    const { a, b } = pair();
    seedSharedDoc(a, "hello");
    a.text.insert(5, "!");
    expect(b.markdown()).toBe("hello!");
  });

  test("two people typing at the same time keep both sets of characters", () => {
    // The whole point. Neither edit is discarded and neither overwrites the
    // other, which is what a conflict box exists to ask about and what this
    // removes the need to ask.
    const { a, b } = pair();
    seedSharedDoc(a, "the quick fox");
    a.text.insert(4, "very ");
    b.text.insert(13, " jumps");
    expect(a.markdown()).toBe(b.markdown());
    expect(a.markdown()).toContain("very ");
    expect(a.markdown()).toContain(" jumps");
  });

  test("only one client seeds, so the note does not arrive twice", () => {
    // The duplicated-first-paragraph bug every CRDT editor ships once.
    const { a, b } = pair();
    expect(seedSharedDoc(a, "the note")).toBe(true);
    expect(seedSharedDoc(b, "the note")).toBe(false);
    expect(a.markdown()).toBe("the note");
  });

  test("a late joiner replayed the log lands on the same text", () => {
    const { a } = pair();
    const log: string[] = [];
    const origin = createSharedDoc({ onLocalUpdate: (u) => log.push(u) });
    seedSharedDoc(origin, "a shared note");
    origin.text.insert(13, ", edited");

    const late = createSharedDoc({ onLocalUpdate: () => {} });
    for (const update of log) late.applyRemote(update);
    expect(late.markdown()).toBe(origin.markdown());
    void a;
  });

  test("a malformed update from a peer is refused, not fatal", () => {
    const { a } = pair();
    seedSharedDoc(a, "intact");
    expect(() => a.applyRemote("bm90IGEgdmFsaWQgdXBkYXRl")).not.toThrow();
    expect(a.markdown()).toBe("intact");
  });

  test("an agent's whole-file write lands as just the part that changed", () => {
    // An MCP agent appends a paragraph. If this replaced the document, every
    // caret in the room would jump to the end; instead the untouched prefix is
    // left alone and the new text is an insert.
    const { a, b } = pair();
    seedSharedDoc(a, "# Notes\n\nfirst line\n");
    const before = a.text.toString().indexOf("first");
    mergeExternalText(a, "# Notes\n\nfirst line\nsecond line\n");
    expect(b.markdown()).toBe("# Notes\n\nfirst line\nsecond line\n");
    // The prefix was not re-inserted: the position of existing text is unmoved.
    expect(a.text.toString().indexOf("first")).toBe(before);
  });

  test("an external write identical to the document changes nothing", () => {
    // And reports no span, because a caret is a claim that somebody is
    // working at a position and an identical file is not an edit.
    const { a } = pair();
    seedSharedDoc(a, "same");
    expect(mergeExternalText(a, "same")).toBeNull();
  });

  test("the span it reports is where the tool's text actually landed", () => {
    /*
      This is the position a tool's caret is drawn at, so it is asserted
      against the merged text rather than against the arithmetic that produced
      it: `slice(from, to)` has to be exactly what the tool wrote and nothing
      of what was already there.
    */
    const { a } = pair();
    seedSharedDoc(a, "# Notes\n\nfirst line\n");
    const span = mergeExternalText(a, "# Notes\n\nfirst line\nsecond line\n");
    expect(span).not.toBeNull();
    expect(a.markdown().slice(span!.from, span!.to)).toBe("second line\n");
  });

  test("a tool that rewrote the middle reports the middle", () => {
    // Not an append: the suffix is shared, so the span must stop before it
    // rather than running to the end of the note.
    const { a } = pair();
    seedSharedDoc(a, "top\nMIDDLE\nbottom\n");
    const span = mergeExternalText(a, "top\nchanged\nbottom\n");
    expect(a.markdown().slice(span!.from, span!.to)).toBe("changed");
  });
});
