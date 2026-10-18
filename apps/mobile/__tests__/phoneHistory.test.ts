import { afterEach, describe, expect, test } from "@jest/globals";
import { FOLDERS_PAGE } from "../features/console/home/homeView";
import { HOME_LABEL, phoneBackLevels, slideDirection } from "../features/console/home/phoneBack";
import { previousPage, resetPhoneHistory, visitPage } from "../features/console/home/phoneHistory";

/**
 * **‹ goes back to the page before, however deep the note** (Dev2,
 * 2026-10-18: "when I click the back button it should take me to the previous
 * page, regardless of how nested the note i clicked was").
 *
 * SABOTAGE: `phoneBackLevels` ignoring `previous` sends a deep note opened
 * from Notes to its own folder (first test); `visitPage` always pushing makes
 * a second ‹ return to the note just left (second test).
 */

afterEach(resetPhoneHistory);

const DEEP = "2-areas/public-worship/kings/kings-20.md";
const walk = (...keys: string[]) => keys.forEach((key) => visitPage(key, "w1"));
const back = (selected: string | null, view: "inbox" | "folders" = "inbox") => {
  const levels = phoneBackLevels(selected, false, view, false, previousPage());
  return levels[levels.length - 1];
};

describe("the phone's ‹", () => {
  test("a deep note opened from Notes goes straight back to Notes", () => {
    walk("", DEEP);
    expect(back(DEEP)).toEqual({ folder: null, label: HOME_LABEL, view: "inbox" });
    expect(HOME_LABEL).toBe("Notes");
  });

  test("goes back one page at a time, the way it came", () => {
    walk("", FOLDERS_PAGE, "2-areas", "2-areas/public-worship", DEEP);
    expect(back(DEEP)?.folder).toBe("2-areas/public-worship");
    walk("2-areas/public-worship");
    expect(back("2-areas/public-worship")?.folder).toBe("2-areas");
    walk("2-areas");
    expect(back("2-areas")).toEqual({ folder: null, label: "Folders", view: "folders" });
  });

  test("a note opened from another note goes back to that note, by its name", () => {
    walk("", "1-projects/dc-chapter.md", DEEP);
    expect(back(DEEP)).toEqual({ folder: "1-projects/dc-chapter.md", label: "dc-chapter" });
  });

  test("with nothing before it, it still goes up a level", () => {
    walk(DEEP);
    expect(back(DEEP)?.folder).toBe("2-areas/public-worship/kings");
  });

  test("a new workspace starts a new history", () => {
    walk("", DEEP);
    visitPage("3-resources/mission.md", "w2");
    expect(previousPage()).toBeNull();
  });

  test("Notes itself has no ‹, and returning to the page before slides back", () => {
    walk(DEEP, "");
    expect(phoneBackLevels(null, false, "inbox", false, previousPage())).toEqual([]);
    resetPhoneHistory();
    walk("", "1-projects", DEEP);
    expect(slideDirection(DEEP, "1-projects")).toBe("back");
    expect(slideDirection(DEEP, "")).toBe("back");
  });
});

describe("pressing it", () => {
  const files = (log: string[]) => ({
    select: (path: string) => {
      log.push(path);
      visitPage(path, "w1");
    },
    deselect: () => {
      log.push("");
      visitPage("", "w1");
    },
  });

  test("up from a page with nothing before it keeps going up, never back down", () => {
    const { goToLevel } = require("../features/console/home/phoneBack") as typeof import("../features/console/home/phoneBack");
    const log: string[] = [];
    walk(DEEP);
    for (let press = 0; press < 6; press += 1) {
      const levels = phoneBackLevels(log[log.length - 1] ?? DEEP, false, "inbox", false, previousPage());
      if (levels.length === 0) break;
      goToLevel(levels[levels.length - 1]!, files(log));
    }
    expect(log).toEqual(["2-areas/public-worship/kings", "2-areas/public-worship", "2-areas", ""]);
  });
});
