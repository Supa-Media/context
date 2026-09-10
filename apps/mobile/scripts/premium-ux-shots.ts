/**
 * @jest-environment jsdom
 */

/**
 * The Premium review pack, rendered.
 *
 * Every frame in `prototypes/premium/frames.tsx`, at a phone's width and a
 * pointer layout's, in both palettes, written into **one** self-contained
 * document — `docs/design/premium-ux/prototype.html` — that a reviewer can
 * click through: an index down the side, a density and a theme toggle, and
 * every button in every frame wired to whatever frame it would navigate to.
 *
 * ## Why one file and not thirty-two
 *
 * `ux-audit-shots.ts` writes a file per surface because its output is a contact
 * sheet: the pictures are the artifact and the HTML is scaffolding it does not
 * commit. This pack's artifact is the *flow* — the point of it is that first
 * run reaches "storage ready" by pressing things — and a flow split across
 * thirty-two documents is not clickable. The stylesheet is emitted once for all
 * of them, which is also what keeps the file a browser can open comfortably.
 *
 * `capture-premium-ux-shots.mjs` photographs the same document, one frame at a
 * time, through the hash the runtime already reads.
 *
 * ## What is real in here, and what is a stand-in
 *
 * - Every `settings` frame is the **real console**, with the real settings
 *   overlay, the real sidebar and the real pane. One module is swapped —
 *   `PremiumPanel` — so the frame's own body is drawn where the Premium panel
 *   would be. Four of those bodies *are* the shipping `PremiumBody`, against
 *   fixtures; the rest are proposals.
 * - Every `welcome` frame is the **real `WelcomeChrome`** — wordmark, step
 *   rail, card, footer — with a proposed step body inside it. Two strings on
 *   that chrome are overridden (`flow.ts`'s step title and rail label), because
 *   renaming the step is part of the proposal and editing production copy
 *   before review is not.
 * - `page` frames have no production chrome yet and say so on the frame.
 *
 * Nothing here reaches a backend: `convex/react` is mocked to a client that
 * answers nothing, and every control in the prototype folder is inert.
 *
 * ## It is not a test, and `pnpm test` does not run it
 *
 * `jest.config.js` matches `__tests__` only. Ask for it by name:
 *
 *     pnpm exec jest --testMatch '**\/scripts/premium-ux-shots.ts' \
 *       --testPathIgnorePatterns '[]'
 *     node scripts/capture-premium-ux-shots.mjs
 *
 * Every frame asserts something it must contain before it is written — a shot
 * that quietly photographs an empty region is worse evidence than no shot, and
 * this pack's whole claim is that the states have been drawn.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A 390x844 phone — the narrow case, not the comfortable one. */
const PHONE = { width: 390, height: 844 };
/** A pointer layout wide enough for the rail's labels (`wideBreakpoint`). */
const DESKTOP = { width: 1440, height: 900 };

const OUT = resolve(
  process.env.PREMIUM_UX_SHOT_DIR ?? resolve(__dirname, "../../../docs/design/premium-ux"),
);

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
const mockUrl: { pathname: string; note?: string; settings?: string } = {
  pathname: "/console/@seyi",
};

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock("expo-router", () => {
  const go = (href: string) => {
    const [pathname, query] = href.split("?");
    mockUrl.pathname = pathname ?? "/console";
    const params = new URLSearchParams(query ?? "");
    const settings = params.get("settings");
    mockUrl.settings = settings === null ? undefined : settings;
  };
  return {
    Slot: () => {
      const { createElement: h } = require("react") as typeof import("react");
      const module = require("../app/(app)/console/[slug]/index") as { default: () => unknown };
      return h(module.default as never);
    },
    Redirect: () => null,
    useRouter: () => ({
      replace: go,
      push: go,
      back: () => {},
      setParams: (next: Record<string, string | undefined>) => {
        if ("settings" in next) mockUrl.settings = next.settings;
      },
    }),
    usePathname: () => mockUrl.pathname,
    useLocalSearchParams: () => ({
      slug: mockUrl.pathname.replace("/console/", ""),
      note: mockUrl.note,
      settings: mockUrl.settings,
    }),
    useNavigation: () => ({ setParams: () => {} }),
  };
});

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

