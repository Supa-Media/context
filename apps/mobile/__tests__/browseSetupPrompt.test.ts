/**
 * @jest-environment jsdom
 */

/**
 * THE OFFER, WIRED INTO THE PANE — WHICH IS THE HALF THAT HAS SHIPPED BROKEN BEFORE.
 *
 * `contextSetup.test.ts` proves when the offer should exist and
 * `consoleSetupPrompt.test.ts` proves what the card says. Neither would notice
 * the card being rendered nowhere, or rendered with the wrong workspace, or its
 * import button handed a press event instead of a section key — the exact
 * defect `browseNoticeActions.test.ts` was written for, one notice further down
 * the same band.
 *
 * So this mounts the pane and looks.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the card left out of the notices band                    2
 *   `hasNotice` not counting the offer (band never drawn)    2
 *   `onImportVault={onOpenSettings}` (the event as section)  1
 */

import { describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  // The card's own hook. It is never called here — nothing presses "Create
  // these folders" in this file, because what the mutation does is
  // `workspaces.applyStructure`'s own test's business.
  useMutation: () => async () => undefined,
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
import { LAYOUT_LANDED_MS } from "../features/console/panes/browsePane/useBrowseNotices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A console on a context whose bucket is connected, verified, and empty.
 *
 * The state somebody lands in after paying for managed storage from
 * `/workspace/new`: the binding is healthy, the bucket holds nothing, and the
 * flow that would have asked about a layout was left at Stripe.
 */
function emptyContextConsole(over: {
  role?: string;
  scaffoldReason?: string;
  status?: string;
  structureTemplate?: string;
  /** What the root listing holds. `undefined` leaves it unread. */
  rootEntries?: Array<Record<string, unknown>> | undefined;
  rootUnread?: boolean;
  /** A layout asked for and not yet answered. */
  scaffoldQueuedAt?: number;
  /** Whether the root listing could read `privacy.md`. */
  manifestUsable?: boolean;
  /** Records `ensureListing` calls. */
  listed?: Array<[string, boolean | undefined]>;
} = {}): ConsoleData {
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: over.rootUnread === true
      ? {}
      : {
          "": {
            path: "",
            folderDefault: "private",
            entries: over.rootEntries ?? [],
            truncated: false,
            manifestUsable: over.manifestUsable ?? true,
          },
        },
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
    notice: null,
    dismissNotice: () => {},
    clipboard: null,
    sync: undefined,
    contextId: "w1",
    ensureListing: (path: string, fresh?: boolean) => over.listed?.push([path, fresh]),
  // No move into another context is running. `BrowsePane` reads this on
  // every render, so a fixture without it crashes the pane rather than
  // failing the assertion the test was written for.
  contextMoves: [],
  } as unknown as FileBrowser;

  return {
    demo: false,
    viewer: { name: "Seyi", handle: "@seyi" },
    contexts: [
      {
        id: "w1",
        slug: "sb-studio",
        name: "sb-studio",
        kind: "shared",
        role: over.role ?? "owner",
        structureTemplate: over.structureTemplate,
      },
    ],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: {
      connected: (over.status ?? "connected") === "connected",
      status: over.status ?? "connected",
      provider: "r2",
      bucket: "example-bucket",
      conditionalWrite: true,
      scaffoldReason: over.scaffoldReason ?? "empty",
      scaffoldQueuedAt: over.scaffoldQueuedAt,
    },
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
  onOpenSettings?: (section?: string) => void,
): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() =>
    root.render(
      createElement(BrowsePane, {
        data,
        ...(onOpenSettings === undefined ? {} : { onOpenSettings }),
      } as never),
    ),
  );
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** A folder row as the browser hands one over. */
function folder(name: string): Record<string, unknown> {
  return {
    kind: "folder",
    path: name,
    name,
    visibility: "private",
    inherited: "private",
    exception: false,
  };
}

const find = (container: HTMLElement, testID: string) =>
  container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

