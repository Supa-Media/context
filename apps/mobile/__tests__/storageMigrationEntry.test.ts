/**
 * @jest-environment jsdom
 */

/**
 * THE STORAGE-LAYOUT UPDATE, AT THE TWO PLACES IT IS NOW OFFERED FROM.
 *
 * It used to be a gear in the file tree's toolbar, beside New note, New
 * folder, Sort A-Z and Collapse every folder — four controls somebody uses
 * every day and a fifth that reorganizes Context's own hidden objects under
 * `.context/` once, ever, and changes not one note. The owner flagged it:
 * permanent top-level chrome for a one-time internal maintenance operation.
 *
 * The control did not become less real by leaving the toolbar, so its guard
 * moved here rather than being deleted. `explorerActionGuards.test.ts` held it
 * while the toolbar owned it and now holds the other half — that the toolbar
 * does *not* draw it — and this file holds the two live entry points:
 *
 *  - **Settings → Storage**, the permanent home: a labelled row in the section
 *    about where this context's files are kept.
 *  - **A dismissible notice in the console**, in the band the no-bucket and
 *    broken-manifest lines already use.
 *
 * ## The guard is the same guard
 *
 * `files.updateStorageLayout` is handed to an owner by `useFileBrowser` and to
 * nobody else, so an absent function is an absent control. Both surfaces are
 * asserted in both states, because "moved it" is exactly the change that can
 * quietly widen who is offered something.
 *
 * ## What "not a modal on load" is asserted as
 *
 * A notice is only better than a dialog if it does not become one by itself.
 * The console mounts with the offer available and the confirmation's words are
 * asserted **absent** until something is pressed.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. 8 checks in this file.
 *
 *   the settings row drawn for everyone (its guard dropped)                  1
 *   `useStorageMigrationOffer` ignoring the stored dismissal                 2
 *   the notice's button running the update without confirming first          1
 *   the dismissal held in component state and never written down             1
 *   running the update not answering the offer (the notice stays)            1
 *   the notice's `storageMigrationWorthOffering` condition dropped           1
 *   the settings card's row not wrapping (`flexWrap` dropped)                1
 *   the text column's `minWidth` floor dropped                               1
 *
 * One mutation is **not** detected and is worth naming rather than leaving to
 * be discovered: dropping `storageMigration.visible` from the notice's own
 * ternary in `BrowsePane` changes nothing, because `hasNotice` — the condition
 * that decides whether the band is built at all — carries the same term, and
 * on a console with no other notice the band is then absent entirely. The
 * ternary keeps it anyway: it is what narrows `updateStorageLayout` for the
 * `run` prop, and the day a second notice is on screen beside it the band is
 * built for the other one and this term is the only thing left.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
  useMutation: () => async () => {
    throw new Error("not used in this test");
  },
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => undefined,
  useQuery: () => undefined,
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { BrowsePane } from "../features/console/panes/BrowsePane";
import { SettingsPane } from "../features/console/panes/SettingsPane";
import {
  STORAGE_MIGRATION_CONFIRM_LABEL,
  storageMigrationDismissedKey,
} from "../features/console/storage/StorageMigration";
import { emptyEditor } from "../features/console/files/editor";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The first sentence of the confirmation, which is its whole promise. */
const NOTE_SAFETY = "Your notes, folders, privacy.md, and index.md are not changed.";

const WORKSPACE = "w1";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

beforeEach(() => {
  // The dismissal is written to the device (`localStorage` on this platform),
  // so one case's "Not now" would otherwise silence the next case's notice.
  window.localStorage.clear();
});

/**
 * A console owned by whoever is looking at it, with a working bucket.
 *
 * `calls` records what reached the browser, which is the only thing worth
 * asserting about a control: a dialog that draws and never calls is the defect
 * this whole feature area keeps producing.
 */
