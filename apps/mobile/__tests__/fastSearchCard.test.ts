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

/* -------------------------------------------------------------------------- */
/*                          how much of it is indexed                          */
/* -------------------------------------------------------------------------- */

/**
 * The percentage, on the card, mounted.
 *
 * `fastSearchSettings.test.ts` pins the arithmetic and the copy. What only
 * exists here is whether the card *draws* it — and, far more importantly,
 * whether it draws anything at all for a viewer the server declined to tell.
 *
 * That last one is the most important assertion in this feature. `notesIndexed`
 * and `notesPending` are dropped for anyone who is not the owner because the
 * index counts every note the context has, private ones included, while a
 * member may read only the `team` tier: a total, or any percentage of it, is
 * the size of what they are not being shown, and it moves as private notes are
 * written. So the rule the card is held to is not "shows a dash" or "shows 0%"
 * but **renders nothing** — asserted over the whole rendered text, not over one
 * element, so a placeholder introduced anywhere on the card fails it.
 */
function accessibleName(testId: string): string | null {
  const node = document.body.querySelector(`[data-testid="${testId}"]`);
  return node?.getAttribute("aria-label") ?? null;
}

describe("the percentage on the card", () => {
  test("an owner mid-backfill is shown how far through it is, and how many notes", () => {
    const body = mount({
      status: { state: "preparing", canChange: true, notesIndexed: 620, notesPending: 380 },
      loading: false,
      disable: async () => {},
    });
    expect(body).toContain("62% indexed");
    // The count stays: a percentage alone cannot say whether 62% is six notes
    // or six thousand.
    expect(body).toContain("620 notes indexed · 380 waiting");
  });

  test("the visible fragment is not what a screen reader is given", () => {
    // "62% indexed" says nothing about what is indexed or what the denominator
    // is. The accessible name is the sentence — and it names the index rather
    // than letting the figure read as a fact about the customer's own bucket.
    mount({
      status: { state: "preparing", canChange: true, notesIndexed: 620, notesPending: 380 },
      loading: false,
      disable: async () => {},
    });
    const name = accessibleName("fast-search-progress");
    expect(name).toContain("fast-search index");
    expect(name).toContain("620 of the 1,000");
    expect(name).not.toBe("62% indexed");
  });

  test("A MEMBER IS SHOWN NO PERCENTAGE ANYWHERE ON THE CARD", () => {
    /*
      The privacy rule, mounted. The server sends a member `state` and
      `canChange` and drops the counters; the card must therefore draw no
      figure, no `0%`, no em dash and no skeleton implying one is coming.

      Asserted across every state, because "off" and "unavailable" are the
      states somebody would reach for a placeholder in, and asserted over the
      card's entire text rather than over the progress element — a percentage
      reintroduced in the blurb, the pill or a new row fails this too.
    */
    for (const state of ["off", "preparing", "on", "failed", "unavailable"] as const) {
      const body = mount({ status: { state, canChange: false }, loading: false });
      expect(body).not.toMatch(/\d+\s*%/);
      expect(body).not.toMatch(/indexed/i);
      // Not an em-dash sweep over the whole card: the consent paragraph uses
      // one as punctuation. So the *containers* that would carry a placeholder
      // are asserted absent instead — an em dash, a "0%" or a skeleton put
      // inside either of them fails here, where a text sweep would read it as
      // ordinary copy.
      expect(document.body.querySelector('[data-testid="fast-search-progress"]')).toBeNull();
      expect(document.body.querySelector('[data-testid="fast-search-index"]')).toBeNull();
      act(() => root?.unmount());
      host?.remove();
    }
  });

  test("an owner whose backfill has not moved is told so in words, not as 0%", () => {
    // The state the missing backfill was actually in. A figure sitting at zero
    // reads as a number somebody is computing; this reads as the fact it is.
    const body = mount({
      status: { state: "preparing", canChange: true, notesIndexed: 0, notesPending: 1284 },
      loading: false,
      disable: async () => {},
    });
    expect(body).toContain("Nothing indexed yet");
    expect(body).not.toMatch(/0\s*%/);
  });

  test("a context with fast search off is not drawn as 0% indexed", () => {
    // Off is a working state. A percentage on it is a badge somebody clears by
    // turning on a copy of their private notes.
    const body = mount({
      status: { state: "off", canChange: true, notesIndexed: 0, notesPending: 0 },
      loading: false,
      enable: async () => {},
    });
    expect(body).not.toMatch(/\d+\s*%/);
    expect(document.body.querySelector('[data-testid="fast-search-progress"]')).toBeNull();
  });

  test("a finished index keeps its 100% rather than going quiet", () => {
    const body = mount({
      status: { state: "on", canChange: true, notesIndexed: 1284, notesPending: 0 },
      loading: false,
      disable: async () => {},
    });
    expect(body).toContain("100% indexed");
  });
});
