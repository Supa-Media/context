/**
 * The chaos score's words in the app: the figure's t, the word, the arrow
 * against a week ago, a folder's hint, and when a folder page earns a chip.
 * Pure — `features/chaos/chaosModel.ts` decides; the surfaces only draw.
 */

import { describe, expect, test } from "@jest/globals";
import {
  biggestWins,
  chaosToT,
  chaosWord,
  chipLabel,
  chipShows,
  folderHint,
  folderLabel,
  itemsLabel,
  scoreShown,
  shownScore,
  trendAgainst,
  treeChanged,
  treeShape,
  type ChaosScore,
} from "../features/chaos/chaosModel";
import { chaosWord as rubricWord, folderChaos } from "../../mcp/src/chaos/rubric.js";

const strip = (text: string): string => text.replace(/[\u2066-\u2069]/g, "");

const SCORE: ChaosScore = {
  kind: "chaosScore",
  available: true,
  score: 34,
  word: "crowded",
  weekAgo: 41,
  folders: [],
  longNotes: [],
  folder: null,
};

describe("the figure's t", () => {
  test("chaos 100 is the full scribble, 0 the calm #", () => {
    expect(chaosToT(100)).toBe(0);
    expect(chaosToT(0)).toBe(1);
    expect(chaosToT(25)).toBeCloseTo(0.75);
  });
  test("out of range and not a number are held to the ends", () => {
    expect(chaosToT(140)).toBe(0);
    expect(chaosToT(-5)).toBe(1);
    expect(chaosToT(Number.NaN)).toBe(0);
  });
});

describe("the word", () => {
  test("matches the rubric's at every boundary", () => {
    for (const chaos of [0, 10, 10.5, 11, 30, 31, 60, 61, 100]) {
      expect(chaosWord(chaos)).toBe(rubricWord(chaos));
    }
  });
  test("the score shown is a whole number from 0 to 100", () => {
    expect(shownScore(33.6)).toBe(34);
    expect(shownScore(-1)).toBe(0);
    expect(shownScore(101)).toBe(100);
  });
});

describe("against a week ago", () => {
  test("lower is better, so down is the good arrow", () => {
    expect(trendAgainst(34, 41)).toEqual({ arrow: "↓", better: true, label: "down 7 from a week ago" });
    expect(trendAgainst(41, 34)).toEqual({ arrow: "↑", better: false, label: "up 7 from a week ago" });
  });
  test("nothing when unknown, or the same once rounded", () => {
    expect(trendAgainst(34, null)).toBeNull();
    expect(trendAgainst(34.2, 33.9)).toBeNull();
    expect(trendAgainst(null, 30)).toBeNull();
  });
});

describe("a folder's hint", () => {
  test("thin, empty and crowded say what calm is", () => {
    expect(folderHint(2, folderChaos(2))).toBe("thin: calm is 4 to 5");
    expect(folderHint(0, folderChaos(0))).toBe("only its about note");
    expect(folderHint(14, folderChaos(14))).toBe("crowded: calm is 4 to 5, 10 is average");
    expect(folderHint(30, folderChaos(30))).toBe("chaotic: calm is 4 to 5, 10 is average");
  });
  test("a built-in folder below four is not thin, and four to ten read plainly", () => {
    expect(folderHint(2, 0)).toBe("calm");
    expect(folderHint(5, 0)).toBe("calm");
    expect(folderHint(8, folderChaos(8))).toBe("fine");
  });
  test("items are counted in words", () => {
    expect(itemsLabel(1)).toBe("1 item");
    expect(itemsLabel(12)).toBe("12 items");
  });
  test("a folder is named without its sort number, and the root has a name", () => {
    expect(strip(folderLabel("1-projects/website"))).toBe("projects/website");
    expect(folderLabel("")).toBe("Top level");
  });
});

describe("the folder page's chip", () => {
  test("only past fine, or thin", () => {
    expect(chipShows(null)).toBe(false);
    expect(chipShows({ folder: "a", items: 12, chaos: 33 })).toBe(true);
    expect(chipShows({ folder: "a", items: 10, chaos: 25 })).toBe(false);
    expect(chipShows({ folder: "a", items: 2, chaos: 20 })).toBe(true);
    expect(chipShows({ folder: "a", items: 2, chaos: 0 })).toBe(false);
    expect(chipShows({ folder: "a", items: 5, chaos: 0 })).toBe(false);
  });
  test("says the count and the word, and thin is its own word", () => {
    expect(chipLabel({ folder: "a", items: 12, chaos: 33 })).toBe("12 items · crowded");
    expect(chipLabel({ folder: "a", items: 1, chaos: 40 })).toBe("1 item · thin");
  });
});

describe("whether there is a score to show", () => {
  test("not scored yet shows nothing", () => {
    expect(scoreShown(null)).toBe(false);
    expect(scoreShown({ ...SCORE, available: false, score: null })).toBe(false);
    expect(scoreShown({ ...SCORE, score: null })).toBe(false);
    expect(scoreShown(SCORE)).toBe(true);
  });
  test("biggest wins are at most five, in the server's order, with nothing calm", () => {
    const folders = [70, 50, 40, 30, 20, 10, 0].map((chaos, i) => ({ folder: `f${i}`, items: 10, chaos }));
    expect(biggestWins({ ...SCORE, folders }).map((f) => f.folder)).toEqual(["f0", "f1", "f2", "f3", "f4"]);
    expect(biggestWins({ ...SCORE, folders: [{ folder: "x", items: 4, chaos: 0 }] })).toEqual([]);
  });
});

describe("when the tree changed", () => {
  const listing = (path: string, names: string[]) => ({
    path,
    entries: names.map((name) => ({ path: path === "" ? name : `${path}/${name}` })),
  });
  test("a folder loaded for the first time is not a change", () => {
    const before = treeShape({ "": listing("", ["a"]) });
    const after = treeShape({ "": listing("", ["a"]), a: listing("a", ["x.md"]) });
    expect(treeChanged(before, after)).toBe(false);
  });
  test("something added, removed or moved in a loaded folder is", () => {
    const before = treeShape({ "": listing("", ["a", "b.md"]) });
    expect(treeChanged(before, treeShape({ "": listing("", ["a", "b.md", "c.md"]) }))).toBe(true);
    expect(treeChanged(before, treeShape({ "": listing("", ["a"]) }))).toBe(true);
    expect(treeChanged(before, treeShape({}))).toBe(true);
  });
  test("the same entries in another order are the same tree", () => {
    const before = treeShape({ "": listing("", ["a", "b.md"]) });
    expect(treeChanged(before, treeShape({ "": listing("", ["b.md", "a"]) }))).toBe(false);
  });
});