/**
 * Convex, absent — `ux-audit-shots.ts`'s reasoning verbatim: the boundary is
 * drawn at the module rather than at one hook, because a leaf that reaches for
 * the client directly (`useNoteEncryption` does) throws before anything renders.
 */
jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
  useMutation: () => async () => undefined,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useConvex: () => undefined,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

jest.mock("../features/console/useLiveConsoleData", () => {
  const { useDemoConsoleData } =
    require("../features/console/useDemoConsoleData") as typeof import("../features/console/useDemoConsoleData");
  return {
    useLiveConsoleData: () => {
      const data = useDemoConsoleData();
      return {
        ...data,
        files: { ...data.files, canEdit: true, canShare: true, canSetVisibility: true },
      };
    },
  };
});

/**
 * The proposed name for the storage step, applied to the real chrome.
 *
 * `stepTitle("storage")` ships as "Connect your bucket" and the rail as "Your
 * bucket", both of which presume the answer this design adds a third option to.
 * Overridden here rather than in `features/onboarding/flow.ts`: that file is
 * production copy, and this pack does not change production copy before Seyi
 * has read it. The strings themselves live in the copy deck.
 */
jest.mock("../features/onboarding/flow", () => {
  const actual = jest.requireActual(
    "../features/onboarding/flow",
  ) as typeof import("../features/onboarding/flow");
  const { stepCopy } = require("../prototypes/premium/copy") as typeof import("../prototypes/premium/copy");
  return {
    ...actual,
    STEP_LABELS: { ...actual.STEP_LABELS, storage: stepCopy.railLabel },
    stepTitle: (key: string) =>
      key === "storage" ? stepCopy.title : actual.stepTitle(key as never),
  };
});

/**
 * The Premium panel, swapped for whichever frame is being drawn.
 *
 * `requireActual` is spread back in so `PremiumBody` — which four frames render
 * as the shipping product — is the real one. Only the panel *entry point* is
 * replaced, which is the seam the settings overlay renders through.
 */
let mockSettingsBody: (() => ReactElement) | null = null;
jest.mock("../features/console/settings/panels/PremiumPanel", () => {
  const actual = jest.requireActual("../features/console/settings/panels/PremiumPanel");
  return {
    ...(actual as object),
    PremiumPanel: () => (mockSettingsBody === null ? null : mockSettingsBody()),
  };
});

const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};
const { View } = require("react-native") as typeof import("react-native");
const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;
const { WelcomeChrome } = require("../features/onboarding/WelcomeScreen") as {
  WelcomeChrome: (props: { step: string; shape: unknown; children: unknown }) => unknown;
};
const { ThemeProvider, useColors } = require("../features/design/theme") as {
  ThemeProvider: (props: { scheme: "light" | "dark"; children: unknown }) => unknown;
  useColors: () => { ground: string };
};
const { FRAMES } = require("../prototypes/premium/frames") as typeof import("../prototypes/premium/frames");

/* -------------------------------------------------------------------------- */

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

/** A `page` frame's ground, so a frame with no chrome is still on the app's own surface. */
function PageStage({ children }: { children: ReactElement }) {
  const colors = useColors();
  return createElement(
    View as never,
    { style: { flex: 1, minHeight: "100%", backgroundColor: colors.ground } } as never,
    children,
  );
}

type Density = "phone" | "desktop";
type Scheme = "dark" | "light";

