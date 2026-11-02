/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of @shared: the Shared with me list beside its sidebar, a granted
 * note open in place (read only, and writable for a grant with edit), a granted
 * folder, and the folder's empty and refused states,
 * for the design audit (`docs/decisions/app-and-console.md`). Same technique as
 * `account-setup-shots.ts`: the shipped components, rendered by react-dom into a
 * real DOM, written out as self-contained `.html`, and photographed by Playwright.
 *
 * The hooks these screens use (Convex queries, actions and mutations, the auth
 * hooks, the router and the safe-area insets) are mocked so they answer fixed,
 * fake data. Every value is invented: a test workspace, test handles, and test
 * names. Long strings are deliberate, to test overflow and truncation.
 *
 *     pnpm exec jest --testMatch '**\/scripts/shared-grant-shots.ts' --testPathIgnorePatterns '[]'
 *
 * The HTML and the photo step land in `SHARED_GRANT_SHOTS_DIR` (default below).
 * Photograph them with `node scripts/capture-shared-grant-shots.mjs <that dir>`.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(
  process.env.SHARED_GRANT_SHOTS_DIR ??
    "/tmp/claude-0/-home-user/bf86cd4f-a947-5a2a-a4c0-08b1d56a8f83/scratchpad/shared-grant-shots",
);

/* -------------------------------------------------------------------------- */
/* Fake data. Everything here is invented.                                     */
/* -------------------------------------------------------------------------- */

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const LONG_TITLE =
  "Riverside editorial quarterly planning: every open question, decision and owner we have not yet settled";
const LONG_WORKSPACE = "The Riverside Studio Editorial Collective and Friends";
const GRANT_WORKSPACE = "ws-riverside-long";

type Row = Record<string, unknown>;

/** A share sent to you, the `kind: "share"` row of `shares.listSharedWithMe`. */
function share(token: string, title: string, handle: string, name: string, place: string | null, createdAt: number): Row {
  return {
    token,
    workspaceId: `ws-${place ?? handle}`,
    slug: place === null ? handle : "riverside",
    displayName: place ?? name,
    workspaceKind: place === null ? "personal" : "shared",
    entryPath: `1-projects/${token}.md`,
    sharedBy: `user-${handle}`,
    sharedByHandle: handle,
    sharedByName: name,
    title,
    createdAt,
  };
}

/** A grant you hold on a note or folder, the `kind: "grant"` row. */
function grant(
  noteId: string,
  overrides: Partial<Row> & { title: string; entryPath: string; itemKind: "file" | "folder" },
): Row {
  return {
    kind: "grant",
    workspaceId: GRANT_WORKSPACE,
    slug: "riverside-editorial",
    displayName: LONG_WORKSPACE,
    workspaceKind: "shared",
    noteId,
    sharedBy: null,
    sharedByHandle: null,
    sharedByName: null,
    createdAt: NOW - 4 * HOUR,
    ...overrides,
  };
}

/** The list: two shares and two grants. One grant has a long title, a long workspace and no granter; one is a folder. */
const ITEMS: Row[] = [
  share("t-chaos", "Beneath the Chaos", "ana", "Ana Ruiz", null, NOW - 2 * HOUR),
  share("t-launch", "Launch week plan", "kola", "Kola Ade", "Riverside Studio", NOW - 26 * HOUR),
  grant("n-granted-long", {
    title: LONG_TITLE,
    entryPath: "1-projects/riverside/quarterly-planning-open-questions-decisions-and-owners.md",
    itemKind: "file",
    createdAt: NOW - 4 * HOUR,
  }),
  grant("n-folder-spring", {
    title: "Riverside spring series",
    entryPath: "1-projects/riverside-spring",
    itemKind: "folder",
    sharedBy: "user-kola",
    sharedByHandle: "kola",
    sharedByName: "Kola Ade",
    createdAt: NOW - 30 * HOUR,
  }),
];

