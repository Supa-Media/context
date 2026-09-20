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
const { darkColors, lightColors } = require("../features/design/tokens") as {
  darkColors: { ground: string };
  lightColors: { ground: string };
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

/** Two words for what a reviewer is looking at, from the frame's own evidence. */
function frameKind(frame: (typeof FRAMES)[number]): { label: string; state: string } {
  const states = frame.evidence.map((item) => item.state);
  if (states.every((state) => state === "built")) return { label: "the product", state: "built" };
  if (states.includes("built")) return { label: "product + proposal", state: "backend" };
  return { label: "proposal", state: "proposed" };
}

function indexHtml(): string {
  const groups = [...new Set(FRAMES.map((frame) => frame.group))];
  let n = 0;
  return groups
    .map((group) => {
      const rows = FRAMES.filter((frame) => frame.group === group)
        .map((frame) => {
          n += 1;
          const num = String(n).padStart(2, "0");
          return (
            `<button class="row" data-goto="${frame.id}">` +
            `<span class="num">${num}</span>` +
            `<span class="rowName">${escapeHtml(frame.title)}</span></button>`
          );
        })
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
          `<li><span class="tag ${item.state}">${EVIDENCE_WORDS[item.state]}</span>` +
          `<span>${escapeHtml(item.label)}</span></li>`,
      )
      .join("");
    return (
      `<article class="evidence" data-for="${frame.id}" hidden>` +
      `<div class="col"><h3>What this frame decides</h3><p class="note">${escapeHtml(frame.note)}</p></div>` +
      `<div class="col"><h3>What is real here</h3><ul>${items}</ul></div>` +
      `</article>`
    );
  }).join("");
}

/**
 * The prototype's own chrome.
 *
 * ## It is a bezel, and it is dressed like one
 *
 * The product inside these frames has a design system, and this is not it. The
 * shell is deliberately a different world — Archivo and IBM Plex against the
 * app's system stack, and a **monochrome** one — because the single worst
 * outcome for a review harness is a reviewer unsure which pixels are the
 * proposal. The only colour the shell spends is on the three evidence chips,
 * where colour is carrying meaning rather than decoration. Everything else
 * coloured on this page belongs to the product.
 *
 * ## A frame is drawn as a device, not as a div
 *
 * Each frame sits in a window or a phone: a title bar with the frame's id, a
 * clipped screen, a caption with the real pixel size and the scale it is being
 * shown at. Before that it was a bordered box, and a bordered box full of app
 * chrome reads as a broken page rather than as a screenshot of one.
 *
 * ## One theme control, two worlds
 *
 * The shell follows the frame's own light/dark toggle rather than carrying a
 * second one, and starts on whichever the reader's system asks for. A dark
 * bezel around a light screenshot is a lightbox; a dark bezel around a light
 * screenshot *while the reader is in light mode and never asked for either* is
 * just a page that ignored them.
 *
 * ## Two views, because review is two jobs
 *
 * **Frames** is walking the journey. **Overview** is the contact sheet — every
 * frame at once, which is the only way to see whether twenty screens look like
 * one product. Reviewers do both, and a tool that only does the first makes
 * them open twenty tabs.
 */
