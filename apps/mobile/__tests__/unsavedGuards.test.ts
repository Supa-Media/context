/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The three things standing between a draft and the bin.
 *
 * Nothing in this app autosaves: `editor.ts` holds the draft in a reducer, the
 * only thing that writes it to the bucket is Save, and the editor's resting
 * state says "Saved in your bucket" — a durability claim the dirty state has
 * no counterpart for. So the guards *are* the feature, and every one of them
 * was either missing or documented-but-absent before this file existed:
 *
 *  - `guardLeaving` refused to open another note, and `useTabs.activate`
 *    routed around it by dispatching first;
 *  - `tabs.ts` said "the UI confirms before dispatching" and nothing did
 *    (covered in `fileTabs.test.ts`, which owns the reducer);
 *  - the browser tab could simply be closed.
 *
 * This file covers the first and the third.
 */

const { useTabs } =
  require("../features/console/files/useTabs") as typeof import("../features/console/files/useTabs");
const { useUnsavedGuard } =
  require("../features/console/files/useUnsavedGuard.web") as typeof import("../features/console/files/useUnsavedGuard.web");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type FileBrowser = import("../features/console/files/browser").FileBrowser;

/**
 * `useTabs` reads three fields off the browser and nothing else — `listings`
 * for pruning, `select` for moving the editor, `editor` for the open path.
 *
 * Written as a partial with those three rather than as a forty-field literal:
 * a stub that lists every member of an interface the subject never touches is
 * a stub that has to be edited every time the interface grows, and it hides
 * which three actually matter here. The cast is the honest form of that.
 */
function browserWhereSelect(answers: boolean, openPath: string | null = null): FileBrowser {
  return {
    listings: {},
    select: () => answers,
    editor: openPath === null ? emptyEditor : { ...emptyEditor, status: "clean", path: openPath },
  } as unknown as FileBrowser;
}

function mountTabs(files: FileBrowser) {
  let live: ReturnType<typeof useTabs> | null = null;
  function Probe() {
    live = useTabs(files, "ctx");
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Probe)));
  return {
    api: () => live!,
    act: (fn: () => void) => act(fn),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */

describe("the tab strip cannot move without the editor", () => {
  test("a refused select leaves the active tab where it was", () => {
    /*
      The desync this fixes. `activate` dispatched `activated` and *then* called
      `select`, which refuses while the open note has unsaved changes — so the
      strip highlighted the tab you pressed while the editor still held the old
      one, and the hook's own effect re-fired the same refusal on every render.

      `useTabs`' effect calls that "the exact desync this hook's one-direction
      rule exists to prevent"; it arrived through the one call that skipped the
      rule.
    */
    const tabs = mountTabs(browserWhereSelect(false, "a.md"));

    tabs.act(() => tabs.api().pin("a.md"));
    tabs.act(() => tabs.api().pin("b.md"));
    const before = tabs.api().state.activePath;

    tabs.act(() => tabs.api().activate("a.md"));

    expect(tabs.api().state.activePath).toBe(before);
    tabs.unmount();
  });

  test("an allowed select moves it", () => {
    // The other direction, so the fix cannot be "never activate anything".
    const tabs = mountTabs(browserWhereSelect(true, "a.md"));

    tabs.act(() => tabs.api().pin("a.md"));
    tabs.act(() => tabs.api().pin("b.md"));
    tabs.act(() => tabs.api().activate("a.md"));

    expect(tabs.api().state.activePath).toBe("a.md");
    tabs.unmount();
  });
});

/* -------------------------------------------------------------------------- */

describe("the exit the app does not own", () => {
  function mountGuard(dirty: boolean) {
    function Probe({ d }: { d: boolean }) {
      useUnsavedGuard(d);
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(Probe, { d: dirty })));
    return {
      set: (next: boolean) => act(() => root.render(createElement(Probe, { d: next }))),
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  test("it listens only while there is something to lose", () => {
    /*
      Attached unconditionally, Chrome and Safari increasingly decline to show
      the prompt at all for a page that always asks — so a guard that is always
      on is a guard that stops working on the day it is needed. The dependency
      is the boolean for that reason, not for tidiness.
    */
    const add = jest.spyOn(window, "addEventListener");
    const remove = jest.spyOn(window, "removeEventListener");
    const listened = () => add.mock.calls.filter((c) => c[0] === "beforeunload").length;
    const unlistened = () => remove.mock.calls.filter((c) => c[0] === "beforeunload").length;

    const guard = mountGuard(false);
    expect(listened()).toBe(0);

    guard.set(true);
    expect(listened()).toBe(1);

    // A save landed. The listener comes straight back off.
    guard.set(false);
    expect(unlistened()).toBe(1);

    guard.unmount();
    add.mockRestore();
    remove.mockRestore();
  });

  test("it cancels the unload", () => {
    /*
      `preventDefault()` is the cancellation in every current engine, and it is
      what this asserts.

      It deliberately does **not** assert `returnValue`. jsdom implements the
      legacy `Event.returnValue` — a boolean alias for `!defaultPrevented` —
      while a browser hands the handler a `BeforeUnloadEvent` whose
      `returnValue` is a string. Pinning jsdom's version would be pinning the
      wrong behaviour, which is the shape of guard this repo keeps finding was
      never really checked.
    */
    const add = jest.spyOn(window, "addEventListener");
    const guard = mountGuard(true);

    const entry = add.mock.calls.find((c) => c[0] === "beforeunload");
    expect(entry).toBeDefined();
    const handler = entry![1] as (event: Event & { returnValue?: unknown }) => unknown;

    const event = new Event("beforeunload", { cancelable: true }) as Event & {
      returnValue?: unknown;
    };
    handler(event);

    expect(event.defaultPrevented).toBe(true);

    guard.unmount();
    add.mockRestore();
  });
});