function console_(
  calls: string[],
  over: Partial<FileBrowser> = {},
): ConsoleData {
  const files = {
    canEdit: true,
    contextId: WORKSPACE,
    loading: false,
    busy: false,
    listings: {},
    expanded: new Set<string>(),
    toggleFolder: () => {},
    collapseAll: () => {},
    selectedPath: null,
    opening: null,
    select: () => true,
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    conflict: null,
    resolveWith: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    clipboard: null,
    linkPaths: [],
    updateStorageLayout: () => calls.push("updateStorageLayout"),
    ...over,
  } as unknown as FileBrowser;

  return {
    demo: false,
    viewer: { name: "Seyi", handle: "@seyi" },
    contexts: [{ id: WORKSPACE, slug: "seyi", name: "Seyi", kind: "personal", role: "owner" }],
    selectedContextId: WORKSPACE,
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: {
      connected: true,
      status: "connected",
      provider: "r2",
      bucket: "notes",
      conditionalWrite: true,
    },
    endpoint: "https://mcp.example",
    ingestionAddress: "seyi@example",
    ingestion: { settings: undefined },
    files,
    fastSearch: { status: null, loading: false },
    members: { rows: [], members: [] },
    shares: { shares: [] },
    advanced: { moves: { jobs: [], loading: false }, audit: { events: [], loading: false } },
    loading: false,
    failure: null,
  } as unknown as ConsoleData;
}

/**
 * Mounts, flushes the effect that asks the device whether this notice has been
 * dismissed, and hands back `document.body`.
 *
 * The body rather than the container: the confirmation renders through
 * `Modal`, which react-native-web portals out of the tree it was rendered in.
 */
async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(element);
  });
  return document.body;
}

const browse = (data: ConsoleData) =>
  mount(createElement(BrowsePane, { data, onOpenSettings: () => {} } as never));

const settingsStorage = (data: ConsoleData) =>
  mount(
    createElement(SettingsPane, {
      data,
      section: "storage",
      onClose: () => {},
    } as never),
  );

