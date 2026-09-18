/**
 * @jest-environment jsdom
 *
 * A render harness, not a test. Writes the phone's sync surfaces — the header
 * pill, the sheet behind it, and the marks on each list — to static HTML so
 * Playwright can photograph them in both palettes. Not matched by
 * `jest.config.js`'s `testMatch`; run it deliberately:
 *
 *   npx jest --no-watchman --testMatch '**\/offlineStatusShots.render.ts'
 *
 * `conflictShots.render.ts` is the pattern and its notes apply: styles are
 * collected once at the end, because react-native-web registers rules with
 * `insertRule` and a page written mid-run gets colours without layout.
 *
 * Every name and path below is a fixture.
 */

import { describe, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import * as fs from "fs";
import * as path from "path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const { View, Text: RNText } = require("react-native") as typeof import("react-native");
const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");
const { darkColors, lightColors } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
const { AppFrame, FrameIconButton } =
  require("../features/app/AppFrame") as typeof import("../features/app/AppFrame");
const { SyncPill, SyncSheet } =
  require("../features/console/files/SyncSheet") as typeof import("../features/console/files/SyncSheet");
const { FolderView } =
  require("../features/console/files/FolderView") as typeof import("../features/console/files/FolderView");
const { FileTree } =
  require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
const { RecentSheet } =
  require("../features/console/files/RecentSheet") as typeof import("../features/console/files/RecentSheet");
const { pendingMarks } =
  require("../features/console/files/pendingMarks") as typeof import("../features/console/files/pendingMarks");
const { saveChip } =
  require("../features/console/files/status") as typeof import("../features/console/files/status");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type SyncFacts = import("../features/offline/copy").SyncFacts;
type FileEntry = import("../features/console/files/types").FileEntry;
type TreeRow = import("../features/console/files/tree").TreeRow;
type Scheme = "light" | "dark";

const OUT = path.join(__dirname, "..", "..", "..", "docs", "design", "offline-status");

const FOLDER = "1-projects";
const PATHS = {
  pilot: `${FOLDER}/pilot.md`,
  budget: `${FOLDER}/budget.md`,
  trip: `${FOLDER}/october-trip.md`,
  notes: `${FOLDER}/meeting-notes.md`,
  plan: `${FOLDER}/plan.md`,
};

const MARKS = pendingMarks([
  { path: PATHS.pilot, state: "pending", queuedAt: 1 },
  { path: PATHS.trip, state: "pending", queuedAt: 2 },
  { path: PATHS.plan, state: "pending", queuedAt: 3 },
  { path: PATHS.budget, state: "conflicted", queuedAt: 4 },
]);

const OFFLINE: SyncFacts = {
  reachability: "offline",
  counts: { pending: 3, conflicted: 0, rejected: 0 },
  durable: true,
  ready: true,
};
const OFFLINE_STUCK: SyncFacts = {
  ...OFFLINE,
  counts: { pending: 3, conflicted: 1, rejected: 0 },
  stuckPaths: [PATHS.budget],
};

const CACHED = saveChip({
  editor: {
    ...emptyEditor,
    status: "clean",
    path: PATHS.notes,
    draft: "x",
    baseline: "x",
    fromCache: true,
    message: "Showing the copy on this device, read 3 hours ago.",
  },
  now: 0,
});

function file(pathName: string): FileEntry {
  return {
    kind: "file",
    path: pathName,
    name: pathName.split("/").pop()!,
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
  };
}

const LISTING = {
  path: FOLDER,
  folderDefault: "team" as const,
  entries: [PATHS.budget, PATHS.notes, PATHS.trip, PATHS.pilot, PATHS.plan].map(file),
  truncated: false,
  manifestUsable: true,
};

const rendered: { name: string; label: string; scheme: Scheme; html: string; width: number; height: number }[] = [];

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 844, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function render(
  name: string,
  label: string,
  scheme: Scheme,
  element: ReactElement,
  width: number,
  height: number,
): void {
  setWidth(width);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(createElement(ThemeProvider, { scheme, children: element })));
  // A `Modal` portals to `document.body`, outside `host` — take the whole body.
  rendered.push({ name, label, scheme, html: document.body.innerHTML, width, height });
  act(() => root.unmount());
  document.body.innerHTML = "";
}

function avatar() {
  return createElement(
    View,
    {
      style: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: "#6b5bd6",
        alignItems: "center",
        justifyContent: "center",
      },
    },
    createElement(RNText, { style: { color: "#fff", fontWeight: "600" } }, "T"),
  );
}

