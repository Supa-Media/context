/**
 * @jest-environment jsdom
 */

/**
 * Every context this account can reach is on the screen at every density; the
 * panes that are not Browse still carry the navigation band; and search's
 * two presentations.
 *
 * Split out of `consoleChrome.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
// `./fixtures` first: its `jest.mock("react-native-safe-area-context", ...)`
// must register before `EditorRegion`/`NavBand` are required, or those pull in
// the real module.
import { mountConsole } from "./fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorRegion } from "../../features/console/EditorRegion";
import { NavBandProvider } from "../../features/console/NavBand";

/**
 * THE SWITCHER EXISTS AT EVERY DENSITY, AND WHICH ONE IT IS CHANGES.
 *
 * "A session resolves to a *set* of accessible contexts — one connection
 * reaches every context its person is a live member of" is the product, not a
 * layout preference, so the surface that offers that set is not allowed to be a
 * phone feature. It was asserted at 390 alone: the file above counts the
 * strip's landmark and pins what the top row holds, all of it at compact,
 * because that is where the two-rows-of-chrome complaint came from.
 *
 * Nothing said the same thing about 1440, and the cost of that showed up in the
 * one console anybody can open in a browser: `/e2e-fixture` mounted the strip
 * and not the rail, so above 880pt it drew no way to another context at all,
 * and a green suite said nothing (`fixtureConsoleDensity.test.ts` is that hole,
 * closed). The product was right the whole time — which is exactly the claim
 * that was resting on nobody having checked.
 *
 * So this asks one question at both densities and does not care which component
 * answers it: is every context this account can reach on the screen, named, and
 * pressable? At compact that is `ContextStrip`; at wide it is `ConsoleRail`.
 * `frame.ts` is explicit that it is never both at once, so that is asserted
 * here too — the strip's dot means *kind* and the rail's means *storage
 * status*, and one glyph with two meanings on one screen is worse than either.
 *
 * SABOTAGE: return `rail: "hidden"` from `regionsFor`'s wide arm and "a pointer
 * layout offers them too" fails; gate `_layout`'s `contexts` node on something
 * other than `phone` and "a phone offers every context" fails.
 */
describe("every context this account can reach is on the screen", () => {
  /*
    Controls naming the one context this account is *not* in. Matched with its
    `@`, which `atName` puts on every label either surface draws: a bare slug is
    a substring of ordinary prose, and a note titled after the workspace would
    make this pass with no switcher on the screen at all.
  */
  const reachable = (app: ReturnType<typeof mountConsole>) =>
    Array.from(app.container.querySelectorAll('[role="button"]'))
      .map((node) => `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`)
      .filter((label) => label.includes("@public-worship")).length;

  test("a phone offers every context, on the strip", () => {
    const app = mountConsole(390);

    expect(app.find("context-strip")).not.toBeNull();
    expect(app.find("console-rail")).toBeNull();
    expect(reachable(app)).toBeGreaterThan(0);

    app.unmount();
  });

  test("a pointer layout offers them too, in the switcher", () => {
    /*
      It used to assert `console-rail` and read the rows off the container.
      The rail folded into the menu under the workspace's name, so the list is
      behind one press — and a press is what a person makes to reach it, which
      is the thing this file exists to prove is possible.
    */
    const app = mountConsole(1440);

    expect(app.find("console-rail")).toBeNull();
    expect(app.find("context-strip")).toBeNull();
    expect(app.find("frame-switcher")).not.toBeNull();

    app.press(app.find("frame-switcher"));
    expect(app.find("switcher-context-public-worship")).not.toBeNull();

    app.unmount();
  });
});

describe("the panes that are not Browse carry the navigation too", () => {
  /*
    THE FIXTURE ABOVE DRAWS `NavBand` ITSELF, AND THAT IS THE RIGHT CALL — a
    `Slot` rendering `null` would be a layout with the navigation missing, so
    every assertion about the strip would be testing the absence. But it means
    those assertions cannot say anything about the pane that draws the band on
    Map, Connections and Settings, because the fixture stands in for it.

    MEASURED, on `main`: deleting `EditorRegion`'s `<NavBand />` — the only one
    for every non-Browse pane — left the whole mobile suite green at 3,516. A
    phone on Settings would have had no rail (hidden at compact) and no strip,
    which is no navigation at all, and nothing would have said so.

    So this mounts the real `EditorRegion`. `BrowsePane` is already covered the
    same way in `noteChrome.test.ts`; between them both halves of "the console
    always has a way out" rest on a real component rather than on a mock.
  */
  const mountEditorRegion = (phone: boolean) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() => {
      root.render(
        createElement(
          NavBandProvider as never,
          /*
            Plain nodes: `NavBand` draws the band when the provider holds any,
            and what the contexts row CONTAINS is `ContextStrip`'s own question,
            asked in `contextStrip.test.ts`. Coupling this to that component's
            props would buy nothing and break on a rename.

            The shape here is `nodes: { contexts, current }`. It was `node` when
            this was written, and #255 changed it — which these two checks
            caught by failing, which is the whole point of mounting the real
            component rather than a fixture that supplies it.
          */
          {
            nodes: {
              contexts: createElement("div", null, "contexts"),
              current: createElement("div", null, "here"),
            },
          },
          createElement(
            EditorRegion as never,
            { browse: false, failure: null, tabs: null, onCloseTab: () => {}, phone },
            createElement("div", null, "a pane"),
          ),
        ),
      );
    });
    return {
      band: () => container.querySelector('[data-testid="nav-band"]'),
      unmount: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  test("a non-Browse pane draws the navigation band on a phone", () => {
    const view = mountEditorRegion(true);
    expect(view.band()).not.toBeNull();
    view.unmount();
  });

  test("...and on a pointer, where the rail is present too", () => {
    /*
      The positive twin for the phone case above. If this drew nothing on a
      pointer the first assertion would still pass while the component was
      broken for everybody — and asserting only the phone would leave the
      band's presence resting on one density.
    */
    const view = mountEditorRegion(false);
    expect(view.band()).not.toBeNull();
    view.unmount();
  });
});

describe("search", () => {
  test("a pointer gets the ⌘K field; a phone gets the toolbar button", () => {
    const desktop = mountConsole(1440);
    expect(desktop.find("frame-search")).not.toBeNull();
    desktop.unmount();

    // Doubling the same control onto the screen with least room for it would
    // be the obvious "consistency" fix and the wrong one.
    const phone = mountConsole(390);
    expect(phone.find("frame-search")).toBeNull();
    phone.unmount();
  });
});
