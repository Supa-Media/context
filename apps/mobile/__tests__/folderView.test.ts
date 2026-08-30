/**
 * @jest-environment jsdom
 */

/**
 * A FOLDER IS SOMEWHERE YOU ARE, NOT A SETTINGS PANEL ABOUT ONE.
 *
 * Reported from a phone with a screenshot: tapping a folder gave its path, one
 * sentence about visibility, a "Make this folder private" button, and then most
 * of the screen empty. It was also the *only* thing a folder did — the notes
 * inside it were reachable only through the tree drawer, which is the surface a
 * phone makes hardest to reach.
 *
 * The property with teeth is the last group below. **This must never claim a
 * folder is empty when it is full of notes the reader may not see.** The rows
 * come from the listing the server already filtered at the caller's scope, so
 * "nothing here" and "nothing here *for you*" are two different sentences and
 * the code has to say the right one.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FolderView } from "../features/console/files/FolderView";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const FOLDER = "1-projects/pilot";

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  kind: "folder",
  path: FOLDER,
  name: "pilot",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
  ...over,
});

const file = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  kind: "file",
  path: `${FOLDER}/${name}`,
  name,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
  ...over,
});

const listing = (entries: FileEntry[], over: Partial<FolderListing> = {}): FolderListing => ({
  path: FOLDER,
  folderDefault: "team",
  entries,
  truncated: false,
  manifestUsable: true,
  ...over,
});

interface Mounted {
  container: HTMLElement;
  selected: string[];
  shares: number;
}

function mount(props: {
  entry?: FileEntry;
  listing?: FolderListing;
  canSetVisibility?: boolean;
  canShare?: boolean;
}): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const selected: string[] = [];
  const state = { shares: 0 };
  act(() => {
    root.render(
      createElement(FolderView, {
        entry: props.entry ?? entry(),
        listing: props.listing,
        canSetVisibility: props.canSetVisibility ?? true,
        canShare: props.canShare ?? true,
        onSetVisibility: () => {},
        onSelect: (path: string) => selected.push(path),
        onShare: () => {
          state.shares += 1;
        },
      }),
    );
  });

  return {
    container,
    selected,
    get shares() {
      return state.shares;
    },
  } as Mounted;
}

describe("the folder's contents are the screen", () => {
  test("every entry is listed", () => {
    const view = mount({
      listing: listing([file("build-decisions.md"), file("findings.md")]),
    });
    expect(view.container.textContent).toContain("build-decisions.md");
    expect(view.container.textContent).toContain("findings.md");
  });

  test("a subfolder is marked as one", () => {
    const view = mount({
      listing: listing([
        { ...file("notes"), kind: "folder", path: `${FOLDER}/notes`, name: "notes" },
      ]),
    });
    // The trailing slash is what tells a reader this opens rather than reads.
    expect(view.container.textContent).toContain("notes/");
  });

  /**
   * The reason this screen exists at all on a phone: the tree is a drawer, and
   * a folder that cannot be opened into is a folder whose notes are three taps
   * and a gesture away.
   */
  test("a row opens what it names", () => {
    const view = mount({ listing: listing([file("build-decisions.md")]) });
    const row = view.container.querySelector('[aria-label="build-decisions.md"]');
    expect(row).not.toBeNull();
    act(() => {
      (row as HTMLElement).click();
    });
    expect(view.selected).toEqual([`${FOLDER}/build-decisions.md`]);
  });

  /**
   * The tree marks **only exceptions**, and so does this: drawing a folder's
   * default beside every one of its files buries the single note that differs
   * from it.
   */
  test("only an exception is marked", () => {
    const view = mount({
      listing: listing([
        file("ordinary.md"),
        file("held-back.md", { visibility: "private", exception: true }),
      ]),
    });
    // Scoped to the rows: the word "private" is also in the visibility button,
    // so counting it across the whole screen counts the control too — which is
    // how the first version of this assertion read 2 and proved nothing about
    // the markers.
    // Selected by `folder-row`, not by any element carrying a label — the
    // visibility button has one too, and its text contains the word "private".
    // That is what made the first two versions of this assertion count the
    // control rather than the markers.
    const marked = [...view.container.querySelectorAll('[data-testid="folder-row"]')]
      .filter((row) => (row.textContent ?? "").includes("private"))
      .map((row) => row.getAttribute("aria-label"));
    expect(marked).toEqual(["held-back.md"]);

    // …and the ordinary row carries no marker at all. Without this the
    // assertion above passes when *every* row is marked, because the one it
    // names is still among them — which is what a sabotage of the `exception`
    // check proved.
    const ordinary = [...view.container.querySelectorAll('[data-testid="folder-row"]')].find(
      (row) => row.getAttribute("aria-label") === "ordinary.md",
    );
    expect(ordinary?.textContent).toBe("ordinary.md");
  });

  test("a short listing says so rather than reading as complete", () => {
    const view = mount({
      listing: listing([file("a.md")], { truncated: true }),
    });
    expect(view.container.textContent).toContain("more in it than is shown");
  });

  test("loading is not emptiness", () => {
    // A folder whose listing has not arrived must not be reported as empty —
    // the same "absent is not zero" rule the note count follows.
    const view = mount({ listing: undefined });
    expect(view.container.textContent).toContain("Loading");
    expect(view.container.textContent).not.toContain("nothing in it");
  });
});

