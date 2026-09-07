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
 * When this file was written nothing autosaved: the only thing that wrote a
 * draft to the bucket was Save, so the guards *were* the feature, and every one
 * of them was either missing or documented-but-absent:
 *
 *  - `guardLeaving` refused to open another note, and `useTabs.activate`
 *    routed around it by dispatching first;
 *  - `tabs.ts` said "the UI confirms before dispatching" and nothing did
 *    (covered in `fileTabs.test.ts`, which owns the reducer);
 *  - the browser tab could simply be closed.
 *
 * This file covers the first and the third, and both have changed shape now
 * that the draft is written without being asked for. The tab strip still may
 * not move without the editor — a refusal is rarer but not gone, and a strip
 * that highlights one note over an editor holding another is the same bug it
 * always was. The browser tab is the interesting one: closing it should
 * **write** the draft, and interrupt somebody only about the drafts autosave
 * refuses. See `autosave.test.ts` for that policy.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests, in this
 * file unless another is named — the last four are the copy that stopped
 * telling people they owed the app an action, which is the same change.
 *
 *   the `visibilitychange` flush dropped                                1
 *   the `pagehide` flush dropped                                        1
 *   flushing when the tab comes *back* as well                          1
 *   flushing for a clean note as well                                   1
 *   `beforeunload` attached for every draft again                       1
 *   `closeIntent` asking about every dirty tab       1 (fileTabs.test.ts)
 *   `closeIntent` never asking                       1 (fileTabs.test.ts)
 *   the strip's dirty segment warning again            1 (status.test.ts)
 *   the editor's dirty line reading "Unsaved changes"
 *                                            1 (offlineEditorRender.test.ts)
 *
 * **One went undetected and is recorded rather than quietly fixed**, because
 * what it proves is that a condition and its dependency array are one guard
 * and not two. Widening the `beforeunload` effect's *condition* to
 * `undone || pending` while leaving its deps at `[undone]` fails nothing: the
 * effect never re-runs when `pending` changes, so the widened condition is
 * almost never evaluated. Sabotaging both together is the honest version and
 * is the line above.
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
  type EditorState = import("../features/console/files/editor").EditorState;

  const NOTE = {
    path: "1-projects/a.md",
    text: "original\n",
    etag: "e1",
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  };

  const { editorReducer } =
    require("../features/console/files/editor") as typeof import("../features/console/files/editor");

  /** A note with an ordinary unsaved draft: what autosave is about to write. */
  function dirty(): EditorState {
    return editorReducer(editorReducer(emptyEditor, { type: "opened", note: NOTE }), {
      type: "edited",
      text: "original\nand more\n",
    });
  }

  /** A draft nothing will write on its own. */
  function conflicted(): EditorState {
    return editorReducer(dirty(), {
      type: "saveFailed",
      error: { code: "CONFLICT", message: "Somebody else saved first.", currentEtag: "e9" },
    });
  }

  function mountGuard(editor: EditorState) {
    const flushed: number[] = [];
    const flush = () => flushed.push(Date.now());
    function Probe({ e }: { e: EditorState }) {
      useUnsavedGuard({ editor: e, flush });
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(Probe, { e: editor })));
    return {
      flushed,
      set: (next: EditorState) => act(() => root.render(createElement(Probe, { e: next }))),
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  test("it prompts only for a draft autosave will not write", () => {
    /*
      Attached unconditionally, Chrome and Safari increasingly decline to show
      the prompt at all for a page that always asks — so a guard that is always
      on is a guard that stops working on the day it is needed. That rule is
      why autosave makes this prompt *better* rather than merely rarer: asking
      on every draft spent the browser's patience on the case that was never in
      danger.
    */
    const add = jest.spyOn(window, "addEventListener");
    const remove = jest.spyOn(window, "removeEventListener");
    const listened = () => add.mock.calls.filter((c) => c[0] === "beforeunload").length;
    const unlistened = () => remove.mock.calls.filter((c) => c[0] === "beforeunload").length;

    const guard = mountGuard(emptyEditor);
    expect(listened()).toBe(0);

    // An ordinary draft: written on the way out, so nothing to ask about.
    guard.set(dirty());
    expect(listened()).toBe(0);

    // A conflict: nothing writes this for anybody.
    guard.set(conflicted());
    expect(listened()).toBe(1);

    // Resolved. The listener comes straight back off.
    guard.set(dirty());
    expect(unlistened()).toBe(1);

    guard.unmount();
    add.mockRestore();
    remove.mockRestore();
  });

  test("hiding the tab writes what is pending", () => {
    /*
      `visibilitychange` and `pagehide` are the last reliable moments a page
      gets, and they fire for a tab switch and an app switch as well as for a
      close — so the pending write goes out when somebody looks away rather
      than only when they leave for good.
    */
    const guard = mountGuard(dirty());

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(guard.flushed).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(guard.flushed).toHaveLength(2);

    guard.unmount();
    // Nothing pending, nothing written: a clean note that is hidden must not
    // spend a request on the customer's bucket for no reason.
    const clean = mountGuard(editorReducer(emptyEditor, { type: "opened", note: NOTE }));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(clean.flushed).toEqual([]);
    clean.unmount();
  });

  test("coming back to the tab is not an exit", () => {
    // `visibilitychange` fires in both directions. Flushing on becoming
    // visible would be a write every time somebody tabbed back.
    const guard = mountGuard(dirty());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(guard.flushed).toEqual([]);
    guard.unmount();
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
    const guard = mountGuard(conflicted());

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
