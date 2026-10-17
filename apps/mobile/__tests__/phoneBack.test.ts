import { describe, expect, test } from "@jest/globals";
import { FOLDERS_LABEL, HOME_LABEL, phoneBackLevels, slideDirection } from "../features/console/home/phoneBack";
import { FOLDERS_PAGE } from "../features/console/home/homeView";

/**
 * Where the phone's ‹ goes and which way a page slides (owner's review,
 * 2026-10-01). The pure half; `noteChrome/pathBar.test.ts` presses the button.
 */
/**
 * The levels ‹ opens (owner, 2026-10-13): Inbox first, then Folders, the
 * page's own folder last, and never the page itself. Inbox and Folders are
 * both the workspace's own page (`folder: null`), told apart by `view`
 * (leadership weekly, 2026-10-17: the phone opens in the Inbox).
 *
 * SABOTAGE: dropping the Inbox row fails the first; taking the page's own path
 * instead of its parent fails the first and second; dropping Folders fails the
 * deep-note test.
 */
describe("the levels behind the back button", () => {
  test("each level names where it goes", () => {
    expect(phoneBackLevels("3-resources/books/lean.md").at(-1)).toEqual({ folder: "3-resources/books", label: "books" });
    expect(phoneBackLevels("3-resources/books").at(-1)).toEqual({ folder: "3-resources", label: "resources" });
  });

  const folders = (path: string | null, mapOpen = false, view: "inbox" | "folders" = "inbox") =>
    phoneBackLevels(path, mapOpen, view).map((level) => level.folder);

  test("a deep note lists Inbox, Folders and every folder above it, nearest last", () => {
    expect(folders("2-areas/health/gym-weights.md")).toEqual([null, null, "2-areas", "2-areas/health"]);
    expect(phoneBackLevels("2-areas/health/gym-weights.md").map((level) => level.label)).toEqual([
      HOME_LABEL,
      FOLDERS_LABEL,
      "areas",
      "health",
    ]);
    expect(phoneBackLevels("2-areas/health/gym-weights.md").slice(0, 2).map((level) => level.view)).toEqual([
      "inbox",
      "folders",
    ]);
  });

  test("a folder lists the levels above it, not itself", () => {
    expect(folders("3-resources/books")).toEqual([null, null, "3-resources"]);
  });

  test("a top-level folder goes back to Folders; a loose note goes straight back to Inbox", () => {
    expect(folders("index.md")).toEqual([null, null]);
    expect(folders("1-projects")).toEqual([null, null]);
    expect(phoneBackLevels("0-inbox/idea.md")).toEqual([{ folder: null, label: HOME_LABEL, view: "inbox" }]);
  });

  test("Folders goes back to Inbox, and Inbox has nothing", () => {
    expect(phoneBackLevels(null, false, "folders")).toEqual([{ folder: null, label: HOME_LABEL, view: "inbox" }]);
    expect(folders(null)).toEqual([]);
    expect(folders("")).toEqual([]);
  });

  test("the homepage's visitor has one top page, Home, and no Folders", () => {
    expect(phoneBackLevels("pricing.md", false, "inbox", true).map((level) => level.label)).toEqual(["Home"]);
    expect(phoneBackLevels("docs/guide.md", false, "inbox", true).map((level) => level.folder)).toEqual([null, "docs"]);
    expect(phoneBackLevels(null, false, "folders", true)).toEqual([]);
  });

  test("the map's only way back is Inbox, whatever is open under it", () => {
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

  test("Folders sits one step in from Inbox, and every folder one step in from it", () => {
    expect(slideDirection("", FOLDERS_PAGE)).toBe("forward");
    expect(slideDirection(FOLDERS_PAGE, "")).toBe("back");
    expect(slideDirection(FOLDERS_PAGE, "1-projects")).toBe("forward");
    expect(slideDirection("1-projects", FOLDERS_PAGE)).toBe("back");
  });
});
