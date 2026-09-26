/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";
import { untitledStem } from "../features/console/files/untitled";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **AN UNTITLED NOTE TAKES THE TITLE YOU TYPE INTO IT.**
 *
 * The owner asked for both halves of this in one sentence — *"for new note, new
 * drawing etc should not ask you to title it, it should be called untitled-date,
 * but the user should be able to title the note while writing in it"* — and the
 * second half is the one that can be shipped broken without anybody noticing
 * for a week. A `+` that writes `untitled-2026-09-19.md` and leaves it called
 * that forever is not a feature; it is a folder full of dated stubs.
 *
 * `untitledNames.test.ts` holds the pure half: which name is generated, which
 * headings count as a title, and which are refused. What only exists inside the
 * hook — and so needs a mounted harness, the one `fileBrowserGuards.test.ts`
 * uses — is **when** the rename happens:
 *
 *  - not on the keystroke, and not while a write is in flight. A `moveEntry`
 *    racing a conditional `writeNote` leaves a write aimed at a name the bucket
 *    no longer has, which is the one class of bug this console must not produce;
 *  - not while the caret is still in the title (`linkedTitleRename.test.ts`),
 *    and again each time the title changes, because after the first rename
 *    the title *is* the name (`linkedTitle.ts`);
 *  - never for a note whose title nobody changed here. A file moving in
 *    somebody's bucket because they opened it is worse than a badly named file.
 *
 * Every assertion is on whether `moveEntry` was **called**, and with what —
 * reading the editor's own state back would pass just as happily on a hook that
 * renamed nothing, because the editor follows the file either way.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite run, named tests observed failing, reverted.
 *
 *   the settled-status guard dropped                                    1
 *   `useLinkedTitle`'s one-attempt memory dropped, so a refusal retries  1
 *   `createUntitled` not recording the path at all                       3
 *   `createUntitled` generating its name against an empty listing        2
 *   `createUntitled` naming without loading the destination first        1
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

const FOLDER = "1-projects";
/** The note the `+` is about to make, by the rule `untitled.ts` states. */
const STEM = untitledStem(new Date());
const MADE = `${FOLDER}/${STEM}.md`;

function name(fn: string): string {
  return `functions/files:${fn}`;
}

/** What the bucket holds, by path. `writeNote` adds to it; `listFiles` reads it. */
let files: Map<string, string>;

function listing(path: string): FolderListing {
  const prefix = path === "" ? "" : `${path}/`;
  return {
    path,
    folderDefault: "private",
    truncated: false,
    manifestUsable: true,
    entries: [...files.keys()]
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .map((key) => ({
        kind: "file" as const,
        path: key,
        name: key.slice(prefix.length),
        visibility: "private" as const,
        inherited: "private" as const,
        exception: false,
        readOnly: false,
      }))
      .concat(
        path === ""
          ? [
              {
                kind: "folder" as unknown as "file",
                path: FOLDER,
                name: FOLDER,
                visibility: "private" as const,
                inherited: "private" as const,
                exception: false,
                readOnly: false,
              },
            ]
          : [],
      ),
  };
}

