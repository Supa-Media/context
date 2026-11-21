/**
 * The Search page's settings and "Try a search" panel, as pure logic: a setting's value is refused when it is out of
 * its bounds or not whole where it must be, and a hit's rank is compared between main and the draft. The panel itself
 * is only its markup over these.
 *
 * Every value here is fake. This repository is public.
 */
import { describe, expect, test } from "@jest/globals";
import { SEARCH_SETTINGS_BOUNDS, SETTINGS_OF } from "../../../apps/mcp/src/search/config/searchConfig.cjs";
import { SETTING_TEXT, checkSetting, rankMoves } from "../app/data/searchSettings";

describe("checkSetting: a value the step may take", () => {
  test("a whole number inside the bounds is saved as that number", () => {
    expect(checkSetting("hits", "10")).toEqual({ ok: true, value: 10 });
    expect(checkSetting("extraNotes", 0)).toEqual({ ok: true, value: 0 });
  });

  test("the bounds themselves are allowed", () => {
    expect(checkSetting("hits", "1").ok).toBe(true);
    expect(checkSetting("hits", "50").ok).toBe(true);
    expect(checkSetting("minScore", "0").ok).toBe(true);
    expect(checkSetting("minScore", "1").ok).toBe(true);
  });

  test("a fraction is fine where the setting is not whole", () => {
    expect(checkSetting("titleWeight", "0.25")).toEqual({ ok: true, value: 0.25 });
  });
});

describe("checkSetting: refused, with the bound shown", () => {
  test("above the maximum names the bound and is not saved", () => {
    const r = checkSetting("hits", "51");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe("Hits shown must be from 1 to 50");
  });

  test("below the minimum names the bound", () => {
    const r = checkSetting("snippetChars", "10");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe("Snippet length must be from 50 to 2000");
  });

  test("a fraction where the setting must be whole is refused", () => {
    const r = checkSetting("looseReads", "2.5");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe("Meaning-only reads (no full match) must be a whole number");
  });

  test("text that is not a number, or an empty box, is refused", () => {
    expect(checkSetting("hits", "ten").ok).toBe(false);
    expect(checkSetting("hits", "   ").ok).toBe(false);
    expect(checkSetting("hits", "Infinity").ok).toBe(false);
  });

  test("a name that is not a search setting is refused", () => {
    expect(checkSetting("nope", "1").ok).toBe(false);
  });
});

describe("the settings' labels", () => {
  test("every setting a search step reads has a label and a tip", () => {
    const keys = new Set(Object.values(SETTINGS_OF).flat());
    for (const k of keys) {
      expect(SETTING_TEXT[k]?.label).toBeTruthy();
      expect(SETTING_TEXT[k]?.tip).toBeTruthy();
    }
  });

  test("every bound has a label, and no label is for a setting that does not exist", () => {
    expect(Object.keys(SETTING_TEXT).sort()).toEqual(Object.keys(SEARCH_SETTINGS_BOUNDS).sort());
  });
});

describe("rankMoves: where a hit sits between main and the draft", () => {
  const main = [
    { key: "a", title: "Alpha" },
    { key: "b", title: "Beta" },
    { key: "c", title: "Gamma" },
  ];

  test("a hit that kept its rank is 'same'", () => {
    const d = rankMoves(main, [{ key: "a", title: "Alpha" }]);
    expect(d[0]).toEqual({ key: "a", title: "Alpha", rank: 1, was: 1, move: "same" });
  });

  test("a hit the draft lifted is 'up', and one it dropped is 'down'", () => {
    const d = rankMoves(main, [
      { key: "c", title: "Gamma" },
      { key: "a", title: "Alpha" },
      { key: "b", title: "Beta" },
    ]);
    expect(d.map((x) => [x.key, x.was, x.rank, x.move])).toEqual([
      ["c", 3, 1, "up"],
      ["a", 1, 2, "down"],
      ["b", 2, 3, "down"],
    ]);
  });

  test("a hit main did not have is 'new' with no earlier rank", () => {
    const d = rankMoves(main, [{ key: "z", title: "Zeta", meaningOnly: true }]);
    expect(d[0]).toEqual({ key: "z", title: "Zeta", rank: 1, was: null, move: "new", meaningOnly: true });
  });

  test("an empty draft answer has no rows", () => {
    expect(rankMoves(main, [])).toEqual([]);
  });
});
