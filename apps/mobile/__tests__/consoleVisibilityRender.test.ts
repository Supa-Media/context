/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { BrowsePane } from "../features/console/panes/BrowsePane";
import { SettingsPane } from "../features/console/panes/SettingsPane";
import { MembersSection } from "../features/console/members/MembersSection";
import { TierChip } from "../features/console/ConsoleShell";
import type { ConsoleData } from "../features/console/types";

/**
 * The class of bug this file exists to prevent: **the tier being correct in a
 * pure module and absent from the screen.**
 *
 * `consoleVisibility.test.ts` proves `visibility.ts` agrees with the control
 * plane. That is worth nothing if no pane ever asks it. A chip wired to the
 * wrong context, dropped from a pane head during a refactor, or rendered for
 * the owner as well as the guest would all leave that file green — and the
 * whole point of this work is that the guarantee was already enforced twice
 * and invisible once.
 *
 * So these mount the real panes over the real demo console, whose three
 * contexts are deliberately one of each shape: `@seyi` you own, `@lk` you are a
 * `member` of, and `@public-worship` you are an `editor` of.
 *
 * jsdom reports a viewport width of 0, which `PaneHead` reads as "not narrow",
 * so the head renders in full here — the trailing slot is drawn at every width
 * regardless, which is the property being asserted.
 */

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

/**
 * The demo console, with one of its three contexts selected.
 *
 * A probe component rather than a hand-written fixture: a literal typed here
 * would be a fourth copy of `ConsoleData`, and the role field it carries is
 * exactly the one this feature reads. Driving the real hook means a change to
 * how a context reports its role reaches these tests.
 */
function demoData(contextId: string): ConsoleData {
  let latest: ConsoleData | null = null;
  function Probe() {
    latest = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  act(() => {
    latest!.selectContext(contextId);
  });
  return latest!;
}

/** The demo's context ids, named so a test reads as the shape it is about. */
const OWNED = "seyi";
const MEMBER_OF = "lk";
const EDITOR_OF = "pw";

const CHIP = "team level only";

/*
  Each helper resolves its `ConsoleData` *before* mounting the pane. `demoData`
  runs its own `act`, and an `act` nested inside the render callback of another
  never flushes — the probe would still be holding `null`.
*/
function browse(contextId: string): string {
  const data = demoData(contextId);
  return mount(() => createElement(BrowsePane, { data })).textContent ?? "";
}

function settings(contextId: string): string {
  const data = demoData(contextId);
  return mount(() => createElement(SettingsPane, { data, onClose: () => {} })).textContent ?? "";
}

function members(contextId: string, viewerRole: string | undefined): HTMLElement {
  const view = demoData(contextId).members;
  return mount(() => createElement(MembersSection, { view, viewerRole }));
}

describe("the chip is worn once, by the frame", () => {
  /*
    `TierChip` sits in the top bar beside the storage pill, because the tier is
    a property of the context you are in rather than of the route — the same
    argument that moved `StorageChip` out of the Browse title. That placement
    is asserted here at the component level rather than by mounting the console
    layout, which would drag a router and every subscription in for one pill.

    What the panes are asserted for is the other half: that they do **not**
    repeat it. Two copies of the same claim two inches apart read as two
    different claims.
  */
  test("it names the limit for a role that has one", () => {
    expect(mount(() => createElement(TierChip, { role: "member" })).textContent).toContain(CHIP);
    expect(mount(() => createElement(TierChip, { role: "editor" })).textContent).toContain(CHIP);
  });

  test("an owner is not told they are limited, and neither is a role still loading", () => {
    for (const role of ["owner", undefined, null, "", "viewer"]) {
      expect(mount(() => createElement(TierChip, { role })).textContent).not.toContain(CHIP);
    }
  });

  test("no pane repeats it", () => {
    for (const context of [MEMBER_OF, EDITOR_OF, OWNED]) {
      expect(browse(context)).not.toContain(CHIP);
      expect(settings(context)).not.toContain(CHIP);
    }
  });
});

describe("Browse says so in words, because Browse is where the absence is invisible", () => {
  /*
    A private folder is not greyed out in the tree — it is not in the tree. An
    editor looking at a short list has no way to tell a small context from a
    filtered one, which is the single strongest reason this notice exists at
    all and why the *sentence* stays here even though the chip moved up to the
    frame.
  */
  test("a context you are only a member of gets the sentence", () => {
    expect(browse(MEMBER_OF)).toContain("invisible here");
  });

  test("a context you can edit is told write access did not include it", () => {
    // The conflation `functions/files.ts` exists to prevent, said out loud:
    // being trusted to write is a separate thing from seeing what somebody
    // marked private.
    expect(browse(EDITOR_OF)).toContain("you can edit this context");
  });

  test("your own context carries no notice at all", () => {
    expect(browse(OWNED)).not.toContain("invisible here");
  });
});

describe("the owner's side of the same fact lives with the people it is about", () => {
  test("an owner is told what having members did and did not hand over", () => {
    const text = members(OWNED, "owner").textContent;
    expect(text).toContain("team level");
    expect(text).toContain("mark it team");
  });

  test("it states the rule and never a count, because nothing here counts notes", () => {
    const container = members(OWNED, "owner");
    const line = container.querySelector('[data-testid="members-tier-rule"]');
    expect(line).not.toBeNull();
    // `ConsoleData` carries no note census and the listings it does carry are
    // the caller's own filtered view. A number drawn here would be a guess
    // rendered as a fact about somebody's storage — the exact failure #25 was.
    expect(line!.textContent).not.toMatch(/\d/);
  });

  test("a member reading somebody else's members list is told nothing about it", () => {
    const text = members(MEMBER_OF, "member").textContent;
    // "Anything you marked private is yours alone" would be a claim about the
    // owner's notes, addressed to the wrong person.
    expect(text).not.toContain("mark it team");
  });

  test("and neither is anybody whose role has not loaded", () => {
    const text = members(OWNED, undefined).textContent;
    expect(text).not.toContain("mark it team");
  });
});
