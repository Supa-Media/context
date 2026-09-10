/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CurrentContextPill } from "../features/console/ContextStrip";
import { NavBand, NavBandProvider } from "../features/console/NavBand";
import type { ConsoleContext } from "../features/console/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **The context you are in is a button at the head of the breadcrumb.**
 *
 * This is the second answer to one defect and the record of the first answer
 * being wrong, which is why it is a file rather than two more cases in
 * `contextStrip.test.ts`.
 *
 * The strip named the current context one row above a breadcrumb that named it
 * again. The first fix deleted the breadcrumb's context segment — duplication
 * gone, and the **way up** gone with it: a top-level folder has no ancestors,
 * so the path row was empty and nothing on the screen led back to the root of
 * your own context. It shipped that way. The owner's report of it is the
 * specification these tests encode:
 *
 * > when I'm on a workspace, the button for that workspace should essentially
 * > move to the breadcrumb… that workspace button removes from the workspace
 * > column, but is put in the breadcrumbs column. So I'm still able to get to
 * > the root.
 *
 * So: **moved**, not deleted. The assertions below are about what is on the
 * screen and what a press does, never about a flag — the failure was a control
 * that was not there, and a boolean saying it should have been would have been
 * green throughout.
 */

function context(over: Partial<ConsoleContext> = {}): ConsoleContext {
  return {
    id: `ws_${over.slug ?? "seyi"}`,
    slug: "seyi",
    kind: "personal",
    role: "owner",
    status: "ok",
    ...over,
  } as ConsoleContext;
}

interface Mounted {
  find: (testID: string) => HTMLElement | null;
  need: (testID: string) => HTMLElement;
  text: () => string;
  press: (testID: string) => void;
  unmount: () => void;
}

let live: Array<() => void> = [];

afterEach(() => {
  for (const close of live) close();
  live = [];
});