describe("an owner who never finished setting a context up", () => {
  test("is offered the layout and the import, in the console they landed in", () => {
    const { container, unmount } = mount(emptyContextConsole(), () => {});
    expect(find(container, "console-setup-prompt")).not.toBeNull();
    expect(find(container, "console-setup-apply")).not.toBeNull();
    expect(find(container, "console-setup-import")).not.toBeNull();
    unmount();
  });

  test("the import opens settings at the section the importer is in", () => {
    // Settings → Storage hosts `VaultImport` and has since before this card
    // existed. The card routes; it does not reimplement an import that clears
    // and rewrites a bucket.
    const opened: Array<string | undefined> = [];
    const { container, unmount } = mount(emptyContextConsole(), (section) =>
      opened.push(section),
    );
    act(() => find(container, "console-setup-import")!.click());
    unmount();
    expect(opened.map((value) => (typeof value === "string" ? value : typeof value))).toEqual([
      "storage",
    ]);
  });

  test("and never hands the press event over as the section", () => {
    // `browse-connect-storage`'s defect, which this band has had once already.
    const opened: unknown[] = [];
    const { container, unmount } = mount(emptyContextConsole(), (section) => opened.push(section));
    act(() => find(container, "console-setup-import")!.click());
    unmount();
    for (const value of opened) {
      expect(typeof value === "string" || value === undefined).toBe(true);
    }
  });

  test("the card is drawn even though it is the only thing in the band", () => {
    /*
      `hasNotice` decides whether the band exists at all, and a card that is
      not counted in it is a card that renders on contexts that happen to have
      another notice and nowhere else. This console has no tier line, a bucket,
      a readable manifest and no refusal — the offer is all there is.
    */
    const { container, unmount } = mount(emptyContextConsole());
    expect(find(container, "console-setup-prompt")).not.toBeNull();
    unmount();
  });

  test("without a route to settings, the layout is still offered", () => {
    // `onOpenSettings` is absent on a console with nowhere to go. The import
    // button goes with it; the folders do not depend on it.
    const { container, unmount } = mount(emptyContextConsole());
    expect(find(container, "console-setup-apply")).not.toBeNull();
    expect(find(container, "console-setup-import")).toBeNull();
    unmount();
  });
});

describe("every other context sees nothing", () => {
  test("a bucket that already held a vault", () => {
    const { container, unmount } = mount(
      emptyContextConsole({ scaffoldReason: "existing-context" }),
      () => {},
    );
    expect(find(container, "console-setup-prompt")).toBeNull();
    unmount();
  });

  test("a context already laid out", () => {
    const { container, unmount } = mount(emptyContextConsole({ scaffoldReason: "created" }), () => {});
    expect(find(container, "console-setup-prompt")).toBeNull();
    unmount();
  });

  test("somebody who is not the owner", () => {
    const { container, unmount } = mount(emptyContextConsole({ role: "editor" }), () => {});
    expect(find(container, "console-setup-prompt")).toBeNull();
    unmount();
  });

  test("a half-written layout whose folders somebody named themselves", () => {
    /*
      The pane's half of the guard: `contextSetupFor` refuses this, and it can
      only refuse it if the recorded template actually reaches it. The field
      travels workspace row → `ConsoleContext` → here, and a break anywhere on
      that path reads as `undefined`, which is exactly the value that means
      "standard" — so the failure mode is silent and this is the assertion that
      is not.
    */
    const { container, unmount } = mount(
      emptyContextConsole({ scaffoldReason: "partial", structureTemplate: "custom" }),
      () => {},
    );
    expect(find(container, "console-setup-prompt")).toBeNull();
    unmount();
  });

  test("a context whose notes arrived after it was verified", () => {
    /*
      THE ONE THIS CARD SHIPPED BROKEN.

      Created empty, verified empty, then filled through a connected AI client
      — which writes notes and never touches `scaffoldReason`. The binding
      still says `empty`, the bucket has folders and notes in it, and the card
      announced "This context is empty" above somebody's open note.
    */
    const { container, unmount } = mount(
      emptyContextConsole({
        scaffoldReason: "empty",
        rootEntries: [folder("1-projects"), folder("2-areas")],
      }),
      () => {},
    );
    expect(find(container, "console-setup-prompt")).toBeNull();
    unmount();
  });

  test("and a context whose listing has not been read yet", () => {
    // Not loaded is not empty. A card in that gap is the same wrong claim,
    // briefly — which on a deep link into a note is the whole of what somebody
    // sees while the tree loads.
    const { container, unmount } = mount(
      emptyContextConsole({ scaffoldReason: "empty", rootUnread: true }),
      () => {},
    );
    expect(find(container, "console-setup-prompt")).toBeNull();
    unmount();
  });

  test("but a half-written standard layout is still offered, as finishing", () => {
    const { container, unmount } = mount(
      emptyContextConsole({ scaffoldReason: "partial", structureTemplate: "para" }),
      () => {},
    );
    expect(find(container, "console-setup-apply")?.textContent ?? "").toMatch(/finish/i);
    unmount();
  });
});