/** Renders one frame at one size in one palette, and returns the page's markup. */
function renderFrame(
  frame: (typeof FRAMES)[number],
  density: Density,
  scheme: Scheme,
): string {
  const size = density === "phone" ? PHONE : DESKTOP;
  stampViewport(size.width, size.height);
  mockUrl.pathname = "/console/@seyi";
  mockUrl.settings = frame.kind === "settings" ? "premium" : undefined;
  mockSettingsBody = frame.kind === "settings" ? frame.body : null;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  const tree =
    frame.kind === "settings"
      ? createElement(ConsoleLayout as never)
      : frame.kind === "welcome"
        ? createElement(
            WelcomeChrome as never,
            { step: "storage", shape: { storage: "skipped" } } as never,
            frame.body(),
          )
        : createElement(PageStage as never, null, frame.body());

  const render = () => {
    act(() => {
      root.render(createElement(ThemeProvider as never, { scheme } as never, tree));
    });
  };
  render();
  // `mockUrl` is not React state, so a navigation schedules nothing — the same
  // six settling passes `design-shots.ts` and `ux-audit-shots.ts` both use.
  for (let pass = 0; pass < 5; pass += 1) render();

  /*
    The assertion, before the markup is taken. A frame that renders nothing, or
    that renders the console *behind* an overlay that failed to open, is exactly
    the silently-wrong evidence this harness exists to refuse to produce.
  */
  if (frame.kind === "settings") {
    const overlay = document.body.querySelector('[data-testid="settings-overlay"]');
    if (overlay === null) throw new Error(`${frame.id}: the settings overlay did not open`);
  }
  const text = document.body.textContent ?? "";
  if (text.trim().length < 40) throw new Error(`${frame.id}: rendered almost nothing`);

  const markup = document.body.innerHTML;
  act(() => root.unmount());
  container.remove();
  mockSettingsBody = null;
  return markup;
}

/* -------------------------------------------------------------------------- *
 * The document.
 * -------------------------------------------------------------------------- */

const DENSITIES: readonly Density[] = ["phone", "desktop"];
const SCHEMES: readonly Scheme[] = ["dark", "light"];

/** `<` and `&` in copy would otherwise close a tag from inside an attribute. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const EVIDENCE_WORDS: Record<string, string> = {
  built: "ships today",
  backend: "needs backend work",
  proposed: "proposed here",
};

function indexHtml(): string {
  const groups = [...new Set(FRAMES.map((frame) => frame.group))];
  return groups
    .map((group) => {
      const rows = FRAMES.filter((frame) => frame.group === group)
        .map(
          (frame) =>
            `<button class="row" data-goto="${frame.id}"><span class="rowName">${escapeHtml(frame.title)}</span></button>`,
        )
        .join("");
      return `<section class="group"><h2>${escapeHtml(group)}</h2>${rows}</section>`;
    })
    .join("");
}

function evidenceHtml(): string {
  return FRAMES.map((frame) => {
    const items = frame.evidence
      .map(
        (item) =>
          `<li><span class="tag ${item.state}">${EVIDENCE_WORDS[item.state]}</span><span>${escapeHtml(item.label)}</span></li>`,
      )
      .join("");
    return (
      `<article class="evidence" data-for="${frame.id}" hidden>` +
      `<p class="note">${escapeHtml(frame.note)}</p>` +
      `<ul>${items}</ul></article>`
    );
  }).join("");
}

/**
 * The prototype's own chrome.
 *
 * ## It is a bezel, and it is dressed like one
 *
 * The product inside these frames has a design system, and this is not it.
 * The shell is deliberately a different world — IBM Plex against the app's
 * system stack, a cooler neutral than either app palette, its own accent —
 * because the single worst outcome for a review harness is a reviewer unsure
 * which pixels are the proposal. Everything here is chrome; everything inside
 * a `.viewport` is the app.
 *
 * ## One theme control, two worlds
 *
 * The shell follows the frame's own light/dark toggle rather than carrying a
 * second one, and starts on whichever the reader's system asks for. A dark
 * bezel around a light screenshot is a lightbox; a dark bezel around a light
 * screenshot *while the reader is in light mode and never asked for either* is
 * just a page that ignored them.
 *
 * ## Sizes
 *
 * A frame is a fixed 390x844 or 1440x900 box, which is what makes it a device
 * rather than a responsive column. On a narrow screen the 1440 box cannot
 * shrink and must not push the page sideways, so the stage is its own
 * horizontal scroller and everything else stacks.
 */
