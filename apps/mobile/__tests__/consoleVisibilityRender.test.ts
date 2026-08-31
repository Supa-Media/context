/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The notch and the home indicator, as a number.

  Every screen now clears them through `features/app/Screen.tsx`, which reads
  `useSafeAreaInsets` — and that hook throws outside a `SafeAreaProvider`
  rather than answering zero. Mocking the hook is the same trade
  `appFrameRender.test.ts` makes: the insets are the platform's business, and a
  provider here would be a second thing under test.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

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

    **Once per screen, and on every screen of the context.** It was drawn only
    with nothing open, on the argument that it is a fact about the context and
    not about the file in front of you. The argument is right and the conclusion
    was wrong: a team link opens straight into a note or a folder, so the one
    person who has never seen this context — and is looking at a listing with
    things missing from it — is precisely the person who was told nothing.

    What made that look reasonable was a comment claiming a fallback: "inside a
    note or a folder the chip at the foot of the file tree carries the same
    claim". There is no such chip on a phone. A safeguard asserted in a comment
    and absent from the screen is worse than no safeguard, because it stops
    anybody looking.

    So: one line, wherever you are, scrolling with the document. The *paragraph*
    is what does not travel — see the last test here and the members card.
  */
  const LINE = "Team access";

  test("a context you are only a member of gets the sentence", () => {
    expect(browseRoot(MEMBER_OF)).toContain(LINE);
  });

  test("a context you can edit is told write access did not include it", () => {
    // The conflation `functions/files.ts` exists to prevent, said out loud:
    // being trusted to write is a separate thing from seeing what somebody
    // marked private.
    expect(browseRoot(EDITOR_OF)).toContain("you can edit this context");
  });

  test("your own context carries no notice at all", () => {
    expect(browseRoot(OWNED)).not.toContain(LINE);
  });

  test("a role that has not loaded is told nothing, rather than assumed filtered", () => {
    /*
      The failure this rules out is the one the owner reported as "I am the
      owner??": a predicate that defaults to "filtered until proven otherwise"
      would put "Team access" in front of an owner on every cold load, and
      permanently if the role never arrived.

      Driven through the pane rather than through `tierSentence` alone, because
      the pure rule was already right and the question is whether the pane can
      reach a state that renders it anyway.
    */
    const loading = { ...atRoot(demoData(MEMBER_OF)), loading: true, contexts: [] } as ConsoleData;
    expect(mount(() => createElement(BrowsePane, { data: loading })).textContent).not.toContain(
      LINE,
    );
  });

  test("a team link into a note is told the view is filtered", () => {
    /*
      The demo console opens on a note, which is what makes it the right fixture
      for this: `demoData` is the "inside a file" state, and it is the state a
      team link lands somebody in.
    */
    const data = demoData(MEMBER_OF);
    expect(mount(() => createElement(BrowsePane, { data })).textContent).toContain(LINE);
  });

  test("a team link into a folder is told the same", () => {
    const data = demoData(MEMBER_OF);
    const folder = Object.keys(data.files.listings).find((path) => path !== "");
    // A fixture that silently had no folder in it would make this vacuous.
    expect(folder).toBeDefined();
    const inFolder = {
      ...data,
      files: { ...data.files, selectedPath: folder! },
    } as ConsoleData;
    expect(mount(() => createElement(BrowsePane, { data: inFolder })).textContent).toContain(LINE);
  });

  test("it is drawn once, not once per thing that could carry it", () => {
    for (const data of [demoData(MEMBER_OF), atRoot(demoData(MEMBER_OF))]) {
      const container = mount(() => createElement(BrowsePane, { data }));
      expect(container.querySelectorAll('[data-testid="browse-tier-notice"]')).toHaveLength(1);
    }
  });

  test("the line is one line, and the argument for it is nowhere near it", () => {
    /*
      Both halves matter and they used to be printed together, four lines deep,
      on the one screen the notice appeared on. `tierExplanation`'s own docstring
      says the paragraph belongs where somebody has gone looking for it and "not
      on every screen" — and now that the line *is* on every screen, printing
      the paragraph with it would be that mistake multiplied.
    */
    for (const text of [browseRoot(MEMBER_OF), browse(MEMBER_OF), browseRoot(EDITOR_OF)]) {
      expect(text).not.toContain("Only a context's owner sees their private notes.");
      expect(text).not.toContain("Being trusted to write is a separate thing");
    }
  });

  test("and the argument is reachable, on the card that is about who can read this", () => {
    // Where `tierExplanation` says it belongs, and where the owner's half of
    // the same fact (`memberReachSentence`) has always been drawn.
    expect(members(MEMBER_OF, "member").textContent).toContain(
      "Only a context's owner sees their private notes.",
    );
    expect(members(EDITOR_OF, "editor").textContent).toContain(
      "Being trusted to write is a separate thing",
    );
    // And it is the reader's own half only: an owner is told what having
    // members handed over, never that their own view is filtered.
    expect(members(OWNED, "owner").textContent).not.toContain("is invisible here");
  });
});

/**
 * The same console with nothing open — the context's own view.
 *
 * The demo hook selects a note on mount, because a picture of the product with
 * an empty editor in it is a bad picture. This is the other state, which is the
 * one the tier line is drawn on.
 */
function atRoot(data: ConsoleData): ConsoleData {
  return { ...data, files: { ...data.files, selectedPath: null } };
}

function browseRoot(contextId: string): string {
  const data = atRoot(demoData(contextId));
  return mount(() => createElement(BrowsePane, { data })).textContent ?? "";
}

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
