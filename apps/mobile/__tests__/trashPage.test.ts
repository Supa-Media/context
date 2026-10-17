/**
 * The Trash page's words, groups and address (`features/console/trash/`,
 * design A, Dev2 2026-10-17).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - group by days left rather than by the 7-day line and an item 7 days out lands under Later;
 *  - round days down and "Erased in 3 days" reads "2" the morning it has 2.4 left;
 *  - drop `trash: undefined` from the map's open and the two pages are open at once.
 */
import { describe, expect, jest, test } from "@jest/globals";
import { routeMap } from "../features/console/map/live/route";
import { routeTrash, trashFromQuery, trashHref } from "../features/console/trash/TrashRouteContext";
import {
  byLine,
  daysLeftLabel,
  eraseLabel,
  eraseSentence,
  fromLabel,
  groupTrash,
  trashName,
  type TrashItem,
} from "../features/console/trash/trashCopy";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 17, 12);

const item = (path: string, daysLeft: number, extra: Partial<TrashItem> = {}): TrashItem => ({
  trash: `.context/trash/x/${path}`,
  path,
  kind: "file",
  at: NOW + daysLeft * DAY - 30 * DAY,
  eraseAt: NOW + daysLeft * DAY,
  byYou: true,
  byName: null,
  notes: 1,
  ...extra,
});

describe("what a row says", () => {
  test("soon is bold-red words, later is a plain count", () => {
    expect(eraseLabel(NOW + 2.4 * DAY, NOW)).toBe("Erased in 3 days");
    expect(eraseLabel(NOW + 0.5 * DAY, NOW)).toBe("Erased in 1 day");
    expect(eraseLabel(NOW - 1, NOW)).toBe("Erased today");
    expect(eraseLabel(NOW + 28 * DAY, NOW)).toBe("28 days left");
    expect(daysLeftLabel(NOW + 3 * DAY, NOW)).toBe("3 days left");
    expect(daysLeftLabel(NOW + 1 * DAY, NOW)).toBe("1 day left");
  });

  test("names and where it was, in the tree's own words", () => {
    expect(trashName({ path: "1-projects/hiring/interview-questions.md", kind: "file" })).toBe("interview-questions");
    expect(trashName({ path: "2-areas/old-onboarding", kind: "folder" })).toBe("old-onboarding");
    expect(fromLabel("1-projects/hiring/q.md")).toBe("from projects / hiring");
    expect(fromLabel("top.md")).toBeNull();
    expect(byLine({ byYou: false, byName: "@ana" })).toBe("@ana deleted it");
    expect(byLine({ byYou: false, byName: null })).toBe("Deleted");
  });

  test("the open note's line names the day", () => {
    expect(eraseSentence(Date.UTC(2026, 10, 16, 12))).toBe("Erased for good on Nov 16 unless you restore it.");
  });
});

describe("groups", () => {
  test("erased within 7 days first, soonest first in each", () => {
    const groups = groupTrash([item("a.md", 20), item("b.md", 3), item("c.md", 7), item("d.md", 8)], NOW);
    expect(groups.soon.map((row) => row.path)).toEqual(["b.md", "c.md"]);
    expect(groups.later.map((row) => row.path)).toEqual(["d.md", "a.md"]);
  });
});

describe("the address", () => {
  test("only ?trash=1 opens it", () => {
    expect(trashFromQuery("1")).toBe(true);
    expect(trashFromQuery(["1"])).toBe(true);
    expect(trashFromQuery("yes")).toBe(false);
    expect(trashFromQuery(undefined)).toBe(false);
    expect(trashHref("seyi")).toBe("/console/@seyi?trash=1");
  });

  test("one page in the slot at a time: opening the trash closes the map, and the map closes the trash", () => {
    const setParams = jest.fn();
    routeTrash({ setParams }, false, "ws").openTrash();
    expect(setParams).toHaveBeenLastCalledWith({ trash: "1", map: undefined, settings: undefined });
    routeMap({ setParams, push: jest.fn() }, false).openMap();
    expect(setParams).toHaveBeenLastCalledWith(expect.objectContaining({ map: "1", trash: undefined }));
  });
});
