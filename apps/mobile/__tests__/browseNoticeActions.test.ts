/**
 * @jest-environment jsdom
 */

/**
 * THE TWO BUTTONS ON BROWSE'S WARN BANNERS, PRESSED.
 *
 * Filmed in the console on a workspace with no bucket: **neither did
 * anything.** Both were rendered, both were enabled, and both had a test
 * asserting they existed — which is exactly the shape of a guard nobody has
 * checked. A button whose presence is asserted and whose press is not is a
 * screenshot, not a control.
 *
 * What the presses actually did:
 *
 *  - **Connect a bucket** was wired `onPress={onOpenSettings}`, and RN hands a
 *    press handler its `GestureResponderEvent`. `BrowsePane`'s prop takes an
 *    optional *section key*, so the event object arrived as the section and
 *    the route was asked to open `?settings=[object Object]`. Nothing resolves
 *    that, so the overlay opened on nothing.
 *  - **Dismiss** was wired to `files.dismissNotice`, which takes no arguments,
 *    so it survived the same mistake by luck — it is pinned here anyway,
 *    because the next person to give it a parameter would break it silently.
 *
 * The fix is one line each and the assertion is what stops it coming back: the
 * press is what these test, and what `onOpenSettings` is *called with* is part
 * of the press. A section key is also better than none — the button says
 * "Connect a bucket", and landing somebody on Overview to go looking for
 * Storage is the same defect one screen further on.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `onPress={onOpenSettings}` restored (the event as the section)        2
 *   the section argument dropped (`onOpenSettings()`)                     1
 *   `onPress={files.dismissNotice}` given an argument it ignores          0
 *     — pinned as a regression guard rather than a caught defect
 */

import { describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  // An owner picker searches through the client; nothing here opens one.
  useConvex: () => ({ query: async () => undefined }),
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { BrowsePane } from "../features/console/panes/BrowsePane";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import { emptyEditor } from "../features/console/files/editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A console with no bucket and a refusal from the server on the notice line. */
function noBucketConsole(over: Partial<FileBrowser> = {}): ConsoleData {
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {},
    expanded: new Set<string>(),
    toggleFolder: () => {},
    collapseAll: () => {},
    selectedPath: null,
    opening: null,
    select: () => true,
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    conflict: null,
    resolveWith: () => {},
    discard: () => {},
    notice: "This context has no bucket connected yet. Connect storage before browsing files.",
    dismissNotice: () => {},
    clipboard: null,
    sync: undefined,
    // No move into another context, unless a test says otherwise.
    // `BrowsePane` reads both on every render, so a fixture without them
    // crashes the pane rather than failing the assertion it was written for.
    contextMoves: [],
    dismissContextMove: () => {},
    // Last, so a test can replace any of the above. It used to sit in the
    // middle, which quietly made `contextMoves` the one field a caller could
    // not set — and that is the field a move notice is drawn from.
    ...over,
  } as unknown as FileBrowser;

  return {
    demo: false,
    viewer: { name: "Seyi", handle: "@seyi" },
    contexts: [{ id: "w1", slug: "seyi", name: "Seyi", kind: "personal", role: "owner" }],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: null,
    endpoint: "https://mcp.example",
    ingestionAddress: "seyi@example",
    ingestion: { settings: undefined },
    files,
    fastSearch: { status: null, loading: false },
    members: { rows: [] },
    loading: false,
    failure: null,
  } as unknown as ConsoleData;
}

function mount(
  data: ConsoleData,
  onOpenSettings: (section?: string) => void,
): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(BrowsePane, { data, onOpenSettings } as never)));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function press(container: HTMLElement, testID: string): void {
  const button = container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
  expect(button).not.toBeNull();
  act(() => button!.click());
}

