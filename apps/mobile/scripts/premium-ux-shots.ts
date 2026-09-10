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
            `<button class="row" data-goto="${frame.id}">${escapeHtml(frame.title)}</button>`,
        )
        .join("");
      return `<div class="group"><h2>${escapeHtml(group)}</h2>${rows}</div>`;
    })
    .join("");
}

function evidenceHtml(): string {
  return FRAMES.map((frame) => {
    const items = frame.evidence
      .map(
        (item) =>
          `<li><span class="tag ${item.state}">${EVIDENCE_WORDS[item.state]}</span>${escapeHtml(item.label)}</li>`,
      )
      .join("");
    return `<div class="evidence" data-for="${frame.id}" hidden><p class="note">${escapeHtml(frame.note)}</p><ul>${items}</ul></div>`;
  }).join("");
}

/**
 * The prototype's own chrome.
 *
 * Plain CSS and plain DOM, deliberately: it is the frame around the product,
 * not part of it, and a reviewer must never be in doubt about which pixels are
 * which. It paints itself in a neutral grey in both themes for the same reason.
 */
const CHROME_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #17171b; color: #e7e7ea;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shell { display: flex; min-height: 100vh; align-items: flex-start; }
  #side { width: 268px; flex: none; padding: 18px 14px 40px; border-right: 1px solid #2a2a31;
    position: sticky; top: 0; max-height: 100vh; overflow: auto; }
  #side h1 { font-size: 14px; margin: 0 0 4px; }
  #side p.sub { color: #9a9aa5; margin: 0 0 16px; font-size: 12px; }
  .group h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .09em;
    color: #83838f; margin: 16px 0 6px; }
  button.row { display: block; width: 100%; text-align: left; background: none; border: 0;
    color: #d5d5dc; padding: 6px 8px; border-radius: 6px; cursor: pointer; font: inherit; }
  button.row:hover { background: #232329; }
  button.row[aria-current="true"] { background: #2f2f38; color: #fff; }
  #main { flex: 1; min-width: 0; padding: 18px 22px 60px; }
  #bar { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .toggle { display: inline-flex; border: 1px solid #33333c; border-radius: 8px; overflow: hidden; }
  .toggle button { background: none; border: 0; color: #c9c9d2; padding: 5px 11px; cursor: pointer; font: inherit; }
  .toggle button[aria-pressed="true"] { background: #3a3a45; color: #fff; }
  #title { font-size: 14px; font-weight: 600; }
  #waits { color: #fcd34d; margin: 0 0 10px; font-size: 12px; }
  #stage { display: inline-block; border: 1px solid #2a2a31; border-radius: 10px; overflow: hidden;
    box-shadow: 0 18px 44px rgba(0,0,0,.45); }
  .viewport { overflow: auto; }
  .viewport > div { height: 100% !important; max-height: 100% !important; }
  .evidence { margin-top: 18px; max-width: 720px; }
  .evidence p.note { color: #b6b6c0; margin: 0 0 10px; }
  .evidence ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
  .evidence li { color: #c9c9d2; }
  .tag { display: inline-block; min-width: 148px; margin-right: 10px; padding: 1px 8px;
    border-radius: 999px; font-size: 11px; }
  .tag.built { background: rgba(52,211,153,.16); color: #6ee7b7; }
  .tag.backend { background: rgba(251,191,36,.16); color: #fcd34d; }
  .tag.proposed { background: rgba(59,130,246,.16); color: #9dc0fb; }
  #hint { color: #83838f; margin-top: 22px; max-width: 720px; font-size: 12px; }
`;

/**
 * The runtime: an index, two toggles, and click routing.
 *
 * Routing is by `data-testid` prefix rather than by a hand-kept map, so a
 * hotspot cannot exist in a frame and be missing from the prototype — the
 * frames declare where a press goes (`hotspot()`), and this reads it.
 */
const CHROME_JS = `
  const state = { frame: null, density: "desktop", theme: "dark" };
  const frames = [...document.querySelectorAll("#stage .viewport")];
  const titles = new Map([...document.querySelectorAll("#side button.row")]
    .map((b) => [b.dataset.goto, b.textContent]));

  function apply() {
    for (const node of frames) {
      node.hidden = !(node.dataset.frame === state.frame
        && node.dataset.density === state.density
        && node.dataset.theme === state.theme);
    }
    for (const button of document.querySelectorAll("#side button.row")) {
      button.setAttribute("aria-current", String(button.dataset.goto === state.frame));
    }
    for (const node of document.querySelectorAll(".evidence")) {
      node.hidden = node.dataset.for !== state.frame;
    }
    for (const button of document.querySelectorAll("[data-set]")) {
      const [key, value] = button.dataset.set.split(":");
      button.setAttribute("aria-pressed", String(state[key] === value));
    }
    document.getElementById("title").textContent = titles.get(state.frame) ?? "";
    const shown = frames.find((node) => !node.hidden);
    const next = shown === undefined ? null : shown.dataset.next ?? null;
    document.getElementById("waits").hidden = next === null;
    const hash = state.frame + "/" + state.density + "/" + state.theme;
    if (location.hash.slice(1) !== hash) history.replaceState(null, "", "#" + hash);
  }

  function go(frame) {
    if (!titles.has(frame)) return;
    state.frame = frame;
    apply();
    window.scrollTo(0, 0);
  }

  document.addEventListener("click", (event) => {
    const set = event.target.closest("[data-set]");
    if (set !== null) {
      const [key, value] = set.dataset.set.split(":");
      state[key] = value;
      apply();
      return;
    }
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
    else if (state.frame === null) state.frame = [...titles.keys()][0];
    if (parts[1] === "phone" || parts[1] === "desktop") state.density = parts[1];
    if (parts[2] === "dark" || parts[2] === "light") state.theme = parts[2];
    apply();
  }

  window.addEventListener("hashchange", fromHash);
  fromHash();
`;

function document_(bodies: string, css: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context.LC — Premium and managed storage, v1</title>
<style>${CHROME_CSS}</style>
<style id="rnw">${css}</style>
</head><body>
<div id="shell">
  <aside id="side">
    <h1>Premium &amp; managed storage</h1>
    <p class="sub">Review pack v1. Press anything — the buttons go where they would go.</p>
    ${indexHtml()}
  </aside>
  <main id="main">
    <div id="bar">
      <span id="title"></span>
      <span class="toggle">
        <button data-set="density:desktop">Desktop</button>
        <button data-set="density:phone">Phone</button>
      </span>
      <span class="toggle">
        <button data-set="theme:dark">Dark</button>
        <button data-set="theme:light">Light</button>
      </span>
    </div>
    <p id="waits" hidden>This screen waits on something rather than on you — click anywhere in it to
      see what comes next.</p>
    <div id="stage">${bodies}</div>
    ${evidenceHtml()}
    <p id="hint">Frames marked <em>ships today</em> are the running product rendered against a
      fixture, not a drawing of it. Nothing in this document can reach an account, a bucket or a
      card: it has no backend behind it at all.</p>
  </main>
</div>
<script>${CHROME_JS}</script>
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
    const file = resolve(OUT, "prototype.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      document_(rendered.join("\n"), `${StyleSheet.getSheet().textContent}\n${injected}`),
      "utf8",
    );
  });
});
