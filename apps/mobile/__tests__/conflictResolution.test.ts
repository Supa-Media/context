/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";
import { offerMerge } from "../features/offline/resolution";
import { MERGE_MARKERS } from "../features/offline/merge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The three answers to a conflict, and the two properties that make them safe.
 *
 * The properties are the point of this file, and each is stated as a test that
 * **fails when the property is broken**, not as a test that passes when the
 * feature works. Both were sabotage-checked while being written:
 *
 *  - **Nothing is written to the customer's bucket until a person chooses.**
 *    Breaking it — retrying the refused write once the review has read the
 *    other side, which is the shape an "auto-resolve" optimisation would take
 *    — fails "no write happens while the decision is open".
 *  - **Whichever answer is chosen, the save is still conditional on the version
 *    that was shown.** Breaking it — dropping `expectedEtag` from the resolve
 *    path, which looks like a fix for "why does keeping mine sometimes fail" —
 *    fails "keeping mine is conditional on the version that was shown" and
 *    "a merge refused again comes back as a fresh conflict".
 *
 * The harness is the one `fileErrorCallSites.test.ts` established: the real
 * `useFileBrowser` against mocked Convex actions, so the assertions are about
 * what the console does to somebody's bucket rather than about a pure function
 * nothing is obliged to call.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const PATH = "1-projects/pilot.md";

/*
  One note, three versions of it, and they are chosen so a three-way merge has
  an unambiguous right answer: the two edits are four lines apart and touch
  nothing in common. If the merge were a two-way diff dressed up, or if the
  ancestor were the wrong version, this is the shape that shows it — the result
  would carry markers, or lose one of the two edits.
*/
const BASE = "# Pilot\n\nOne.\n\nTwo.\n\nThree.\n";
const MINE = "# Pilot\n\nOne, from the train.\n\nTwo.\n\nThree.\n";
const THEIRS = "# Pilot\n\nOne.\n\nTwo.\n\nThree, corrected.\n";
const MERGED = "# Pilot\n\nOne, from the train.\n\nTwo.\n\nThree, corrected.\n";