const CHROME_CSS = `
  @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;450;500;600&display=swap");

  :root {
    --ground: #EFEFF3;
    --panel: #FFFFFF;
    --sunk: #E4E4EA;
    --line: rgba(18,18,28,0.13);
    --text: #16161C;
    --muted: #63636E;
    --accent: #2E5FD0;
    --accent-wash: rgba(46,95,208,0.10);
    --built: #17805C;
    --built-wash: rgba(23,128,92,0.12);
    --backend: #8A6100;
    --backend-wash: rgba(138,97,0,0.12);
    --proposed: #2E5FD0;
    --proposed-wash: rgba(46,95,208,0.10);
    --shadow: 0 20px 44px rgba(20,20,35,0.14);
    color-scheme: light;
  }
  :root[data-shell="dark"] {
    --ground: #131318;
    --panel: #1B1B22;
    --sunk: #101015;
    --line: rgba(255,255,255,0.10);
    --text: #EAEAF0;
    --muted: #8E8E9A;
    --accent: #7AA2F7;
    --accent-wash: rgba(122,162,247,0.14);
    --built: #5FD7A6;
    --built-wash: rgba(95,215,166,0.13);
    --backend: #E9B949;
    --backend-wash: rgba(233,185,73,0.13);
    --proposed: #8FB3F5;
    --proposed-wash: rgba(143,179,245,0.13);
    --shadow: 0 22px 50px rgba(0,0,0,0.5);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  html { background: var(--ground); }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--text);
    font: 450 14px/1.55 "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #wrap { padding: 0 20px 72px; max-width: 1860px; margin: 0 auto; }

  header#head { padding-block: 26px 18px; display: grid; gap: 6px; }
  header#head h1 {
    margin: 0; font-size: 21px; font-weight: 600; letter-spacing: -0.015em; text-wrap: balance;
  }
  header#head p { margin: 0; color: var(--muted); max-width: 62ch; }
  header#head .v { font: 500 11px/1 "IBM Plex Mono", ui-monospace, monospace;
    letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }

  #cols { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 26px; align-items: start; }

  #side { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow: auto;
    padding-right: 4px; }
  .group { margin-bottom: 16px; }
  .group h2 { margin: 0 0 5px; font: 500 10px/1 "IBM Plex Mono", ui-monospace, monospace;
    letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  button.row { display: block; width: 100%; text-align: left; background: none; border: 0;
    color: var(--text); padding: 6px 9px; border-radius: 7px; cursor: pointer;
    font: inherit; font-size: 13px; }
  button.row:hover { background: var(--accent-wash); }
  button.row[aria-current="true"] { background: var(--accent); color: #fff; }
  :root:not([data-shell="dark"]) button.row[aria-current="true"] { color: #fff; }

  #bar { display: flex; gap: 10px 16px; align-items: center; flex-wrap: wrap;
    padding-bottom: 12px; }
  #frameName { font-weight: 600; font-size: 15px; margin-right: auto; }
  #count { font: 400 12px/1 "IBM Plex Mono", ui-monospace, monospace; color: var(--muted);
    font-variant-numeric: tabular-nums; }
  .toggle { display: inline-flex; border: 1px solid var(--line); border-radius: 9px;
    overflow: hidden; background: var(--panel); }
  .toggle button, .step {
    background: none; border: 0; color: var(--muted); padding: 6px 12px; cursor: pointer;
    font: inherit; font-size: 12.5px;
  }
  .toggle button[aria-pressed="true"] { background: var(--accent); color: #fff; }
  .step { border: 1px solid var(--line); border-radius: 9px; background: var(--panel);
    color: var(--text); min-width: 34px; }
  .step:hover, .toggle button:hover:not([aria-pressed="true"]) { color: var(--text); background: var(--accent-wash); }
  :where(button, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  #waits { margin: 0 0 10px; padding: 8px 12px; border-radius: 9px; font-size: 12.5px;
    color: var(--backend); background: var(--backend-wash); max-width: 72ch; }

  #track { overflow-x: auto; padding-bottom: 6px; }
  #stage { display: block; border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden; box-shadow: var(--shadow); background: var(--sunk); }
  /*
    THE TRANSFORM IS LOAD-BEARING, TWICE OVER.

    A settings frame contains a react-native-web \`Modal\`, which is
    \`position: fixed\` — and a fixed element is positioned against the *browser
    window* unless an ancestor establishes a containing block. Without this the
    settings overlay escaped its device box entirely and sized itself to
    whatever window the page happened to be open in: a 1440-wide frame drawing
    a 1500-wide overlay, which looks plausible and is not the screen under
    review. A transform (any transform) makes \`.viewport\` that containing block.

    The same property then earns its keep a second time: the scale factor the
    runtime sets is what fits a 1440x900 frame on a laptop or a phone without
    the page scrolling sideways.
  */
  .viewport { overflow: hidden; transform-origin: top left; transform: scale(1); }
  .viewport > div { height: 100% !important; max-height: 100% !important; }
  #scale { margin: 8px 0 0; font: 400 12px/1 "IBM Plex Mono", ui-monospace, monospace;
    color: var(--muted); }

  #below { display: grid; gap: 22px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    margin-top: 22px; max-width: 1100px; }
  .evidence p.note { margin: 0 0 12px; color: var(--text); max-width: 64ch; }
  .evidence ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 9px; }
  .evidence li { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px;
    align-items: baseline; color: var(--muted); font-size: 13px; }
  .tag { justify-self: start; padding: 2px 9px; border-radius: 999px;
    font: 500 11px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
  .tag.built { background: var(--built-wash); color: var(--built); }
  .tag.backend { background: var(--backend-wash); color: var(--backend); }
  .tag.proposed { background: var(--proposed-wash); color: var(--proposed); }
  #hint { margin: 0; color: var(--muted); font-size: 13px; max-width: 60ch; }
  #hint strong { color: var(--text); font-weight: 500; }

  @media (max-width: 900px) {
    #cols { grid-template-columns: minmax(0, 1fr); gap: 14px; }
    /*
      One scrolling line, not a row of columns of different heights: grouped
      vertically the tallest group set the height and the frame — the thing the
      page is for — started 180px down the screen.
    */
    #side { position: static; max-height: none; overflow-x: auto; overflow-y: hidden;
      display: flex; gap: 14px; padding-bottom: 8px; align-items: center; }
    .group { margin: 0; flex: none; display: flex; align-items: center; gap: 6px; }
    .group h2 { margin: 0 2px 0 0; }
    button.row { white-space: nowrap; padding: 5px 10px; border: 1px solid var(--line);
      border-radius: 999px; }
    #below { grid-template-columns: minmax(0, 1fr); }
  }
`;

