/**
 * @jest-environment jsdom
 */

/**
 * Deleting the open note while the delete has to wait in this device's queue
 * (offline, or a note the bucket does not have at that name yet) keeps it on
 * screen as a trashed note, as an online delete does (`useTrashedNote`).
 * Restore takes the delete back out of the queue while it waits; once it is
 * sent, the trash key the server answered settles the note, and Restore goes
 * to the server like any other.
 *
 * Sabotage:
 *  - put back the close-and-toast for the open note in `queueRemovalOf` and
 *    the first case finds the editor closed and a toast;
 *  - leave `trashed.undoQueued` out of `trashedViewOf` and Restore is
 *    disabled while the delete waits;
 *  - call the server restore while `trash` is `null` and the queued Restore
 *    case sends `restoreTrashEntry` with no key;
 *  - drop the `trash` field from `OpSent` (or the `onOpLanded` listener) and
 *    the landing case never settles;
 *  - keep `undoQueued` when settling and Restore after it landed asks the
 *    queue instead of the server.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => ({
  useAction: () => async () => null,
  useConvex: () => ({ query: async () => null }),
}));

import { useCreateAndMove } from "../features/console/files/fileBrowser/useCreateAndMove";
import { QUEUED_TRASH_SENDING, useTrashedNote } from "../features/console/files/fileBrowser/useTrashedNote";
import { trashedViewOf } from "../features/console/files/noteEditor/trashed";
import { emptyOutbox, queueRemoval } from "../features/offline/outbox";
import { drainOutbox, type OpSent } from "../features/offline/sync";
import type { TrashedNote } from "../features/console/files/browser/supportingTypes";

const NOTE = "1-projects/offsite-plan.md";
const TRASH = `.context/trash/stamp/${NOTE}`;

function render<T>(hook: () => T): { current: () => T; unmount: () => void } {
  let value: T;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    value = hook();
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return { current: () => value!, unmount: () => act(() => root.unmount()) };
}

const flush = () => act(async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
});

describe("a queued delete of the open note", () => {
  function removal(queued: { ok: boolean; undo?: () => boolean; dropped?: unknown }) {
    const marked: TrashedNote[] = [];
    const events: string[] = [];
    const deps = {
      options: { canEdit: true },
      autosave: { flush: () => {} },
      deviceEtag: async () => "e1",
      isFolderPath: () => false,
      offlineRef: { current: { queueRemoval: () => queued, restoreCreate: () => {} } },
      selectedPathRef: { current: NOTE },
      editorRef: { current: { path: NOTE } },
      markTrashed: (next: TrashedNote | null) => void (next !== null && marked.push(next)),
      setSelectedPath: () => void events.push("deselected"),
      dispatch: (action: { type: string }) => void events.push(action.type),
      setNotice: (notice: string) => void events.push(`notice:${notice}`),
      queuedToast: (message: string) => void events.push(`toast:${message}`),
      nextToastId: { current: 0 },
      setToasts: () => void events.push("toast:dropped"),
    };
    const hook = render(() => useCreateAndMove(deps as unknown as Parameters<typeof useCreateAndMove>[0]));
    return { hook, marked, events };
  }

  test("stays on screen as trashed, with the queue's undo, and no toast", async () => {
    const undo = () => true;
    const { hook, marked, events } = removal({ ok: true, undo });
    act(() => hook.current().queueRemovalOf(NOTE, "trash"));
    await flush();
    expect(marked).toEqual([{ path: NOTE, trash: null, at: expect.any(Number), byYou: true, byName: null, undoQueued: undo }]);
    expect(events).toEqual([]);
    hook.unmount();
  });

  test("an archive, and a note that never synced, keep today's close and toast", async () => {
    const archived = removal({ ok: true, undo: () => true });
    act(() => archived.hook.current().queueRemovalOf(NOTE, "archive"));
    await flush();
    expect(archived.marked).toEqual([]);
    expect(archived.events).toEqual(["deselected", "closed", "toast:Archived offsite-plan. Waiting to sync."]);
    archived.hook.unmount();

    const dropped = removal({ ok: true, dropped: { path: NOTE } });
    act(() => dropped.hook.current().queueRemovalOf(NOTE, "trash"));
    await flush();
    expect(dropped.marked).toEqual([]);
    expect(dropped.events).toEqual(["deselected", "closed", "toast:dropped"]);
    dropped.hook.unmount();
  });
});

describe("Restore of a note whose delete is queued", () => {
  function trashedHook() {
    const landed = new Set<(done: OpSent) => void>();
    const notices: (string | null)[] = [];
    const restores: unknown[] = [];
    const deps = {
      autosave: { pending: () => null, cancel: () => {} },
      dispatch: () => {},
      editor: { path: NOTE },
      onOpLanded: (handler: (done: OpSent) => void) => {
        landed.add(handler);
        return () => void landed.delete(handler);
      },
      openMissing: { current: null },
      openNote: async () => {},
      refresh: async () => {},
      restoreTrashEntry: async (args: unknown) => void restores.push(args),
      setNotice: (notice: string | null) => void notices.push(notice),
      workspaceId: "w1",
      workspaceGenerationRef: { current: { epoch: 1 } },
    };
    const hook = render(() => useTrashedNote(deps as unknown as Parameters<typeof useTrashedNote>[0]));
    const land = (done: OpSent) => act(() => landed.forEach((handler) => handler(done)));
    const view = () =>
      trashedViewOf({ editor: { path: NOTE }, trashed: hook.current().trashed, restoreTrashed: hook.current().restoreTrashed } as never);
    return { hook, land, view, notices, restores };
  }
  const queued = (undoQueued: () => boolean): TrashedNote => ({ path: NOTE, trash: null, at: 1, byYou: true, byName: null, undoQueued });

  test("takes the delete back out of the queue, and the note never left", () => {
    const { hook, view, restores } = trashedHook();
    const undo = jest.fn(() => true);
    act(() => hook.current().markTrashed(queued(undo)));
    expect(view()?.onRestore).toBeDefined();
    act(() => view()!.onRestore!());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(hook.current().trashed).toBeNull();
    expect(restores).toEqual([]);
    hook.unmount();
  });

  test("once it is on its way, says so and keeps the note trashed", () => {
    const { hook, view, notices, restores } = trashedHook();
    act(() => hook.current().markTrashed(queued(() => false)));
    act(() => view()!.onRestore!());
    expect(notices).toEqual([QUEUED_TRASH_SENDING]);
    expect(hook.current().trashed).toMatchObject({ path: NOTE, trash: null });
    expect(restores).toEqual([]);
    hook.unmount();
  });

  test("when it lands, the trash key settles it and Restore goes to the server", async () => {
    const { hook, land, view, restores } = trashedHook();
    const undo = jest.fn(() => false);
    act(() => hook.current().markTrashed(queued(undo)));
    land({ id: "op1", kind: "trash", path: NOTE, trash: TRASH, sentUpdatedAt: 1 });
    expect(hook.current().trashed).toEqual({ path: NOTE, trash: TRASH, at: 1, byYou: true, byName: null });
    act(() => view()!.onRestore!());
    await flush();
    expect(undo).not.toHaveBeenCalled();
    expect(restores).toEqual([{ workspaceId: "w1", from: TRASH, to: NOTE }]);
    hook.unmount();
  });
});

describe("a queued delete reaching the bucket", () => {
  test("reports the trash key the server answered", async () => {
    const removed = queueRemoval(emptyOutbox("ws1"), { id: "op1", kind: "trash", path: NOTE, etag: "e1", now: 1, coalesce: true });
    const sent: OpSent[] = [];
    await drainOutbox(removed!.outbox, {
      now: () => 2,
      write: async () => ({ kind: "written", etag: "w1", conflictCheck: "conditional" }),
      op: async () => ({ kind: "done", to: TRASH }),
      onOpDone: (done) => void sent.push(done),
    });
    expect(sent).toEqual([expect.objectContaining({ kind: "trash", path: NOTE, trash: TRASH })]);
  });
});
