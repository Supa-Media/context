/**
 * @jest-environment jsdom
 */

/**
 * Every console surface, in both palettes and at both densities, rendered to
 * standalone HTML so a browser can photograph it.
 *
 * ## Why a third shot script
 *
 * `design-shots.ts` photographs five phone states against the Obsidian
 * reference and `breadcrumb-shots.ts` photographs one band. Both answer a
 * question that was already asked. This one exists for the question nobody had
 * a picture for: **does the whole app look like one app** — are its buttons the
 * same size, its menus the same shape, its chrome the same weight, in light as
 * in dark, on a phone as on a pointer.
 *
 * That question cannot be answered a screen at a time, which is why this is one
 * file that walks the surfaces rather than a shot added to each feature's own
 * suite. The output is a contact sheet: same harness, same data, same moment,
 * so two pictures side by side differ only where the app does.
 *
 * ## It is not a test, and `pnpm test` does not run it
 *
 * `jest.config.js` matches `__tests__` only. Ask for it by name:
 *
 *     pnpm exec jest --testMatch '**\/scripts/ux-audit-shots.ts' \
 *       --testPathIgnorePatterns '[]'
 *     node scripts/capture-ux-audit-shots.mjs
 *
 * `design-shots.ts`'s header records what being un-run costs — a shot that
 * quietly photographs an empty region is worse evidence than no shot at all —
 * so **every shot here asserts the surface it is a picture of** before taking
 * it, and a surface that cannot be reached throws rather than producing a
 * blank.
 *
 * ## What is mocked, and what is not
 *
 * The router, the safe-area insets, the Convex subscription and the colour
 * scheme. Everything else — the frame, the layout, the palettes, every
 * measurement in them — is what ships. The router mock is `design-shots.ts`'s,
 * extended in one way it needed: `Slot` resolves the route module from the
 * mock URL, so `/console/map` and `/console/connections` render their own panes
 * rather than four copies of Browse.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A 390x844 phone — the narrow case, not the comfortable one. */
const PHONE = { width: 390, height: 844 };
/** A pointer layout wide enough for the rail's labels (`wideBreakpoint`). */
const DESKTOP = { width: 1440, height: 900 };

const OUT = resolve(
  process.env.UX_AUDIT_SHOT_DIR ?? resolve(__dirname, "../../../docs/design/ux-audit"),
);

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };

/** The address bar. Written by `replace`/`push`, read by everything reading a URL. */
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
    const asked = params.get("note");
    mockUrl.note = asked === null ? undefined : asked;
    const settings = params.get("settings");
    mockUrl.settings = settings === null ? undefined : settings;
  };
  return {
    /*
      The real route for the address, not `BrowsePane` directly — Map and
      Connections are their own panes, and a `Slot` that always rendered Browse
      would photograph the same screen under four names.
    */
    Slot: () => {
      const { createElement: h } = require("react") as typeof import("react");
      const path = mockUrl.pathname;
      const module =
        path === "/console/map"
          ? (require("../app/(app)/console/map") as { default: () => unknown })
          : path === "/console/connections"
            ? (require("../app/(app)/console/connections") as { default: () => unknown })
            : path === "/console/search"
              ? (require("../app/(app)/console/search") as { default: () => unknown })
              : (require("../app/(app)/console/[slug]/index") as { default: () => unknown });
      return h(module.default as never);
    },
    Redirect: () => null,
    useRouter: () => ({
      replace: go,
      push: go,
      back: () => {},
      setParams: (next: Record<string, string | undefined>) => {
        if ("note" in next) mockUrl.note = next.note;
        if ("settings" in next) mockUrl.settings = next.settings;
      },
    }),
    usePathname: () => mockUrl.pathname,
    useLocalSearchParams: () => ({
      slug: mockUrl.pathname.replace("/console/", ""),
      note: mockUrl.note,
      settings: mockUrl.settings,
    }),
    useNavigation: () => ({
      setParams: ({ note }: { note?: string }) => {
        mockUrl.note = note;
      },
    }),
  };
});

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

/**
 * Convex, absent.
 *
 * `useLiveConsoleData` being mocked used to be enough, and stopped being enough
 * the moment a *leaf* reached for the client directly: `useNoteEncryption`
 * calls `useAction` from inside `BrowsePane`, unconditionally, so every shot of
 * a note threw `Could not find Convex client!` before it rendered. That is what
 * took `design-shots.ts` red — the same failure, in the file whose own header
 * warns that a shot script nobody runs rots.
 *
 * So the boundary is drawn at the module rather than at one hook: there is no
 * backend behind these pictures, and a component that asks for one gets an
 * action that resolves to nothing rather than an exception. Nothing here is a
 * behavioural claim — a shot that depended on a query's *answer* would be
 * photographing this mock, not the app, which is why every surface below is one
 * the demo data already fills.
 */
jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
  useMutation: () => async () => undefined,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useConvex: () => undefined,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

