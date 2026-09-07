/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import { act, createElement, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **A team link opened the context and not the note.**
 *
 * `teamShareLink` hands somebody `/console/@seyi?note=3-resources/…md`, and the
 * whole point of that URL over `/s/<token>` is that it says what it points at.
 * Following one on a cold load — which is what following a link *is* — landed
 * on "Choose a note to read or edit it", over a context whose notes were
 * sitting right there.
 *
 * ## The cause is effect order, which is why nothing saw it
 *
 * The route's "open the note the URL names" effect lives in
 * `app/(app)/console/[slug]/index.tsx`; the file browser's "forget the old
 * context" effect lives in `useFileBrowser`, which is mounted by the console
 * **layout** — the route's parent. React runs a child's effects before its
 * parent's, so in the one commit where `selectedContextId` goes from `null` to
 * the workspace the URL names, both fire in this order:
 *
 *   1. the route selects the linked note,
 *   2. the browser resets for its new context and clears the selection.
 *
 * The route had already recorded the URL as honoured, so nothing retried and
 * the selection stayed empty until the person tapped something themselves.
 *
 * Warm navigation — following a link while already inside that context — never
 * reproduced it, because the browser's effect does not re-run when nothing
 * about the workspace changed. Every existing test exercised the warm path.
 *
 * ## What is asserted
 *
 * The cold path, against the real `useFileBrowser`, with the route's effect in
 * a real child component so the ordering is the reconciler's rather than the
 * test's. A string of `act`s cannot stand in for that: the bug is that two
 * effects ran in one commit in an order neither of them chose.
 *
 * ## And the other direction, which was missing entirely
 *
 * The hook is now `useNoteAddress` and the URL is a **mirror**: the selection
 * writes back to it, so a refresh returns to the file somebody was on. The
 * suite carries that half too, and it is the half whose failure mode needs a
 * reconciler rather than a pure test — two effects updating each other through
 * the router is how you get an infinite loop, and `nextAddressStep` being
 * correct in isolation does not prove the wiring settles. Every test below
 * therefore asserts the count of URL writes, not only the final value: one
 * write per real change, and none at rest.
 *
 * ## And a third suite, for the commit where the two contexts disagree
 *
 * Both suites above drive one context, so neither could see what a **switch**
 * does: the URL moves to `@supa` a commit or two before the console selects it
 * and the browser resets under it, and the mirror was reconciling the new
 * address against the old context's open note. `switchTo` moves the URL's two
 * halves together, which is what a navigation does and what this harness could
 * not express — `setContext` alone is the workspace list landing, not somebody
 * pressing a workspace.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => {
      calls.push({ name, args });
      return actions[name]!(args);
    };
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { useNoteAddress } from "../features/console/useNoteAddress";

const NOTE = "3-resources/engineering/shipping-an-expo-app-safely.md";
const FOLDER = "3-resources/engineering";

function entry(path: string, kind: "file" | "folder") {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "team" as const,
    inherited: "team" as const,
    exception: false,
    readOnly: false,
  };
}

const ROOT: FolderListing = {
  path: "",
  folderDefault: "team",
  entries: [entry("3-resources", "folder")],
  truncated: false,
  manifestUsable: true,
};