/**
 * The runtime: an index, three controls, and click routing.
 *
 * Routing is by `data-testid` prefix rather than by a hand-kept map, so a
 * hotspot cannot exist in a frame and be missing from the prototype — the
 * frames declare where a press goes (`hotspot()`), and this reads it.
 */
const CHROME_JS = `
  const state = { frame: null, density: "desktop", theme: null };
  const frames = [...document.querySelectorAll("#stage .viewport")];
  const rows = [...document.querySelectorAll("#side button.row")];
  const order = rows.map((b) => b.dataset.goto);
  const titles = new Map(rows.map((b) => [b.dataset.goto, b.textContent]));

  function apply() {
    for (const node of frames) {
      node.hidden = !(node.dataset.frame === state.frame
        && node.dataset.density === state.density
        && node.dataset.theme === state.theme);
    }
    for (const button of rows) {
      button.setAttribute("aria-current", String(button.dataset.goto === state.frame));
    }
    for (const node of document.querySelectorAll(".evidence")) {
      node.hidden = node.dataset.for !== state.frame;
    }
    for (const button of document.querySelectorAll("[data-set]")) {
      const [key, value] = button.dataset.set.split(":");
      button.setAttribute("aria-pressed", String(state[key] === value));
    }
    // The shell follows the frame rather than carrying a second theme control.
    document.documentElement.dataset.shell = state.theme;
    document.getElementById("frameName").textContent = titles.get(state.frame) ?? "";
    const at = order.indexOf(state.frame);
    document.getElementById("count").textContent = (at + 1) + " / " + order.length;
    const shown = frames.find((node) => !node.hidden);
    const next = shown === undefined ? null : shown.dataset.next ?? null;
    document.getElementById("waits").hidden = next === null;
    fit(shown);
    const hash = state.frame + "/" + state.density + "/" + state.theme;
    if (location.hash.slice(1) !== hash) history.replaceState(null, "", "#" + hash);
  }

  /*
    Fit the device to the space there is, and say so when it is not 1:1.

    A 1440x900 frame does not fit beside an index on a laptop, and does not fit
    at all on a phone. Scaling it down keeps the whole screen visible — which is
    what a reviewer is here for — and the caption stops anybody reading the
    result as the real size of the type.
  */
  function fit(shown) {
    const stage = document.getElementById("stage");
    const caption = document.getElementById("scale");
    if (shown === undefined || shown === null) return;
    const w = parseFloat(shown.style.width);
    const h = parseFloat(shown.style.height);
    const room = document.getElementById("track").clientWidth - 2;
    const k = Math.min(1, room / w);
    shown.style.transform = "scale(" + k + ")";
    stage.style.width = Math.floor(w * k) + "px";
    stage.style.height = Math.floor(h * k) + "px";
    caption.textContent = k < 0.999
      ? w + "×" + h + ", shown at " + Math.round(k * 100) + "%"
      : w + "×" + h;
  }

  function go(frame) {
    if (!titles.has(frame)) return;
    state.frame = frame;
    apply();
  }

  function step(by) {
    const at = order.indexOf(state.frame);
    go(order[(at + by + order.length) % order.length]);
  }

  document.addEventListener("click", (event) => {
    const set = event.target.closest("[data-set]");
    if (set !== null) {
      const [key, value] = set.dataset.set.split(":");
      state[key] = value;
      apply();
      return;
    }
    const stepper = event.target.closest("[data-step]");
    if (stepper !== null) { step(Number(stepper.dataset.step)); return; }
    const row = event.target.closest("#side button.row");
    if (row !== null) { go(row.dataset.goto); return; }
    const hot = event.target.closest('[data-testid^="goto-"]');
    if (hot !== null) {
      event.preventDefault();
      go(hot.dataset.testid.slice("goto-".length));
      return;
    }
    /*
      A frame that advances on its own advances on a click anywhere in it. The
      product has no control here — the wait ends when a webhook lands — so the
      prototype's chrome moves it on rather than a button inside the frame
      pretending to.
    */
    const frame = event.target.closest(".viewport[data-next]");
    if (frame !== null && !frame.hidden) go(frame.dataset.next);
  });

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowRight") { step(1); event.preventDefault(); }
    if (event.key === "ArrowLeft") { step(-1); event.preventDefault(); }
  });

  /*
    The address is readable as well as written.

    The runtime used to read the hash once, on load, and only ever write it
    afterwards — so \`#confirm/phone/light\` opened correctly and then editing
    the address, or pressing Back, changed nothing at all. Found by driving the
    page from a script that navigated by hash instead of reloading, which is
    also how anybody sharing "look at this frame" would use it.
  */
  function fromHash() {
    const parts = location.hash.slice(1).split("/");
    if (titles.has(parts[0])) state.frame = parts[0];
    else if (state.frame === null) state.frame = order[0];
    if (parts[1] === "phone" || parts[1] === "desktop") state.density = parts[1];
    if (parts[2] === "dark" || parts[2] === "light") state.theme = parts[2];
    else if (state.theme === null) {
      // Neither the address nor a press has said: follow the reader's system.
      state.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    apply();
  }

  window.addEventListener("hashchange", fromHash);
  window.addEventListener("resize", () => fit(frames.find((node) => !node.hidden)));
  fromHash();
`;

