/**
 * @jest-environment jsdom
 */

/**
 * Recent is the notes this person opened or edited (owner, 2026-10-05), and
 * only what they physically did, never their agents (owner, 2026-10-17). This
 * is the half on the device: when a note is put at the top of their Recent,
 * and what the row says they did.
 *
 *  - Arriving on a note counts, once, as "opened". A redraw, or sitting on it, does not.
 *  - Their own typing counts as "edited": the first keystroke at once, then at
 *    most once a minute, so a note written in for an hour is not stuck at the
 *    time it was opened.
 *  - A changed draft that is not their typing (an agent's edit merged into the
 *    open note) never counts.
 *  - A page run by automation records nothing.
 *  - Nothing counts for a visitor, a folder, or before the page has settled.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The minute ignored: every keystroke counted.  → "their typing counts as edited: at once, then once a minute"
 *  2. `enabled` ignored.                            → "nothing counts while not enabled"
 *  3. `personIsTyping` not asked.                   → "a draft changed by someone else never counts"
 *  4. `drivenByAutomation` not asked.               → "a page run by automation records nothing"
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockCalls: { path: string; kind?: string }[] = [];
const mockConvexClient = {
  mutation: async (_fn: unknown, args: { path: string; kind?: string }) => {
    mockCalls.push(args);
    return null;
  },
};
jest.mock("convex/react", () => ({ useConvex: () => mockConvexClient }));

const mockInput = { typing: false, automated: false };
jest.mock("../features/console/home/personInput", () => ({
  watchPersonInput: () => undefined,
  personIsTyping: () => mockInput.typing,
  drivenByAutomation: () => mockInput.automated,
}));

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
  mockInput.typing = false;
  mockInput.automated = false;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  jest.restoreAllMocks();
});

describe("useRecordRecent", () => {
  test("arriving on a note counts once, as opened, and a redraw does not", () => {
    draw({ enabled: true, path: "1-projects/launch.md", typed: null });
    draw({ enabled: true, path: "1-projects/launch.md", typed: null });
    draw({ enabled: true, path: "clients/acme.md", typed: null });
    expect(mockCalls).toEqual([
      expect.objectContaining({ path: "1-projects/launch.md", kind: "opened" }),
      expect.objectContaining({ path: "clients/acme.md", kind: "opened" }),
    ]);
  });

  test("their typing counts as edited: at once, then once a minute", () => {
    mockInput.typing = true;
    draw({ enabled: true, path: "a.md", typed: null });
    draw({ enabled: true, path: "a.md", typed: "h" });
    draw({ enabled: true, path: "a.md", typed: "he" });
    expect(mockCalls.map((call) => call.kind)).toEqual(["opened", "edited"]);
    clock += RECENT_EDIT_EVERY_MS;
    draw({ enabled: true, path: "a.md", typed: "hel" });
    draw({ enabled: true, path: "a.md", typed: "hell" });
    expect(mockCalls.map((call) => call.kind)).toEqual(["opened", "edited", "edited"]);
  });

  test("a draft changed by someone else never counts", () => {
    // An agent's edit merged into the open note: the draft moves, nobody typed.
    draw({ enabled: true, path: "a.md", typed: null });
    draw({ enabled: true, path: "a.md", typed: "the agent's paragraph" });
    clock += RECENT_EDIT_EVERY_MS * 3;
    draw({ enabled: true, path: "a.md", typed: "the agent's second paragraph" });
    expect(mockCalls.map((call) => call.kind)).toEqual(["opened"]);
    // Their own keystroke after it still counts.
    mockInput.typing = true;
    draw({ enabled: true, path: "a.md", typed: "the agent's second paragraph, and mine" });
    expect(mockCalls.map((call) => call.kind)).toEqual(["opened", "edited"]);
  });

  test("a page run by automation records nothing", () => {
    mockInput.automated = true;
    mockInput.typing = true;
    draw({ enabled: true, path: "a.md", typed: null });
    draw({ enabled: true, path: "a.md", typed: "typed by a script" });
    draw({ enabled: true, path: "b.md", typed: null });
    expect(mockCalls).toHaveLength(0);
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
