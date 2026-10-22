/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of the Old copies row and page (board b1 of `remove-copies`,
 * Dev2 2026-10-21) at 1440 and 390, for the design check: the shipped
 * components rendered by react-dom, written as self-contained `.html`, and
 * photographed by `capture-trash-shots.mjs`. Every value is invented; the
 * addresses are long on purpose.
 *
 *     pnpm exec jest --testMatch '**\/scripts/old-copies-shots.ts' --testPathIgnorePatterns '[]'
 */

import { afterEach, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const OUT = resolve(process.env.OLD_COPIES_SHOTS_DIR ?? "/tmp/old-copies-shots");

const { StyleSheet, View } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } }; View: unknown };
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { OldCopiesPage, OldCopiesRow } = require("../features/console/google/OldCopies") as typeof import("../features/console/google/OldCopies");
const { Text } = require("../features/design/components/Text") as typeof import("../features/design/components/Text");

const SUMMARY = {
  state: "hidden" as const,
  days: 696,
  contacts: 1306,
  files: 212,
  firstDay: "2026-09-07",
  lastDay: "2026-10-21",
  since: new Date(2026, 9, 22, 9).getTime(),
  problem: null,
  addresses: ["someone.with.a.long.address@example-company.test", "team.inbox@example.test"],
};

type Viewport = { name: "desktop" | "phone"; width: number; height: number };
const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function stampViewport(width: number, height: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

/** The settings pane's column: centred and capped on a desktop, edge to edge with a gutter on a phone. */
function pane(viewport: Viewport, children: ReactElement): ReactElement {
  const inner = createElement(
    View as never,
    { style: { width: "100%", maxWidth: 640, paddingHorizontal: viewport.name === "phone" ? 16 : 32, paddingVertical: 24 } },
    createElement(Text, { variant: "paneTitle" }, "Mail and calendar"),
    children,
  );
  return createElement(View as never, { style: { alignItems: "center", width: "100%", minHeight: viewport.height } }, inner);
}

async function shot(name: string, viewport: Viewport, node: ReactElement, after?: () => Promise<void>): Promise<void> {
  stampViewport(viewport.width, viewport.height);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme: "dark", children: pane(viewport, node) }));
  });
  if (after) await after();
  const css = `${StyleSheet.getSheet().textContent}\n${[...document.head.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n")}`;
  const file = resolve(OUT, `${name}-${viewport.name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#100F0E}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#shot{width:${viewport.width}px;min-height:${viewport.height}px}</style><style>${css}</style></head><body><div id="shot">${container!.innerHTML}</div></body></html>`,
  );
  act(() => root!.unmount());
  container.remove();
  root = null;
  container = null;
}

test("writes the Old copies boards", async () => {
  for (const viewport of VIEWPORTS) {
    await shot("old-copies-row", viewport, createElement(OldCopiesRow, { summary: SUMMARY, onOpen: () => {} }));
    const page = () => createElement(OldCopiesPage, { summary: SUMMARY, onBack: () => {}, onKeep: async () => {}, onDelete: async () => {} });
    await shot("old-copies-page", viewport, page());
    await shot("old-copies-armed", viewport, page(), async () => {
      const button = container!.querySelector('[data-testid="old-copies-delete"]') as HTMLElement;
      await act(async () => button.click());
    });
  }
  expect(true).toBe(true);
});
