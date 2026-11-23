/**
 * @jest-environment jsdom
 */
// @ts-nocheck

/**
 * The Areas folder's page, List and Chart, as HTML snapshots: the real
 * `FolderView` (and so the real `AreasView`) over a fake Areas folder, at
 * desktop and phone size, in light and dark. Nothing here ships and nothing
 * reaches a backend. Local harness only, NOT committed. Same technique as
 * `seats-shots.ts`; `areas-shots.sh` runs it and photographs the result.
 *
 *     AREAS_SHOT_DIR=/path pnpm exec jest --testMatch '**\/scripts/areas-shots.ts' \
 *       --testPathIgnorePatterns '[]'
 *     PW_EXE=/path/to/chrome node scripts/capture-chaos-shots.mjs /path /path/png
 */

import { describe, expect, test } from "@jest/globals";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet } from "react-native";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { FolderView } from "../features/console/files/FolderView";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FolderListing } from "../features/console/files/types";
import { ThemeProvider } from "../features/design/theme";
import { all, entry, host, one, press, type Write } from "../__tests__/projectPage/fixtures";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const OUT = resolve(process.env.AREAS_SHOT_DIR ?? "/tmp/areas-shots");
const FONT_DIR = process.env.AREAS_FONT_DIR ?? "/tmp/claude-0/-home-user/66a60b97-aa30-5543-9afe-b707ed78ba5a/scratchpad/kit";
const ROOT = "areas";
const CONTEXT = "@supa";

/* The fake Areas folder, mirroring the prototype's seats. Every path is `areas/...`. */
const n = (path: string, properties: ListNote["properties"] = {}): ListNote => ({ path: `${ROOT}/${path}`, properties });

const NOTES: ListNote[] = [
  n("about.md"),
  n("principles.md"),
  n("finance/about.md", {
    owner: "@seyi",
    modes: ["Visionary", "Manager"],
    metrics: ["Monthly cost, target under $600"],
    approvals: ["Spending over $20 needs Seyi's approval."],
  }),
  n("finance/metrics.csv"),
  n("finance/vendors.csv"),
  n("finance/budget-2026.md"),
  n("finance/receipts/r1.md"),
  n("finance/subscriptions/about.md", { area: "true" }),
  n("finance/subscriptions/tools.csv"),
  n("finance/subscriptions/cancel-list.md"),
  n("finance/payroll/about.md", { area: "true" }),
  n("finance/payroll/contractors.md"),
  n("engineering/about.md", {
    owner: "@dev2",
    helper: "Claude Code",
    modes: ["Manager", "Doer"],
    metrics: ["PR time to ship", "MCP response p50"],
  }),
  n("engineering/metrics.csv"),
  n("engineering/on-call.md"),
  n("engineering/runbooks/a.md"),
  n("engineering/stack.page.md"),
  n("product/about.md", { owner: "@seyi", metrics: ["Product quality"] }),
  n("product/roadmap.page.md"),
  n("product/feedback/f.md"),
  n("product/pricing.md"),
  n("design/about.md", { metrics: ["Design quality"] }),
  n("design/brand.md"),
  n("design/references/r.md"),
  n("tex/about.md", { owner: "Tex", modes: ["Doer"] }),
  n("tex/persona.md"),
  n("people/about.md", { area: "false" }),
  n("people/seyi.md", {
    holder: "@seyi",
    kind: "person",
    phone: "+1 555 010 0142",
    email: "seyi@example.com",
    delegation: "Tex",
  }),
];

const LISTING: FolderListing = {
  path: ROOT,
  folderDefault: "team",
  entries: [
    entry("file", `${ROOT}/about.md`),
    entry("file", `${ROOT}/principles.md`),
    entry("folder", `${ROOT}/finance`),
    entry("folder", `${ROOT}/engineering`),
    entry("folder", `${ROOT}/product`),
    entry("folder", `${ROOT}/design`),
    entry("folder", `${ROOT}/tex`),
    entry("folder", `${ROOT}/people`),
  ],
  truncated: false,
  manifestUsable: true,
};

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

