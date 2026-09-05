/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FastSearchCard } from "../features/console/search/FastSearchCard";
import type { FastSearchView } from "../features/console/search/fastSearch";

/**
 * The switch itself, mounted.
 *
 * `fastSearchSettings.test.ts` holds the pure rules; what only exists inside
 * the component is *when the server is actually asked* — and this control asks
 * for a copy of somebody's private notes to be made, or for one to be deleted.
 * Both are one press away from a thumb, so the two things worth a reconciler
 * are: a control that is offered calls the mutation it names, and a control
 * that is not offered has no path to one.
 *
 * `react-native-web` renders these to real DOM (see `jest.config.js`), so the
 * text asserted below is the copy somebody actually reads.
 */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(view: FastSearchView, demo = false): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(createElement(FastSearchCard, { view, demo }));
  });
  return host.textContent ?? "";
}

function text(): string {
  return host?.textContent ?? "";
}

/**
 * A press that settles the promise it starts.
 *
 * `run` sets state in a `.finally`, so a press that reaches a mutation lands a
 * second update after the microtask queue drains. Awaiting inside `act` is
 * what keeps that update inside the same act scope instead of arriving as a
 * warning after the assertion.
 */
async function press(label: string): Promise<void> {
  const node = [...document.body.querySelectorAll("[aria-label]")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  expect(node).toBeDefined();
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

function offered(): string[] {
  return [...document.body.querySelectorAll('[role="button"]')].map(
    (node) => node.textContent ?? "",
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const TURN_ON = "Turn fast search on for this context";
const TURN_OFF = "Turn fast search off and delete the hosted index";

describe("turning it on", () => {
  test("the press an owner makes reaches the mutation", async () => {
    const enable = jest.fn(async () => {});
    mount({ status: { state: "off", canChange: true }, loading: false, enable });
    await press(TURN_ON);
    expect(enable).toHaveBeenCalledTimes(1);
  });

  test("the card says what the press puts where before it is pressed", () => {
    // The consent, at the moment of the decision. A card that says "make
    // search faster" is asking for the same permission without naming it.
    const body = mount({ status: { state: "off", canChange: true }, loading: false, enable: async () => {} });
    expect(body).toContain("private notes included");
    expect(body).toContain("Supa Media runs");
    expect(body).toContain("your own bucket");
  });
});

describe("turning it off takes two presses, and the first one is not it", () => {
  test("one press arms, and nothing has been deleted", async () => {
    const disable = jest.fn(async () => {});
    mount({ status: { state: "on", canChange: true }, loading: false, disable });
    await press(TURN_OFF);
    // The whole point: a mis-tap in a pocket must not delete an index that
    // took a backfill to build.
    expect(disable).not.toHaveBeenCalled();
    expect(text()).toContain("Press again to turn off");
  });

  test("the armed state says what the second press destroys and what survives", async () => {
    mount({ status: { state: "on", canChange: true }, loading: false, disable: async () => {} });
    await press(TURN_OFF);
    expect(text()).toContain("untouched in your own bucket");
  });

  test("the second press deletes", async () => {
    const disable = jest.fn(async () => {});
    mount({ status: { state: "on", canChange: true }, loading: false, disable });
    await press(TURN_OFF);
    await press(TURN_OFF);
    expect(disable).toHaveBeenCalledTimes(1);
  });
});

describe("a control nobody may use is not drawn", () => {
  test("a member sees the state and no switch, and is told who decides", () => {
    // `canChange: false` is the server's own answer. An editor may write every
    // note here; deciding where a copy of all of them is kept is not the same
    // authority, and a button whose only outcome is a permission error is
    // worse than no button.
    const body = mount({ status: { state: "on", canChange: false }, loading: false });
    expect(offered()).toEqual([]);
    expect(body).toContain("Only an owner of this context can change this");
  });

  test("a switch is withheld even when the console is holding the mutations", async () => {
    // Defence in depth, and the case the absent-action guard cannot catch: a
    // future caller that hands this card `enable`/`disable` without reading
    // `canChange` first must still draw nothing, because the server is the one
    // that decides and it already said no.
    const enable = jest.fn(async () => {});
    const disable = jest.fn(async () => {});
    mount({ status: { state: "off", canChange: false }, loading: false, enable, disable });
    expect(offered()).toEqual([]);
    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });

  test("the landing page's demo says where the decision is taken instead", () => {
    const body = mount({ status: { state: "off", canChange: false }, loading: false }, true);
    expect(offered()).toEqual([]);
    expect(body).toContain("open your own context");
  });

  test("an unanswered status offers nothing and claims nothing", () => {
    // Not an "off" with a switch: a console that guesses here offers to
    // provision a database every time the page is still loading.
    const body = mount({ status: null, loading: true });
    expect(offered()).toEqual([]);
    expect(body).toContain("Loading…");
    expect(body).not.toContain("Fast search is off");
  });

  test("a status that failed to load says so rather than spinning forever", () => {
    const body = mount({ status: null, loading: false });
    expect(body).toContain("could not be read");
  });
});

describe("a failed provision", () => {
  test("shows the deployment's own sentence and offers a retry", async () => {
    const enable = jest.fn(async () => {});
    const body = mount({
      status: {
        state: "failed",
        canChange: true,
        error: "The configured Cloudflare token was refused.",
      },
      loading: false,
      enable,
    });
    expect(body).toContain("The configured Cloudflare token was refused.");
    await press("Try preparing the index again");
    expect(enable).toHaveBeenCalledTimes(1);
  });
});

describe("a mutation that rejects", () => {
  test("says so in our words, and does not leave the button spinning", async () => {
    const enable = jest.fn(async () => {
      throw new Error("functions/fastSearch:enable failed");
    });
    mount({ status: { state: "off", canChange: true }, loading: false, enable });
    await press(TURN_ON);
    // Ours, not Convex's: a function path in a settings card tells a person
    // nothing they can act on.
    expect(text()).toContain("Check your connection and try again");
    expect(text()).not.toContain("functions/fastSearch");
  });
});
