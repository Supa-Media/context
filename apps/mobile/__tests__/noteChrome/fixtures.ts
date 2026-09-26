/**
 * @jest-environment jsdom
 */

/**
 * ONE ROW OF CHROME ABOVE A NOTE, ON A PHONE.
 *
 * The acceptance question for this branch, asked three times by the owner and
 * answered here rather than by eye: **above the note, can you count more than
 * one row?** Obsidian on iOS spends one transparent row — a sidebar toggle at
 * the leading edge, one grouped container at the trailing edge, nothing in the
 * middle — and names the note with an inline title *inside the document*, which
 * is why its first screen of text scrolls up behind the chrome.
 *
 * Ours spent two: a bar carrying a `@seyi personal` chip, and a breadcrumb row
 * under it carrying a path and a `team · inherited` chip. Each of the three
 * things that row carried had to go somewhere rather than be deleted, and this
 * file is the proof that each of them arrived:
 *
 *  - the note's **name** is an inline title at the top of the document;
 *  - its **visibility** is a Properties row, because `visibility:` is filing
 *    metadata about a note and Properties is the panel that lists that;
 *  - **Share** is in the top bar's trailing group, where the reference puts ⋯.
 *
 * `browseShare.test.ts` is the same Share claim on the pointer layout, where the
 * breadcrumb and the button both stay. Neither file can fail for the other's
 * reason, which is the point of having two.
 *
 * The whole console is mounted — the real `AppFrame`, the real `BrowsePane`,
 * the real `Explorer` — because every one of these moves is a control crossing
 * from one component to another, and a test that mounted only the pane would go
 * green on a control that had gone missing from the frame.
 *
 * This module is the shared mounting harness for every file in this folder —
 * it carries no tests of its own. `jest.mock` is per test file, so this module
 * re-registers every mock each time a split file imports it (the same reasoning
 * `appFrameRender/fixtures.ts` documents), and the `afterEach` that tears down
 * every mounted root applies file-wide to whichever split file pulled it in.
 */

import { afterEach, jest } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleData } from "../../features/console/types";
import type { FileBrowser } from "../../features/console/files/browser";
import type { FolderListing } from "../../features/console/files/types";
import { layout } from "../../features/design/tokens";
import { resetReadMode } from "../../features/console/files/readMode";

export { layout };

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };

/**
 * `BrowsePane` now instantiates its own passphrase controller
 * (`useNoteEncryption`, for the "Password-encrypt content" advanced option
 * and a locked note's own view), which calls `useAction`. None of these
 * renders wrap the tree in a real `ConvexProvider` -- nothing here exercises
 * encryption -- so a stub that refuses if actually called is enough to let
 * the pane mount.
 */