describe("what an empty folder is told", () => {
  /**
   * THE test. The listing is filtered by the server at the caller's scope, so a
   * member looking at a folder of private notes sees zero rows — and telling
   * them "this folder has nothing in it" is a false statement about somebody
   * else's context, of exactly the kind the visibility rules exist to avoid.
   */
  test("a member sees 'nothing shared with you', not 'nothing here'", () => {
    const view = mount({ listing: listing([]), canSetVisibility: false });
    expect(view.container.textContent).toContain("Nothing in this folder is shared with you");
    expect(view.container.textContent).not.toContain("nothing in it yet");
  });

  test("the owner, who can see everything, is told it is empty", () => {
    const view = mount({ listing: listing([]), canSetVisibility: true });
    expect(view.container.textContent).toContain("nothing in it yet");
  });
});

describe("the controls", () => {
  test("an owner is offered Share", () => {
    const view = mount({ listing: listing([]) });
    expect(view.container.querySelector('[data-testid="folder-share"]')).not.toBeNull();
  });

  /**
   * Owner-only, absent rather than disabled — the same rule every other
   * visibility-adjacent control follows, and the server refuses anyone else
   * with `minimum: "owner"` regardless.
   */
  test("an editor is not", () => {
    const view = mount({ listing: listing([]), canShare: false });
    expect(view.container.querySelector('[data-testid="folder-share"]')).toBeNull();
  });

  test("pressing it asks for a link", () => {
    const view = mount({ listing: listing([]) });
    act(() => {
      (view.container.querySelector('[data-testid="folder-share"]') as HTMLElement).click();
    });
    expect(view.shares).toBe(1);
  });

  test("the visibility control says which way it goes", () => {
    expect(mount({ listing: listing([]) }).container.textContent).toContain(
      "Make this folder private",
    );
    expect(
      mount({ entry: entry({ visibility: "private" }), listing: listing([]) }).container
        .textContent,
    ).toContain("Share this folder with your team");
  });

  test("somebody who cannot set visibility is offered no switch", () => {
    const view = mount({ listing: listing([]), canSetVisibility: false });
    expect(view.container.textContent).not.toContain("Make this folder private");
    // …and is still told what the folder's visibility means.
    expect(view.container.textContent).toContain("team access");
  });

  /** The rule that has no public tier in it, kept in front of the owner. */
  test("the tier sentence stays", () => {
    expect(mount({ listing: listing([]) }).container.textContent).toContain(
      "There is no public tier",
    );
  });
});