describe("Connect a bucket", () => {
  test("opens settings, at the section that connects one", () => {
    const opened: Array<string | undefined> = [];
    const { container, unmount } = mount(noBucketConsole(), (section) => opened.push(section));
    press(container, "browse-connect-storage");
    unmount();
    // Compared as strings: a press event here is circular, and asking jest to
    // diff one crashes the worker rather than failing the test.
    expect(opened.map((value) => (typeof value === "string" ? value : typeof value))).toEqual([
      "storage",
    ]);
  });

  /**
   * The defect itself, as its own assertion: the section handed over has to be
   * a section key. A press event arriving here is what made the button dead,
   * and it is invisible in a test that only checks the callback fired.
   */
  test("and never hands the press event over as the section", () => {
    const opened: unknown[] = [];
    const { container, unmount } = mount(noBucketConsole(), (section) => opened.push(section));
    press(container, "browse-connect-storage");
    unmount();
    for (const value of opened) {
      expect(typeof value === "string" || value === undefined).toBe(true);
    }
  });
});

describe("Dismiss", () => {
  test("clears the notice, and is called with nothing", () => {
    const calls: unknown[][] = [];
    const { container, unmount } = mount(
      noBucketConsole({
        dismissNotice: ((...args: unknown[]) => {
          calls.push(args);
        }) as unknown as FileBrowser["dismissNotice"],
      }),
      () => {},
    );
    press(container, "browse-dismiss-notice");
    unmount();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((arg) => typeof arg)).toEqual([]);
  });
});

/**
 * THE DISMISS THAT HAD NOWHERE TO WRITE THE ANSWER.
 *
 * The same defect this file was opened for, one notice along, and the reason
 * it hid so long: the button *was* wired, to a `useState` set in the pane, so
 * it worked perfectly — until the app was closed. A finished move stays
 * listable for a day, so the row came back on the next launch and so did the
 * line. "Moved 1 note to @supa." every time you open the app, with a Dismiss
 * that never sticks.
 *
 * So the press has two halves and the test pins both: the pane hides the line
 * now, and the row is told so it stays hidden. Asserting only the first is how
 * a button ships that looks like it works.
 */
describe("Dismiss, on a move into another context", () => {
  function moveConsole(dismissContextMove: (id: string) => void): ConsoleData {
    return noBucketConsole({
      notice: null,
      dismissContextMove,
      contextMoves: [
        {
          id: "mv1",
          from: "1-projects/acme.md",
          to: "acme.md",
          destination: "@supa",
          status: "complete",
          objects: 1,
          skipped: [],
        },
      ],
    } as unknown as Partial<FileBrowser>);
  }

  test("tells the row, so the line does not come back on the next launch", () => {
    const dismissed: string[] = [];
    const { container, unmount } = mount(
      moveConsole((id) => dismissed.push(id)),
      () => {},
    );
    // The line is there to begin with — otherwise the press below proves
    // nothing about a notice that was never drawn.
    expect(container.textContent).toContain("Moved 1 note to @supa.");

    press(container, "browse-context-move-dismiss-mv1");

    expect(dismissed).toEqual(["mv1"]);
    unmount();
  });

  test("a failure offers to put it aside, not to be rid of it", () => {
    const { container, unmount } = mount(
      noBucketConsole({
        notice: null,
        dismissContextMove: () => {},
        contextMoves: [
          {
            id: "mv2",
            from: "1-projects/acme",
            to: "acme",
            destination: "@supa",
            status: "failed",
            objects: 12,
            skipped: [],
            error: "The bucket stopped answering.",
          },
        ],
      } as unknown as Partial<FileBrowser>),
      () => {},
    );

    /*
      "Not now", because that is what the press does. `dismissContextMove`
      takes a completed move only — a failed one's notice carries the one
      control that can finish it, and the server refuses to hide that for
      good. So this line comes back, and the word has to say so. A "Dismiss"
      that undismisses itself overnight is the complaint this came from.
    */
    const button = container.querySelector('[data-testid="browse-context-move-dismiss-mv2"]');
    expect(button?.textContent).toBe("Not now");
    // And the control that finishes it is still the point of the notice.
    expect(container.querySelector('[data-testid="browse-context-move-resume-mv2"]')).not.toBeNull();
    unmount();
  });

  test("and hides it in the same press, rather than waiting for the query", () => {
    const { container, unmount } = mount(
      moveConsole(() => {}),
      () => {},
    );
    press(container, "browse-context-move-dismiss-mv1");
    // `contextMoves` is a subscription and does not turn around inside the
    // press. Without the pane's own set the line would sit there for a beat
    // after being dismissed, which is a button that reads as broken.
    expect(container.textContent).not.toContain("Moved 1 note to @supa.");
    unmount();
  });
});
