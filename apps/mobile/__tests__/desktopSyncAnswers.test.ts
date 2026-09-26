/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A parked rename or delete can be answered on every layout.
 *
 * The answers live on the sync sheet's rows, and the sheet was the phone's —
 * opened from the phone's pill. On a pointer layout the same op was marked in
 * the tree and counted in the status strip ("2 notes need you") and could not
 * be answered anywhere: a change stranded with no way to act on it. The strip's
 * sync segments now open the same sheet, the same rows, the same answers.
 *
 * Sabotage-checked: taking `onPress` off the strip's sync segments (the map in
 * `Status`) fails every test here.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * `BrowsePane` now instantiates its own passphrase controller
 * (`useNoteEncryption`, for the "Password-encrypt content" advanced option
 * and a locked note's own view), which calls `useAction`. None of these
 * renders wrap the tree in a real `ConvexProvider` -- nothing here exercises
 * encryption -- so a stub that refuses if actually called is enough to let
 * the pane mount.
 */
// These layout fixtures have no authenticated gateway session.
jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => { throw new Error("No fixture gateway session"); },
}));

jest.mock("convex/react", () => ({
  // An owner picker searches through the client; nothing here opens one.
  useConvex: () => ({ query: async () => undefined }),
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

/*
  `Slot` is the real Browse pane, because the phone's half of this figure is
  drawn by a *page* now rather than by a panel of the frame. It used to be
  `() => null` and could be: the file tree was mounted by the layout, so the
  footer existed without any route rendering. The pane is what draws the
  context root, so a mock that renders nothing would assert this feature absent
  and pass.
*/
jest.mock("expo-router", () => ({
  Slot: () => {
    const { createElement: h } = require("react") as typeof import("react");
    const { BrowsePane } =
      require("../features/console/panes/BrowsePane") as typeof import("../features/console/panes/BrowsePane");
    const { useConsoleData } =
      require("../features/console/ConsoleDataContext") as typeof import("../features/console/ConsoleDataContext");
    return h(BrowsePane, { data: useConsoleData() });
  },
  Redirect: () => null,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/console/@seyi",
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

// The layout is what is under test; its data source is not.
jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

const { pendingMarks } =
  require("../features/console/files/pendingMarks") as typeof import("../features/console/files/pendingMarks");

/** Every answer the sheet sent, as `id:answer`. */
const mockAnswers: string[] = [];

/** A rename parked on a conflict, and a delete refused — the two kinds of answer. */
const mockMarks = pendingMarks([], {
  ops: [
    {
      id: "r1",
      kind: "move",
      path: "1-projects/plan.md",
      to: "1-projects/plan-2026.md",
      baseEtag: "e1",
      queuedAt: 1,
      updatedAt: 1,
      attempts: 1,
      state: "conflicted",
      conflict: { currentEtag: "e9", message: "That note changed somewhere else.", noticedAt: 1 },
    },
    {
      id: "d1",
      kind: "trash",
      path: "0-inbox/old-notes.md",
      baseEtag: "e2",
      queuedAt: 2,
      updatedAt: 2,
      attempts: 1,
      state: "rejected",
      rejection: { code: "FILE_NOT_FOUND", message: "That file does not exist.", noticedAt: 2 },
    },
  ],
});

/**
 * What is open, and therefore which page is on screen.
 *
 * `""` is the context root — the page that carries the foot. A subfolder is
 * what the negative case selects; see `a folder page inside the context carries
 * no caption`.
 */
let mockSelected: string | null = "";

function mockConsoleData(): never {
  const files = {
    // No move into another context is running. `BrowsePane` reads this on
    // every render, so a fixture without it crashes the pane rather than
    // failing the assertion the test was written for.
    contextMoves: [],
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [
          {
            kind: "folder" as const,
            path: "1-projects",
            name: "1-projects",
            visibility: "private" as const,
            inherited: "private" as const,
            exception: false,
            readOnly: false,
          },
        ],
      },
      "1-projects": {
        path: "1-projects",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [
          {
            kind: "note" as const,
            path: "1-projects/plan.md",
            name: "plan.md",
            visibility: "team" as const,
            inherited: "private" as const,
            exception: true,
            readOnly: false,
          },
        ],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: mockSelected,
    opening: null,
    conflict: null,
    canSetVisibility: true,
    canShare: true,
    canResetPrivacy: false,
    resetPrivacy: () => {},
    shares: [],
    share: () => {},
    teamShareLink: () => {},
    revokeShare: () => {},
    setSharePreviewTitle: () => {},
    copyShareLink: () => {},
    openLinkPaths: new Set<string>(),
    linkPaths: [],
    setScope: () => {},
    collapseAll: () => {},
    copyTo: () => {},
    select: () => {},
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    resolveWith: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    toasts: [],
    dismissToast: () => {},
    clipboard: null,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    createNote: () => {},
    createFolder: () => {},
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
    sync: {
      reachability: "online",
      counts: { pending: 0, conflicted: 1, rejected: 1 },
      durable: true,
      ready: true,
      stuckPaths: ["Rename plan → plan-2026", "Delete old-notes"],
    },
    pending: mockMarks,
    answerOp: (id: string, answer: string) => {
      mockAnswers.push(`${id}:${answer}`);
    },
  };

  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    contexts: [
      {
        id: "w1",
        slug: "seyi",
        displayName: "Seyi",
        role: "owner",
        kind: "personal",
        status: "ok",
      },
    ],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: {
      connected: true,
      status: "connected",
      provider: "Cloudflare R2",
      bucket: "example-bucket",
      endpoint: "https://example.invalid",
      region: "auto",
      accessKey: "EXAMPLEKEY",
      conditionalWrite: true,
      updatedAt: 0,
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files,
    fastSearch: { status: null, loading: false },
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/* -------------------------------------------------------------------------- */

let unmountAll: Array<() => void> = [];

afterEach(() => {
  for (const done of unmountAll) done();
  unmountAll = [];
});

function mountConsole(width: number) {
  // react-native-web measures `document.documentElement.clientWidth`, which
  // jsdom reports as 0 — see `appFrameRender.test.ts` for the full trap.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  // Inside `act`: react-native-web's `useWindowDimensions` sets state on this
  // event, and an update outside act is a warning rather than a failure — i.e.
  // exactly the kind of noise that trains people to ignore the output.
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(createElement(ConsoleLayout as never));
  });

  // Document-wide: the sheet is a `Modal`, which portals into `document.body`.
  const find = (testId: string) =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  /*
    `openDrawer` used to be here, and every phone assertion below called it
    first. It pressed `frame-drawer-toggle` to pull the file tree in, because
    the figure was that tree's footer. There is no drawer and no toggle at any
    density now (`features/app/frame.ts`), and the figure is on the page
    already — so the helper is gone rather than pointed at something else, and
    the phone cases press nothing.
  */
  const app = {
    text: () => container.textContent ?? "",
    find,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  unmountAll.push(app.unmount);
  return app;
}


describe("on a pointer layout, the status strip leads to the answers", () => {
  test("\"need you\" is a button that opens the sync sheet", () => {
    const app = mountConsole(1440);
    expect(app.find("sync-sheet")).toBeNull();
    const press = app.find("status-queue-press");
    expect(press).not.toBeNull();
    act(() => press!.click());
    expect(app.find("sync-sheet")).not.toBeNull();
    expect(app.find("sync-section-stuck")?.textContent).toContain("Rename plan → plan-2026 · needs you");
    expect(app.find("sync-section-stuck")?.textContent).toContain("Delete old-notes · needs you");
  });

  test("each answer is reachable and pressed", () => {
    mockAnswers.length = 0;
    const app = mountConsole(1440);
    act(() => app.find("status-queue-press")!.click());
    for (const [id, answer] of [
      ["r1", "override"],
      ["r1", "discard"],
      ["d1", "retry"],
      ["d1", "discard"],
    ] as const) {
      const button = app.find(`sync-op-${id}-${answer}`);
      expect(button).not.toBeNull();
      act(() => button!.click());
    }
    expect(mockAnswers).toEqual(["r1:override", "r1:discard", "d1:retry", "d1:discard"]);
  });
});