/**
 * The palette, chosen rather than inherited.
 *
 * jsdom has no `prefers-color-scheme`, so `useColorScheme()` answers `null`,
 * `resolveScheme` reads that as "the platform will not say" and lands on dark —
 * the app's own ground — and every shot would be the same world's.
 *
 * `theme.tsx` already takes an explicit `scheme` through `ThemeProvider` for
 * exactly this case: a test that needs to mount a screen in a named
 * appearance. So the tree is wrapped rather than the platform hook mocked —
 * which is the door the app itself opened, and it also means these pictures
 * exercise the provider a pinned-appearance setting would use rather than a
 * path that only exists under Jest.
 */

/**
 * The demo console, with an owner's capabilities.
 *
 * `design-shots.ts`'s `mockOwner` and its reasoning: the landing page's demo is
 * read-only so a visitor is never offered a control that would lie, and a
 * picture of the product has to be somebody's own console or half the chrome
 * being audited does not exist.
 */
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

const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};
const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;
const { ThemeProvider } = require("../features/design/theme") as {
  ThemeProvider: (props: { scheme: "light" | "dark"; children: unknown }) => unknown;
};

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

/**
 * The rendered tree plus every stylesheet built for it.
 *
 * `#shot` is given the viewport's exact box, and the `dvh` fix-up is
 * `design-shots.ts`'s: jsdom drops `height: 100dvh` because its CSS parser does
 * not know the unit, so the frame comes out content-tall with its floating
 * toolbar stranded mid-page unless a real height is put back.
 */
function page(
  title: string,
  body: string,
  css: string,
  width: number,
  height: number,
  ground: string,
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  html { margin: 0; padding: 0; background: ${ground}; }
  body {
    margin: 0; padding: 0; background: ${ground};
    -webkit-font-smoothing: antialiased;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    width: ${width}px; height: ${height}px; overflow: hidden; position: relative;
  }
  /*
    The frame asks for \`height: 100dvh\`, and jsdom's CSS parser does not know
    \`dvh\` — it drops the whole declaration, so the markup that comes out of
    here has the frame's \`max-height\` and not its height, and the frame would
    be content-tall with its floating toolbar stranded mid-page. This restores
    what a real browser would have computed, and nothing else.

    \`body > div\` rather than a wrapper's children, because **a modal is not
    inside the tree that opened it**: react-native-web portals \`Modal\` to
    \`document.body\`, so the palette, the settings overlay and every sheet are
    siblings of the app rather than descendants. Photographing one container's
    \`innerHTML\` therefore photographed the screen *behind* every surface
    reached by pressing something — which is exactly the silently-wrong evidence
    this harness is supposed to refuse to produce.
  */
  body > div { height: ${height}px !important; max-height: ${height}px !important; }
</style>
<style id="rnw">${css}</style>
</head><body>${body}</body></html>`;
}

function press(node: Element | null): void {
  if (node === null) throw new Error("nothing to press");
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * Anywhere on the page, not anywhere in the container.
 *
 * A `Modal` is portalled to `document.body` by react-native-web, so the
 * palette, the settings overlay and every sheet are *siblings* of the app
 * rather than descendants of it. A finder scoped to the container therefore
 * reported "no element with testID settings-overlay" for an overlay that was
 * open and on screen — and, worse, would have let a shot pass while
 * photographing the screen behind one.
 */
const find = (_container: HTMLElement, testId: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** The same, but a missing one says which one rather than "nothing to press". */
function need(container: HTMLElement, testId: string): HTMLElement {
  const node = find(container, testId);
  if (node === null) {
    /*
      `UX_AUDIT_LENIENT=1` downgrades this to a warning, and exists for exactly
      one job: finding out what a surface *does* render when an assertion says
      it does not render what was expected. It is never how the shots are taken
      — an unset variable is the strict harness, which is the whole point of the
      assertions.
    */
    if (process.env.UX_AUDIT_LENIENT === "1") {
      const present = [...document.body.querySelectorAll("[data-testid]")]
        .map((el) => el.getAttribute("data-testid"))
        .join(" ");
      console.warn(`missing ${testId}; present: ${present}`);
      return document.body;
    }
    throw new Error(`no element with testID ${testId}`);
  }
  return node;
}

interface Shot {
  /** File stem. The scheme and density are appended. */
  name: string;
  /** Where the address starts. Defaults to the context's own page. */
  at?: { pathname: string; note?: string; settings?: string };
  /** Reach the surface, then assert it is on screen. */
  prepare?: (container: HTMLElement, settle: () => void) => void;
  /** Which densities this surface exists at. Defaults to both. */
  sizes?: ReadonlyArray<"phone" | "desktop">;
}

function shoot(shot: Shot, size: { width: number; height: number }, scheme: "light" | "dark"): void {
  stampViewport(size.width, size.height);
  mockUrl.pathname = shot.at?.pathname ?? "/console/@seyi";
  mockUrl.note = shot.at?.note;
  mockUrl.settings = shot.at?.settings;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  const render = () => {
    act(() => {
      root.render(
        createElement(
          ThemeProvider as never,
          { scheme } as never,
          createElement(ConsoleLayout as never),
        ),
      );
    });
  };
  render();
  /*
    `mockUrl` is not React state, so a navigation schedules nothing. A shot that
    presses something has to say when it is done pressing — `design-shots.ts`'s
    `settle`, same six passes and the same reason.
  */
  const settle = () => {
    for (let pass = 0; pass < 6; pass += 1) render();
  };
  shot.prepare?.(container, settle);

  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  /*
    The whole body, not `container.innerHTML` — see `page`. A `Modal` is
    portalled to `document.body`, so a shot of the container alone is a shot of
    whatever the modal is covering.
  */
  const body = document.body.innerHTML;
  const density = size.width === PHONE.width ? "phone" : "desktop";
  const file = resolve(OUT, `${shot.name}-${density}-${scheme}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    page(
      `${shot.name} ${density} ${scheme}`,
      body,
      `${StyleSheet.getSheet().textContent}\n${injected}`,
      size.width,
      size.height,
      scheme === "dark" ? "#050506" : "#FFFFFF",
    ),
    "utf8",
  );

  act(() => root.unmount());
  container.remove();
}