const GRANTED_NOTE_TEXT = [
  `# ${LONG_TITLE}`,
  "",
  "This is the working note for the spring quarter. Everything in it is a question we have not closed yet, and the answers belong to whoever is named beside them. Read it from the top, then go straight to the owners list.",
  "",
  "## What we already decided",
  "",
  "The series runs for six Thursdays rather than eight. Guest speakers confirm one week ahead, and the room is booked for the full evening so that the sound check is never rushed. Nobody moves a date without telling the whole team in the channel first.",
  "",
  "We will publish each talk as a short text before the recording, so people who cannot attend can still read the argument.",
  "",
  "## Open questions",
  "",
  "- Do we pay the two guest speakers from the series budget, or from the studio fund that already covers hospitality?",
  "- Should the recap go out as an email, a note in the workspace, or both?",
  "- Who writes the summary for the archive, and by when?",
  "",
  "## Owners",
  "",
  "Kola holds the schedule and the venue. Maya owns the speaker follow-ups. Ana decides the archive format once the first two talks are in.",
  "",
  "Revisit this note on the first Monday of the quarter. Anything still open then moves to the Archive folder rather than being deleted.",
  "",
].join("\n");

const FOLDER_ENTRIES = [
  { path: "1-projects/riverside-spring/archive-2025", name: "archive-2025", kind: "folder" },
  { path: "1-projects/riverside-spring/running-order", name: "running-order", kind: "file" },
  {
    path: "1-projects/riverside-spring/speaker-notes-and-run-of-show-final-v3-do-not-edit-before-friday-the-twelfth",
    name: "speaker-notes-and-run-of-show-final-v3-do-not-edit-before-friday-the-twelfth",
    kind: "file",
  },
  { path: "1-projects/riverside-spring/guest-list", name: "guest-list", kind: "file" },
  { path: "1-projects/riverside-spring/venue-and-sound", name: "venue-and-sound", kind: "file" },
  { path: "1-projects/riverside-spring/recap-draft", name: "recap-draft", kind: "file" },
];

/* -------------------------------------------------------------------------- */
/* Mutable fake answers, reset before every board.                             */
/* -------------------------------------------------------------------------- */

type Fake = {
  items: Row[] | undefined;
  seenAt: number | null | undefined;
  readGrantedNote: (args: unknown) => Promise<unknown>;
  listGrantedFolder: (args: unknown) => Promise<unknown>;
  readSharedNote: (args: unknown) => Promise<unknown>;
};

const fakeDefaults = (): Fake => ({
  items: ITEMS,
  seenAt: NOW - 3 * HOUR,
  readGrantedNote: async () => ({ path: "1-projects/riverside/quarterly-planning.md", text: GRANTED_NOTE_TEXT }),
  listGrantedFolder: async () => ({ path: "1-projects/riverside-spring", entries: FOLDER_ENTRIES }),
  readSharedNote: async () => ({ kind: "folder" }),
});

/*
  Named `mockShots` because Jest hoists `jest.mock` above every declaration and
  refuses a factory that closes over an ordinary local. The factories only read
  it when React calls the hook, so the late initialisation is safe.
*/
const mockShots: Fake = fakeDefaults();

/* -------------------------------------------------------------------------- */
/* Mocks: every hook these screens reach, answering fake data.                 */
/* -------------------------------------------------------------------------- */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  usePathname: () => "/",
  Redirect: () => null,
  Slot: () => null,
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signIn: async () => ({}),
    signOut: async () => {},
  }),
}));

const mockStableReadGranted = (args: unknown) => mockShots.readGrantedNote(args);
const mockStableListFolder = (args: unknown) => mockShots.listGrantedFolder(args);
const mockStableReadShared = (args: unknown) => mockShots.readSharedNote(args);
const mockStableNoop = async () => ({});

