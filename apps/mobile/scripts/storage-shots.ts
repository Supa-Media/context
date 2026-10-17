/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of storage on a storage provider this build no longer runs, for the design
 * audit (`docs/decisions/app-and-console.md`). Same technique as
 * `shared-grant-shots.ts` and `account-setup-shots.ts`: the shipped components,
 * rendered by react-dom into a real DOM, written out as self-contained `.html`,
 * and photographed by Playwright.
 *
 * Four screens, each at 1440 and 390 wide:
 *   01  the storage picker, "Bring your own storage" open, S3-compatible card only
 *   02  Settings > Storage on an R2 bucket with a 63-character bucket name, details open
 *   03  Settings > Storage on a retired provider, with the bucket chooser below
 *   04  the HandoffCard offer "Move to another bucket" on the same long-named bucket
 *
 * The hooks these screens use (Convex, the auth provider, the router and the
 * safe-area insets) are mocked so they answer fixed, fake data. Every value is
 * invented: a test workspace, a test slug, a test bucket, and an account id made
 * of zeros. Long strings are deliberate, to test overflow and truncation.
 *
 *     pnpm exec jest --testMatch '**\/scripts/storage-shots.ts' --testPathIgnorePatterns '[]'
 *
 * The HTML and the photo step land in `STORAGE_SHOTS_DIR` (default below).
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(
  process.env.STORAGE_SHOTS_DIR ??
    "/tmp/claude-0/-home-user/bf86cd4f-a947-5a2a-a4c0-08b1d56a8f83/scratchpad/storage-shots",
);

/* -------------------------------------------------------------------------- */
/* Fake data. Everything here is invented.                                     */
/* -------------------------------------------------------------------------- */

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

/** 63 characters: the longest bucket name S3 and R2 allow. */
const LONG_BUCKET = "riverside-studio-editorial-collective-spring-archive-2026-notes";
const LONG_WORKSPACE = "The Riverside Studio Editorial Collective and Friends";
const LONG_SLUG = "riverside-studio-editorial-collective-and-friends";
const ENDPOINT = "https://00000000000000000000000000000000.r2.cloudflarestorage.com";
const ACCESS_KEY = "EXAMPLEKEY0000000000";

/** Reset before every board, so no state leaks from one picture to the next. */
const fakeDefaults = () => ({
  connect: async () => ({ status: "unverified" }),
});

const mockFake = fakeDefaults();

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
  Stack: () => null,
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signIn: async () => ({}),
    signOut: async () => {},
  }),
}));

const mockNoop = async () => ({});

jest.mock("convex/react", () => ({
  /* No Convex client: the settings chooser draws its plain form, with no billing offer. */
  useConvex: () => undefined,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQuery: () => undefined,
  useMutation: () => mockNoop,
  useAction: () => mockNoop,
}));

/* -------------------------------------------------------------------------- */
/* Rendering and writing.                                                      */
/* -------------------------------------------------------------------------- */

const { StyleSheet, View } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
  View: unknown;
};
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { StorageChoice } = require("../features/console/storage/StorageChoice") as typeof import("../features/console/storage/StorageChoice");
const { SettingsPane } = require("../features/console/panes/SettingsPane") as typeof import("../features/console/panes/SettingsPane");
const { HandoffCard } = require("../features/console/storage/handoff/HandoffCard") as typeof import("../features/console/storage/handoff/HandoffCard");

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