// These layout fixtures have no authenticated gateway session.
jest.mock("../../features/agent/useConsoleGrant", () => ({
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
  `Slot` is the real Browse pane, because the note's name and its visibility are
  rendered by the pane and the Share control by the layout around it — and what
  is under test is exactly that they add up to one row.
*/
jest.mock("expo-router", () => ({
  Slot: () => {
    const { createElement: h } = require("react") as typeof import("react");
    const { BrowsePane } =
      require("../../features/console/panes/BrowsePane") as typeof import("../../features/console/panes/BrowsePane");
    const { useConsoleData } =
      require("../../features/console/ConsoleDataContext") as typeof import("../../features/console/ConsoleDataContext");
    return h(BrowsePane, { data: useConsoleData() });
  },
  Redirect: () => null,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/console/@seyi",
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
let mockData: () => ConsoleData = () => {
  throw new Error("no console data set");
};

jest.mock("../../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockData(),
}));

const { emptyEditor } =
  require("../../features/console/files/editor") as typeof import("../../features/console/files/editor");
const ConsoleLayout = (
  require("../../app/(app)/console/_layout") as { default: () => unknown }
).default;

export { emptyEditor };

/* -------------------------------------------------------------------------- */

export const NOTE = "1-projects/plan.md";

/**
 * A real captured note's shape, trimmed.
 *
 * It carries a `subject` — so the inline title has something to prefer over the
 * filename — and its own `visibility:` line, which is the case the Properties
 * panel has to resolve rather than duplicate: a `visibility:` written inside a
 * note decides nothing, because `privacy.md` decides access.
 */
export const FILE = [
  "---",
  'subject: "The storage binding"',
  "visibility: private",
  "status: unprocessed",
  "---",
  "",
  "The first paragraph of the note itself.",
  "",
].join("\n");

/**
 * The same shape as `FILE`, with a short title — used where a test's claim is
 * about a folder segment being *pressable* and the title's own length is not
 * the point. `crumbs.ts` used to have a width budget that would give a folder
 * up beside a longer title; there is no such budget left to avoid triggering,
 * but the short fixture stays for tests that have no reason to care what the
 * title says. `noteChrome.test.ts`'s own "a deep path renders every segment"
 * test is where `FILE`'s sentence-length title is deliberately used instead,
 * against the deepest path — nothing elides even there any more.
 */
export const SHORT_FILE = [
  "---",
  'subject: "Notes"',
  "visibility: private",
  "status: unprocessed",
  "---",
  "",
  "Short.",
  "",
].join("\n");

export const ENTRY: FolderListing["entries"][number] = {
  kind: "file",
  path: NOTE,
  name: "plan.md",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
};

export function dataWith(
  over: Partial<FileBrowser> = {},
  entry: Partial<FolderListing["entries"][number]> = {},
): ConsoleData {
  const path = entry.path ?? NOTE;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const files = {
    canEdit: true,
    /*
      The browser has caught up with the context the console selected — which
      is what a console anybody is looking at looks like, and what `BrowsePane`
      now requires before it draws a path. Absent, this fixture was a console
      mid-switch, and the band would honestly draw the pill alone.
    */
    contextId: "w1",
    loading: false,
    busy: false,
    listings: {
      [folder]: {
        path: folder,
        folderDefault: "team" as const,
        truncated: false,
        manifestUsable: true,
        entries: [{ ...ENTRY, ...entry, path }],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: path,
    select: () => {},
    // `useTabs` calls this when the last tab closes — see the last-tab rule at
    // the foot of that file. A stub missing it is a crash, not a quiet no-op.
    deselect: () => false,
    editor: { ...emptyEditor, status: "clean", path, baseline: FILE, draft: FILE },
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    toasts: [],
    dismissToast: () => {},
    clipboard: null,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    copyTo: () => {},
    createNote: () => {},
    createFolder: () => {},
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
    setScope: () => {},
    openLinkPaths: new Set<string>(),
    linkPaths: [],
    resetPrivacy: () => {},
    canResetPrivacy: false,
    canSetVisibility: true,
    canShare: true,
    shares: [],
    share: () => {},
    teamShareLink: () => {},
    revokeShare: () => {},
    setSharePreviewTitle: () => {},
    search: undefined,
    ...over,
  // No move into another context is running. `BrowsePane` reads this on
  // every render, so a fixture without it crashes the pane rather than
  // failing the assertion the test was written for.
  contextMoves: [],
  } as unknown as FileBrowser;

  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    contexts: [
      {
        id: "w1",
        slug: "seyi",
        displayName: "seyi",
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
      bucket: "notes-bucket",
      endpoint: "https://example.invalid",
      region: "auto",
      accessKey: "EXAMPLEKEY",
      conditionalWrite: true,
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files,
    // Required on `ConsoleData`, and read by the status strip and the phone's
    // tree footer for how much of this context is indexed. `status: null` is
    // "not answered yet", so neither draws a figure — `indexProgressSurfaces`
    // is where that is the subject rather than a fixture detail.
    fastSearch: { status: null, loading: false },
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as unknown as ConsoleData;
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/**
 * Something inside the share sheet.
 *
 * `mountConsole`'s own `find` is scoped to the mount container, and the sheet
 * is a `Modal` — react-native-web portals it to the document, outside that
 * container. Everything asserted about the sheet therefore goes through here;
 * a `find` would return `null` for a control that is on screen.
 */
export const sheet = (testId: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/**
 * A live unlisted link on the note, as the two places that care about one both
 * see it.
 *
 * `openLinkPaths` is *derived* from `shares` in `useFileBrowser`, so setting
 * only the derived half is a state the real app cannot be in — and the sheet
 * reads `shares`, which is the source. Both are set here so the fixture stays
 * a state that can actually occur.
 */
export const OPEN_LINK = {
  shareId: "s1",
  token: "t".repeat(24),
  recipient: "Anyone with access",
  audience: "anyone" as const,
  entryPath: NOTE,
  titleInPreview: false,
  createdAt: 0,
};

export function mountConsole(data: ConsoleData, width = 390) {
  /*
    Reading mode is module state — `files/readMode.ts` says why it is a bus
    rather than a route parameter — so a test that turns it on leaves it on for
    the next one. Reset here rather than in a hook because a fresh mount is
    exactly the moment the mode should be its default, and every test in this
    file starts with one. Found the hard way: the editability check below failed
    in a full run and passed alone, because the test above it had pressed the
    eye and never let go.
  */
  resetReadMode();
  mockData = () => data;
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 956,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(ConsoleLayout as never));
  });

  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  /** By accessible name — what a press target is addressed by here. */
  const find2 = (label: string) =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

  return {
    container,
    find,
    find2,
    press: (node: HTMLElement | null) => {
      if (node === null) throw new Error("nothing to press");
      act(() => {
        for (const type of ["mousedown", "mouseup", "click"]) {
          node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        }
      });
    },
  };
}