const FONTS = `
@font-face { font-family: "Instrument Sans"; src: url("InstrumentSans.woff2") format("woff2"); font-weight: 400 700; }
@font-face { font-family: "JetBrains Mono"; src: url("JetBrainsMono.woff2") format("woff2"); font-weight: 400 700; }`;

function copyFonts(): void {
  for (const name of ["InstrumentSans.woff2", "JetBrainsMono.woff2"]) {
    const from = resolve(FONT_DIR, name);
    if (existsSync(from)) copyFileSync(from, resolve(OUT, name));
  }
}

function page(title: string, body: string, css: string, size: { width: number; height: number }, ground: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${FONTS}
  html, body { margin: 0; padding: 0; background: ${ground}; }
  body { -webkit-font-smoothing: antialiased; width: ${size.width}px; height: ${size.height}px; overflow: hidden; position: relative; }
  body > div:not([data-sprites]) { height: ${size.height}px !important; max-height: ${size.height}px !important; }
  [data-testid="presence-pile"] { display: none !important; }
</style>
<style id="rnw">${css}</style>
</head><body>${body}</body></html>`;
}

function write(stem: string, size: { width: number; height: number }, scheme: "light" | "dark"): void {
  const injected = [...document.head.querySelectorAll("style")].map((n) => n.textContent ?? "").join("\n");
  const file = resolve(OUT, `${stem}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    page(stem, document.body.innerHTML, `${StyleSheet.getSheet().textContent}\n${injected}`, size, scheme === "dark" ? "#100F0E" : "#FFFDF9"),
    "utf8",
  );
}

const settle = async () => {
  await act(async () => {});
  await new Promise((done) => setTimeout(done, 0));
  await act(async () => {});
};

async function shoot(view: "list" | "chart", density: "phone" | "desktop", scheme: "light" | "dark"): Promise<void> {
  const size = density === "phone" ? PHONE : DESKTOP;
  stampViewport(size.width, size.height);
  document.body.innerHTML = "";
  forgetViews();
  try {
    localStorage.clear();
  } catch {
    // no storage here
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const writes: Write[] = [];
  await act(async () => {
    root.render(
      createElement(
        SafeAreaProvider,
        {
          initialMetrics: {
            frame: { x: 0, y: 0, width: size.width, height: size.height },
            insets: density === "phone" ? { top: 59, bottom: 34, left: 0, right: 0 } : { top: 0, bottom: 0, left: 0, right: 0 },
          },
        } as never,
        createElement(
          ThemeProvider as never,
          { scheme } as never,
          createElement(FolderView as never, {
            entry: entry("folder", ROOT),
            listing: LISTING,
            canSetVisibility: true,
            contextLabel: CONTEXT,
            onSelect: () => {},
            page: host(writes, { notes: NOTES, files: [] }),
          } as never),
        ),
      ),
    );
  });
  await settle();
  if (view === "chart") {
    await press(one("folder-view-chart"));
    await settle();
  }
  await settle();

  try {
    expect(all("areas-list").length + all("areas-chart").length).toBe(1);
    if (view === "chart") expect(all("areas-chart")).toHaveLength(1);
    write(`areas-${view}-${density}-${scheme}`, size, scheme);
  } finally {
    root.unmount();
    container.remove();
  }
}

describe("areas folder page snapshots", () => {
  mkdirSync(OUT, { recursive: true });
  copyFonts();
  for (const view of ["list", "chart"] as const) {
    for (const density of ["desktop", "phone"] as const) {
      for (const scheme of ["light", "dark"] as const) {
        test(`${view} — ${density}, ${scheme}`, async () => {
          await shoot(view, density, scheme);
        }, 120_000);
      }
    }
  }
});
