import { describe, expect, test } from "@jest/globals";
import { HOME_LABEL, phoneBackLevels, slideDirection } from "../features/console/home/phoneBack";

/**
 * Where the phone's ‹ goes and which way a page slides (owner's review,
 * 2026-10-01). The pure half; `noteChrome/pathBar.test.ts` presses the button.
 */
/**
 * The levels ‹ opens (owner, 2026-10-13): Home first, the page's own folder
 * last, and never the page itself.
 *
 * SABOTAGE: dropping the Home row fails the first; taking the page's own path
 * instead of its parent fails the first and second.
 */
describe("the levels behind the back button", () => {
  test("each level names where it goes", () => {
    expect(phoneBackLevels("3-resources/books/lean.md").at(-1)).toEqual({ folder: "3-resources/books", label: "books" });
    expect(phoneBackLevels("3-resources/books").at(-1)).toEqual({ folder: "3-resources", label: "resources" });
  });

  const folders = (path: string | null, mapOpen = false) =>
    phoneBackLevels(path, mapOpen).map((level) => level.folder);

  test("a deep note lists Home and every folder above it, nearest last", () => {
    expect(folders("2-areas/health/gym-weights.md")).toEqual([null, "2-areas", "2-areas/health"]);
    expect(phoneBackLevels("2-areas/health/gym-weights.md").map((level) => level.label)).toEqual([
      HOME_LABEL,
      "areas",
      "health",
    ]);
  });

  test("a folder lists the levels above it, not itself", () => {
    expect(folders("3-resources/books")).toEqual([null, "3-resources"]);
  });

  test("the top of the workspace has Home alone, and Home has nothing", () => {
    expect(folders("index.md")).toEqual([null]);
    expect(folders("1-projects")).toEqual([null]);
    expect(folders(null)).toEqual([]);
    expect(folders("")).toEqual([]);
  });

  test("the map's only way back is Home, whatever is open under it", () => {
    expect(folders("2-areas/health/gym-weights.md", true)).toEqual([null]);
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