jest.mock("convex/react", () => {
  const fnName = (ref: unknown): string => {
    const { getFunctionName } = require("convex/server") as typeof import("convex/server");
    try {
      return getFunctionName(ref as never);
    } catch {
      return String(ref);
    }
  };
  return {
    useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
    useQuery: (ref: unknown) => {
      const name = fnName(ref);
      if (name.endsWith("listSharedWithMe")) return mockShots.items;
      if (name.endsWith("sharedSeenAt")) return mockShots.seenAt;
      return undefined;
    },
    useMutation: () => mockStableNoop,
    /*
      The same function object on every render, as Convex's hook returns: the
      screens list the action in an effect's dependencies, so a fresh one each
      render would refetch forever.
    */
    useAction: (ref: unknown) => {
      const name = fnName(ref);
      if (name.endsWith("readGrantedNote")) return mockStableReadGranted;
      if (name.endsWith("listGrantedFolder")) return mockStableListFolder;
      if (name.endsWith("readSharedNote")) return mockStableReadShared;
      return mockStableNoop;
    },
  };
});

/* -------------------------------------------------------------------------- */
/* Rendering and writing.                                                      */
/* -------------------------------------------------------------------------- */

const { StyleSheet, View } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
  View: unknown;
};
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { SharedPane } = require("../features/console/shared/SharedPane") as typeof import("../features/console/shared/SharedPane");
const { SharedSidebar } = require("../features/console/shared/SharedSidebar") as typeof import("../features/console/shared/SharedSidebar");
const { SharedGrantView } = require("../features/console/shared/SharedGrantView") as typeof import("../features/console/shared/SharedGrantView");
const { grantItemKey } = require("../features/console/shared/sharedGrant") as typeof import("../features/console/shared/sharedGrant");

type Viewport = { name: "desktop" | "phone"; width: number; height: number };
const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

function stampViewport(width: number, height: number): void {
  for (const [key, value] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    Object.defineProperty(document.documentElement, key, { value, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

async function mount(node: ReactElement, viewport: Viewport): Promise<void> {
  stampViewport(viewport.width, viewport.height);
  container = document.createElement("div");
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme: "light", children: node }));
  });
}

function page(title: string, body: string, css: string, width: number, height: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

/** Writes the mounted screen as a self-contained page at one viewport. */
function write(name: string, width: number, height: number): void {
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  expect(container).not.toBeNull();
  writeFileSync(file, page(name, container!.innerHTML, css, width, height));
}

/**
 * The page as the reader sees it: on a desktop, the sidebar in its column with
 * the page beside it (as `ConsoleFrame` draws it); on a phone, the page alone,
 * since a phone has no sidebar to stand beside.
 */
function shell(main: ReactElement, sidebar: ReactElement | null, viewport: Viewport): ReactElement {
  const column = createElement(
    View as never,
    { style: { width: 264, height: "100%", borderRightWidth: 1, borderRightColor: "rgba(0,0,0,0.08)" } },
    sidebar,
  );
  return createElement(
    View as never,
    { style: { flexDirection: "row", width: "100%", height: viewport.height, overflow: "hidden" } },
    viewport.name === "desktop" ? column : null,
    createElement(View as never, { style: { flex: 1, minWidth: 0, height: "100%" } }, main),
  );
}

/** One board at both widths: reset the fakes, mount, run the steps, write. */
async function board(
  name: string,
  node: (viewport: Viewport) => ReactElement,
  fake: Partial<Fake> = {},
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    Object.assign(mockShots, fakeDefaults(), fake);
    await mount(node(viewport), viewport);
    await act(async () => {});
    write(`${name}-${viewport.name}`, viewport.width, viewport.height);
    await act(async () => root!.unmount());
    container!.remove();
    root = null;
    container = null;
  }
}

/* -------------------------------------------------------------------------- */
/* The boards.                                                                 */
/* -------------------------------------------------------------------------- */

const sidebarFor = (selected: string | null) =>
  createElement(SharedSidebar, {
    items: mockShots.items as never,
    selected,
    seenAt: mockShots.seenAt,
    onEverything: () => {},
    onOpen: () => {},
    foot: null,
  });

const NOTE_GRANT = { workspaceId: GRANT_WORKSPACE, ref: { by: "id" as const, noteId: "n-granted-long" }, folder: false };
const FOLDER_GRANT = { workspaceId: GRANT_WORKSPACE, ref: { by: "id" as const, noteId: "n-folder-spring" }, folder: true };
const FOLDER_ITEM = ITEMS[3] as never;
const NOTE_ITEM = ITEMS[2] as never;