/** The phone's console: the real frame, the real pill, the real folder page. */
function phone(sync: SyncFacts, save: ReturnType<typeof saveChip>): ReactElement {
  return createElement(AppFrame, {
    switcher: null,
    accountSlot: avatar(),
    syncSlot: createElement(SyncPill, { sync, save, onPress: () => {} }),
    topTrailing: createElement(FrameIconButton, {
      label: "Share this",
      icon: "share",
      grouped: true,
      onPress: () => {},
    }),
    bottomBar: createElement(View, { style: { height: 56 } }),
    children: createElement(
      View,
      { style: { paddingTop: 72 } },
      createElement(FolderView, {
        entry: { ...file(FOLDER), kind: "folder", name: FOLDER },
        listing: LISTING,
        canSetVisibility: true,
        contextLabel: "@someone",
        onSelect: () => {},
        pendingStateFor: MARKS.stateFor,
      }),
    ),
  });
}

function treeRow(pathName: string, selected = false): TreeRow {
  const name = pathName.split("/").pop()!;
  return {
    kind: "file",
    key: pathName,
    path: pathName,
    name,
    label: name.replace(/\.md$/, ""),
    depth: 1,
    expanded: false,
    selected,
    markerIsDefault: false,
    readOnly: false,
  };
}

function page(one: (typeof rendered)[number], styles: string): string {
  const ground = one.scheme === "dark" ? darkColors.ground : lightColors.ground;
  const ink = one.scheme === "dark" ? darkColors.muted : lightColors.muted;
  return `<!doctype html><meta charset="utf-8"><title>${one.label}</title>
<style>${styles}
  body { margin: 0; background: ${ground};
         font-family: -apple-system, system-ui, sans-serif; }
  .frame { width: ${one.width}px; margin: 0 auto; padding: 16px 0; }
  .label { color: ${ink}; font-size: 12px; letter-spacing: .06em;
           text-transform: uppercase; margin: 0 0 10px 12px; }
  .surface { position: relative; border-radius: 12px; overflow: hidden;
             display: flex; flex-direction: column; height: ${one.height}px; }
  .surface > div { flex: 1 1 auto; min-height: 0; }
</style>
<div class="frame"><p class="label">${one.label} — ${one.scheme}</p>
<div class="surface">${one.html}</div></div>`;
}

describe("offline status shots", () => {
  test("write them", () => {
    for (const scheme of ["light", "dark"] as const) {
      render(
        `phone-offline-${scheme}`,
        "Phone, offline: the pill and the marks",
        scheme,
        phone(OFFLINE, null),
        390,
        560,
      );
      render(
        `phone-needs-you-${scheme}`,
        "Phone, a note parked: crit outranks warn",
        scheme,
        phone(OFFLINE_STUCK, CACHED),
        390,
        560,
      );
      render(
        `phone-sheet-${scheme}`,
        "Phone, the sheet behind the pill",
        scheme,
        createElement(SyncSheet, {
          sync: OFFLINE_STUCK,
          save: CACHED,
          pending: MARKS,
          onOpen: () => {},
          onDismiss: () => {},
        }),
        390,
        700,
      );
      render(
        `phone-recent-${scheme}`,
        "Phone, Recent marks the same notes",
        scheme,
        createElement(RecentSheet, {
          paths: [PATHS.notes, PATHS.budget, PATHS.pilot, PATHS.plan],
          currentPath: PATHS.notes,
          onOpen: () => {},
          onDismiss: () => {},
          pendingStateFor: MARKS.stateFor,
        }),
        390,
        480,
      );
      render(
        `desktop-tree-${scheme}`,
        "Pointer layout, the file tree",
        scheme,
        createElement(
          View,
          { style: { width: 260, padding: 8 } },
          createElement(FileTree, {
            rows: [
              treeRow(PATHS.budget),
              treeRow(PATHS.notes, true),
              treeRow(PATHS.trip),
              treeRow(PATHS.pilot),
              treeRow(PATHS.plan),
            ],
            canSetVisibility: false,
            onSelect: () => {},
            onToggle: () => {},
            onCycleVisibility: () => {},
            pendingStateFor: MARKS.stateFor,
          }),
        ),
        1200,
        200,
      );
    }

    const styles = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText);
        } catch {
          return [];
        }
      })
      .join("\n");

    fs.mkdirSync(OUT, { recursive: true });
    for (const one of rendered) {
      fs.writeFileSync(path.join(OUT, `${one.name}.html`), page(one, styles));
    }
  });
});
