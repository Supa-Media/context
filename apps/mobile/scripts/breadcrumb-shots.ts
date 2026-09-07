/**
 * @jest-environment jsdom
 */

/**
 * The phone's navigation band, rendered to standalone HTML so it can be
 * photographed in a real browser.
 *
 * `design-shots.ts`'s harness and its reasoning, with one thing added that the
 * question here needs: **the URL is real state**. This is a picture of
 * *navigation*, so a router that swallows `replace` would photograph four
 * copies of the same screen. `mockUrl` is the address bar; `useRouter().replace`
 * writes it, `usePathname` and `useLocalSearchParams` read it, and `Slot`
 * renders the real `ContextBrowseRoute` — so `useNoteAddress`, the console
 * layout's context resolution and the demo file browser are all in the loop the
 * way they are in the app.
 *
 * Run it by name, like its sibling — `jest.config.js` matches `__tests__` only:
 *
 *     pnpm exec jest --testMatch '**\/scripts/breadcrumb-shots.ts' \
 *       --testPathIgnorePatterns '[]'
 *
 * Every shot asserts the surface it is a picture of before taking it. A shot
 * that quietly photographs an unchanged screen is worse than one that fails.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A 390x844 phone: the iPhone 14/15 the report's screenshots came from. */
const WIDTH = 390;
const HEIGHT = 844;

/**
 * Outside the repository by default.
 *
 * These are **evidence for one decision**, not a fixture anything reads — the
 * count the elision uses came out of measuring them — so they do not belong
 * beside `docs/design/obsidian-parity/`, whose files are the standing picture
 * of the product and are regenerated on purpose. Point `BREADCRUMB_SHOT_DIR`
 * somewhere to collect them.
 */
const OUT = resolve(
  process.env.BREADCRUMB_SHOT_DIR ?? resolve(tmpdir(), "context-breadcrumb-shots"),
);

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };

/** The address bar. Written by `replace`, read by everything that reads a URL. */
const mockUrl: { pathname: string; note?: string } = { pathname: "/console/@seyi" };
/** Re-render, because nothing here is React state. */
let mockRerender: () => void = () => {};

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock("expo-router", () => {
  const go = (href: string) => {
    const [pathname, query] = href.split("?");
    mockUrl.pathname = pathname ?? "/console";
    const asked = query?.startsWith("note=") === true ? query.slice(5) : undefined;
    mockUrl.note = asked === undefined ? undefined : decodeURIComponent(asked);
    mockRerender();
  };
  return {
    Slot: () => {
      const { createElement: h } = require("react") as typeof import("react");
      const Route = (
        require("../app/(app)/console/[slug]/index") as { default: () => unknown }
      ).default;
      return h(Route as never);
    },
    Redirect: () => null,
    useRouter: () => ({ replace: go, push: go }),
    usePathname: () => mockUrl.pathname,
    useLocalSearchParams: () => ({
      slug: mockUrl.pathname.replace("/console/", ""),
      note: mockUrl.note,
    }),
    useNavigation: () => ({
      setParams: ({ note }: { note?: string }) => {
        mockUrl.note = note;
        mockRerender();
      },
    }),
  };
});

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

/** See `design-shots.ts` — the demo is read-only and a real console is not. */
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

/* -------------------------------------------------------------------------- */