const ROOT_LISTING: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [
    {
      kind: "file",
      path: PATH,
      name: "pilot.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

function noteAt(text: string, etag: string): OpenNote {
  return {
    path: PATH,
    text,
    etag,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

const name = (fn: string) => `functions/files:${fn}`;

/** Every write this console attempted, in order. The safety evidence. */
let writes: { path: string; text: string; expectedEtag?: string }[] = [];
/** What `readNote` currently answers with. Moved on to stage a second writer. */
let inBucket: OpenNote;
let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", canEdit: true });
    return null;
  }

  act(() => root.render(createElement(Probe)));
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

/** Somebody else got there first. What `writeNote` answers on a conflict. */
function conflictWith(etag: string) {
  return new ConvexError({
    code: "CONFLICT",
    message: "That file changed somewhere else while you were editing it.",
    currentEtag: etag,
  });
}

/**
 * Open the note, type over it, press save, and let the refusal land.
 *
 * The state every test below starts from: a conflict parked, both versions
 * real, and — crucially — the read cache holding `BASE` at `e1`, because
 * `openNote` remembered what it read. That cached body is the common ancestor,
 * and it is the whole reason a merge can be offered.
 */
async function reachTheConflict() {
  browser.select(PATH);
  await settle();
  browser.setDraft(MINE);
  await settle();
  inBucket = noteAt(THEIRS, "e2");
  browser.save();
  await settle();
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  writes = [];
  inBucket = noteAt(BASE, "e1");
  actions[name("listFiles")] = async () => ROOT_LISTING;
  actions[name("readNote")] = async () => inBucket;
  actions[name("writeNote")] = async (args: never) => {
    const write = args as unknown as {
      path: string;
      text: string;
      expectedEtag?: string;
    };
    // Only the three fields the safety properties are about. `workspaceId` is
    // the same on every call and would make every assertion below noisier
    // without making one of them stronger.
    writes.push({ path: write.path, text: write.text, expectedEtag: write.expectedEtag });
    if (write.expectedEtag !== inBucket.etag) throw conflictWith(inBucket.etag);
    inBucket = noteAt(write.text, `${inBucket.etag}+`);
    return { path: write.path, etag: inBucket.etag, conflictCheck: "conditional" };
  };
  unmount = mount();
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("a conflict, and the decision it asks for", () => {
  test("the refused save parks, and both versions are put in front of the person", async () => {
    await reachTheConflict();

    expect(browser.editor.status).toBe("conflict");
    const review = browser.conflict;
    expect(review).not.toBeNull();
    expect(review!.path).toBe(PATH);
    expect(review!.mine).toBe(MINE);
    expect(review!.theirs).toBe(THEIRS);
    expect(review!.theirsEtag).toBe("e2");
  });

  test("the merge is a three-way merge, and it keeps both edits", async () => {
    await reachTheConflict();

    const merge = browser.conflict!.merge;
    expect(merge).not.toBeNull();
    expect(merge!.conflicts).toBe(0);
    expect(merge!.text).toBe(MERGED);
    // Not a two-way diff wearing a merge's name: a proposal built without the
    // ancestor could not know that "Three, corrected." is theirs rather than a
    // deletion of mine.
    expect(merge!.text).not.toContain(MERGE_MARKERS.mine);
  });

  /**
   * **The first safety property.**
   *
   * Between the refusal and a person pressing something, this console must
   * touch the bucket exactly once — the save that was refused — and never
   * again. No conflict copy, no speculative write, no retry.
   *
   * The drain is deliberately given a chance to run: the queue is the one thing
   * in this feature that writes on its own, and a `conflicted` entry is exactly
   * the entry it must refuse to send.
   */
  test("no write happens while the decision is open", async () => {
    await reachTheConflict();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ path: PATH, text: MINE, expectedEtag: "e1" });

    // Time passes, effects re-run, the queue gets every chance to act.
    await settle();
    await settle();

    expect(writes).toHaveLength(1);
    // And the draft is still here, untouched, the whole time.
    expect(browser.editor.draft).toBe(MINE);
    expect(browser.editor.status).toBe("conflict");
  });

  test("keeping theirs writes nothing at all", async () => {
    await reachTheConflict();
    browser.useTheirs();
    await settle();

    expect(writes).toHaveLength(1);
    expect(browser.editor.status).toBe("clean");
    expect(browser.editor.draft).toBe(THEIRS);
    expect(browser.conflict).toBeNull();
  });

  /**
   * **The second safety property**, for the answer that overwrites.
   *
   * `expectedEtag` is `e2` — the version the review read and showed — not `e1`
   * (the stale base, which would be refused again) and not absent (which would
   * be a blind put over whatever is there, the last-write-wins this whole
   * design exists to refuse).
   */
  test("keeping mine is conditional on the version that was shown", async () => {
    await reachTheConflict();
    browser.resolveWith(browser.conflict!.mine);
    await settle();

    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ path: PATH, text: MINE, expectedEtag: "e2" });
    expect(browser.editor.status).toBe("saved");
  });

  test("saving a reviewed merge is the same conditional write, with the merged text", async () => {
    await reachTheConflict();
    browser.resolveWith(browser.conflict!.merge!.text);
    await settle();

    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ path: PATH, text: MERGED, expectedEtag: "e2" });
    expect(browser.editor.status).toBe("saved");
    expect(browser.editor.baseline).toBe(MERGED);
  });

  test("an edited merge is what gets written, not the proposal", async () => {
    await reachTheConflict();
    const byHand = `${MERGED}\nAnd a line I added while reviewing.\n`;
    browser.resolveWith(byHand);
    await settle();

    expect(writes[1]!.text).toBe(byHand);
  });

  /**
   * A third writer, between the review's read and the chosen save.
   *
   * The write is refused because it is conditional, the draft survives as the
   * text that was approved, and the whole surface comes back with the *new*
   * versions rather than the ones the decision was made about. That is the
   * "back in the same flow with fresh content" this design promises, and it is
   * the property a force flag would destroy.
   */
  test("a merge refused again comes back as a fresh conflict, not a forced write", async () => {
    await reachTheConflict();
    const proposal = browser.conflict!.merge!.text;

    // Somebody writes a third version while the person is reading the merge.
    inBucket = noteAt("# Pilot\n\nA third writer got here.\n", "e3");

    browser.resolveWith(proposal);
    await settle();

    expect(writes).toHaveLength(2);
    expect(writes[1]!.expectedEtag).toBe("e2");
    expect(browser.editor.status).toBe("conflict");
    // The approved text is what is still in hand — not the version it replaced.
    expect(browser.editor.draft).toBe(proposal);
    expect(browser.conflict!.theirsEtag).toBe("e3");
    expect(browser.conflict!.theirs).toContain("A third writer");
    /*
      And a merge is still on offer, correctly: the ancestor of the text they
      approved is the version they approved it against, which `resolveWith`
      moved the cache onto before the write.
    */
    expect(browser.conflict!.merge).not.toBeNull();
  });

  /**
   * The ancestor is gone, so there is nothing honest to propose.
   *
   * `localStorage` cleared is the real shape of this: the bounded cache swept
   * the note, or this is a different browser. The two remaining answers are
   * still offered, and the reason the third is not is a sentence rather than a
   * missing button nobody can account for.
   */
  test("with no ancestor on the device there is no merge, and it says why", async () => {
    browser.select(PATH);
    await settle();
    browser.setDraft(MINE);
    await settle();
    window.localStorage.clear();
    inBucket = noteAt(THEIRS, "e2");
    browser.save();
    await settle();

    const review = browser.conflict!;
    expect(review.merge).toBeNull();
    expect(review.mergeRefusal?.reason).toBe("ancestor-evicted");
    expect(review.mergeRefusal?.sentence).toContain("no longer has it");
    // The other two answers are untouched by the absence of the third.
    expect(review.theirs).toBe(THEIRS);
    expect(review.mine).toBe(MINE);
  });
});

