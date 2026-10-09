/**
 * @jest-environment jsdom
 */

/**
 * The card a tapped dot opens, mounted: the note's words, who is writing and
 * who is reading, the part being typed marked as it is typed, and Close and
 * Expand reaching the page. Dev2 (2026-10-09): "when I click on a dot, it
 * takes me directly to the note ... instead it should show up in a small
 * popup and if I want to expand it I can ... if things are being written, I
 * should see a live view of what's being written". Fake names only.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

let mockText = "# Q4 launch plan\n\nWeek 1: TestFlight.";
const mockReads: string[] = [];

jest.mock("convex/react", () => ({
  useAction: () => async (args: { path: string }) => {
    mockReads.push(args.path);
    return { kind: "file", path: args.path, text: mockText, encrypted: false };
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MapPageState } from "../features/console/map/live/hooks/useMapPage";
import { PEEK_READ_MS, PEEK_WRITING_READ_MS } from "../features/console/map/live/peek/peekModel";
import { NotePeek, type OpenPeek } from "../features/console/map/live/ui/NotePeek";

const NOTE: OpenPeek = { workspaceId: "ws-p", path: "1-projects/launch/q4.md", at: { x: 300, y: 200 } };

function pageWith(working: MapPageState["working"]): MapPageState {
  return {
    working,
    replaying: false,
    events: [],
    now: 0,
    book: { title: () => "Q4 launch plan", known: () => "Q4 launch plan", workspace: () => "Personal" },
  } as unknown as MapPageState;
}

const writer = { id: "w", kind: "agent", name: "@maya's Claude", path: NOTE.path, doing: "edit", at: 1, workspaceId: "ws-p" } as const;
const reader = { id: "r", kind: "agent", name: "ChatGPT", path: NOTE.path, doing: "read", at: 1, workspaceId: "ws-p" } as const;

let root: Root | null = null;
let host: HTMLDivElement;

async function render(props: { working: MapPageState["working"]; onClose?: () => void; onExpand?: () => void; compact?: boolean }) {
  await act(async () =>
    root!.render(
      createElement(NotePeek, {
        page: pageWith(props.working),
        peek: NOTE,
        compact: props.compact ?? false,
        box: { width: 1200, height: 700 },
        onClose: props.onClose ?? (() => {}),
        onExpand: props.onExpand ?? (() => {}),
      }),
    ),
  );
}

const byTest = (id: string) => host.querySelectorAll(`[data-testid="${id}"]`);

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockReads.length = 0;
  mockText = "# Q4 launch plan\n\nWeek 1: TestFlight.";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  jest.useRealTimers();
});

describe("the note card", () => {
  test("shows the note, where it is, and who is writing and reading it", async () => {
    await render({ working: [writer, reader] });
    const card = byTest("map-peek")[0]!;
    expect(card.textContent).toContain("Projects › Launch");
    expect(card.textContent).toContain("Week 1: TestFlight.");
    expect(byTest("map-peek-writing")[0]!.textContent).toBe("@maya's Claude is writing");
    expect(byTest("map-peek-reading")[0]!.textContent).toBe("ChatGPT is reading");
  });

  test("what is typed while it is open shows up, marked, with the writer's name at the caret", async () => {
    await render({ working: [writer] });
    expect(byTest("map-peek-changed")).toHaveLength(0);
    mockText = "# Q4 launch plan\n\nWeek 1: TestFlight. Week 2: fixes.";
    await advance(PEEK_WRITING_READ_MS);
    const changed = byTest("map-peek-changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.textContent).toContain("Week 2: fixes.");
    expect(byTest("map-peek-caret")[0]!.textContent).toBe("@maya's Claude");
  });

  test("read every couple of seconds while written, and seldom when nobody is", async () => {
    await render({ working: [writer] });
    const first = mockReads.length;
    // One step at a time: each read is scheduled once the one before has answered.
    for (let i = 0; i < 4; i += 1) await advance(PEEK_WRITING_READ_MS);
    expect(mockReads.length - first).toBeGreaterThanOrEqual(3);
    await render({ working: [] });
    const quiet = mockReads.length;
    await advance(PEEK_READ_MS - 1);
    expect(mockReads.length - quiet).toBeLessThanOrEqual(1);
  });

  test("Close and Expand reach the page", async () => {
    let closed = 0;
    let expanded = 0;
    await render({ working: [], onClose: () => (closed += 1), onExpand: () => (expanded += 1) });
    await act(async () => (byTest("map-peek-close")[0] as HTMLElement).click());
    await act(async () => (byTest("map-peek-expand")[0] as HTMLElement).click());
    expect(closed).toBe(1);
    expect(expanded).toBe(1);
  });

  test("Escape closes it", async () => {
    let closed = 0;
    await render({ working: [], onClose: () => (closed += 1) });
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(closed).toBe(1);
  });

  test("on a phone the button says Open note", async () => {
    await render({ working: [], compact: true });
    expect(byTest("map-peek-expand")[0]!.textContent).toBe("Open note");
  });
});
