/**
 * @jest-environment jsdom
 */

/**
 * **"I'll change between workspaces and it will say file not found."**
 *
 * The URL half of that is `noteAddress.ts`'s and is driven in
 * `linkedNote.test.ts` against the real file browser. This is the half that
 * *persists*: `/console/@:slug` records where somebody is on the device, so a
 * cold relaunch and the phone's context strip can come back to it — and during
 * a switch the two values that record is built from belong to two different
 * places.
 *
 * The address moves first. `router.replace` lands `/console/@supa`, the layout
 * selects `@supa` in its own effect a commit later, and `useFileBrowser` resets
 * a commit after that. In between, `slug` is `@supa` and the open note is
 * `@seyi`'s — and the writer paired them, so `@supa`'s entry on the device came
 * to hold a path `@supa` has never had. The URL recovers from that on the next
 * navigation; a device does not. Every later switch to `@supa` restored that
 * path, opened it as a link, and got the editor's "That file does not exist".
 *
 * ## Why the route, and not the hooks under it
 *
 * Because the bug is a *pairing*, and each half is defensible alone.
 * `placeFor`'s new guard is asserted in `lastPlace.test.ts`; what nothing could
 * see is whether the route hands it the comparison that makes it fire, and
 * `onContext: true` is a one-word edit that reads as obviously correct. So this
 * mounts the real route component, drives a real switch through the ordering
 * the console has (parent effects after the child's), and asserts what ends up
 * on the device.
 *
 * `BrowsePane` is stubbed: this is about two effects and a store, and mounting
 * the editor would drag in the whole console for nothing.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  act,
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HIS = "1-projects/pilot.md";
const THEIRS = "1-projects/gateway.md";

/** The URL, as the router would hand it to the route. */
const mockParams: { slug: string; note?: string } = { slug: "@seyi" };
/** Every `setParams` the route made — the `?note=` mirror writing back. */
const mockAddressed: (string | undefined)[] = [];
let mockSetNote: (note: string | undefined) => void = () => {};

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useNavigation: () => ({
    setParams: ({ note }: { note?: string }) => {
      mockAddressed.push(note);
      mockSetNote(note);
    },
  }),
}));

const mockStore = (
  require("../features/offline/memory") as typeof import("../features/offline/memory")
).memoryStore();

jest.mock("../features/offline/store", () => ({ openStore: () => mockStore }));

jest.mock("../features/console/panes/BrowsePane", () => ({ BrowsePane: () => null }));

const { ConsoleDataProvider } =
  require("../features/console/ConsoleDataContext") as typeof import("../features/console/ConsoleDataContext");
const { recallPlaces } =
  require("../features/console/lastPlace") as typeof import("../features/console/lastPlace");
const { resetPlaceCacheForTests } =
  require("../features/console/useLastPlace") as typeof import("../features/console/useLastPlace");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

const ContextBrowseRoute = (
  require("../app/(app)/console/[slug]/index") as { default: () => ReactNode }
).default;

const CONTEXTS = [
  { id: "w1", slug: "seyi", displayName: "Seyi", role: "owner", kind: "personal", status: "ok" },
  { id: "w2", slug: "supa", displayName: "Supa", role: "editor", kind: "shared", status: "ok" },
];

/** Press a context: the URL's slug and note move together, in one commit. */
let switchTo: (slug: string, note: string | undefined) => void;
/** What the file browser is holding, as the route sees it. */
let browserContextId: string | null;

/**
 * The console's shape, reduced to the three things that lag.
 *
 * The URL is the truth; the layout's effect selects the context it names; the
 * file browser's effect follows the selection and clears the selected path.
 * Both of those are the route's *parent*, so React runs them after the route's
 * own — which is the ordering the whole bug lives in, and the reason this is a
 * mount rather than three assignments.
 */