function press(host: HTMLElement, selector: string): void {
  const node = host.querySelector(selector) as HTMLElement | null;
  expect(node).not.toBeNull();
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

/** Presses by the label a person reads, for the dialog's own two buttons. */
function pressLabel(label: string): void {
  const node = [...document.body.querySelectorAll("[aria-label]")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (node === undefined) throw new Error(`no control labelled ${label}`);
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

describe("Settings → Storage is the permanent home", () => {
  test("an owner is offered it there, and it asks before it runs", async () => {
    const calls: string[] = [];
    const host = await settingsStorage(console_(calls));

    expect(host.querySelector('[data-testid="settings-storage-migration"]')).not.toBeNull();
    // Nothing is asked for until it is asked for: the row is a row, not a
    // dialog waiting to happen.
    expect(host.textContent ?? "").not.toContain(NOTE_SAFETY);

    press(host, '[data-testid="settings-storage-migration-run"]');
    expect(document.body.textContent ?? "").toContain(NOTE_SAFETY);
    expect(calls).toEqual([]);

    pressLabel(STORAGE_MIGRATION_CONFIRM_LABEL);
    expect(calls).toEqual(["updateStorageLayout"]);
  });

  test("cancelling the confirmation runs nothing", async () => {
    const calls: string[] = [];
    const host = await settingsStorage(console_(calls));
    press(host, '[data-testid="settings-storage-migration-run"]');
    pressLabel("Cancel");
    expect(calls).toEqual([]);
    expect(document.body.textContent ?? "").not.toContain(NOTE_SAFETY);
  });

  test("its row wraps rather than crushing the words on a phone", async () => {
    /*
      Found by looking, not by failing: at 390pt the panel's card put a
      three-line heading in a 110pt column beside a button at its full width,
      because `Row` does not wrap and `Grow` carries `minWidth: 0`.

      jsdom lays nothing out, so this reads the two CSS properties that decide
      it off the real react-native-web styles rather than claiming to measure a
      wrap. Both halves are needed and both are asserted: somewhere to wrap to,
      and a floor under the text so the layout prefers a second line to a
      narrower column.
    */
    const host = await settingsStorage(console_([]));
    const card = host.querySelector('[data-testid="settings-storage-migration"]') as HTMLElement;
    const row = card.firstElementChild as HTMLElement;
    expect(getComputedStyle(row).flexWrap).toBe("wrap");
    const grow = row.firstElementChild as HTMLElement;
    expect(getComputedStyle(grow).minWidth).not.toBe("0px");
  });

  test("and an absent action is an absent row", async () => {
    // `useFileBrowser` hands `updateStorageLayout` to an owner and to nobody
    // else. The section still renders — the positive control is the binding
    // card beside it — so this cannot pass on a panel that drew nothing.
    const host = await settingsStorage(console_([], { updateStorageLayout: undefined }));
    expect(host.querySelector('[data-testid="settings-storage-migration"]')).toBeNull();
    expect(host.textContent ?? "").toContain("Your bucket, your credentials");
  });
});

describe("the console offers it as a notice, not as a modal", () => {
  test("it is a line in the band, and nothing is asked until it is pressed", async () => {
    const calls: string[] = [];
    const host = await browse(console_(calls));

    expect(host.querySelector('[data-testid="browse-storage-migration"]')).not.toBeNull();
    // The whole of "not a modal that fires on load".
    expect(host.textContent ?? "").not.toContain(NOTE_SAFETY);

    press(host, '[data-testid="browse-storage-migration-run"]');
    expect(document.body.textContent ?? "").toContain(NOTE_SAFETY);
    expect(calls).toEqual([]);

    pressLabel(STORAGE_MIGRATION_CONFIRM_LABEL);
    expect(calls).toEqual(["updateStorageLayout"]);
    // Starting it answers the offer. A notice still sitting there restating
    // something already under way is the nag this change exists to remove.
    expect(host.querySelector('[data-testid="browse-storage-migration"]')).toBeNull();
  });

  test("Not now puts it away, and it stays away on the next visit", async () => {
    const calls: string[] = [];
    const first = await browse(console_(calls));
    press(first, '[data-testid="browse-storage-migration-dismiss"]');
    expect(first.querySelector('[data-testid="browse-storage-migration"]')).toBeNull();
    expect(calls).toEqual([]);

    // It is written down, per context, and that is what the second mount
    // below is checking rather than a lucky render.
    expect(window.localStorage.getItem(storageMigrationDismissedKey(WORKSPACE))).not.toBeNull();

    // The second mount is the reload. Local component state would pass the
    // assertion above and fail this one — which is the difference between an
    // offer and a nag, given nothing tells the console whether this bucket
    // still needs the update.
    while (roots.length > 0) roots.pop()!();
    const second = await browse(console_(calls));
    expect(second.querySelector('[data-testid="browse-storage-migration"]')).toBeNull();
  });

  test("and it is not offered at all where there is no bucket to tidy", async () => {
    /*
      The one condition the notice has and the settings row does not. An owner
      with no binding is looking at "No bucket is connected to this context
      yet" two lines above; an offer to reorganize the hidden files of a
      bucket that does not exist is noise at the worst moment. It narrows the
      *interruption*, never who may run this — the same owner still finds it
      in Settings → Storage, which is asserted by the block above.
    */
    const withoutBucket = console_([]);
    const host = await browse({ ...withoutBucket, storage: null } as ConsoleData);
    expect(host.querySelector('[data-testid="browse-storage-migration"]')).toBeNull();
    // The positive control: the band is drawn, for the notice that *should*
    // be there. Without it this passes on a pane that rendered no band at all.
    expect(host.textContent ?? "").toContain("No bucket is connected");
  });

  test("and an editor is offered nothing at all", async () => {
    const host = await browse(console_([], { updateStorageLayout: undefined }));
    expect(host.querySelector('[data-testid="browse-storage-migration"]')).toBeNull();
  });
});
