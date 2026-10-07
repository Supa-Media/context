/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MeaningSearchCardView } from "../features/console/search/MeaningSearchCard";
import {
  meaningProgress,
  meaningStateWord,
  meaningSwitchOn,
  type MeaningSearchStatus,
} from "../features/console/search/meaningSearch";

/**
 * Search by meaning's Settings card: on by default for everyone, so the switch
 * is on before anything is built; turning it off takes two presses, because
 * off deletes; and only an owner is offered the switch at all.
 *
 * Sabotage record (temporary local edits, reverted):
 *   off wired to `run(false)` directly, not through `useArming` → "off takes two presses" fails
 *   the switch drawn without `onSet`                          → "a member reads the state and gets no switch" fails
 */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(status: MeaningSearchStatus | undefined, onSet?: (on: boolean) => Promise<void>): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(MeaningSearchCardView, { status, demo: false, onSet }));
  });
}

const text = () => host?.textContent ?? "";
const switches = () => [...document.body.querySelectorAll('[role="checkbox"]')];

async function press(label: string): Promise<void> {
  const node = [...document.body.querySelectorAll("[aria-label]")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  expect(node).toBeDefined();
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the words", () => {
  test("every state but an owner's off reads as switched on", () => {
    expect(meaningSwitchOn("waiting")).toBe(true);
    expect(meaningSwitchOn("preparing")).toBe(true);
    expect(meaningSwitchOn("failed")).toBe(true);
    expect(meaningSwitchOn("off")).toBe(false);
    expect(meaningStateWord("waiting")).toBe("Starting soon");
  });

  test("progress is said only while getting ready, and only with counts", () => {
    expect(meaningProgress({ state: "preparing", canChange: true, notesIndexed: 340, notesPending: 864 })).toBe(
      "340 of 1,204 notes ready",
    );
    expect(meaningProgress({ state: "preparing", canChange: false })).toBeNull();
    expect(meaningProgress({ state: "on", canChange: true, notesIndexed: 5, notesPending: 0 })).toBeNull();
  });
});

describe("the switch", () => {
  test("off takes two presses, and says what it deletes in between", async () => {
    const set = jest.fn(async (_on: boolean) => {});
    mount({ state: "on", canChange: true }, set);
    await press("Turn search by meaning off");
    expect(set).not.toHaveBeenCalled();
    expect(text()).toContain("The fingerprints are deleted");
    await press("Turn search by meaning off");
    expect(set).toHaveBeenCalledWith(false);
  });

  test("on is one press", async () => {
    const set = jest.fn(async (_on: boolean) => {});
    mount({ state: "off", canChange: true }, set);
    await press("Turn search by meaning on");
    expect(set).toHaveBeenCalledWith(true);
  });

  test("a member reads the state and gets no switch", () => {
    mount({ state: "on", canChange: false });
    expect(switches()).toHaveLength(0);
    expect(text()).toContain("Only an owner of this workspace can change this.");
  });

  test("an owner sees how far it has got while it gets ready", () => {
    mount({ state: "preparing", canChange: true, notesIndexed: 3, notesPending: 1 }, async () => {});
    expect(text()).toContain("3 of 4 notes ready");
    expect(text()).toContain("Getting ready");
  });
});
