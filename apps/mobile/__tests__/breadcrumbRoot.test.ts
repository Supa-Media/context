/**
 * @jest-environment jsdom
 */

/**
 * **"Clicking on the workspace name in the breadcrumb should take you to the
 * root. Right now it doesn't do anything."**
 *
 * The lit pill at the head of the phone's band is documented as the way up and
 * pressed to `browseHref(slug)` — `/console/@seyi`, no `?note=` — which is
 * exactly right and had no visible effect for as long as `noteAddress.ts` read
 * a URL that had lost its note as *stale* rather than as an instruction. The
 * mirror re-addressed the open note within the same tick, so the press went out
 * and came straight back. Nothing on the screen moved; nothing in the log said
 * why.
 *
 * ## Two things have to happen, and only one of them is the URL
 *
 * The note has to close — `FileBrowser.deselect`, which did not exist and whose
 * absence was the whole of the stated reasoning — **and the device record has
 * to follow**, because on a phone that record is what a cold relaunch restores.
 * A press that cleared the screen and left `{ slug, note }` on the device would
 * put somebody back in the note they had just closed, the next time they opened
 * the app.
 *
 * ## Why this mounts the route
 *
 * Because the bug is the *composition*: the pill's href, the address rule and
 * the device writer are each defensible alone and were each correct. What was
 * missing was between them. `contextSwitchRecord.test.ts` is the same harness
 * for the same reason, and this file is its sibling — the ordering it models
 * (parent effects after the child's) is the ordering the console has.
 *
 * `BrowsePane` is stubbed: this is about two effects and a store.
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
const THEIRS = "3-resources/gateway.md";

const mockParams: { slug: string; note?: string } = { slug: "@seyi" };
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
const { browseHref, noteHref } =
  require("../features/console/nav") as typeof import("../features/console/nav");

const ContextBrowseRoute = (
  require("../app/(app)/console/[slug]/index") as { default: () => ReactNode }
).default;

const CONTEXTS = [
  { id: "w1", slug: "seyi", displayName: "Seyi", role: "owner", kind: "personal", status: "ok" },
  { id: "w2", slug: "supa", displayName: "Supa", role: "editor", kind: "shared", status: "ok" },
];

/** A navigation: the URL's slug and note move together, in one commit. */
let go: (href: string) => void;
/** What the file browser is holding, as the route sees it. */
let selected: string | null;
/** Every `deselect` the route asked for, and whether the guard allowed it. */
let closes: number;
/** Set to make `deselect` refuse, the way a conflicted draft does. */
let refuseClose = false;

/**
 * The console's shape, reduced to the four things that move at different times:
 * the URL, the context the console has selected, the context the browser has
 * caught up with, and what is open.
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
    /*
      A press, expressed as the href it produces — which is what every control
      in the console actually hands the router, and the one thing a test of
      "does pressing the pill work" must not paraphrase.
    */
    go = (href) => {
      const [path, query] = href.split("?");
      setSlug(path!.replace("/console/@", ""));
      const asked = query?.startsWith("note=") === true ? query.slice(5) : undefined;
      setNote(asked === undefined ? undefined : decodeURIComponent(asked));
    };
    selected = selectedPath;

    useEffect(() => {
      setSelected(CONTEXTS.find((context) => context.slug === slug)?.id ?? null);
    }, [slug]);

    const settledOnce = useRef(false);
    useEffect(() => {
      setContextId(selectedContextId);
      if (!settledOnce.current) {
        settledOnce.current = true;
        return;
      }
      // A different bucket: the browser forgets the previous context's tree.
      setSelectedPath(null);
    }, [selectedContextId]);

    const select = useCallback((path: string) => {
      setSelectedPath(path);
      return true;
    }, []);
    const deselect = useCallback(() => {
      closes += 1;
      // `guardLeaving`'s refusal, which leaves the note where it was.
      if (refuseClose) return false;
      setSelectedPath(null);
      return true;
    }, []);

    const data = {
      contexts: CONTEXTS,
      selectedContextId,
      files: { contextId, selectedPath, editor: emptyEditor, notice: null, select, deselect },
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
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

describe("pressing the context you are in", () => {
  let unmount: (() => void) | null = null;

  beforeEach(async () => {
    mockAddressed.length = 0;
    mockParams.slug = "@seyi";
    mockParams.note = HIS;
    closes = 0;
    refuseClose = false;
    resetPlaceCacheForTests();
    for (const key of await mockStore.keys()) await mockStore.remove(key);
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  /**
   * The shipped defect, end to end.
   *
   * SABOTAGE: `nextAddressStep` answering `address` for a URL that lost its
   * note — the behaviour this replaces. Fails here: the note is still open and
   * `?note=` has been written back.
   */
  test("closes the open note", async () => {
    unmount = mount();
    await settle();
    expect(selected).toBe(HIS);

    await act(async () => go(browseHref("seyi")));
    await settle();

    expect(closes).toBe(1);
    expect(selected).toBeNull();
    // …and the URL stays at the root rather than being re-addressed back.
    expect(mockAddressed).toEqual([]);
  });

  /**
   * The half that outlives the session. The device record is what a cold
   * relaunch and the phone's strip both read, so a press that cleared the
   * screen and left the note on the device would reopen it on the next launch —
   * the "it persists where it last was" the owner reported, one relaunch later.
   *
   * SABOTAGE: `placeFor` fed the browser's selection instead of the URL's note.
   * Fails here — the record keeps the note the press just closed.
   */
  test("and the device stops remembering that note", async () => {
    unmount = mount();
    await settle();
    expect(await recallPlaces(mockStore)).toEqual([{ slug: "seyi", note: HIS }]);

    await act(async () => go(browseHref("seyi")));
    await settle();

    expect(await recallPlaces(mockStore)).toEqual([{ slug: "seyi", note: null }]);
  });

  /**
   * The guard still gets the last word. A conflicted draft is one nothing will
   * write and `guardLeaving` will not let go of, and the note stays open — so
   * the address has to come **back** to it, or the device would be filed at the
   * root with a conflict still unanswered on the screen.
   *
   * SABOTAGE: `useNoteAddress` ignoring `deselect`'s answer. Fails here.
   */
  test("but a refused close puts the note back in the address and on the device", async () => {
    refuseClose = true;
    unmount = mount();
    await settle();

    await act(async () => go(browseHref("seyi")));
    await settle();

    expect(closes).toBe(1);
    expect(selected).toBe(HIS);
    expect(mockAddressed).toEqual([HIS]);
    expect(await recallPlaces(mockStore)).toEqual([{ slug: "seyi", note: HIS }]);
  });

  /**
   * The good half of the switch, which this must not have broken.
   *
   * Pressing a context you are **not** in restores the place this device last
   * had open there (`contextHrefFrom`), and that arrives as a URL carrying a
   * note. It must be opened, not read as a close: the two are told apart by
   * whether the URL *changed to* a note or *changed to* nothing, and a rule
   * that looked only at "the note is absent" would send every restored switch
   * to the root.
   *
   * SABOTAGE: `nextAddressStep` returning `close` whenever `note === null`.
   * Fails here — @supa opens at its root instead of at what was left open.
   */
  test("pressing another context still restores where you were there", async () => {
    unmount = mount();
    await settle();

    await act(async () => go(noteHref("supa", THEIRS)));
    await settle();

    expect(selected).toBe(THEIRS);
    expect(closes).toBe(0);
    const places = await recallPlaces(mockStore);
    expect(places[0]).toEqual({ slug: "supa", note: THEIRS });
    expect(places).toContainEqual({ slug: "seyi", note: HIS });
  });
});