describe("shared with me shots", () => {
  test("01 the Shared with me list, beside its sidebar", async () => {
    await board(
      "01-shared-list",
      (viewport) =>
        shell(
          createElement(SharedPane, {
            note: null,
            grant: null,
            phone: viewport.name === "phone",
            me: "@seyi",
            onOpen: () => {},
            onList: () => {},
            onBack: () => {},
            onGo: () => {},
          }),
          sidebarFor(null),
          viewport,
        ),
    );
  }, 120_000);

  test("02 a granted note, open in place", async () => {
    await board(
      "02-granted-note",
      (viewport) =>
        shell(
          createElement(SharedGrantView, {
            target: NOTE_GRANT,
            item: NOTE_ITEM,
            phone: viewport.name === "phone",
            now: NOW,
            onList: () => {},
            onGo: () => {},
          }),
          sidebarFor(grantItemKey(GRANT_WORKSPACE, "n-granted-long")),
          viewport,
        ),
    );
  }, 120_000);

  test("03 a granted folder, with a subfolder and a long file name", async () => {
    await board(
      "03-granted-folder",
      (viewport) =>
        shell(
          createElement(SharedGrantView, {
            target: FOLDER_GRANT,
            item: FOLDER_ITEM,
            phone: viewport.name === "phone",
            now: NOW,
            onList: () => {},
            onGo: () => {},
          }),
          sidebarFor(grantItemKey(GRANT_WORKSPACE, "n-folder-spring")),
          viewport,
        ),
    );
  }, 120_000);

  test("04 a granted folder with nothing shared in it", async () => {
    await board(
      "04-granted-folder-empty",
      (viewport) =>
        shell(
          createElement(SharedGrantView, {
            target: FOLDER_GRANT,
            item: FOLDER_ITEM,
            phone: viewport.name === "phone",
            now: NOW,
            onList: () => {},
            onGo: () => {},
          }),
          sidebarFor(grantItemKey(GRANT_WORKSPACE, "n-folder-spring")),
          viewport,
        ),
      { listGrantedFolder: async () => ({ path: "1-projects/riverside-spring", entries: [] }) },
    );
  }, 120_000);

  test("05 a granted folder that is no longer shared", async () => {
    await board(
      "05-granted-folder-refused",
      (viewport) =>
        shell(
          createElement(SharedGrantView, {
            target: FOLDER_GRANT,
            item: FOLDER_ITEM,
            phone: viewport.name === "phone",
            now: NOW,
            onList: () => {},
            onGo: () => {},
          }),
          sidebarFor(grantItemKey(GRANT_WORKSPACE, "n-folder-spring")),
          viewport,
        ),
      {
        listGrantedFolder: async () => {
          throw new Error("refused");
        },
      },
    );
  }, 120_000);

  test("06 a granted note that is no longer shared", async () => {
    await board(
      "06-granted-note-refused",
      (viewport) =>
        shell(
          createElement(SharedGrantView, {
            target: NOTE_GRANT,
            item: NOTE_ITEM,
            phone: viewport.name === "phone",
            now: NOW,
            onList: () => {},
            onGo: () => {},
          }),
          sidebarFor(grantItemKey(GRANT_WORKSPACE, "n-granted-long")),
          viewport,
        ),
      {
        readGrantedNote: async () => {
          throw new Error("refused");
        },
      },
    );
  }, 120_000);

  test("07 a granted note you may edit, open writable", async () => {
    await board(
      "07-granted-note-edit",
      (viewport) =>
        shell(
          createElement(SharedGrantView, {
            target: NOTE_GRANT,
            item: NOTE_ITEM,
            phone: viewport.name === "phone",
            now: NOW,
            onList: () => {},
            onGo: () => {},
          }),
          sidebarFor(grantItemKey(GRANT_WORKSPACE, "n-granted-long")),
          viewport,
        ),
      {
        readGrantedNote: async () => ({
          path: "1-projects/riverside/quarterly-planning.md",
          text: GRANTED_NOTE_TEXT,
          canEdit: true,
          etag: "etag-fake-1",
        }),
      },
    );
  }, 120_000);
});
