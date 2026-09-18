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
  storage: Record<string, unknown> = {},
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
  // No move into another context is running. `BrowsePane` reads this on
  // every render, so a fixture without it crashes the pane rather than
  // failing the assertion the test was written for.
  contextMoves: [],
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
      /*
        Absent `layoutState` with `layoutChecked` is the default on purpose: it
        is a bucket that has been **asked** and answered that nobody has ever
        run the migration there, which is the one combination that still
        offers. Absent *and unasked* is a different fixture — a question the
        console has not put yet — and it has its own test below.
      */
      layoutChecked: true,
      ...storage,
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

describe("a recorded outcome, not a flag on one device", () => {
  /*
    THE NAG THIS ENDS.

    The migration has always written its own state into the bucket — under
    `.context/`, where `migrateStorageLayout` reads it and short-circuits on
    `complete`. Nothing outside the bucket could see it, so the console's
    "available" was as close to "pending" as it could get and the offer was
    answered by a `localStorage` flag: per browser, per device, per context.
    Run it on a laptop and the phone offered it again; clear site data and the
    laptop did too. The owner who reported this had pressed it "so many times".

    `storageBindings.storageLayoutState` is now that outcome, recorded on every
    pass, so the answer travels with the workspace instead of with the device.
    Each case below sets it and asserts against a **clean** device store —
    `beforeEach` clears it — so nothing here can pass on a leftover dismissal.
  */
  const noticeIn = (host: HTMLElement) =>
    host.querySelector('[data-testid="browse-storage-migration"]');

  test("a migrated bucket is not offered the migration, on a device that never ran it", async () => {
    const host = await browse(console_([], {}, { layoutState: "complete" }));
    expect(noticeIn(host)).toBeNull();
    // The positive control: the same console with nothing recorded still
    // offers, so this cannot pass on a pane that drew no band at all.
    const fresh = await browse(console_([]));
    expect(noticeIn(fresh)).not.toBeNull();
  });

  /*
    THE HALF THE RECORDED OUTCOME DID NOT FIX.

    `storageLayoutState` is written by a migration *pass*, so it answered for
    every context migrated after it shipped and for none of the ones migrated
    before. Those kept `complete` in their own bucket and nothing on their
    binding — and an absent state was read as "nobody has run it", so the
    notice came back on every device, for ever, for exactly the people who had
    already run it. The owner who reported the original nag was one of them:
    recording the outcome ended it for everybody except them.

    So the console asks the bucket before it offers anything, and an unasked
    binding offers nothing while the question is in flight.
  */
  test("a bucket nobody has asked is not offered anything, and is asked", async () => {
    const asked: string[] = [];
    const data = console_([], {}, { layoutChecked: undefined });
    (data as { storageActions?: unknown }).storageActions = {
      ...((data.storageActions ?? {}) as object),
      observeLayout: async () => {
        asked.push(WORKSPACE);
        return { queued: true };
      },
    };

    const host = await browse(data);
    expect(noticeIn(host)).toBeNull();
    // And the silence is temporary rather than a second way to never offer:
    // the console put the question that makes the answer exist.
    expect(asked).toEqual([WORKSPACE]);
  });

  test("once the bucket has answered 'never run', the offer comes back", async () => {
    /*
      The sabotage guard for the test above. If `layoutChecked` merely
      suppressed the notice, this would fail — and the fix would have been a
      nag replaced by a control nobody is ever offered, which is worse and
      silent.
    */
    const host = await browse(console_([], {}, { layoutChecked: true }));
    expect(noticeIn(host)).not.toBeNull();
  });

  test("nor is one in the middle of it, or one that can never run it", async () => {
    for (const state of ["copying", "copied", "cleaning", "unsupported", "conflict"] as const) {
      while (roots.length > 0) roots.pop()!();
      const host = await browse(console_([], {}, { layoutState: state }));
      expect(noticeIn(host)).toBeNull();
    }
  });

  test("Settings says where it got to instead of offering it again", async () => {
    const done = await settingsStorage(console_([], {}, { layoutState: "complete" }));
    expect(done.querySelector('[data-testid="settings-storage-migration"]')).not.toBeNull();
    // The row stays — it is the permanent home, and "already done" is exactly
    // what somebody who went looking came to find out.
    expect(done.textContent ?? "").toContain("already on the current layout");
    expect(done.querySelector('[data-testid="settings-storage-migration-run"]')).toBeNull();
  });

  test("and says so for a bucket that cannot run it at all", async () => {
    const host = await settingsStorage(console_([], {}, { layoutState: "unsupported" }));
    // `runStorageLayoutMigration` refuses without conflict-safe writes. A
    // button whose only outcome is that refusal is worse than a sentence.
    expect(host.textContent ?? "").toContain("conflict-safe writes");
    expect(host.querySelector('[data-testid="settings-storage-migration-run"]')).toBeNull();
  });

  test("a stalled migration keeps its way out", async () => {
    // `conflict` is the one answered state that is still somebody's to act on:
    // a destination changed under the copy. Not offered in the band — an
    // interruption is for an offer, not for a retry — but the control stays
    // where they would look for it.
    const calls: string[] = [];
    const host = await settingsStorage(console_(calls, {}, { layoutState: "conflict" }));
    expect(host.querySelector('[data-testid="settings-storage-migration-run"]')).not.toBeNull();
    press(host, '[data-testid="settings-storage-migration-run"]');
    pressLabel(STORAGE_MIGRATION_CONFIRM_LABEL);
    expect(calls).toEqual(["updateStorageLayout"]);
  });

  test("running it from Settings answers the notice too", async () => {
    /*
      The gap that made "I keep clicking it" literally true. The notice's own
      text sends people to Settings → Storage, and running it there never
      wrote the dismissal — so until the recorded state came back through the
      subscription, the band still offered what they had just started.

      The device flag is belt and braces now rather than the whole mechanism,
      and it is what covers that window.
    */
    const calls: string[] = [];
    const host = await settingsStorage(console_(calls));
    press(host, '[data-testid="settings-storage-migration-run"]');
    pressLabel(STORAGE_MIGRATION_CONFIRM_LABEL);
    expect(calls).toEqual(["updateStorageLayout"]);
    expect(window.localStorage.getItem(storageMigrationDismissedKey(WORKSPACE))).not.toBeNull();

    // And the band is quiet on the next mount, before any state has landed.
    while (roots.length > 0) roots.pop()!();
    const second = await browse(console_(calls));
    expect(noticeIn(second)).toBeNull();
  });
});