/* -------------------------------------------------------------------------- */

const SHOTS: readonly Shot[] = [
  {
    /*
      A note open. The phone's demo browser opens on `tree.defaultSelection`, so
      nothing has to be pressed there; a pointer layout starts at the context's
      own page with the tree beside it, so the note arrives through the address
      — which is the same route a shared link takes.
    */
    name: "reading",
    at: { pathname: "/console/@seyi", note: "1-projects/context-lc.md" },
    prepare: (container) => {
      /*
        The breadcrumb's leaf, not `note-scroll`: the phone draws the document
        in its own scroller and a pointer layout draws it inside `EditorRegion`,
        so the one testID both densities agree on for "a note is open" is the
        name at the end of the path.
      */
      need(container, "breadcrumb-leaf");
    },
  },
  {
    name: "context-root",
    prepare: (container, settle) => {
      /*
        Pressed rather than addressed, because on a phone this **is** the
        control the audit is about: the pill at the head of the band is the only
        way up from a note, and a shot that navigated by URL would photograph
        the destination without proving the press reaches it.

        A pointer layout has no such pill — the rail is the way around — so
        there it is already at the context's page and there is nothing to press.
      */
      const pill = find(container, "nav-context-seyi");
      if (pill !== null) {
        press(pill);
        settle();
      }
      need(container, "folder-row");
    },
    sizes: ["phone"],
  },
  {
    /*
      The frontmatter row, expanded. Phone only: a pointer layout has the
      properties in the editor region and draws no such row.
    */
    name: "properties",
    at: { pathname: "/console/@seyi", note: "1-projects/context-lc.md" },
    prepare: (container) => {
      /*
        Pressed only if it is shut. The panel's open state outlives a shot —
        the demo browser is module state, not this root's — so a second shot
        that presses unconditionally *closes* the panel and photographs exactly
        the collapsed row this shot exists to not photograph. It did, in the
        light run, immediately after the dark one opened it.
      */
      if (find(container, "note-properties-open") === null) {
        press(need(container, "note-properties"));
      }
      need(container, "note-properties-open");
    },
    sizes: ["phone"],
  },
  {
    name: "settings",
    at: { pathname: "/console/@seyi", settings: "account" },
    prepare: (container) => {
      need(container, "settings-overlay");
    },
  },
  {
    name: "settings-storage",
    at: { pathname: "/console/@seyi", settings: "storage" },
    prepare: (container) => {
      need(container, "settings-overlay");
    },
  },
  {
    name: "palette",
    prepare: (container, settle) => {
      const key = find(container, "bottom-bar-search") ?? find(container, "frame-search");
      if (key === null) throw new Error("no way to the palette on this density");
      press(key);
      settle();
      need(container, "palette-input");
    },
  },
  {
    name: "map",
    at: { pathname: "/console/map" },
    prepare: (container) => {
      need(container, "app-frame");
    },
  },
  {
    name: "connections",
    at: { pathname: "/console/connections" },
    prepare: (container) => {
      need(container, "app-frame");
    },
  },
  {
    name: "search",
    at: { pathname: "/console/search" },
    prepare: (container) => {
      need(container, "search-pane");
    },
  },
];

describe("ux audit shots", () => {
  for (const shot of SHOTS) {
    const sizes = shot.sizes ?? (["phone", "desktop"] as const);
    for (const density of sizes) {
      for (const scheme of ["dark", "light"] as const) {
        test(`${shot.name} — ${density}, ${scheme}`, () => {
          shoot(shot, density === "phone" ? PHONE : DESKTOP, scheme);
          expect(true).toBe(true);
        });
      }
    }
  }
});