function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Harness(): ReactNode {
    const [slug, setSlug] = useState("seyi");
    const [note, setNote] = useState<string | undefined>(HIS);
    const [selectedContextId, setSelected] = useState<string | null>("w1");
    const [contextId, setContextId] = useState<string | null>("w1");
    const [selectedPath, setSelectedPath] = useState<string | null>(HIS);

    mockParams.slug = `@${slug}`;
    mockParams.note = note;
    mockSetNote = setNote;
    switchTo = (nextSlug, nextNote) => {
      setSlug(nextSlug);
      setNote(nextNote);
    };
    browserContextId = contextId;

    // `resolveContextRoute` — the URL names a context, the console selects it.
    useEffect(() => {
      setSelected(CONTEXTS.find((context) => context.slug === slug)?.id ?? null);
    }, [slug]);

    /*
      `useFileBrowser`'s reset — a new workspace forgets the previous one's
      tree, selection and open note.

      The first pass is skipped because the state this mounts in is a console
      that has *already* settled: `@seyi` selected, its note open, exactly what
      somebody is looking at when they press another context. A cold start is
      the other suite's subject (`linkedNote.test.ts` drives the real browser
      through it), and starting there would spend three commits reaching the
      state this file begins in.
    */
    const settled = useRef(false);
    useEffect(() => {
      setContextId(selectedContextId);
      if (!settled.current) {
        settled.current = true;
        return;
      }
      setSelectedPath(null);
    }, [selectedContextId]);

    /*
      The one behaviour of the browser this needs: `select` puts a path in the
      editor. Without it the URL's own note would be reconciled against a
      console that never opens anything, and the mirror would clear `?note=`
      before a switch had even happened.
    */
    const select = useCallback((path: string) => {
      setSelectedPath(path);
      return true;
    }, []);

    const data = {
      contexts: CONTEXTS,
      selectedContextId,
      files: { contextId, selectedPath, editor: emptyEditor, notice: null, select },
      loading: false,
    } as never;

    return createElement(ConsoleDataProvider, {
      value: data,
      children: createElement(ContextBrowseRoute),
    });
  }

  act(() => {
    root.render(createElement(Harness));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

describe("what a switch writes to the device", () => {
  let unmount: (() => void) | null = null;

  beforeEach(async () => {
    mockAddressed.length = 0;
    mockParams.slug = "@seyi";
    mockParams.note = HIS;
    resetPlaceCacheForTests();
    for (const key of await mockStore.keys()) await mockStore.remove(key);
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("where somebody actually is, once the browser is there too", async () => {
    // The control. Without it a fix that simply never records would pass every
    // assertion below and delete the feature.
    unmount = mount();
    await settle();

    expect(await recallPlaces(mockStore)).toEqual([{ slug: "seyi", note: HIS }]);
  });

  test("not the note from the context being left", async () => {
    unmount = mount();
    await settle();

    // The rail: `/console/@supa`, no note. The layout has not selected it yet
    // and the browser is still holding `@seyi`'s note.
    await act(async () => switchTo("supa", undefined));
    await settle();

    expect(browserContextId).toBe("w2");
    /*
      The bug: `{ slug: "supa", note: "1-projects/pilot.md" }` — a path from
      `@seyi` filed under `@supa`, which the strip and the cold-launch redirect
      both read back as somewhere to return to.
    */
    expect(await recallPlaces(mockStore)).toEqual([
      { slug: "supa", note: null },
      { slug: "seyi", note: HIS },
    ]);
    // …and the URL was not written to on the way, either.
    expect(mockAddressed).toEqual([]);
  });

  test("and not the new context's own note under the old context's slug", async () => {
    /*
      The phone's version of the same commit: the strip restores the path
      `@supa` was last left at, so the URL arrives carrying `@supa`'s note while
      everything else still says `@seyi`. Written then, the entry would name
      `@seyi` and hold a path that belongs to `@supa` — the same swap, in the
      direction the strip makes easy.
    */
    unmount = mount();
    await settle();

    await act(async () => switchTo("supa", THEIRS));
    await settle();

    const places = await recallPlaces(mockStore);
    expect(places.find((place) => place.slug === "seyi")).toEqual({ slug: "seyi", note: HIS });
    expect(places[0]).toEqual({ slug: "supa", note: THEIRS });
  });
});