describe("what may be offered, as a rule rather than as a screen", () => {
  const cached = { text: BASE, etag: "e1" };

  test("an ancestor at the draft's own etag is the only one that counts", () => {
    expect(offerMerge({ cached, draftBase: "e1", mine: MINE, theirs: THEIRS }).merge).not.toBeNull();
    /*
      The cache moved on — the note was reopened online after the draft was
      typed — so its body is one of the two sides being merged rather than
      their ancestor. Merging against it would three-way somebody's edit
      against a version they never saw, and it would look exactly as confident
      as a real merge.
    */
    expect(offerMerge({ cached, draftBase: "e0", mine: MINE, theirs: THEIRS }).refusal?.reason).toBe(
      "ancestor-moved",
    );
  });

  test("a note that did not exist has no ancestor to merge against", () => {
    expect(
      offerMerge({ cached: null, draftBase: null, mine: MINE, theirs: THEIRS }).refusal?.reason,
    ).toBe("no-ancestor");
  });

  test("their version unread means no merge, not an empty one", () => {
    const offer = offerMerge({ cached, draftBase: "e1", mine: MINE, theirs: null });
    expect(offer.merge).toBeNull();
    expect(offer.refusal?.reason).toBe("offline");
  });

  test("every refusal carries a sentence, so none of them can be silent", () => {
    const refusals = [
      offerMerge({ cached: null, draftBase: null, mine: "", theirs: "" }),
      offerMerge({ cached: null, draftBase: "e1", mine: "", theirs: "" }),
      offerMerge({ cached, draftBase: "e9", mine: "", theirs: "" }),
      offerMerge({ cached, draftBase: "e1", mine: "", theirs: null }),
    ];
    for (const offer of refusals) {
      expect(offer.merge).toBeNull();
      expect(offer.refusal?.sentence.length ?? 0).toBeGreaterThan(40);
    }
  });
});

/**
 * The surface, mounted.
 *
 * The rules above are held in modules; these are the two that can only be
 * broken by the component — a Merge button drawn over a refusal, and a review
 * that saves something before anybody presses save. Neither is visible to a
 * pure test, and neither is visible in a screenshot to somebody who is not
 * already looking for it.
 */