function mount(node: ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  act(() => {
    root.render(node);
  });
  const close = () => {
    act(() => root.unmount());
    container.remove();
  };
  live.push(close);

  const find = (testID: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  return {
    find,
    need: (testID) => {
      const node = find(testID);
      if (node === null) throw new Error(`no element with testID ${testID}`);
      return node;
    },
    text: () => container.textContent ?? "",
    press: (testID) => {
      const node = find(testID);
      if (node === null) throw new Error(`no element with testID ${testID}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    unmount: close,
  };
}

/** The band as the console layout builds it, with a stub path row. */
function mountBand(
  over: { current?: ReactElement | null; contexts?: ReactElement | null; path?: ReactElement | null } = {},
  onOpenRoot: () => void = () => {},
): Mounted {
  const current =
    over.current === undefined
      ? createElement(CurrentContextPill, {
          context: context({ slug: "seyi" }),
          onOpenRoot,
          onSelect: () => {},
        })
      : over.current;
  return mount(
    createElement(
      NavBandProvider,
      {
        nodes: { contexts: over.contexts ?? null, current },
        children: createElement(NavBand, { path: over.path ?? null }),
      },
    ),
  );
}

/* -------------------------------------------------------------------------- */

describe("the context you are in", () => {
  /**
   * SABOTAGE: `nodes.current` set to `null` in `console/_layout`. Fails here —
   * and this is exactly the shipped defect, so it is the case that has to fail
   * loudest.
   */
  test("is drawn in the band, as a button", () => {
    const band = mountBand();
    const pill = band.need("nav-context-seyi");
    expect(pill.getAttribute("role")).toBe("button");
    expect(band.text()).toContain("@seyi");
  });

  /**
   * The way up, which is the whole reason the button exists rather than a
   * label. `onOpenRoot` stays `() => void` at this layer regardless of what a
   * caller does with the press — `NavBand`/`ContextStrip` do not know or care
   * whether that is a navigation or not — so this only proves the wiring:
   * exactly one press, exactly one call.
   *
   * **What used to be asserted here was stronger than the prop actually
   * promises**, and the strength was wrong: this test's own name read "presses
   * to somewhere, and that somewhere is asked for", on the assumption that
   * `onOpenRoot` necessarily produces a navigation. It no longer does —
   * `console/_layout.tsx` calls `data.files.deselect()` directly, and there is
   * no "somewhere" to ask for, on purpose (see `breadcrumbRoot.test.ts`, "the
   * press calls deselect and makes no router call"). A test at this layer
   * cannot see that distinction either way, since `mountBand` supplies its own
   * stub handler rather than the layout's real one — which is exactly why it
   * must not claim more than "the button calls its prop".
   *
   * SABOTAGE: the press handler wired to fire twice (once on `mousedown`,
   * once on `click`). Fails here.
   */
  test("presses call the handler once, whatever it does", () => {
    const opened: number[] = [];
    const band = mountBand({}, () => opened.push(1));
    band.press("nav-context-seyi");
    expect(opened).toHaveLength(1);
  });

  /**
   * The name says where you are AND what the press does. On the strip the
   * label was "@seyi, the context you are in", which was true of a pill whose
   * press went nowhere visible. This one navigates, so a screen reader is told.
   *
   * SABOTAGE: reverted the label to the strip's. Fails here.
   */
  test("says what it is and what pressing it does", () => {
    const band = mountBand();
    expect(band.need("nav-context-seyi").getAttribute("aria-label")).toBe(
      "@seyi, the context you are in — open its root",
    );
  });

  test("is absent outside a context, where there is no root to open", () => {
    // Map, Connections and Settings with nothing selected.
    const band = mountBand({ current: null });
    expect(band.find("nav-context-seyi")).toBeNull();
  });
});

describe("the band's two rows", () => {
  /**
   * The button and the path scroll together: they are one line — *this context,
   * then this folder* — and two scrollers would let the button sit still while
   * the path it heads slid out from under it.
   *
   * SABOTAGE: moved the `ScrollView` back inside `Breadcrumb.pathOnly`. Fails
   * here, because the button is then outside it.
   */
  test("the context button and the path are in one scroller", () => {
    const path = createElement("span", { "data-testid": "stub-path" }, "/ 1-projects");
    const band = mountBand({ path });
    const trail = band.need("nav-band-trail");
    expect(trail.contains(band.need("nav-context-seyi"))).toBe(true);
    expect(trail.contains(band.need("stub-path"))).toBe(true);
  });

  test("and that row is horizontal, because a path is longer than a phone", () => {
    const band = mountBand();
    expect(getComputedStyle(band.need("nav-band-trail")).flexDirection).not.toBe("column");
  });

  /**
   * The falloff, asserted as far as jsdom can see it — `contextStrip.test.ts`
   * makes the same assertion the same way and records why: react-native-web
   * compiles the gradient to an atomic class and jsdom's `cssstyle` drops
   * `background-image: linear-gradient(…)` as a value it cannot parse, so
   * `getComputedStyle` answers `""` whether the fade is there or not. The class
   * is what is observable, and it is only emitted for a declaration that was
   * made. **Whether it looks right is unverified here**; that was checked in a
   * real browser, which is how the row's missing falloff was found at all.
   *
   * It is on this row because a path overflows it far more often than the
   * contexts overflow the one above — `1-projects/october-group-airbnb-trip` is
   * already past a 390pt screen — and `ContextStrip`'s rule is that a thing cut
   * by a hard edge reads as a rendering bug where the same thing under a
   * falloff reads as a list.
   *
   * SABOTAGE: removed the fade from `NavBand`. Fails here.
   */
  test("the path row fades at its trailing edge rather than being cut", () => {
    const band = mountBand({ path: createElement("span", null, "/ 1-projects") });
    const fade = band.need("nav-band-fade");
    expect(fade.className).toContain("r-backgroundImage");
    // It lies over the last segment, so it must not be able to eat a press.
    expect(fade.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(fade).pointerEvents).toBe("none");
  });

  test("the band draws nothing at all when it has neither row", () => {
    // Every pointer density, and the landing page's picture of the console.
    const band = mountBand({ current: null, contexts: null, path: null });
    expect(band.find("nav-band")).toBeNull();
  });

  test("a context with nothing to switch to still gets its own button", () => {
    /*
      One brain, no workspaces. `stripEntries` answers `null` so there is no
      contexts row — and the person still has to be able to reach their root,
      which is the row that is left.
    */
    const band = mountBand({ contexts: null });
    expect(band.find("nav-band")).not.toBeNull();
    expect(band.find("nav-context-seyi")).not.toBeNull();
  });
});