/** The page itself, without the document wrapper an Artifact supplies. */
function pageHtml(bodies: string, css: string): string {
  return `<title>Premium Review Pack</title>
<style>${CHROME_CSS}</style>
<style id="rnw">${css}</style>
<div id="wrap">
  <header id="head">
    <span class="v">Context.LC · review pack v1</span>
    <h1>Premium and managed storage, end to end</h1>
    <p>Twenty frames of the journey from "I want Context to handle this" to "my notes have a
      working home". Press anything — every button goes where it would go. Arrow keys step
      through in order.</p>
  </header>
  <div id="cols">
    <nav id="side" aria-label="Frames">${indexHtml()}</nav>
    <main id="main">
      <div id="bar">
        <span id="frameName"></span>
        <span id="count"></span>
        <button class="step" data-step="-1" aria-label="Previous frame">←</button>
        <button class="step" data-step="1" aria-label="Next frame">→</button>
        <span class="toggle" role="group" aria-label="Size">
          <button data-set="density:desktop">Desktop</button>
          <button data-set="density:phone">Phone</button>
        </span>
        <span class="toggle" role="group" aria-label="Appearance">
          <button data-set="theme:light">Light</button>
          <button data-set="theme:dark">Dark</button>
        </span>
      </div>
      <p id="waits" hidden>This screen waits on something rather than on you — click anywhere in
        it to see what comes next.</p>
      <div id="track"><div id="stage">${bodies}</div></div>
      <p id="scale"></p>
      <div id="below">
        ${evidenceHtml()}
        <p id="hint">Frames marked <strong>ships today</strong> are the running product rendered
          against a fixture — the real console, the real settings overlay, the real Premium panel —
          not a drawing of it. Everything else is a proposal and says so. Nothing here can reach an
          account, a bucket or a card: there is no backend behind this page at all.</p>
      </div>
    </main>
  </div>
</div>
<script>${CHROME_JS}</script>`;
}

