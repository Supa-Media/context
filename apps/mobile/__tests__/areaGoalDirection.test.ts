/**
 * A GOAL'S SHAPE IS PICKED FROM A DROPDOWN, ITS NUMBER THE FIELD BESIDE IT.
 *
 * The owner, 2026-11-26, on Failed deploys showing "Goal 0": "we need this
 * metric to be 'at most' and show like we want at most 2 failed deploys",
 * then "there should just be a dropdown for the different shapes a metric can
 * take", "it shouldnt be typed out". The
 * target stays one line in about.md; the panel reads it as a direction and a
 * bar and writes the two back as one line, keeping the word already used.
 */

import { describe, expect, test } from "@jest/globals";
import { GOAL_SHAPES, goalParts, goalTarget } from "../features/console/files/folderPage/areas/goalDirection";
import { verdictOf } from "../features/console/files/folderPage/areas/verdict";

describe("a goal's direction and bar", () => {
  test("a written direction is split from its bar, in the words it used", () => {
    expect(goalParts("at most 2")).toEqual({ word: "At most", bar: "2" });
    expect(goalParts("at least 100 by Dec 31")).toEqual({ word: "At least", bar: "100 by Dec 31" });
    expect(goalParts("under $600")).toEqual({ word: "Less than", bar: "$600" });
    expect(goalParts("over 5")).toEqual({ word: "More than", bar: "5" });
    expect(goalParts("10 or more")).toEqual({ word: "At least", bar: "10" });
    expect(goalParts("4 or less")).toEqual({ word: "At most", bar: "4" });
  });

  test("a bare number is a goal to reach and a bare zero a limit, as the verdict reads them", () => {
    expect(goalParts("100")).toEqual({ word: "At least", bar: "100" });
    expect(goalParts("0")).toEqual({ word: "At most", bar: "0" });
    expect(goalParts(null)).toEqual({ word: "At least", bar: "" });
  });

  test("the dropdown offers every shape, each one the verdict reads", () => {
    const now = Date.UTC(2026, 10, 26);
    expect(GOAL_SHAPES.map((shape) => shape.word)).toEqual(["At least", "At most", "More than", "Less than"]);
    const kinds = GOAL_SHAPES.map((shape) => verdictOf("3", goalTarget(shape.word, "3"), null, now)?.words);
    expect(kinds).toEqual(["On target", "On target", "Under target", "Needs a look"]);
  });

  test("a direction and a bar write one line; a bar with its own word is taken as typed; empty is no goal", () => {
    expect(goalTarget("At most", "2")).toBe("at most 2");
    expect(goalTarget("Less than", "$500")).toBe("less than $500");
    expect(goalTarget("At least", "100 by Dec 31")).toBe("at least 100 by Dec 31");
    expect(goalTarget("At most", "at least 3")).toBe("at least 3");
    expect(goalTarget("At most", "3 or more")).toBe("3 or more");
    expect(goalTarget("At most", "  ")).toBeNull();
  });

  test("at most 2 failed deploys: 5 needs a look, 2 is on target, 0 exceeds it", () => {
    const now = Date.UTC(2026, 10, 26);
    const target = goalTarget("At most", "2");
    expect(verdictOf("5", target, null, now)?.words).toBe("Needs a look");
    expect(verdictOf("2", target, null, now)?.words).toBe("On target");
    expect(verdictOf("0", target, null, now)?.words).toBe("Exceeds target");
  });
});