function openNote(path: string): OpenNote {
  return {
    path,
    text: files.get(path) ?? "",
    etag: `etag:${path}`,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  await act(async () => {
    for (let n = 0; n < 8; n += 1) await Promise.resolve();
  });
}

function moves(): { from: string; to: string }[] {
  return calls
    .filter((c) => c.name === name("moveEntry"))
    .map((c) => {
      const { from, to } = c.args as { from: string; to: string };
      return { from, to };
    });
}

/** Make the note, open it, and hand back the path it landed at. */
async function makeAndOpen(): Promise<void> {
  await act(async () => {
    browser.createUntitled(FOLDER, "note");
  });
  await settle();
  await act(async () => {
    browser.select(MADE);
  });
  await settle();
}

/**
 * Type a whole document and let the save land — with the caret in the title
 * while typing and out of it after, which is when a title renames its file
 * (`useLinkedTitle.ts`).
 */
async function writeAndSave(text: string): Promise<void> {
  await act(async () => {
    browser.setTitleCaret!(true);
  });
  await act(async () => {
    browser.setDraft(text);
  });
  await act(async () => {
    browser.save();
  });
  await settle();
  await act(async () => {
    browser.setTitleCaret!(false);
  });
  await settle();
}

describe("a note made without a name", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    files = new Map([["index.md", "# index\n"]]);
    actions[name("listFiles")] = async (args: never) =>
      listing((args as { path: string }).path);
    actions[name("readNote")] = async (args: never) => openNote((args as { path: string }).path);
    actions[name("writeNote")] = async (args: never) => {
      const { path, text } = args as { path: string; text: string };
      files.set(path, text);
      return { path, etag: `etag:${path}:${text.length}`, conflictCheck: "conditional" };
    };
    actions[name("moveEntry")] = async (args: never) => {
      const { from, to } = args as { from: string; to: string };
      const text = files.get(from);
      files.delete(from);
      if (text !== undefined) files.set(to, text);
      return { path: to };
    };
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("is written at untitled-<date>, with no name asked for", async () => {
    unmount = mount();
    await settle();

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();

    const written = calls
      .filter((c) => c.name === name("writeNote"))
      .map((c) => (c.args as { path: string }).path);
    expect(written).toEqual([MADE]);
  });

  test("a drawing gets both extensions from the same call", async () => {
    unmount = mount();
    await settle();

    await act(async () => {
      browser.createUntitled(FOLDER, "drawing");
    });
    await settle();

    const written = calls
      .filter((c) => c.name === name("writeNote"))
      .map((c) => (c.args as { path: string }).path);
    expect(written).toEqual([`${FOLDER}/${STEM}.excalidraw.md`]);
  });

  test("two presses make two notes rather than a collision notice", async () => {
    unmount = mount();
    await settle();

    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();
    await act(async () => {
      browser.createUntitled(FOLDER, "note");
    });
    await settle();

    const written = calls
      .filter((c) => c.name === name("writeNote"))
      .map((c) => (c.args as { path: string }).path);
    expect(written).toEqual([MADE, `${FOLDER}/${STEM}-2.md`]);
    expect(browser.notice).toBeNull();
  });

  /**
   * THE DESTINATION IS LOADED BEFORE THE NAME IS CHOSEN.
   *
   * Listings are fetched per folder, so a folder nobody has opened reads as
   * empty — and every untitled note made into it would be called
   * `untitled-<date>` with no suffix, which the server's create refuses the
   * second time. That is the quick-note link's exact shape: it files into
   * `0-inbox` from a widget, on a console that has loaded the root and nothing
   * else, and two captures in one day across two launches is the ordinary use
   * of a capture widget.
   *
   * Driven against a folder this harness has never listed, holding a note made
   * on the same day, which is the state a second launch is in.
   */
  test("a name is chosen against a folder this session has not opened", async () => {
    const UNSEEN = "0-inbox";
    files.set(`${UNSEEN}/${STEM}.md`, "# captured earlier\n");

    unmount = mount();
    await settle();
    expect(calls.filter((c) => c.name === name("listFiles"))).toHaveLength(1);

    await act(async () => {
      browser.createUntitled(UNSEEN, "note");
    });
    await settle();

    const written = calls
      .filter((c) => c.name === name("writeNote"))
      .map((c) => (c.args as { path: string }).path);
    expect(written).toEqual([`${UNSEEN}/${STEM}-2.md`]);
    expect(browser.notice).toBeNull();
  });

  /** The one that is the feature. */
  test("renames itself to the heading typed into it, once the save lands", async () => {
    unmount = mount();
    await settle();
    await makeAndOpen();
    expect(moves()).toEqual([]);

    await writeAndSave("# Weekly sync\n\nWhat we agreed.\n");

    expect(moves()).toEqual([{ from: MADE, to: `${FOLDER}/Weekly sync.md` }]);
  });

  /**
   * NOT WHILE THE WRITE IS IN FLIGHT.
   *
   * The rename waits for `clean`, which is the one moment nothing is pending: the
   * draft is in the bucket, the etag the editor holds is the one it answered
   * with, and the autosave timer is spent. A `moveEntry` issued against a dirty
   * editor leaves the next conditional `writeNote` aimed at a path the bucket no
   * longer has.
   */
  test("and not while the note is still dirty", async () => {
    unmount = mount();
    await settle();
    await makeAndOpen();

    await act(async () => {
      browser.setDraft("# Weekly sync\n\n");
    });
    await settle();

    expect(browser.editor.status).toBe("dirty");
    expect(moves()).toEqual([]);
  });

  /**
   * AND AGAIN, FOR AS LONG AS THE TITLE IS THE NAME.
   *
   * This used to be "once, and then it is their filename", and the owner asked
   * for the opposite (2026-09-26: renaming from the page itself). After the
   * first rename the note's title *is* its name, so a second edit of the title
   * renames it again — `linkedTitle.ts` has the rule, and `linkedTitleRename`
   * holds the half this suite cannot: a note whose title and name already
   * differ is never moved by its heading.
   */
  test("and again when the title changes after that, since the two are one name now", async () => {
    unmount = mount();
    await settle();
    await makeAndOpen();

    await writeAndSave("# Weekly sync\n\n");
    expect(moves()).toHaveLength(1);

    await writeAndSave("# Weekly sync, revised\n\nMore.\n");
    expect(moves()).toEqual([
      { from: MADE, to: `${FOLDER}/Weekly sync.md` },
      { from: `${FOLDER}/Weekly sync.md`, to: `${FOLDER}/Weekly sync, revised.md` },
    ]);
  });

  /**
   * AND IT DOES NOT COME BACK FOR A SECOND GO AT A RENAME THAT FAILED.
   *
   * The path leaves `awaitingTitle` when the rename is *asked for*, not when it
   * succeeds, so a refusal costs the note its automatic title and nothing else —
   * the notice says why, and Rename is on the row menu. The alternative is a
   * note that quietly tries to move itself again on every save for the rest of
   * the session, which is a file in somebody's bucket shifting under them long
   * after they stopped thinking about it.
   *
   * Driven through a `moveEntry` that refuses, because that is the failure the
   * console cannot predict: the collision check in front of it would make this
   * test about the check instead.
   */
  test("a rename the server refuses is not retried on the next save", async () => {
    actions[name("moveEntry")] = async () => {
      throw new Error("nope");
    };

    unmount = mount();
    await settle();
    await makeAndOpen();

    await writeAndSave("# Weekly sync\n\n");
    expect(moves()).toHaveLength(1);
    expect(browser.notice).not.toBeNull();

    await writeAndSave("# Weekly sync\n\nMore body.\n");
    expect(moves()).toHaveLength(1);
  });

  /**
   * AND NEVER FOR A NOTE THIS SESSION DID NOT MAKE.
   *
   * The positive control above proves the rename fires; this proves what stops
   * it. An existing note that merely *looks* untitled — one made yesterday, with
   * a heading its owner changed by hand — must not move because somebody opened
   * it today. Only a note this session created without asking for a name is a
   * note this session may name.
   */
  test("an existing untitled-looking note is left where it is", async () => {
    const OLD = `${FOLDER}/untitled-2026-01-02.md`;
    files.set(OLD, "# Last year's thinking\n\nBody.\n");

    unmount = mount();
    await settle();
    await act(async () => {
      browser.select(OLD);
    });
    await settle();

    // Opened, clean, and its heading is nothing like its name — every condition
    // the rename needs except the one that matters.
    expect(browser.editor.status).toBe("clean");
    expect(moves()).toEqual([]);

    // And still not when it is edited and saved like any other note.
    await writeAndSave("# Last year's thinking\n\nBody, revised.\n");
    expect(moves()).toEqual([]);
  });

  test("a note whose heading is still the placeholder keeps its name", async () => {
    unmount = mount();
    await settle();
    await makeAndOpen();

    // Typing a body without touching the heading is the ordinary case, and it
    // must not rename the file to the word `untitled-<date>` it already has.
    await writeAndSave(`# ${STEM}\n\nJust the body.\n`);
    expect(moves()).toEqual([]);
  });

  test("and a heading a bucket could not store as a name keeps its name too", async () => {
    unmount = mount();
    await settle();
    await makeAndOpen();

    await writeAndSave("# 1-projects/somewhere else\n\nBody.\n");
    expect(moves()).toEqual([]);
    // Refused rather than mangled: nothing was moved, and nothing was renamed to
    // a nearly-right name the person cannot see.
    expect(files.has(MADE)).toBe(true);
  });
});
