import { describe, expect, test } from "@jest/globals";
import { HOME_LABEL, phoneBackTarget, slideDirection } from "../features/console/home/phoneBack";

/**
 * Where the phone's ‹ goes and which way a page slides (owner's review,
 * 2026-10-01). The pure half; `noteChrome/pathBar.test.ts` presses the button.
 */
describe("the phone's back button", () => {
  test("is up one level, naming where it goes", () => {
    expect(phoneBackTarget("3-resources/books/lean.md")).toEqual({ folder: "3-resources/books", label: "books" });
    expect(phoneBackTarget("3-resources/books")).toEqual({ folder: "3-resources", label: "resources" });
  });

  test("goes Home from the top of the workspace", () => {
    expect(phoneBackTarget("index.md")).toEqual({ folder: null, label: HOME_LABEL });
    expect(phoneBackTarget("1-projects")).toEqual({ folder: null, label: HOME_LABEL });
  });

  test("is not there on Home", () => {
    expect(phoneBackTarget(null)).toBeNull();
    expect(phoneBackTarget("")).toBeNull();
  });
});

describe("which way a page slides", () => {
  test("deeper is forward, up is back", () => {
    expect(slideDirection("", "1-projects")).toBe("forward");
    expect(slideDirection("1-projects", "1-projects/plan.md")).toBe("forward");
    expect(slideDirection("1-projects/plan.md", "1-projects")).toBe("back");
    expect(slideDirection("1-projects/a/b.md", "1-projects")).toBe("back");
    expect(slideDirection("1-projects", "")).toBe("back");
  });

  test("a jump sideways is forward, and staying put does not move", () => {
    expect(slideDirection("1-projects/plan.md", "2-areas/home.md")).toBe("forward");
    // A sibling whose name starts with the folder's is not inside it.
    expect(slideDirection("1-projects-old/x.md", "1-projects")).toBe("forward");
    expect(slideDirection("1-projects", "1-projects")).toBe("none");
  });
});
