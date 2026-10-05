/**
 * @jest-environment jsdom
 */

/**
 * Recent is the notes this person opened or edited (owner, 2026-10-05). This
 * is the half on the device: when a note is put at the top of their Recent.
 *
 *  - Arriving on a note counts, once. A redraw, or sitting on it, does not.
 *  - Typing in it counts again, at most once a minute, so a note written in for
 *    an hour is not stuck at the time it was opened.
 *  - Nothing counts for a visitor, a folder, or before the page has settled.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The minute ignored: every keystroke counted. → "typing counts again, once a minute"
 *  2. `enabled` ignored.                         → "nothing counts while not enabled"
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockCalls: { path: string }[] = [];
const mockConvexClient = {
  mutation: async (_fn: unknown, args: { path: string }) => {
    mockCalls.push(args);
    return null;
  },
};
jest.mock("convex/react", () => ({ useConvex: () => mockConvexClient }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RECENT_EDIT_EVERY_MS, useRecordRecent } from "../features/console/home/useHomePlaces";

type Props = { enabled: boolean; path: string | null; typed: string | null };

function Probe(props: Props) {
  useRecordRecent("ws_1", props.enabled, props.path, props.typed);
  return null;
}

let root: Root;
let clock = Date.UTC(2026, 9, 5, 12);

function draw(props: Props) {
  act(() => root.render(createElement(Probe, props)));
}

beforeEach(() => {
  mockCalls.length = 0;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  jest.restoreAllMocks();
});

describe("useRecordRecent", () => {
  test("arriving on a note counts once, and a redraw does not", () => {
    draw({ enabled: true, path: "1-projects/launch.md", typed: null });
    draw({ enabled: true, path: "1-projects/launch.md", typed: null });
    draw({ enabled: true, path: "clients/acme.md", typed: null });
    expect(mockCalls.map((call) => call.path)).toEqual(["1-projects/launch.md", "clients/acme.md"]);
  });

  test("typing counts again, once a minute", () => {
    draw({ enabled: true, path: "a.md", typed: null });
    draw({ enabled: true, path: "a.md", typed: "h" });
    draw({ enabled: true, path: "a.md", typed: "he" });
    expect(mockCalls).toHaveLength(1);
    clock += RECENT_EDIT_EVERY_MS;
    draw({ enabled: true, path: "a.md", typed: "hel" });
    draw({ enabled: true, path: "a.md", typed: "hell" });
    expect(mockCalls).toHaveLength(2);
  });

  test("nothing counts while not enabled, or without a note", () => {
    draw({ enabled: false, path: "a.md", typed: null });
    draw({ enabled: true, path: null, typed: null });
    expect(mockCalls).toHaveLength(0);
    // Settling later is still the arrival.
    draw({ enabled: true, path: "a.md", typed: null });
    expect(mockCalls).toHaveLength(1);
  });
});
