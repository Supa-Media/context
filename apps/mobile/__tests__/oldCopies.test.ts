/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://context.lc/"}
 */

/**
 * The Old copies row and page (board b1 of `remove-copies`, Dev2 2026-10-21):
 * what they say, and that Delete takes two presses on the owner's own page
 * while Keep them hidden is the default answer.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - call `onDelete` on the first press and "a first press only arms" fails;
 *  - drop the `settled` gate and "Delete waits for the hiding" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { OldCopiesPage, OldCopiesRow } from "../features/console/google/OldCopies";
import {
  deleteLine,
  oldCopiesFrom,
  oldCopiesRowLine,
  oldCopiesTitle,
  whatGoes,
  type OldCopiesSummary,
} from "../features/console/google/oldCopiesWords";

const SUMMARY: OldCopiesSummary = {
  state: "hidden",
  days: 696,
  contacts: 1306,
  files: 0,
  firstDay: "2026-09-07",
  lastDay: "2026-10-21",
  since: new Date(2026, 9, 22, 9, 0).getTime(),
  addresses: ["me@example.test", "team@example.test"],
};

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return container;
}

const press = async (container: HTMLElement, id: string) => {
  const target = container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  if (target === null) throw new Error(`nothing to press at ${id}`);
  await act(async () => target.click());
};

describe("what the row and page say", () => {
  test("the row, as the board words it", () => {
    expect(oldCopiesTitle(SUMMARY)).toBe("696 days of mail, calendar and chat");
    expect(oldCopiesRowLine(SUMMARY)).toBe("Copied before Oct 22. Hidden from your notes, search and AI. Still in Download as folders.");
  });

  test("the page names the accounts and the days, and that the mail is still in Gmail", () => {
    expect(oldCopiesFrom(SUMMARY)).toBe(
      "From me@example.test and team@example.test, Sep 7 to Oct 21. Your mail is still in Gmail; these are only Context's copies.",
    );
  });

  test("the count Delete names is what goes, with thousands written out", () => {
    expect(whatGoes(SUMMARY)).toBe("696 days and 1,306 contact pages");
    expect(deleteLine(SUMMARY, true)).toBe("Press again to delete 696 days and 1,306 contact pages. This can't be undone.");
    expect(whatGoes({ ...SUMMARY, days: 1, contacts: 0, files: 3 })).toBe("1 day and 3 attachments");
  });

  test("only contact pages, or one day, still read as a person would say it", () => {
    expect(oldCopiesTitle({ ...SUMMARY, days: 0 })).toBe("1,306 contact pages");
    expect(oldCopiesTitle({ ...SUMMARY, days: 1 })).toBe("1 day of mail, calendar and chat");
  });
});

describe("the page", () => {
  test("the row opens the page", async () => {
    const opened: string[] = [];
    const container = mount(createElement(OldCopiesRow, { summary: SUMMARY, onOpen: () => opened.push("open") }));
    expect(container.textContent).toContain("696 days of mail, calendar and chat");
    await press(container, "old-copies-open");
    expect(opened).toEqual(["open"]);
  });

  test("a first press on Delete only arms it; the second deletes", async () => {
    const calls: string[] = [];
    const container = mount(
      createElement(OldCopiesPage, {
        summary: SUMMARY,
        onBack: () => calls.push("back"),
        onKeep: async () => void calls.push("keep"),
        onDelete: async () => void calls.push("delete"),
      }),
    );
    expect(container.textContent).toContain("Keep them hidden");
    expect(container.textContent).toContain("Contact pages you wrote your own notes on are kept either way.");

    await press(container, "old-copies-delete");
    expect(calls).toEqual([]);
    expect(container.textContent).toContain("Press again to delete 696 days and 1,306 contact pages. This can't be undone.");

    await press(container, "old-copies-delete-confirm");
    expect(calls).toEqual(["delete"]);
  });

  test("Keep them hidden is the owner's answer, and pressing it while Delete is armed disarms instead", async () => {
    const calls: string[] = [];
    const container = mount(
      createElement(OldCopiesPage, {
        summary: SUMMARY,
        onBack: () => {},
        onKeep: async () => void calls.push("keep"),
        onDelete: async () => void calls.push("delete"),
      }),
    );
    await press(container, "old-copies-delete");
    await press(container, "old-copies-keep");
    expect(calls).toEqual([]);
    expect(container.querySelector('[data-testid="old-copies-delete"]')).not.toBeNull();
    await press(container, "old-copies-keep");
    expect(calls).toEqual(["keep"]);
  });

  test("Delete waits for the hiding to finish, so what goes is what was counted", async () => {
    const calls: string[] = [];
    const container = mount(
      createElement(OldCopiesPage, {
        summary: { ...SUMMARY, state: "hiding" },
        onBack: () => {},
        onKeep: async () => {},
        onDelete: async () => void calls.push("delete"),
      }),
    );
    await press(container, "old-copies-delete");
    await press(container, "old-copies-delete");
    expect(calls).toEqual([]);
    expect(container.textContent).toContain("Available once they are all hidden.");
  });
});