const NOTE_BODY: OpenNote = {
  path: NOTE,
  text: "# Shipping an expo app safely\n",
  etag: "etag-1",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;
/** The workspace list lands, or a navigation moves the URL to another context. */
let setContext: (id: string | null) => void;
/** Change the URL from outside the app — a pasted address, a followed link. */
let setUrl: (note: string | null) => void;
/**
 * Press another context: the URL's two halves move in one commit.
 *
 * Which is what a navigation is, and what nothing here could express before.
 * The rail replaces the address with `/console/@supa` (no note); the phone's
 * strip replaces it with `/console/@supa?note=<the path that context was last
 * left at>`. Both land while the console is still selecting the *previous*
 * context and the browser is still holding its tree.
 */
let switchTo: (contextId: string | null, note: string | null) => void;
/** What the URL says right now, and every value it has been set to. */
let url: string | null = null;
let addressed: (string | null)[] = [];

/**
 * The console's real shape: the layout owns the browser, the route is a child
 * of it, and only the child knows what the URL asked for.
 *
 * `workspaceId` starts `null` and is set from outside, which is what
 * `useLiveConsoleData` does — `selectedContextId` is derived from a Convex
 * subscription, so it is `null` for every render before the workspace list
 * lands. That first non-null render is the whole of this bug.
 *
 * **The URL is state**, held by the layout and written by the hook's `address`
 * callback. That is what the router does — `setParams` re-renders the route
 * with a new `?note=` — and modelling it as anything less would make the
 * write-back half untestable: the failure it guards against is the two
 * directions taking turns undoing each other, and you cannot see that in a
 * one-way harness. `addressed` records every write in order, so a test can
 * assert both what the URL ends up saying and how many times it was set.
 */
function mount(note: string | null): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Route({
    files,
    contextId,
    urlContextId,
    note: inUrl,
    onAddress,
  }: {
    files: FileBrowser;
    contextId: string | null;
    urlContextId: string | null;
    note: string | null;
    onAddress: (next: string | null) => void;
  }): ReactNode {
    useNoteAddress(files, { contextId: urlContextId, note: inUrl }, contextId, onAddress);
    return null;
  }

  function Layout(): ReactNode {
    /** The URL: a context and a note, and a navigation moves both at once. */
    const [urlContextId, setUrlContextId] = useState<string | null>(null);
    const [inUrl, setInUrl] = useState<string | null>(note);
    /** What the console has selected, which follows the URL. */
    const [contextId, setId] = useState<string | null>(null);
    setContext = setUrlContextId;
    setUrl = setInUrl;
    switchTo = (nextContext, nextNote) => {
      setUrlContextId(nextContext);
      setInUrl(nextNote);
    };
    url = inUrl;
    /*
      The layout's own rule: `resolveContextRoute` reads the URL and selects
      the context it names. It is the *parent's* effect, so React runs it after
      the route's — the ordering this whole file exists for, and the reason a
      switch is three commits rather than one.
    */
    useEffect(() => {
      setId(urlContextId);
    }, [urlContextId]);
    const files = useFileBrowser({
      workspaceId: contextId as never,
      tier: "private",
      canEdit: true,
      isOwner: true,
    });
    browser = files;
    return createElement(Route, {
      files,
      contextId,
      urlContextId,
      note: inUrl,
      onAddress: (next: string | null) => {
        addressed.push(next);
        setInUrl(next);
      },
    });
  }

  act(() => {
    root.render(createElement(Layout));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

describe("a team link opens the note it names", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    addressed = [];
    url = null;
    actions[name("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      return path === "" ? ROOT : { ...ROOT, path, entries: [entry(NOTE, "file")] };
    };
    actions[name("readNote")] = async () => NOTE_BODY;
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("the note the URL names is open once the context has resolved", async () => {
    unmount = mount(NOTE);
    await settle();

    // The workspace list lands. This is the commit the bug lived in.
    await act(async () => setContext("w1"));
    await settle();

    expect(browser.selectedPath).toBe(NOTE);
    expect(browser.editor.path).toBe(NOTE);
    expect(calls.filter((c) => c.name === name("readNote"))).toHaveLength(1);
  });

  test("…and a folder the URL names is selected too, with its own listing asked for", async () => {
    unmount = mount(FOLDER);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    expect(browser.selectedPath).toBe(FOLDER);
    expect(
      calls.filter((c) => c.name === name("listFiles") && (c.args as { path: string }).path === FOLDER),
    ).toHaveLength(1);
  });

  test("the folder's own listing survives the root listing landing after it", async () => {
    /**
     * **A folder opened by a link said "Loading…" until the tree fetched it.**
     *
     * `select` asks for a folder's own listing when it does not have one, and
     * the console's root load — the effect that forgets the previous context —
     * finished by *replacing* the whole listings map with `{ "": root }`. So a
     * folder listing that arrived first was thrown away by a round trip that
     * had been started before it and knew nothing about it, and nothing
     * retried: the page sat on "Loading…" until somebody expanded that folder
     * in the side panel, which asks again.
     *
     * Ordering is what decides it, and both orders are ordinary — the folder's
     * listing is the smaller request. The folder test above passes because its
     * two round trips settle in the lucky order, which is exactly why this one
     * defers the root instead.
     */
    let landRoot: (() => void) | null = null;
    const rootLanded = new Promise<void>((resolve) => {
      landRoot = resolve;
    });
    actions[name("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      if (path === "") {
        await rootLanded;
        return ROOT;
      }
      return { ...ROOT, path, entries: [entry(NOTE, "file")] };
    };

    unmount = mount(FOLDER);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    // The folder answered first, and only now does the root.
    expect(browser.listings[FOLDER]).toBeDefined();
    await act(async () => {
      landRoot!();
      await Promise.resolve();
    });
    await settle();

    expect(browser.listings[""]).toBeDefined();
    // The whole point: the root landing must not take the folder with it.
    expect(browser.listings[FOLDER]).toBeDefined();
    expect(browser.listings[FOLDER]!.entries.map((e) => e.path)).toEqual([NOTE]);
  });

  test("a URL naming no note leaves the console where it was", async () => {
    // The positive control for the guard, not for the fix: without it the two
    // tests above would pass on a hook that selects something unconditionally.
    unmount = mount(null);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    expect(browser.selectedPath).toBeNull();
  });

  test("the link is honoured once, so tapping another note is not undone", async () => {
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();
    expect(browser.selectedPath).toBe(NOTE);

    await act(async () => {
      browser.select("3-resources");
    });
    await settle();

    // Re-applying the URL on every render would drag somebody back to the
    // linked note the moment they opened anything else.
    expect(browser.selectedPath).toBe("3-resources");
  });
});

describe("the URL follows the note that is open", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    addressed = [];
    url = null;
    actions[name("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      return path === "" ? ROOT : { ...ROOT, path, entries: [entry(NOTE, "file")] };
    };
    actions[name("readNote")] = async () => NOTE_BODY;
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("tapping a note puts it in the URL, once", async () => {
    /**
     * **The bug this whole direction exists for.** `?note=` opened the note it
     * named and nothing ever wrote it back, so the address bar told the truth
     * until somebody tapped a second note — and every refresh after that landed
     * them on "Choose a note to read or edit it" over the context they were
     * already in.
     */
    unmount = mount(null);
    await settle();
    await act(async () => setContext("w1"));
    await settle();
    expect(url).toBeNull();

    await act(async () => {
      browser.select(NOTE);
    });
    await settle();

    expect(url).toBe(NOTE);
    expect(addressed).toEqual([NOTE]);
  });

  test("and does not re-read the note it just addressed", async () => {
    // The oscillation, in its cheapest form: a URL write that reads back as a
    // link being followed costs a second `readNote` for the note already open.
    // `select` is not idempotent, so this is a real round trip, every tap.
    unmount = mount(null);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    await act(async () => {
      browser.select(NOTE);
    });
    await settle();

    expect(calls.filter((c) => c.name === name("readNote"))).toHaveLength(1);
  });

  test("a link followed while another note is open wins", async () => {
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    await act(async () => {
      browser.select("3-resources");
    });
    await settle();
    expect(url).toBe("3-resources");

    // A second link arrives from outside — pasted into the address bar, or
    // followed from a chat while the app is already open. The URL changes
    // under the route, which is exactly what `setParams` does to it.
    await act(async () => setUrl(NOTE));
    await settle();

    expect(browser.selectedPath).toBe(NOTE);
    expect(url).toBe(NOTE);
    // And it settles: the selection is not written back over the link.
    expect(addressed).toEqual(["3-resources"]);
  });

  test("a URL that loses its note closes the note", async () => {
    /**
     * **This assertion is the inverse of the one it replaces, and that is the
     * point.**
     *
     * It read "a URL that merely lost its note is re-addressed, not obeyed", on
     * the reasoning that there was no "close the note" for such a URL to be
     * expressing: `select` took a path and the browser had no deselect, so
     * obeying it would leave the address bar disagreeing with the screen.
     * Correct about the mechanism, and it made a control on the phone dead. The
     * lit context pill navigates to `/console/@slug` — that is what "go to the
     * root" *is* — and the mirror put the note straight back, so pressing the
     * one thing on screen labelled as the way up did nothing you could see.
     *
     * `FileBrowser.deselect` is what that reasoning was waiting for. A console
     * URL that had a note and now has none is somebody having gone to the
     * context's root, which is a state the browser can now be asked for.
     *
     * SABOTAGE: `nextAddressStep` returning `address` for a URL that lost its
     * note — which is the shipped behaviour. Fails here.
     */
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();
    expect(browser.selectedPath).toBe(NOTE);

    await act(async () => setUrl(null));
    await settle();

    expect(browser.selectedPath).toBeNull();
    expect(browser.editor.path).toBeNull();
    // …and it settles there rather than the two directions taking turns.
    expect(url).toBeNull();
    expect(addressed).toEqual([]);
  });

  test("a URL that loses its note over a conflict settles on the screen", async () => {
    /**
     * `deselect` is refusable exactly like `select`, because it is a navigation
     * away from a draft — and a conflicted one is precisely what autosave will
     * not write and `guardLeaving` will not let go of.
     *
     * When the guard says no the note stays open, and the rule must then follow
     * **the screen**: an address bar claiming somebody is at the root while a
     * prompt asks which version of their note to keep is the disagreement this
     * whole module exists to end. It needs no second mechanism — the next pass
     * sees a URL it has reconciled and a selection that disagrees, and
     * addresses the open note, which is how a refused `select` already settled.
     *
     * SABOTAGE: dropped the guard from `deselect`. Fails here: the conflict is
     * closed out from under the person who has to answer it.
     */
    actions[name("writeNote")] = async () => {
      throw new ConvexError({
        code: "CONFLICT",
        message: "That file changed somewhere else while you were editing it.",
        currentEtag: "etag-9",
      });
    };
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    await act(async () => {
      browser.setDraft("# Shipping an expo app safely\n\nmine\n");
    });
    await act(async () => {
      browser.save();
    });
    await settle();
    expect(browser.editor.status).toBe("conflict");

    await act(async () => setUrl(null));
    await settle();

    expect(browser.selectedPath).toBe(NOTE);
    expect(url).toBe(NOTE);
  });

  test("deleting the open note clears ?note= rather than leaving a dead one", async () => {
    /**
     * The stale-state requirement, from the other end. `useFileBrowser` drops
     * the selection when the open note is deleted, archived or moved away; if
     * the URL kept naming it, the next reload would follow a link to a note
     * that no longer exists and land on "That file does not exist".
     */
    actions[name("deleteEntry")] = async () => ({});
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();
    expect(url).toBe(NOTE);

    await act(async () => {
      browser.destroy(NOTE);
    });
    await settle();

    expect(browser.selectedPath).toBeNull();
    expect(url).toBeNull();
    expect(addressed[addressed.length - 1]).toBeNull();
  });

  test("nothing is written while the console sits still", async () => {
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();
    const afterLanding = addressed.length;

    // Several more commits with nothing changing. A rule that re-addresses on
    // every render would show up here and nowhere else.
    await settle();
    await settle();

    expect(addressed.length).toBe(afterLanding);
  });
});

/**
 * **"I'll change between workspaces and it will say file not found."**
 *
 * Reported by the owner against the shipped feature, and the two suites above
 * could not see it: both drive one context. A switch moves the URL first and
 * the console after it, so for a commit or two the address names `@supa` while
 * the file browser is still holding `@seyi`'s tree with `@seyi`'s note open —
 * and the rule was reading the note out of the new address and the context out
 * of the old state.
 *
 * What that did on the web is write the old note back onto the new context's
 * URL (`?note=` is a mirror, and the mirror was pointed at the wrong screen);
 * what it did on a phone is worse, because the strip restores the path the new
 * context was last left at, so the stale commit `select`ed one context's path
 * against the other's bucket. Both end on "That file does not exist", which is
 * the sentence somebody gets for pressing a workspace.
 */
describe("switching context leaves the other context's note behind", () => {
  let unmount: (() => void) | null = null;

  /** A note that exists in `w2` and has never existed in `w1`. */
  const THEIRS = "1-projects/gateway.md";

  beforeEach(() => {
    calls.length = 0;
    addressed = [];
    url = null;
    actions[name("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      return path === "" ? ROOT : { ...ROOT, path, entries: [entry(NOTE, "file")] };
    };
    // Echoes the path, so a body cannot stand in for a note it is not.
    actions[name("readNote")] = async (args: never) => ({
      ...NOTE_BODY,
      path: (args as { path: string }).path,
    });
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  /** Every `readNote` as it was actually sent: which bucket, which path. */
  const reads = () =>
    calls
      .filter((c) => c.name === name("readNote"))
      .map((c) => c.args as { workspaceId: string; path: string });

  test("the rail's switch does not carry the open note into the new context", async () => {
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();
    expect(url).toBe(NOTE);

    // `router.replace(hrefFor(next))` — `/console/@supa`, and nothing else.
    await act(async () => switchTo("w2", null));
    await settle();

    expect(browser.contextId).toBe("w2");
    // The bug: the URL was re-addressed with the note from the context that
    // had just been left, and the console then opened it as a link.
    expect(url).toBeNull();
    expect(addressed).toEqual([]);
    expect(browser.selectedPath).toBeNull();
    expect(browser.notice).toBeNull();
    expect(reads()).toEqual([{ workspaceId: "w1", path: NOTE }]);
  });

  test("the phone's switch opens the new context's own note, in the new context", async () => {
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    /*
      `contextHrefFrom(slug)` — the path `@supa` was last left at. A note link
      followed from outside (`/note/@supa/…`, which redirects to the canonical
      console URL) arrives in exactly this shape, and must keep working: it is
      an *address*, not a switch, and the difference is whose context the note
      in it belongs to rather than whether the context changed.
    */
    await act(async () => switchTo("w2", THEIRS));
    await settle();

    expect(browser.selectedPath).toBe(THEIRS);
    expect(browser.editor.path).toBe(THEIRS);
    // One read, against the bucket the URL names. Before the fix the stale
    // commit read `@supa`'s path out of `@seyi`'s workspace first.
    expect(reads()).toEqual([
      { workspaceId: "w1", path: NOTE },
      { workspaceId: "w2", path: THEIRS },
    ]);
  });

  test("a note that really is gone still says so, once", async () => {
    /*
      The other half of the requirement, and the reason this is a wait rather
      than a rule about paths: a `?note=` naming a file the context does not
      have must still land on the editor's own refusal — which is where a stale
      link, a note deleted from another device and a hand-typed URL all land.
      What it must not do is retry, oscillate, or clear the address it refused.
    */
    actions[name("readNote")] = async () => {
      throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });
    };

    unmount = mount(null);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    await act(async () => switchTo("w2", THEIRS));
    await settle();
    await settle();

    expect(browser.notice).toBe("That file does not exist.");
    expect(browser.editor.path).toBeNull();
    // The URL still names what was asked for, and was not written to on the
    // way to the refusal: a person can correct it, or press Back.
    expect(url).toBe(THEIRS);
    expect(reads()).toEqual([{ workspaceId: "w2", path: THEIRS }]);
  });

  test("a switch back is a switch, not a link", async () => {
    // Two contexts, three navigations, and the guard against a fix that simply
    // never writes the URL again: `@seyi` is re-entered at its root, and
    // tapping a note there still addresses it.
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    await act(async () => switchTo("w2", null));
    await settle();
    await act(async () => switchTo("w1", null));
    await settle();

    expect(browser.contextId).toBe("w1");
    expect(browser.selectedPath).toBeNull();
    expect(url).toBeNull();

    await act(async () => {
      browser.select(NOTE);
    });
    await settle();

    expect(url).toBe(NOTE);
    expect(addressed).toEqual([NOTE]);
  });
});
