/**
 * @jest-environment jsdom
 */

/**
 * THE TWO PERMANENT BANDS ABOVE SOMEBODY ELSE'S CONTEXT.
 *
 * A `member` of a shared context read this above every note, every folder and
 * every listing, on every load, with no way to put either away:
 *
 *   Team access — notes marked private are not shown here.
 *   This is Context's own workspace, not yours — read anything here, and use a
 *   form to file a bug or a request. Your own notes are never in it.
 *
 * and, two inches above both, the `team level only` chip the frame draws on
 * every route of the context anyway. Three statements of one relationship, on
 * the pinned `@context-lc` — a workspace every account has in its rail and
 * opens repeatedly. The owner reported them as useless.
 *
 * The sentences are not the useless part. A status was being drawn as news,
 * and drawn twice. So:
 *
 *  - the **fact** stays where a permanent fact belongs — the chip, plus
 *    `tierExplanation` on the members card, neither touched;
 *  - the **band** is what a band is for, and is answered once per context;
 *  - and there is never more than one of it.
 *
 * `consoleVisibilityRender.test.ts` still holds the half that must not move:
 * the line is drawn on every screen of a context — a note, a folder, the root
 * — for a reader who has not answered it, because a team link lands a stranger
 * inside a filtered listing and that stranger is the whole reason it exists.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the pinned rule dropped, so both sentences stack again                   1
 *   the dismissal held in component state and never written down             2
 *   the key built without the kind, so a promotion is answered in advance    1
 *   the key built without the workspace, so one answer silences them all     1
 *   `demo` given a Got it button, hiding the landing page's call to action   1
 *
 * The third of those was **not caught** by the first version of this file: the
 * promotion case asserted that two roles produce two kinds and never that the
 * key carries the kind, so a key built from the workspace alone passed a test
 * written to prevent exactly that. It asserts the key now. Left as it was, the
 * check would have read as a guard and been none — which is what
 * `docs/decisions/testing.md` is one rule about.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  useConvex: () => undefined,
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { BrowsePane } from "../features/console/panes/BrowsePane";
import { TierChip } from "../features/console/ConsoleShell";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { contextIntro, contextIntroDismissedKey } from "../features/console/contextIntro";
import type { ConsoleData } from "../features/console/types";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

beforeEach(() => {
  // The answer is written to the device, so one case's "Got it" would
  // otherwise silence the next case's band.
  window.localStorage.clear();
});

/** The demo's context ids: one you own, one you are a `member` of. */
const OWNED = "seyi";
const MEMBER_OF = "lk";

const TIER_LINE = "Team access";
const CHIP = "team level only";

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

/** Mounts and lets the device answer, which is what decides the band. */
async function mountLive(render: () => ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = mount(render);
  await act(async () => {});
  return container;
}

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
  // `demo: false` because the demo is the landing page's picture, and the one
  // surface where this band is permanent by design. Every case here is about
  // the console a real member sees.
  return { ...latest!, demo: false } as ConsoleData;
}

const browse = (data: ConsoleData) => mountLive(() => createElement(BrowsePane, { data }));

const band = (host: HTMLElement) => host.querySelector('[data-testid="browse-context-intro"]');