describe("the resolver, drawn", () => {
  const { ThemeProvider } =
    require("../features/design/theme") as typeof import("../features/design/theme");
  const { ConflictResolver } =
    require("../features/console/files/ConflictResolver") as typeof import("../features/console/files/ConflictResolver");
  type ConflictReview = import("../features/console/files/useConflictReview").ConflictReview;

  const REVIEW: ConflictReview = {
    path: PATH,
    mine: MINE,
    theirs: THEIRS,
    theirsEtag: "e2",
    reading: false,
    unreadable: null,
    merge: { text: MERGED, conflicts: 0 },
    mergeRefusal: null,
    conditionalWrite: true,
  };

  const mounted: (() => void)[] = [];

  afterEach(() => {
    for (const teardown of mounted.splice(0)) teardown();
  });

  function draw(review: ConflictReview, spies: {
    keepTheirs?: () => void;
    resolveWith?: (text: string) => void;
  } = {}): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() =>
      root.render(
        createElement(ThemeProvider, {
          scheme: "light",
          children: createElement(ConflictResolver, {
            review,
            onKeepTheirs: spies.keepTheirs ?? (() => {}),
            onResolveWith: spies.resolveWith ?? (() => {}),
          }),
        }),
      ),
    );
    mounted.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    return container;
  }

  function press(container: HTMLElement, testID: string): void {
    const node = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    if (node === null) throw new Error(`no control with testID ${testID}`);
    act(() => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
    });
  }

  test("all three answers are on screen, and both versions with them", () => {
    const container = draw(REVIEW);
    expect(container.querySelector('[data-testid="conflict-keep-theirs"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conflict-keep-mine"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conflict-merge"]')).not.toBeNull();
    expect(container.textContent).toContain("One, from the train.");
    expect(container.textContent).toContain("Three, corrected.");
  });

  /**
   * THE test for the honest half of this feature. Draw the Merge button anyway
   * — the one-line "simplification" of `review.merge === null ? … : …` — and
   * this fails while everything else stays green.
   */
  test("no merge on offer means no Merge button, and the reason in its place", () => {
    const container = draw({
      ...REVIEW,
      merge: null,
      mergeRefusal: {
        reason: "ancestor-evicted",
        sentence: "Merging needs the version you started from, and this device no longer has it.",
      },
    });
    expect(container.querySelector('[data-testid="conflict-merge"]')).toBeNull();
    expect(container.textContent).toContain("no longer has it");
    // The other two are untouched: an absent third answer must not cost the
    // two that are still perfectly good.
    expect(container.querySelector('[data-testid="conflict-keep-theirs"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="conflict-keep-mine"]')).not.toBeNull();
  });

  test("their version unread leaves Keep theirs unpressable rather than a coin toss", () => {
    let pressed = 0;
    const container = draw(
      {
        ...REVIEW,
        theirs: null,
        theirsEtag: null,
        merge: null,
        mergeRefusal: { reason: "offline", sentence: "The version in your bucket has not been read yet." },
      },
      { keepTheirs: () => (pressed += 1) },
    );
    press(container, "conflict-keep-theirs");
    expect(pressed).toBe(0);
    expect(container.textContent).toContain("only your version is here");
  });

  /**
   * **Nothing is written when the merge is opened.**
   *
   * "Merge them" moves to a review surface and nothing else. An
   * implementation that saved the proposal and let somebody undo it would
   * satisfy every other test in this file.
   */
  test("opening the merge saves nothing; the review does that, on its own button", () => {
    const saved: string[] = [];
    const container = draw(REVIEW, { resolveWith: (text) => saved.push(text) });

    press(container, "conflict-merge");
    expect(saved).toEqual([]);
    expect(container.textContent).toContain("Review the merge");

    press(container, "conflict-save-merge");
    expect(saved).toEqual([MERGED]);
  });

  test("a merge with marked hunks says so, and still lets it be saved once cleaned up", () => {
    const withMarkers = `# Pilot\n${MERGE_MARKERS.mine}\nmine\n${MERGE_MARKERS.split}\ntheirs\n${MERGE_MARKERS.theirs}\n`;
    const container = draw({ ...REVIEW, merge: { text: withMarkers, conflicts: 1 } });
    press(container, "conflict-merge");
    expect(container.textContent).toContain("One spot has both versions marked");
  });
});