function stampViewport(): void {
  for (const [key, value] of [
    ["clientWidth", WIDTH],
    ["clientHeight", HEIGHT],
  ] as const) {
    Object.defineProperty(document.documentElement, key, { value, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: WIDTH, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: HEIGHT, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function page(title: string, body: string, css: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative; }
  /* jsdom drops \`dvh\`; see design-shots.ts. */
  #shot > div { height: ${HEIGHT}px !important; max-height: ${HEIGHT}px !important; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

const find = (container: HTMLElement, testId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function need(container: HTMLElement, testId: string): HTMLElement {
  const node = find(container, testId);
  if (node === null) throw new Error(`no element with testID ${testId}`);
  return node;
}

function byLabel(container: HTMLElement, label: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (node === null) throw new Error(`no control labelled ${label}`);
  return node;
}

function press(node: Element): void {
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

/** The band's text, which is what every assertion here is really about. */
function bandText(container: HTMLElement): string {
  return need(container, "nav-band-trail").textContent ?? "";
}

function write(name: string, container: HTMLElement): void {
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    page(name, container.innerHTML, `${StyleSheet.getSheet().textContent}\n${injected}`),
    "utf8",
  );
}

/* -------------------------------------------------------------------------- */

/** Two folders deep, with a title (`# Org chart`) long enough that neither
 * folder fits beside it at 390pt — the exact fixture the report's screenshot
 * clipped, and now the row's proof that a `budget` fixes it. */
const DEEP = "2-areas/public-worship/org-chart.md";

describe("the phone's navigation band", () => {
  test("states of it, photographed in order", () => {
    stampViewport();
    mockUrl.pathname = "/console/@seyi";
    mockUrl.note = undefined;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    mockRerender = () => {
      act(() => {
        root.render(createElement(ConsoleLayout as never));
      });
    };
    /*
      Several passes, because a navigation here is several commits — the URL,
      then the console selecting the context it names, then the browser
      catching up, then the mirror opening the note. That is the ordering the
      whole band was got wrong by, so the harness has to let it run rather than
      photograph the first frame of it.
    */
    const settle = () => {
      for (let pass = 0; pass < 6; pass += 1) mockRerender();
    };
    settle();

    /*
      Walk down by pressing rows — which is how somebody gets there and, in
      this harness, the only way: the landing page's demo browser resets its
      own selection whenever the context object changes, so a `?note=` set
      before the first commit is opened and then overwritten. That is a
      property of the *demo* browser (`useDemoFileBrowser` answers with its
      context id immediately, where the real one lags a commit on purpose),
      not of the console — `linkedNote.test.ts` drives the URL route against
      the real `useFileBrowser`.

      `2-areas/weekly-review.md` first — one folder deep, with a title short
      enough that the folder stays a live, pressable crumb — so the ordinary
      case (nothing elided, a segment you can press) gets its own picture
      before the row is asked to do something harder.
    */
    press(need(container, "nav-context-seyi"));
    settle();
    press(byLabel(container, "2-areas, folder"));
    settle();
    press(byLabel(container, "weekly-review"));
    settle();

    /* 1 — an ordinary note, one folder deep: nothing elided, nothing to protect. */
    expect(bandText(container)).toContain("@seyi");
    expect(bandText(container)).toContain("2-areas");
    expect(need(container, "breadcrumb-leaf").textContent).toBe("Weekly review");
    write("1-note-one-folder-deep", container);

    /* 2 — pressing that folder segment, from the open note. */
    press(byLabel(container, "Open 2-areas"));
    settle();
    expect(need(container, "folder-row")).not.toBeNull();
    expect(need(container, "breadcrumb-leaf").textContent).toBe("2-areas");
    write("2-middle-segment-pressed", container);

    /*
      Now the harder case: two folders deep, and a title too long for either
      of them to fit beside it. `DEEP` is the exact path the report's
      screenshot clipped.
    */
    press(byLabel(container, "public-worship, folder"));
    settle();
    press(byLabel(container, "org-chart"));
    settle();

    /*
      3 — the leaf, protected. Neither folder fits beside "Org chart" at this
      width — the report's screenshot had this exact row clip "Org cha│rt"
      under the trailing fade — so both are elided to the one `…` a `budget`
      falls back to, and the leaf that survives is the whole word.
    */
    expect(need(container, "breadcrumb-gap")).not.toBeNull();
    expect(bandText(container)).not.toContain("2-areas");
    expect(bandText(container)).not.toContain("public-worship");
    expect(need(container, "breadcrumb-leaf").textContent).toBe("Org chart");
    write("3-deep-note-leaf-protected", container);

    /* 4 — pressing the lit context chip: back to the root, nothing open. */
    mockUrl.note = DEEP;
    settle();
    expect(need(container, "breadcrumb-leaf").textContent).toBe("Org chart");
    press(need(container, "nav-context-seyi"));
    settle();
    expect(mockUrl.note).toBeUndefined();
    expect(find(container, "breadcrumb-leaf")).toBeNull();
    // The context's own page — a phone's file browser — rather than a blank.
    expect(need(container, "folder-row")).not.toBeNull();
    write("4-context-chip-pressed", container);

    /*
      5 — switching to another context, which restores its own place. A longer
      context name (`@public-worship` beside `@seyi`) spends more of the same
      390pt, which is exactly why the budget takes the pill's own label into
      account rather than assuming a fixed width for it — here it leaves no
      room for `1-projects` beside "LTN 2026" at all, so the one folder
      collapses too. The leaf is still whole either way.
    */
    press(need(container, "context-strip-public-worship"));
    settle();
    expect(mockUrl.pathname).toBe("/console/@public-worship");
    expect(bandText(container)).toContain("@public-worship");
    expect(bandText(container)).not.toContain("1-projects");
    expect(need(container, "breadcrumb-leaf").textContent).not.toBe("");
    write("5-context-switched", container);

    act(() => root.unmount());
    container.remove();
  });

  /**
   * A path deeper than the demo has, so the elision can be photographed.
   *
   * The band alone rather than the whole console: no context in
   * `placeholderData.ts` is four folders deep, and inventing one there would
   * change what the landing page shows in order to take a picture. The pieces
   * are the shipped ones — `NavBand`, `CurrentContextPill`, `Breadcrumb` in
   * `pathOnly` — and the question this answers is the one only a browser can:
   * whether the leaf is **fully** on screen, guaranteed, rather than merely
   * `MAX_FOLDER_CRUMBS`-shaped and hoping.
   *
   * At this width the cap's own shape (root, gap, parent, leaf) still runs
   * past the edge — this is the exact path `crumbs.ts`'s header measured that
   * on — so folders give way from the front: `3-resources` and `books` fold
   * into the `…`, and `2026` — the immediate parent, short enough to still fit
   * — stays a live, pressable segment. The leaf comes back whole either way,
   * which is the part a `RowBudget` exists to guarantee rather than fading
   * out past a scroller nobody was told to drag.
   */
  test("a deep path, elided down to the leaf, fully on screen", () => {
    stampViewport();
    const { NavBand, NavBandProvider } =
      require("../features/console/NavBand") as typeof import("../features/console/NavBand");
    const { CurrentContextPill } =
      require("../features/console/ContextStrip") as typeof import("../features/console/ContextStrip");
    const { Breadcrumb } =
      require("../features/console/files/Breadcrumb") as typeof import("../features/console/files/Breadcrumb");
    const { layout } =
      require("../features/design/tokens") as typeof import("../features/design/tokens");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

    act(() => {
      root.render(
        createElement(
          NavBandProvider,
          {
            nodes: {
              contexts: null,
              current: createElement(CurrentContextPill, {
                context: {
                  id: "seyi",
                  slug: "seyi",
                  displayName: "seyi",
                  role: "owner",
                  kind: "personal",
                  status: "ok",
                } as never,
                onOpenRoot: () => {},
                onSelect: () => {},
              }),
            },
            children: createElement(NavBand, {
              gutter: layout.readingMargin,
              path: createElement(Breadcrumb, {
                pathOnly: true,
                path: "3-resources/books/reading-notes/2026/the-lean-startup.md",
                contextLabel: "@seyi",
                visibility: "private",
                inherited: "private",
                exception: false,
                readOnly: false,
                onSelectFolder: () => {},
              }),
            }),
          },
        ),
      );
    });

    // The oldest two ancestors fold into `…`; the immediate parent survives
    // live, and the leaf — the whole point — comes back whole.
    expect(need(container, "breadcrumb-gap")).not.toBeNull();
    expect(need(container, "breadcrumb-leaf").textContent).toBe("the-lean-startup");
    expect(bandText(container)).not.toContain("3-resources");
    expect(bandText(container)).not.toContain("books");
    expect(bandText(container)).not.toContain("reading-notes");
    expect(bandText(container)).toContain("2026");
    write("6-deep-path-elided", container);

    act(() => root.unmount());
    container.remove();
  });
});