function press(host: HTMLElement, selector: string): void {
  const node = host.querySelector(selector) as HTMLElement | null;
  expect(node).not.toBeNull();
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

describe("what the band says is one paragraph, never a stack", () => {
  /*
    The rules, as rules. The render cases below prove a pane asks them; these
    prove what the answers are, including for the pinned context — which has no
    demo fixture, because nothing in the demo is a workspace nobody invited you
    to.
  */
  const PINNED = "This is Context's own workspace, not yours — read anything here.";

  test("the pinned context says what it is, and not also what it withholds", () => {
    /*
      The two sentences overlap most exactly where they were most annoying. A
      visitor to Context's own docs does not need "notes marked private are not
      shown here" — of course they are not — and the pinned sentence already
      states the whole relationship *and* the one thing a visitor can do, which
      is file a bug through a form.
    */
    const intro = contextIntro({
      role: "member",
      pinned: true,
      canEdit: false,
      readOnlyReason: PINNED,
    });
    expect(intro?.text).toBe(PINNED);
    expect(intro?.text).not.toContain(TIER_LINE);
  });

  test("a member of an ordinary context gets both facts in one band", () => {
    // Genuinely two facts — what you cannot see, and what you cannot write —
    // so neither is dropped. One band, because two bands is the complaint.
    const intro = contextIntro({
      role: "member",
      canEdit: false,
      readOnlyReason: "You have read-only access to this context.",
    });
    expect(intro?.text).toContain(TIER_LINE);
    expect(intro?.text).toContain("read-only access");
  });

  test("an editor is told about reading, not about a write they have", () => {
    const intro = contextIntro({
      role: "editor",
      canEdit: true,
      readOnlyReason: "You have read-only access to this context.",
    });
    expect(intro?.text).toContain("you can edit this context");
    expect(intro?.text).not.toContain("read-only access");
  });

  test("an owner, and a role still loading, are told nothing at all", () => {
    expect(contextIntro({ role: "owner", canEdit: true })).toBeNull();
    expect(contextIntro({ role: undefined, canEdit: true })).toBeNull();
  });

  test("a promotion is a different intro, so it is offered again", () => {
    /*
      The kind is part of the dismissal key. Keyed on the workspace alone,
      somebody who answered this as a `member` and was later made an `editor`
      would never be told that write access arrived without the private notes
      coming with it — which is the exact conflation `functions/files.ts` exists
      to prevent, silenced by a flag.
    */
    const asMember = contextIntro({ role: "member", canEdit: false, readOnlyReason: "x" });
    const asEditor = contextIntro({ role: "editor", canEdit: true });
    expect(asMember?.kind).not.toBe(asEditor?.kind);
    // And the key carries it, which is where the silence would actually happen:
    // two different sentences answered by one flag on the same workspace.
    expect(contextIntroDismissedKey("w1", asMember!.kind)).not.toBe(
      contextIntroDismissedKey("w1", asEditor!.kind),
    );
  });
});

describe("the band is read once; the fact stays on the chip", () => {
  test("a member is told, and answering it is remembered for that context", async () => {
    const first = await browse(demoData(MEMBER_OF));
    expect(band(first)).not.toBeNull();
    expect(first.textContent ?? "").toContain(TIER_LINE);

    press(first, '[data-testid="browse-context-intro-dismiss"]');
    expect(band(first)).toBeNull();

    // Written down, per context — and the second mount is the reload. Component
    // state would pass the assertion above and fail this one, which is the
    // difference between answering a notice and hiding it until you blink.
    const data = demoData(MEMBER_OF);
    const context = data.contexts.find((row) => row.id === MEMBER_OF);
    const key = contextIntroDismissedKey(
      context!.id,
      contextIntro({
        role: context!.role,
        pinned: context!.pinned,
        canEdit: data.files.canEdit,
        readOnlyReason: data.files.readOnlyReason,
      })!.kind,
    );
    expect(window.localStorage.getItem(key)).not.toBeNull();

    while (roots.length > 0) roots.pop()!();
    expect(band(await browse(demoData(MEMBER_OF)))).toBeNull();
  });

  test("and the console still says the view is filtered afterwards", async () => {
    /*
      THE SABOTAGE GUARD FOR ALL OF THIS.

      If answering the band were the only thing saying a view is filtered, this
      change would have traded a nag for a reader who is told nothing — worse,
      and silent. The chip is permanent, on every route of the context, and is
      what carries the fact once the sentence has been read; the paragraph
      behind it is on the members card. Neither moved.
    */
    const host = await browse(demoData(MEMBER_OF));
    press(host, '[data-testid="browse-context-intro-dismiss"]');
    expect(band(host)).toBeNull();

    while (roots.length > 0) roots.pop()!();
    expect(mount(() => createElement(TierChip, { role: "member" })).textContent).toContain(CHIP);
  });

  test("answering it for one context does not answer it for another", async () => {
    /*
      Per workspace, because the offer is per workspace: being finished with
      what one context is to you says nothing about the next one somebody
      shares. A single global flag would tell the first reader and nobody
      after.
    */
    const host = await browse(demoData(MEMBER_OF));
    press(host, '[data-testid="browse-context-intro-dismiss"]');

    const keys = Object.keys(window.localStorage);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(MEMBER_OF);
  });

  test("your own context never had a band to answer", async () => {
    /*
      `canEdit`, because the demo's owner cannot write — it is a picture of the
      product, and its file browser carries the landing page's "sign in" line
      for every context in it. A real owner can, which is the state this is
      about: no tier sentence, no read-only reason, so nothing is built at all.
    */
    const data = demoData(OWNED);
    const host = await browse({
      ...data,
      files: { ...data.files, canEdit: true },
    } as ConsoleData);
    expect(band(host)).toBeNull();
  });
});

describe("the landing page keeps its line, and keeps it permanent", () => {
  test("the demo draws the band with no control on it", async () => {
    /*
      The one surface where a permanent band is right: on the demo this line is
      "This is a demo. Sign in to edit your own workspace" — the page's call to
      action, not an orientation somebody is finished with. A Got it button
      there would let a visitor hide the reason the page exists.
    */
    // The same fixture as every case above, with the one flag that separates
    // the landing page's picture from the console put back.
    const host = await browse({ ...demoData(OWNED), demo: true } as ConsoleData);
    expect(host.textContent ?? "").toContain("This is a demo");
    expect(band(host)).not.toBeNull();
    expect(host.querySelector('[data-testid="browse-context-intro-dismiss"]')).toBeNull();
  });
});