const CHROME_CSS = `
  :root {
    --paper: #F6F6F8;
    --card: #FFFFFF;
    --canvas: #E8E8EC;
    --ink: #0E0E12;
    --ink2: #5C5C68;
    --line: rgba(14,14,18,0.12);
    --line2: rgba(14,14,18,0.07);
    --sel: #0E0E12;
    --sel-ink: #FFFFFF;
    --built: #0F7B57;
    --built-wash: rgba(15,123,87,0.10);
    --backend: #8A5A00;
    --backend-wash: rgba(138,90,0,0.10);
    --proposed: #2A56C6;
    --proposed-wash: rgba(42,86,198,0.09);
    --lift: 0 1px 2px rgba(14,14,20,0.06), 0 18px 40px rgba(14,14,20,0.13);
    --display: "Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif;
    --ui: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    color-scheme: light;
  }
  :root[data-shell="dark"] {
    --paper: #0D0D11;
    --card: #16161B;
    --canvas: #07070A;
    --ink: #EFEFF3;
    --ink2: #92929E;
    --line: rgba(255,255,255,0.11);
    --line2: rgba(255,255,255,0.06);
    --sel: #EFEFF3;
    --sel-ink: #0E0E12;
    --built: #57D3A0;
    --built-wash: rgba(87,211,160,0.12);
    --backend: #E6B54A;
    --backend-wash: rgba(230,181,74,0.12);
    --proposed: #8CB0F3;
    --proposed-wash: rgba(140,176,243,0.12);
    --lift: 0 1px 2px rgba(0,0,0,0.5), 0 24px 54px rgba(0,0,0,0.55);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  html { background: var(--paper); }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font: 400 14px/1.55 var(--ui);
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3 { margin: 0; }

  /* ── the bar that is always reachable ─────────────────────────────────── */
  #tools {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap;
    padding: 10px 20px;
    background: color-mix(in srgb, var(--paper) 88%, transparent);
    backdrop-filter: saturate(1.4) blur(9px);
    border-bottom: 1px solid var(--line2);
  }
  #mark { font: 600 13px/1 var(--display); letter-spacing: -0.01em; }
  #mark span { color: var(--ink2); font-weight: 400; }
  #tools .spacer { margin-left: auto; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px;
    overflow: hidden; background: var(--card); }
  .seg button {
    background: none; border: 0; color: var(--ink2); cursor: pointer;
    font: 500 12px/1 var(--ui); padding: 7px 13px;
  }
  .seg button[aria-pressed="true"] { background: var(--sel); color: var(--sel-ink); }
  .seg button:hover:not([aria-pressed="true"]) { color: var(--ink); }
  .icon {
    border: 1px solid var(--line); background: var(--card); color: var(--ink);
    border-radius: 999px; width: 30px; height: 30px; cursor: pointer;
    font: 400 14px/1 var(--ui);
  }
  .icon:hover { background: var(--canvas); }
  :where(button, a):focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

  #wrap { padding: 0 20px 80px; max-width: 1900px; margin: 0 auto; }

  /* ── the header ───────────────────────────────────────────────────────── */
  header#head { padding-block: 34px 26px; display: grid; gap: 10px; max-width: 74ch; }
  header#head h1 {
    font: 600 clamp(26px, 3.4vw, 38px)/1.06 var(--display);
    letter-spacing: -0.028em; text-wrap: balance;
  }
  header#head p { margin: 0; color: var(--ink2); font-size: 15px; max-width: 62ch; }
  #meta { display: flex; gap: 16px; flex-wrap: wrap; font: 400 11.5px/1 var(--mono);
    color: var(--ink2); letter-spacing: .04em; text-transform: uppercase; }
  #meta b { font-weight: 500; color: var(--ink); }

  /* ── index + stage ────────────────────────────────────────────────────── */
  #cols { display: grid; grid-template-columns: 244px minmax(0, 1fr); gap: 32px;
    align-items: start; }
  #side { position: sticky; top: 62px; max-height: calc(100vh - 74px); overflow: auto;
    padding-right: 6px; }
  .group + .group { margin-top: 18px; }
  .group h2 { font: 500 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase;
    color: var(--ink2); padding: 0 0 7px 9px; border-bottom: 1px solid var(--line2);
    margin-bottom: 5px; }
  button.row {
    display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; align-items: baseline;
    width: 100%; text-align: left; background: none; border: 0; color: var(--ink);
    padding: 6px 9px; border-radius: 8px; cursor: pointer; font: 400 13px/1.35 var(--ui);
  }
  button.row .num { font: 400 11px/1.4 var(--mono); color: var(--ink2);
    font-variant-numeric: tabular-nums; }
  button.row:hover { background: var(--canvas); }
  button.row[aria-current="true"] { background: var(--sel); color: var(--sel-ink); }
  button.row[aria-current="true"] .num { color: var(--sel-ink); opacity: .65; }

  #bar { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding-bottom: 14px; }
  #frameName { font: 600 20px/1.2 var(--display); letter-spacing: -0.018em; }
  #count { font: 400 12px/1 var(--mono); color: var(--ink2); font-variant-numeric: tabular-nums; }
  .kind { padding: 3px 9px; border-radius: 999px; font: 500 11px/1.4 var(--mono); }
  .kind.built { background: var(--built-wash); color: var(--built); }
  .kind.backend { background: var(--backend-wash); color: var(--backend); }
  .kind.proposed { background: var(--proposed-wash); color: var(--proposed); }

  #waits { margin: 0 0 14px; padding: 9px 13px; border-radius: 10px; font-size: 13px;
    color: var(--backend); background: var(--backend-wash); max-width: 74ch; }

  #track { overflow-x: auto; padding: 2px 2px 8px; }
  #stage { display: flex; flex-wrap: wrap; gap: 30px; align-items: flex-start; }
  #stage[data-view="frame"] { display: block; }

  .cell { margin: 0; }
  .device { border: 1px solid var(--line); border-radius: 13px; overflow: hidden;
    background: var(--card); box-shadow: var(--lift); width: max-content; }
  .device .barbar {
    display: flex; align-items: center; gap: 9px; padding: 0 11px; height: 30px;
    border-bottom: 1px solid var(--line2); background: var(--card);
  }
  .device[data-kind="phone"] .barbar { height: 26px; justify-content: center; }
  .dots { display: inline-flex; gap: 5px; }
  .dots i { width: 8px; height: 8px; border-radius: 50%; background: var(--line);
    display: block; }
  .device .fid { font: 400 11px/1 var(--mono); color: var(--ink2); }
  /* The ground is the app's own, set per cell by the renderer, so a frame
     shorter than its box does not show the shell through the bottom of it. */
  .screen { overflow: hidden; }
  .viewport { overflow: hidden; transform-origin: top left; transform: scale(1); }
  .viewport > div { height: 100% !important; max-height: 100% !important; }
  .cell figcaption { margin-top: 9px; font: 400 11.5px/1.5 var(--mono); color: var(--ink2);
    max-width: 300px; }
  #stage[data-view="overview"] .cell { cursor: pointer; }
  #stage[data-view="overview"] .cell:hover .device { border-color: var(--ink2); }

  /* ── what the frame is, under it ──────────────────────────────────────── */
  #below { margin-top: 30px; max-width: 1100px; }
  .evidence { display: grid; gap: 26px; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
    padding-top: 22px; border-top: 1px solid var(--line2); }
  .evidence h3 { font: 500 10px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase;
    color: var(--ink2); margin-bottom: 10px; }
  .evidence p.note { margin: 0; font-size: 14px; max-width: 46ch; }
  .evidence ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .evidence li { display: grid; grid-template-columns: 148px minmax(0, 1fr); gap: 11px;
    align-items: baseline; color: var(--ink2); font-size: 13px; }
  .tag { justify-self: start; padding: 2px 9px; border-radius: 999px;
    font: 500 11px/1.5 var(--mono); }
  .tag.built { background: var(--built-wash); color: var(--built); }
  .tag.backend { background: var(--backend-wash); color: var(--backend); }
  .tag.proposed { background: var(--proposed-wash); color: var(--proposed); }
  #hint { margin: 26px 0 0; padding-top: 20px; border-top: 1px solid var(--line2);
    color: var(--ink2); font-size: 13px; max-width: 68ch; }
  #hint strong { color: var(--ink); font-weight: 500; }

  @media (max-width: 900px) {
    #cols { grid-template-columns: minmax(0, 1fr); gap: 18px; }
    #side {
      position: static; max-height: none; display: flex; gap: 12px; align-items: center;
      overflow-x: auto; overflow-y: hidden; padding-bottom: 8px;
    }
    .group + .group { margin: 0; }
    .group { display: flex; align-items: center; gap: 6px; flex: none; }
    .group h2 { border: 0; padding: 0 4px 0 0; margin: 0; }
    button.row { white-space: nowrap; border: 1px solid var(--line); border-radius: 999px;
      padding: 6px 12px; width: auto; }
    header#head { padding-block: 24px 18px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/**
 * The runtime: two views, an index, three controls, and click routing.
 *
 * Routing is by `data-testid` prefix rather than by a hand-kept map, so a
 * hotspot cannot exist in a frame and be missing from the prototype — the
 * frames declare where a press goes (`hotspot()`), and this reads it.
 */
const CHROME_JS = `
  const state = { frame: null, density: "desktop", theme: null, view: "frame" };
  const cells = [...document.querySelectorAll("#stage .cell")];
  const rows = [...document.querySelectorAll("#side button.row")];
  const order = rows.map((b) => b.dataset.goto);
  const titles = new Map(rows.map((b) => [b.dataset.goto, b.querySelector(".rowName").textContent]));
  const THUMB = 288;

  function shownCells() {
    return cells.filter((cell) => !cell.hidden);
  }

  /*
    Fit each visible device to the space there is, and say what it is being
    shown at.

    A 1440x900 frame does not fit beside an index on a laptop and does not fit
    at all on a phone; a contact sheet needs twenty of them at thumbnail size.
    Both are the same arithmetic, and the caption is what stops a scaled frame
    being read as the real size of the type.
  */
  function fit() {
    const room = document.getElementById("track").clientWidth - 4;
    for (const cell of shownCells()) {
      const view = cell.querySelector(".viewport");
      const screen = cell.querySelector(".screen");
      const w = parseFloat(view.style.width);
      const h = parseFloat(view.style.height);
      const target = state.view === "overview" ? Math.min(THUMB, w) : Math.min(room, w);
      const k = target / w;
      view.style.transform = "scale(" + k + ")";
      screen.style.width = Math.floor(w * k) + "px";
      screen.style.height = Math.floor(h * k) + "px";
      const caption = cell.querySelector("figcaption");
      caption.textContent = state.view === "overview"
        ? titles.get(cell.dataset.frame)
        : (k < 0.999 ? w + "×" + h + " · shown at " + Math.round(k * 100) + "%" : w + "×" + h);
    }
  }

  function apply() {
    const overview = state.view === "overview";
    document.getElementById("stage").dataset.view = state.view;
    for (const cell of cells) {
      const right = cell.dataset.density === state.density && cell.dataset.theme === state.theme;
      cell.hidden = !(right && (overview || cell.dataset.frame === state.frame));
    }
    for (const button of rows) {
      const current = !overview && button.dataset.goto === state.frame;
      button.setAttribute("aria-current", String(current));
      /*
        Keep the current row in view. On a phone the index is one scrolling
        line, so stepping past frame four otherwise marks a row nobody can see;
        on a pointer layout the list is longer than the rail.
      */
      if (current) button.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    for (const node of document.querySelectorAll(".evidence")) {
      node.hidden = overview || node.dataset.for !== state.frame;
    }
    for (const button of document.querySelectorAll("[data-set]")) {
      const [key, value] = button.dataset.set.split(":");
      button.setAttribute("aria-pressed", String(state[key] === value));
    }
    // The shell follows the frame rather than carrying a second theme control.
    document.documentElement.dataset.shell = state.theme;
    const at = order.indexOf(state.frame);
    document.getElementById("frameName").textContent = overview
      ? "Every frame"
      : titles.get(state.frame) ?? "";
    document.getElementById("count").textContent = overview
      ? order.length + " frames"
      : (at + 1) + " / " + order.length;
    const kind = document.getElementById("kind");
    const meta = KINDS[state.frame];
    kind.hidden = overview || meta === undefined;
    if (!kind.hidden) { kind.textContent = meta.label; kind.className = "kind " + meta.state; }
    const next = overview ? null : (shownCells()[0]?.dataset.next ?? null);
    document.getElementById("waits").hidden = next === null;
    document.getElementById("bar").querySelectorAll("[data-step]").forEach((b) => { b.hidden = overview; });
    fit();
    const hash = state.frame + "/" + state.density + "/" + state.theme + (overview ? "/all" : "");
    if (location.hash.slice(1) !== hash) history.replaceState(null, "", "#" + hash);
  }

  function go(frame, view) {
    if (!titles.has(frame)) return;
    state.frame = frame;
    if (view !== undefined) state.view = view;
    apply();
  }

  function step(by) {
    const at = order.indexOf(state.frame);
    go(order[(at + by + order.length) % order.length], "frame");
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
    if (row !== null) { go(row.dataset.goto, "frame"); return; }
    // In the contact sheet a frame is a link to itself, not a working screen.
    if (state.view === "overview") {
      const cell = event.target.closest(".cell");
      if (cell !== null) { go(cell.dataset.frame, "frame"); window.scrollTo(0, 0); }
      return;
    }
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
    const frame = event.target.closest(".cell[data-next]");
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
    state.view = parts[3] === "all" ? "overview" : "frame";
    apply();
  }

  window.addEventListener("hashchange", fromHash);
  window.addEventListener("resize", fit);
  fromHash();
`;

/** The page itself, without the document wrapper an Artifact supplies. */
function pageHtml(bodies: string, css: string): string {
  const kinds = JSON.stringify(
    Object.fromEntries(FRAMES.map((frame) => [frame.id, frameKind(frame)])),
  );
  return `<title>Premium Review Pack</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&display=swap">
<style>${CHROME_CSS}</style>
<style id="rnw">${css}</style>
<div id="tools">
  <span id="mark">Context<span>.lc</span> — review pack v1</span>
  <span class="spacer"></span>
  <span class="seg" role="group" aria-label="View">
    <button data-set="view:frame">Frames</button>
    <button data-set="view:overview">Overview</button>
  </span>
  <span class="seg" role="group" aria-label="Size">
    <button data-set="density:desktop">Desktop</button>
    <button data-set="density:phone">Phone</button>
  </span>
  <span class="seg" role="group" aria-label="Appearance">
    <button data-set="theme:light">Light</button>
    <button data-set="theme:dark">Dark</button>
  </span>
</div>
<div id="wrap">
  <header id="head">
    <h1>Premium and managed storage, end to end</h1>
    <p>The journey from “I want Context to handle this” to “my notes have a working home”,
      drawn for a new person and for an owner upgrading a context they already have. Press
      anything — every button goes where it would go.</p>
    <div id="meta">
      <span><b>${FRAMES.length}</b> frames</span>
      <span><b>Nothing</b> implemented</span>
      <span>← → steps through</span>
    </div>
  </header>
  <div id="cols">
    <nav id="side" aria-label="Frames">${indexHtml()}</nav>
    <main id="main">
      <div id="bar">
        <span id="frameName"></span>
        <span id="kind" class="kind" hidden></span>
        <span id="count"></span>
        <button class="icon" data-step="-1" aria-label="Previous frame">←</button>
        <button class="icon" data-step="1" aria-label="Next frame">→</button>
      </div>
      <p id="waits" hidden>This screen waits on something rather than on you — click anywhere in
        it to see what comes next.</p>
      <div id="track"><div id="stage" data-view="frame">${bodies}</div></div>
      <div id="below">
        ${evidenceHtml()}
        <p id="hint">Frames marked <strong>the product</strong> are the running app rendered
          against a fixture — the real console, the real settings overlay, the real Premium panel —
          not a drawing of it. Everything else is a proposal and says so. Nothing here can reach an
          account, a bucket or a card: there is no backend behind this page at all.</p>
      </div>
    </main>
  </div>
</div>
<script>const KINDS = ${kinds};</script>
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
            `<figure class="cell" hidden data-frame="${frame.id}" data-density="${density}" ` +
              `data-theme="${scheme}"${frame.next === undefined ? "" : ` data-next="${frame.next}"`}>` +
              `<div class="device" data-kind="${density}">` +
              `<div class="barbar">` +
              (density === "desktop" ? `<span class="dots"><i></i><i></i><i></i></span>` : "") +
              `<span class="fid">${frame.id}</span></div>` +
              `<div class="screen" style="background:${scheme === "dark" ? darkColors.ground : lightColors.ground}">` +
              `<div class="viewport" ` +
              `style="width:${size.width}px;height:${size.height}px">${markup}</div></div>` +
              `</div><figcaption></figcaption></figure>`,
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
