/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of choosing which folder does each built-in job (owner,
 * 2026-10-18, "Built-in folder jobs" boards 2, 3, 4 and 6): Settings › Built-in
 * folders for an imported vault, the band that asks which folders do the jobs,
 * and "Use this folder as…", at 1440 and 390, light and dark.
 * `folder-jobs-shots.ts`'s technique. Every value is invented; long nested
 * names are deliberate, to test wrapping.
 *
 *     pnpm exec jest --testMatch '**\/scripts/folder-job-settings-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.FOLDER_JOB_SETTINGS_SHOTS_DIR ?? "/tmp/folder-job-settings-shots");

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {}, setParams: () => {} }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  usePathname: () => "/",
  Redirect: () => null,
  Slot: () => null,
}));

const mockStableNoop = async () => ({});

jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => mockStableNoop,
  useAction: () => mockStableNoop,
}));

const { StyleSheet, View } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
  View: unknown;
};
const { ThemeProvider, useColors } = require("../features/design/theme") as typeof import("../features/design/theme");
const { BuiltInFoldersPanel } = require("../features/console/settings/panels/BuiltInFoldersPanel") as typeof import("../features/console/settings/panels/BuiltInFoldersPanel");
const { MainFoldersNotice } = require("../features/console/panes/browsePane/MainFoldersNotice") as typeof import("../features/console/panes/browsePane/MainFoldersNotice");
const { FolderJobDialog } = require("../features/console/files/FolderJobDialog") as typeof import("../features/console/files/FolderJobDialog");
const info = require("@context/shared/src/folderJobInfo.cjs") as typeof import("@context/shared/src/folderJobInfo.cjs");
const { JOB_LABEL } = require("@context/shared/src/folderRoles.cjs") as typeof import("@context/shared/src/folderRoles.cjs");

type Scheme = "light" | "dark";
type Viewport = { name: "desktop" | "phone"; width: number; height: number };
const DESKTOP: Viewport = { name: "desktop", width: 1440, height: 900 };
const PHONE: Viewport = { name: "phone", width: 390, height: 844 };

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

async function shoot(name: string, viewport: Viewport, scheme: Scheme, node: () => ReactElement): Promise<void> {
  stampViewport(viewport.width, viewport.height);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme, children: node() }));
  });
  await act(async () => {});
  const injected = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}-${scheme}-${viewport.name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  expect(document.body.textContent).not.toBe("");
  writeFileSync(file, page(name, document.body.innerHTML, css, viewport.width, viewport.height));
  await act(async () => root!.unmount());
  container.remove();
  root = null;
  container = null;
}

/* -------------------------------------------------------------------------- */
/* An imported vault: "00 Inbox" not yet the Inbox, Projects nested in Work.   */
/* -------------------------------------------------------------------------- */

const HELD: Record<string, string | null> = {
  inbox: null,
  projects: "Work/Projects",
  areas: "Life/Areas of responsibility and the long-running household admin",
  resources: "Reference",
  archive: null,
  tex: "Life/Assistant",
  website: null,
  clients: "Work/Clients",
  teams: null,
  products: null,
};

const ANSWER: import("../features/console/files/folderJobsView").FolderJobsAnswer = {
  jobs: info.SHOWN_JOBS.map((job) => ({
    job,
    label: JOB_LABEL[job],
    group: info.JOB_GROUP[job],
    line: info.JOB_LINE[job],
    path: HELD[job] ?? null,
    canChange: job !== "website",
    canRemove: info.canRemoveJob(job),
  })),
  inboxParts: info.INBOX_PARTS.map((name) => ({ name, label: info.INBOX_PART_LABEL[name], path: null })),
  guesses: [
    { job: "inbox", path: "00 Inbox", why: "name says Inbox" },
    { job: "archive", path: "Old stuff/Archives", why: "nested, another word for Archive" },
  ],
  missingNeeded: ["inbox", "archive"],
  folders: ["00 Inbox", "Life", "Life/Assistant", "Old stuff", "Reference", "Work", "Work/Clients", "Work/Projects"],
};

const files = {
  folderJobs: async () => ANSWER,
  setFolderJob: async () => {},
  addBuiltInFolder: async () => "4-archive",
} as never;

function Backdrop({ children, height, width }: { children?: ReactNode; height: number; width: number }) {
  const colors = useColors();
  return createElement(View as never, { style: { width, height, backgroundColor: colors.surface } }, children);
}

const pad = (viewport: Viewport, child: ReactElement) =>
  createElement(
    Backdrop,
    { height: viewport.height, width: viewport.width },
    createElement(
      View as never,
      { style: { paddingTop: 24, paddingHorizontal: viewport.name === "desktop" ? 0 : 16, width: viewport.name === "desktop" ? 720 : "100%", alignSelf: "center", gap: 8 } },
      child,
    ),
  );

const settings = (viewport: Viewport) => () => pad(viewport, createElement(BuiltInFoldersPanel, { files, sectioned: true }));
const band = (viewport: Viewport) => () => pad(viewport, createElement(MainFoldersNotice, { files, dismiss: () => {}, onChoose: () => {} }));
const dialog = (viewport: Viewport) => () =>
  pad(viewport, createElement(FolderJobDialog, { files, path: "Work/Retainers and ongoing client work", sheet: viewport.name === "phone", onClose: () => {} }));

describe("folder job settings shots", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const viewport of [DESKTOP, PHONE]) {
      test(`settings, ${scheme} ${viewport.name}`, async () => {
        const tall = { ...viewport, height: viewport.name === "phone" ? 2100 : 1500 };
        await shoot("01-settings", tall, scheme, settings(tall));
      }, 120_000);
      test(`band, ${scheme} ${viewport.name}`, async () => {
        await shoot("02-band", viewport, scheme, band(viewport));
      }, 120_000);
      test(`dialog, ${scheme} ${viewport.name}`, async () => {
        await shoot("03-dialog", viewport, scheme, dialog(viewport));
      }, 120_000);
    }
  }
});
