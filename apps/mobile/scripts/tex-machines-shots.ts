/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of Tex's "Your machines" screens, as built, at 1440 and 390,
 * light and dark, for the design comparison against the artboards.
 * `tex-launch-shots.ts`'s technique: the shipped page (`TexPageBody`), rendered
 * by react-dom into a real DOM over the fixture gateway, written as
 * self-contained `.html`, and photographed by Playwright
 * (`capture-tex-machines-shots.mjs`).
 *
 * Every value is invented (`texMachineFixture.ts`). Desktop shots pass
 * `wide` so the page lays out as it does past 640; jsdom never fires onLayout.
 *
 *     pnpm exec jest --testMatch '**\/scripts/tex-machines-shots.ts' --testPathIgnorePatterns '[]'
 *     node scripts/capture-tex-machines-shots.mjs
 *
 * `TEX_MACHINES_SHOTS_DIR` is where the HTML goes (default /tmp/tex-machines-shots/html).
 * `TEX_MACHINES_SHOTS_FONTS` names a stylesheet with local `@font-face` rules
 * for Instrument Sans, Libron and JetBrains Mono (default
 * /tmp/tex-machines-shots/fonts.css), inlined so the photographs touch no network.
 */

import { afterEach, describe, jest, test } from "@jest/globals";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.TEX_MACHINES_SHOTS_DIR ?? "/tmp/tex-machines-shots/html");
const FONTS = resolve(process.env.TEX_MACHINES_SHOTS_FONTS ?? process.env.TEX_SHOTS_FONTS ?? "/tmp/tex-machines-shots/fonts.css");
// jsdom has no object URLs; the contact card link only needs one to draw.
Object.assign(URL, { createObjectURL: () => "blob:tex-card", revokeObjectURL: () => {} });

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {}, setParams: () => {} }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  usePathname: () => "/",
  Redirect: () => null,
  Slot: () => null,
  Stack: () => null,
  router: { push: () => {} },
}));

jest.mock("../features/tex/history/useSeesTurnTiming", () => ({ useSeesTurnTiming: () => false }));

const { StyleSheet } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } } };
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { TexPageBody } = require("../features/tex/page/TexPageBody") as typeof import("../features/tex/page/TexPageBody");
const { useTexPage } = require("../features/tex/page/useTexPage") as typeof import("../features/tex/page/useTexPage");
const { machineFixtureSource } = require("../features/tex/page/texMachineFixture") as typeof import("../features/tex/page/texMachineFixture");
const { fixtureNow } = require("../features/tex/page/texPageFixture") as typeof import("../features/tex/page/texPageFixture");
const { WIDE_PX } = require("../features/tex/page/TexPageParts") as typeof import("../features/tex/page/TexPageParts");

import type { Place } from "../features/tex/page/TexPageBody";
import type { MachineScenario } from "../features/tex/page/texMachineFixture";
import type { TexPageSource } from "../features/tex/page/texPageSource";

type Scheme = "light" | "dark";
type Viewport = { name: "desktop" | "phone"; width: number; height: number };
const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

interface Shot {
  name: string;
  scenario: MachineScenario;
  place: Place;
  ask?: boolean;
  schemes: readonly Scheme[];
}

const BOTH: readonly Scheme[] = ["light", "dark"];
const LIGHT: readonly Scheme[] = ["light"];

const SHOTS: Shot[] = [
  { name: "01-machines", scenario: "full", place: { chat: "me", view: "machines" }, schemes: BOTH },
  { name: "02-machine-detail", scenario: "full", place: { chat: "me", view: "machine", machine: "m-mbp" }, schemes: LIGHT },
  { name: "03-connect", scenario: "full", place: { chat: "me", view: "connect" }, schemes: LIGHT },
  { name: "03-connect-approve", scenario: "pairing", place: { chat: "me", view: "connect" }, schemes: LIGHT },
  { name: "04-group-machines", scenario: "full", place: { chat: "g-team", view: "settings" }, schemes: BOTH },
  { name: "05-approval", scenario: "full", place: { chat: "me" }, ask: true, schemes: LIGHT },
  { name: "06-minion-pool", scenario: "offline", place: { chat: "me" }, schemes: LIGHT },
  { name: "08-machine-states", scenario: "states", place: { chat: "me", view: "machines" }, schemes: LIGHT },
  { name: "09-not-ready", scenario: "notReady", place: { chat: "me", view: "machine", machine: "m-mbp" }, schemes: LIGHT },
  { name: "10-limit-reached", scenario: "limit", place: { chat: "me", view: "machine", machine: "m-mbp" }, schemes: LIGHT },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
  localStorage.clear();
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

/** Full height: the page grows to its content, and the photograph takes all of it. */
function page(title: string, body: string, css: string, width: number, ground: string): string {
  const fonts = existsSync(FONTS) ? readFileSync(FONTS, "utf8") : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${fonts}</style>
<style>
  html, body { margin: 0; padding: 0; background: ${ground}; }
  body { -webkit-font-smoothing: antialiased; font-family: "Instrument Sans", -apple-system, sans-serif; }
  #shot { width: ${width}px; position: relative; }
  #shot .tx { height: auto !important; min-height: 100vh; overflow: visible !important; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

/** The page's own ground, read from the rendered tree, so the photograph's edge matches the page. */
function groundOf(): string {
  const node = container?.querySelector('[data-testid="tex-page"]') as HTMLElement | null;
  if (node === null || node === undefined) return "#FFFDF9";
  return getComputedStyle(node).backgroundColor || "#FFFDF9";
}

function write(name: string, width: number): void {
  const injected = [...document.querySelectorAll("style")].map((node) => node.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  if (container === null) throw new Error(`nothing mounted for ${name}`);
  writeFileSync(file, page(name, container.innerHTML, css, width, groundOf()));
}

/** Wraps the page's hook the way the screen does: the state lives here, the page draws it. */
function Harness({ source, start, wide }: { source: TexPageSource; start: Place; wide: boolean }): ReactElement {
  const [place] = useState<Place>(start);
  const page = useTexPage(source, place.chat);
  return createElement(TexPageBody, {
    source,
    page,
    place,
    go: () => {},
    computer: null,
    openComputer: () => {},
    now: fixtureNow,
    wide,
  });
}

/** Lets the page's reads resolve: a few macrotask turns inside act, so state lands before the photograph. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((done) => setTimeout(done, 5));
  });
}

async function shoot(shot: Shot, scheme: Scheme, viewport: Viewport): Promise<void> {
  const source = machineFixtureSource(shot.scenario, { ask: shot.ask === true });
  stampViewport(viewport.width, viewport.height);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const wide = viewport.width >= WIDE_PX;
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme, children: createElement(Harness, { source, start: shot.place, wide }) }));
  });
  await settle();
  const suffix = scheme === "dark" ? "-dark" : "";
  write(`${shot.name}${suffix}-${viewport.name}`, viewport.width);
  act(() => root!.unmount());
  container.remove();
  root = null;
  container = null;
  localStorage.clear();
}

describe("tex machines shots", () => {
  for (const shot of SHOTS) {
    test(shot.name, async () => {
      for (const scheme of shot.schemes) {
        for (const viewport of VIEWPORTS) {
          await shoot(shot, scheme, viewport);
        }
      }
    });
  }
});