/** The standalone file, for opening from a checkout. */
function document_(bodies: string, css: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${pageHtml(bodies, css)}
</body></html>`;
}

/* -------------------------------------------------------------------------- */

const rendered: string[] = [];

describe("premium ux prototype", () => {
  for (const frame of FRAMES) {
    for (const density of DENSITIES) {
      for (const scheme of SCHEMES) {
        test(`${frame.id} — ${density}, ${scheme}`, () => {
          const size = density === "phone" ? PHONE : DESKTOP;
          const markup = renderFrame(frame, density, scheme);
          rendered.push(
            `<div class="viewport" hidden data-frame="${frame.id}" data-density="${density}" ` +
              `data-theme="${scheme}"${frame.next === undefined ? "" : ` data-next="${frame.next}"`} ` +
              `style="width:${size.width}px;height:${size.height}px">${markup}</div>`,
          );
          expect(markup.length).toBeGreaterThan(500);
        });
      }
    }
  }

  test("the document is written", () => {
    expect(rendered).toHaveLength(FRAMES.length * DENSITIES.length * SCHEMES.length);
    const injected = [...document.head.querySelectorAll("style")]
      .map((node) => node.textContent ?? "")
      .join("\n");
    const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
    const bodies = rendered.join("\n");
    const file = resolve(OUT, "prototype.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, document_(bodies, css), "utf8");
    /*
      The same page without the `<html>`/`<head>`/`<body>` wrapper, for
      publishing where the host supplies one. Off by default and never written
      into the repository: it is the identical document, and committing it
      twice would double the pack's weight to say the same thing.
    */
    const fragment = process.env.PREMIUM_UX_FRAGMENT;
    if (fragment !== undefined && fragment !== "") {
      mkdirSync(dirname(resolve(fragment)), { recursive: true });
      writeFileSync(resolve(fragment), pageHtml(bodies, css), "utf8");
    }
  });
});