const byId = (testID: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

/** A click the way a pointer delivers one; react-native-web reacts to these. */
async function press(testID: string): Promise<void> {
  const node = byId(testID);
  if (node === null) throw new Error(`nothing to press: ${testID}`);
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
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

/** One board at both widths: mount, run the steps, check, write. */
async function board(
  name: string,
  node: () => ReactElement,
  steps: () => Promise<void>,
  check: () => void,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    Object.assign(mockFake, fakeDefaults());
    await mount(node(), viewport);
    await steps();
    check();
    write(`${name}-${viewport.name}`, viewport.width, viewport.height);
    await act(async () => root!.unmount());
    container!.remove();
    root = null;
    container = null;
  }
}

const nothing = async () => {};

/* -------------------------------------------------------------------------- */
/* The fake console data, for the settings pane.                               */
/* -------------------------------------------------------------------------- */

/**
 * The shape `SettingsPane` reads, as `storageScreens.test.ts` builds it. Every
 * list is empty and every loader is at rest, so the only content on screen is
 * the storage section under test.
 */
function consoleData(storage: Partial<import("../features/console/types").ConsoleStorage>) {
  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    contexts: [
      {
        id: "w1",
        slug: LONG_SLUG,
        displayName: LONG_WORKSPACE,
        role: "owner",
        kind: "shared",
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
      provider: "r2",
      conditionalWrite: true,
      updatedAt: 0,
      ...storage,
    },
    storageActions: {
      workspaceId: "w1",
      reverify: async () => ({ queued: true, status: "unverified" }),
      connect: async () => ({ status: "unverified" }),
      handoff: async () => ({ started: true }),
      move: async () => ({ started: true }),
      cancelHandoff: async () => ({ cancelled: true }),
      chooseExistingFiles: async () => ({ resumed: true as const }),
      disconnect: async () => ({ disconnected: true }),
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files: { listings: {} },
    members: { members: [], invitations: [], loading: false, failure: null, canInvite: false },
    shares: { shares: [], loading: false, failure: null },
    groups: { groups: [], loading: false },
    advanced: {
      moves: { jobs: [], loading: false, failure: null },
      audit: { events: [], loading: false, failure: null },
    },
    fastSearch: { status: { state: "off", canChange: false }, loading: false },
    plugins: { state: "idle" },
    contextPlugins: { state: "loading" },
    pluginInstalls: { state: "loading", read: async () => {} },
    pluginGrants: { grants: [], loading: false },
    pluginBrowse: { query: "", limit: 20, searching: false, failure: null },
    pluginRuntime: { states: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

/** A plain R2 bucket the owner connected, with the long bucket name. */
const R2_BINDING = {
  provider: "r2",
  bucket: LONG_BUCKET,
  endpoint: ENDPOINT,
  region: "auto",
  accessKey: ACCESS_KEY,
  objectCount: "1284",
  versioningOn: true,
  lastVerifiedAt: NOW - 3 * HOUR,
};

/** A binding on a provider this build no longer runs. */
const RETIRED_BINDING = {
  provider: "retired-provider",
  bucket: "old-notes-archive",
  connected: true,
  status: "connected",
};

/* -------------------------------------------------------------------------- */
/* The boards.                                                                 */
/* -------------------------------------------------------------------------- */

describe("storage screens: shots", () => {
  test("01 the storage picker, Bring your own storage open", async () => {
    await board(
      "01-storage-picker",
      () =>
        createElement(
          View as never,
          { style: { padding: 24, width: "100%" } },
          createElement(StorageChoice, { connect: mockFake.connect }),
        ),
      async () => {
        await press("choose-own-storage");
      },
      () => {
        expect(byId("choose-bucket")).not.toBe(null);
        expect(byId("choose-free")).toBe(null);
        expect(byId("choose-managed")).toBe(null);
      },
    );
  }, 120_000);

  test("02 Settings > Storage on an R2 bucket with a long bucket name", async () => {
    await board(
      "02-storage-r2-long-bucket",
      () => createElement(SettingsPane, { data: consoleData(R2_BINDING), onClose: () => {} }),
      async () => {
        await press("storage-details-toggle");
      },
      () => {
        expect(byId("storage-binding")?.textContent).toContain(LONG_BUCKET);
        expect(byId("storage-unsupported")).toBe(null);
      },
    );
  }, 120_000);

  test("03 Settings > Storage on a retired provider, bucket chooser below", async () => {
    await board(
      "03-storage-retired-provider",
      () => createElement(SettingsPane, { data: consoleData(RETIRED_BINDING), onClose: () => {} }),
      nothing,
      () => {
        expect(byId("storage-unsupported")?.textContent).toContain("This storage isn't supported any more");
        expect(byId("choose-own-storage")).not.toBe(null);
        expect(byId("storage-rebind")).toBe(null);
        expect(document.body.textContent).toContain("Not supported");
      },
    );
  }, 120_000);

  test("04 the Move to another bucket offer on a long-named bucket", async () => {
    await board(
      "04-storage-handoff-offer",
      () =>
        createElement(
          View as never,
          { style: { padding: 24, width: "100%" } },
          createElement(HandoffCard, {
            storage: { ...R2_BINDING, connected: true, status: "connected", conditionalWrite: true, updatedAt: 0 } as never,
            owner: true,
            onMove: () => {},
          }),
        ),
      nothing,
      () => {
        expect(byId("storage-own-move-offer")?.textContent).toContain("Move to another bucket");
        expect(byId("storage-handoff-offer")).toBe(null);
      },
    );
  }, 120_000);
});
