/**
 * @jest-environment jsdom
 */

/**
 * The move dialog: its other-contexts row, and the folders it does and does
 * not offer as a destination.
 *
 * Split out of `explorerActionGuards.test.ts`; see `fixtures.ts` in this
 * folder for the guard table and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ExplorerDialogs } from "../../features/console/files/Explorer";
import type { FileBrowser } from "../../features/console/files/browser";
import { browser, METRICS, PROJECTS_LISTING, ROOT_LISTING, roots, type Calls } from "./fixtures";

const noop = () => {};

/**
 * `ExplorerDialogs` mounted on its own.
 *
 * It is exported from the same module and takes no frame context, so it needs
 * no `AppFrame` — but `MovePicker` renders through `Shell`, which reaches for
 * safe-area insets on the web build, so it needs `METRICS` for the reason given
 * there.
 */
function mountMoveDialog(
  path: string,
  elsewhere: {
    moveDestinations?: FileBrowser["moveDestinations"];
    destinationFolders?: FileBrowser["destinationFolders"];
  } = {},
): { container: HTMLElement; calls: Calls } {
  const calls: Calls = { entries: [], props: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(ExplorerDialogs, {
          files: browser(true, calls, elsewhere),
          dialog: { kind: "move", path },
          onClose: noop,
        }),
      ),
    );
  });
  return { container, calls };
}

/** `MovePicker`'s label for the root, which is not a path. */
const ROOT_LABEL = "the root of your context";

/**
 * Every folder path the fixture contains, derived rather than listed.
 *
 * `loadedFolders` can only ever return `""` plus the `kind: "folder"` entries of
 * the listings it is given, so this set is exactly the space the dialog's list
 * is drawn from — which makes the filter below complete by construction. The
 * first version matched `/^[0-9]-/` instead and would have silently dropped a
 * leaked `Journal/` or `Clients/`, the folder names `CLAUDE.md`'s
 * `resetPrivacyManifest` decision exists because real workspaces actually have.
 */
const EVERY_FOLDER = new Set(
  [ROOT_LISTING, PROJECTS_LISTING].flatMap((listing) =>
    listing.entries.filter((entry) => entry.kind === "folder").map((entry) => entry.path),
  ),
);

/** Every destination the dialog is offering, in the order it offers them. */
function offeredFolders(): string[] {
  return [...document.body.querySelectorAll("[aria-label]")]
    .map((node) => node.getAttribute("aria-label") ?? "")
    .filter((label) => label === ROOT_LABEL || EVERY_FOLDER.has(label));
}

/** The one node carrying this accessibility label, or `undefined`. */
function labelled(label: string): Element | undefined {
  return [...document.body.querySelectorAll("[aria-label]")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
}

function press(label: string): void {
  const node = labelled(label);
  expect(node).toBeDefined();
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

/**
 * MOVING INTO ANOTHER CONTEXT, FROM THE SAME DIALOG.
 *
 * One dialog rather than two, because it is one question — "where should this
 * live?" — and the only new part of the answer is which context. What has to
 * be true of it:
 *
 *  - **The row of contexts exists only where the browser offers one.** That
 *    list is already gated on owning the context this is leaving (the server's
 *    own rule, in `functions/contextMoves.ts`), and a dialog that drew the row
 *    from anything else would be offering a destination every press of which
 *    is refused.
 *  - **`moveToContext`, never `move`.** They are different server actions with
 *    different guarantees — one rewrites links and one cannot — and the dialog
 *    is the thing that decides which. Confusing them would send a
 *    cross-context move through an action that cannot cross.
 *  - **A folder chosen in one context does not survive a switch to another.**
 *    Two contexts can both have `work/`, so a stale selection is not an
 *    invalid press that fails — it is a valid press that lands somewhere
 *    nobody chose.
 */
describe("the move dialog's other contexts", () => {
  const WORK = { id: "w-work", label: "@work", displayName: "Work" };

  /** Flush the promise `destinationFolders` resolves with. */
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  test("no contexts to move into means no row of contexts", () => {
    mountMoveDialog("note.md");
    expect(labelled("This context")).toBeUndefined();
    expect(labelled("@work")).toBeUndefined();
  });

  test("choosing one lists its folders and moves into it", async () => {
    const dialog = mountMoveDialog("note.md", {
      moveDestinations: [WORK],
      destinationFolders: async () => ({ folders: ["archive", "clients"], truncated: false }),
    });

    press("@work");
    await settle();

    // Its folders, not this context's: `1-projects` and `2-areas` are here and
    // must not be offered as somewhere in @work.
    expect(labelled("clients")).toBeDefined();
    expect(labelled("1-projects")).toBeUndefined();

    press("clients");
    press("Move to @work");
    expect(dialog.calls.entries).toEqual([
      { name: "moveToContext", args: ["note.md", "w-work", "clients"] },
    ]);
  });

  test("switching back drops the folder that was chosen over there", async () => {
    const dialog = mountMoveDialog("note.md", {
      moveDestinations: [WORK],
      destinationFolders: async () => ({ folders: ["clients"], truncated: false }),
    });

    press("@work");
    await settle();
    press("clients");
    press("This context");

    // Nothing is armed: the button that would confirm is the local one again,
    // and it has nothing selected to confirm.
    press("Move here");
    expect(dialog.calls.entries).toEqual([]);
  });

  test("a truncated list says so rather than reading as the whole context", async () => {
    mountMoveDialog("note.md", {
      moveDestinations: [WORK],
      destinationFolders: async () => ({ folders: ["clients"], truncated: true }),
    });

    press("@work");
    await settle();

    expect(document.body.textContent).toContain("Showing the first 1 folders");
  });

  test("a context whose folders cannot be read says so and offers nothing", async () => {
    const dialog = mountMoveDialog("note.md", {
      moveDestinations: [WORK],
      destinationFolders: async () => {
        throw new Error("nope");
      },
    });

    press("@work");
    await settle();

    expect(document.body.textContent).toContain("could not be read");
    // And no destination is offered, so there is nothing to press through to a
    // move that would have been refused anyway.
    expect(labelled("clients")).toBeUndefined();
    expect(dialog.calls.entries).toEqual([]);
  });
});

describe("the move dialog does not offer a folder itself or its own descendants", () => {
  test("a folder is offered every destination but itself and below it", () => {
    // Positive control in the same assertion: `2-areas` and the root ARE
    // offered, so this cannot pass by rendering an empty list. `loadedFolders`
    // returns all four — "", 1-projects, 1-projects/sub, 2-areas — and does no
    // filtering of its own, so the two that are missing are missing because of
    // the filter under test.
    mountMoveDialog("1-projects");
    expect(offeredFolders()).toEqual([ROOT_LABEL, "2-areas"]);
  });

  test("choosing an offered destination moves; the dialog's list is the only gate", () => {
    // `MovePicker` calls `onConfirm` with whatever was chosen and asks nothing
    // else, and `files.move` does not re-check — so what the list contains is
    // what can be moved into. That is why the exclusion above is a guard rather
    // than a nicety.
    const dialog = mountMoveDialog("1-projects");
    press("2-areas");
    press("Move here");
    expect(dialog.calls.entries).toEqual([{ name: "move", args: ["1-projects", "2-areas"] }]);
  });
});
