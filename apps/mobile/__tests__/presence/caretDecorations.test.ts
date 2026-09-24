/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { clampToDocument } from "../../features/console/presence/protocol";
import { CARET_LABEL_MS, buildCaretDecorations } from "../../features/console/presence/remoteCarets";
import { member, at, resolve } from "./fixtures";

describe("the caret decorations", () => {
  function positions(set: ReturnType<typeof buildCaretDecorations>) {
    const found: { from: number; to: number }[] = [];
    const cursor = set.iter();
    while (cursor.value !== null) {
      found.push({ from: cursor.from, to: cursor.to });
      cursor.next();
    }
    return found;
  }

  test("an offset past the end of the document is clamped, not thrown on", () => {
    // The failure worth the whole feature being reverted: this throws inside
    // the update cycle of an editor somebody is typing in.
    expect(() => buildCaretDecorations([member({ head: at(9_000), anchor: at(9_000) })], 10, 0, new Map(), resolve)).not.toThrow();
    const ranges = positions(buildCaretDecorations([member({ head: at(9_000), anchor: at(9_000) })], 10, 0, new Map(), resolve));
    expect(ranges).toEqual([{ from: 10, to: 10 }]);
  });

  test("a reversed selection is drawn the right way round", () => {
    const ranges = positions(buildCaretDecorations([member({ anchor: at(8), head: at(2) })], 20, 0, new Map(), resolve));
    expect(ranges).toContainEqual({ from: 2, to: 8 });
  });

  test("an empty selection draws a caret and no highlight", () => {
    const ranges = positions(buildCaretDecorations([member({ anchor: at(5), head: at(5) })], 20, 0, new Map(), resolve));
    expect(ranges).toEqual([{ from: 5, to: 5 }]);
  });

  test("several people are added in document order", () => {
    // `RangeSetBuilder` throws "Ranges must be added sorted" otherwise, and the
    // roster arrives in whatever order the room sent it.
    const ranges = positions(
      buildCaretDecorations([member({ id: "a", anchor: at(30), head: at(30) }), member({ id: "b", anchor: at(2), head: at(6) })], 40, 0, new Map(), resolve),
    );
    expect(ranges.map((one) => one.from)).toEqual([2, 6, 30].slice(0, ranges.length));
    expect(ranges).toEqual([...ranges].sort((x, y) => x.from - y.from || x.to - y.to));
  });

  test("a caret the document cannot place is not drawn", () => {
    // The replacement for clamping: a relative position referring to text this
    // client has not received yet resolves to nothing, and nothing is the
    // right thing to draw. Drawing at zero would be a claim about where
    // somebody is standing, and a false one.
    const ranges = positions(
      buildCaretDecorations([member({ head: "p:unresolvable" })], 20, 0, new Map(), resolve),
    );
    expect(ranges).toEqual([]);
  });

  test("clamping is the client's job because the server cannot do it", () => {
    expect(clampToDocument(-1, 10)).toBe(0);
    expect(clampToDocument(11, 10)).toBe(10);
    expect(clampToDocument(4.7, 10)).toBe(4);
  });

  test("the label is drawn only while the caret is recently moved", () => {
    const moved = new Map([["m1", 1_000]]);
    const fresh = buildCaretDecorations([member({ head: at(3) })], 10, 1_000 + CARET_LABEL_MS - 1, moved, resolve);
    const faded = buildCaretDecorations([member({ head: at(3) })], 10, 1_000 + CARET_LABEL_MS + 1, moved, resolve);
    // Same range either way — what changes is the widget, so compare the DOM
    // the widget builds rather than the positions.
    // The caret widget is not necessarily the first range: a member with a
    // selection contributes a mark before it. Find the widget rather than
    // assuming where it sits, which is what the first version of this did.
    const label = (set: ReturnType<typeof buildCaretDecorations>) => {
      const cursor = set.iter();
      while (cursor.value !== null) {
        const spec = cursor.value.spec as { widget?: { toDOM: () => HTMLElement } };
        if (spec.widget) return spec.widget.toDOM().textContent;
        cursor.next();
      }
      return null;
    };
    expect(label(fresh)).toBe("@ana");
    expect(label(faded)).toBe("");

    /*
      Except for a tool's, which never fades.

      A person's caret keeps moving, so its label comes back whenever they do
      anything; a tool's lands once when its write does and then sits still
      until it is taken down about a minute later. Fading it leaves an
      unattributed caret in somebody's note for the rest of that minute, which
      is precisely the question — *who is changing this?* — the feature exists
      to answer.
    */
    const tool = member({ head: at(3), name: "Some Client", isAgent: true });
    const long = buildCaretDecorations([tool], 10, 1_000 + CARET_LABEL_MS * 100, moved, resolve);
    expect(label(long)).toBe("Some Client");
  });
});
