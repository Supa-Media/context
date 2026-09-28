import { describe, expect, test } from "@jest/globals";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";
import { cursorPosition } from "../features/console/presence/sync";
import {
  lineWords,
  memberWhere,
  pileFaces,
  pileGeometry,
  presenceLabel,
  presenceListTitle,
  presenceShown,
} from "../features/console/presence/pile";

const member = (id: string, name: string) => ({
  id,
  name,
  color: "#8b5cf6",
  anchor: null,
  head: null,
  canWrite: true,
  isAgent: false,
});

describe("presence pile label", () => {
  test("names one remote editor and distinguishes it from the current person", () => {
    expect(
      presenceLabel({ phase: "live", summary: "1 here", members: [member("m1", "@ana")] }),
    ).toBe("@ana · 1 other here");
  });

  test("names the first two remote editors and keeps the total count", () => {
    expect(
      presenceLabel({
        phase: "live",
        summary: "3 here",
        members: [member("m1", "@ana"), member("m2", "@bo"), member("m3", "@cy")],
      }),
    ).toBe("@ana, @bo +1 · 3 others here");
  });

  test("does not claim stale names while reconnecting", () => {
    expect(
      presenceLabel({ phase: "reconnecting", summary: "Reconnecting", members: [member("m1", "@ana")] }),
    ).toBe("Reconnecting");
  });

  test("a demonstration says so, so nobody takes the homepage's cast for real people", () => {
    expect(
      presenceLabel({ phase: "live", summary: "1 here", members: [member("m1", "@maya")], demo: true }),
    ).toBe("@maya · 1 other here · demo");
  });
});

describe("presence pile", () => {
  test("draws nothing when nobody else is here or presence is off", () => {
    expect(presenceShown({ phase: "live", summary: "" })).toBe(false);
    expect(presenceShown({ phase: "unavailable", summary: "1 here" })).toBe(false);
    expect(presenceShown({ phase: "idle", summary: "1 here" })).toBe(false);
    expect(presenceShown({ phase: "live", summary: "1 here" })).toBe(true);
    expect(presenceShown({ phase: "reconnecting", summary: "Reconnecting" })).toBe(true);
  });

  test("shows every face up to the limit, then folds the rest into +n", () => {
    expect(pileFaces([1, 2, 3], 3)).toEqual({ faces: [1, 2, 3], more: 0 });
    // Never wider than the limit: the last slot becomes the count.
    expect(pileFaces([1, 2, 3, 4, 5, 6], 3)).toEqual({ faces: [1, 2], more: 4 });
    expect(pileFaces([1, 2, 3, 4, 5], 4)).toEqual({ faces: [1, 2, 3], more: 2 });
  });

  /**
   * A phone's pile is smaller: 18pt faces overlapping by 6, so three people
   * take about 44pt of the breadcrumb row rather than about 66 (owner,
   * 2026-09-27, the phone artboards). Still three slots, the last a +n.
   *
   * SABOTAGE: `pileGeometry` answering the pointer's numbers for `compact`.
   */
  test("a phone's pile is 18pt faces overlapping by 6, three slots at most", () => {
    const phone = pileGeometry(true);
    expect(phone).toEqual({ face: 18, overlap: 6, limit: 3 });
    // Three faces, drawn: 18 + 2 × (18 − 6) = 42pt — about 44 with the padding.
    expect(phone.face + (phone.limit - 1) * (phone.face - phone.overlap)).toBe(42);
    // The pointer layout is unchanged.
    expect(pileGeometry(false)).toEqual({ face: 24, overlap: 3, limit: 4 });
  });

  test("the list heading counts others, not the reader", () => {
    expect(presenceListTitle({ members: [member("m1", "@ana")] })).toBe("1 other here now");
    expect(presenceListTitle({ members: [member("m1", "@ana"), member("m2", "@bo")] })).toBe("2 others here now");
  });
});

describe("where somebody is", () => {
  const text = "---\ntitle: pricing\n---\n\n# <!--c:tvty-->free, you cheapo<!--/c:tvty-->\n\n- **unlimited** notes for everyone who signs up early\n";

  test("quotes the words of their line, without markup or comment anchors", () => {
    expect(lineWords(text, text.indexOf("cheapo"))).toBe("free, you cheapo");
    expect(lineWords(text, text.indexOf("notes"))).toBe("unlimited notes for everyone who si…");
  });

  test("a caret at the very end of a line still names that line", () => {
    const end = text.indexOf("\n", text.indexOf("cheapo"));
    expect(lineWords(text, end)).toBe("free, you cheapo");
  });

  test("with no caret, a person is reading and an agent is writing", () => {
    expect(memberWhere({ head: null, isAgent: false }, null)).toBe("Reading");
    expect(memberWhere({ head: null, isAgent: true }, null)).toBe("Writing");
    expect(memberWhere({ head: "not-a-position", isAgent: false }, null)).toBe("Reading");
  });

  test("a real caret in the room reads as the words of its line", () => {
    const shared = createSharedDoc({});
    seedSharedDoc(shared, "# Pricing\n\nPremium is five bucks.\n");
    const head = cursorPosition(shared.text, "# Pricing\n\nPremium is".length);
    expect(head).not.toBeNull();
    expect(memberWhere({ head, isAgent: true }, shared)).toBe("At “Premium is five bucks.”");
  });
});