describe("a layout on its way is not a broken context", () => {
  /*
    The first person to sign up after the first-run rebuild landed here seconds
    after "Start fresh": the layout was queued, `privacy.md` did not exist yet,
    and this band said so as a fails-closed privacy warning — with an "empty"
    card on top of it offering to write the layout already on its way.
  */
  const writing = () =>
    emptyContextConsole({ scaffoldQueuedAt: Date.now(), manifestUsable: false, rootEntries: [] });

  test("draws the folders being written, and neither warns nor offers", () => {
    const { container, unmount } = mount(writing(), () => {});
    expect(find(container, "browse-laying-out")?.textContent).toMatch(/Setting up/);
    // Where a note would be — in place of "Choose a note", not stretched
    // across the notice band above it.
    expect(container.textContent).not.toMatch(/Choose a note/);
    // The standard folders and the privacy file, each still on its way.
    for (const row of ["1-projects", "2-areas", "3-resources", "4-archive", "privacy.md"]) {
      expect(find(container, `browse-laying-out-${row}`)).not.toBeNull();
    }
    expect(container.querySelector('[aria-label="written"]')).toBeNull();
    expect(container.textContent).not.toMatch(/privacy\.md is missing/);
    expect(find(container, "console-setup-prompt")).toBeNull();
    unmount();
  });

  test("a stamp nobody answered stops counting, and the truth comes back", () => {
    const stale = emptyContextConsole({
      scaffoldQueuedAt: Date.now() - 10 * 60 * 1000,
      manifestUsable: false,
      rootEntries: [],
    });
    const { container, unmount } = mount(stale, () => {});
    expect(find(container, "browse-laying-out")).toBeNull();
    expect(find(container, "console-setup-prompt")).not.toBeNull();
    unmount();
  });

  test("when it lands, the root is read again rather than left empty", () => {
    const listed: Array<[string, boolean | undefined]> = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    const render = (data: ConsoleData) =>
      act(() => root.render(createElement(BrowsePane, { data, onOpenSettings: () => {} } as never)));
    render(emptyContextConsole({ scaffoldQueuedAt: Date.now(), manifestUsable: false, listed }));
    expect(listed).toEqual([]);
    render(emptyContextConsole({ scaffoldReason: "created", listed }));
    expect(listed).toContainEqual(["", true]);
    act(() => root.unmount());
    container.remove();
  });

  test("when it lands written, the rows tick, and then the card goes", () => {
    jest.useFakeTimers();
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
      const render = (data: ConsoleData) =>
        act(() => root.render(createElement(BrowsePane, { data, onOpenSettings: () => {} } as never)));
      render(emptyContextConsole({ scaffoldQueuedAt: Date.now(), manifestUsable: false }));
      // Landed, and the root on screen is still the one read before it: the
      // card stays, ticked, and the warning stays away.
      render(emptyContextConsole({ scaffoldReason: "created", manifestUsable: false }));
      expect(find(container, "browse-laying-out")?.textContent).toMatch(/folders are ready/);
      // Every row ticked — the folders and the privacy file alike.
      const rows = container.querySelectorAll('[data-testid^="browse-laying-out-"]').length;
      expect(rows).toBeGreaterThan(1);
      expect(container.querySelectorAll('[aria-label="written"]')).toHaveLength(rows);
      expect(container.textContent).not.toMatch(/privacy\.md is missing/);
      act(() => {
        jest.advanceTimersByTime(LAYOUT_LANDED_MS);
      });
      expect(find(container, "browse-laying-out")).toBeNull();
      act(() => root.unmount());
      container.remove();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a layout that lands half-written is not drawn as ready", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    const render = (data: ConsoleData) =>
      act(() => root.render(createElement(BrowsePane, { data, onOpenSettings: () => {} } as never)));
    render(emptyContextConsole({ scaffoldQueuedAt: Date.now(), rootEntries: [] }));
    render(emptyContextConsole({ scaffoldReason: "partial", rootEntries: [] }));
    expect(find(container, "browse-laying-out")).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
