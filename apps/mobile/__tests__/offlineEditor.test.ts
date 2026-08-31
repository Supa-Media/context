import { describe, expect, test } from "@jest/globals";

import {
  editorReducer,
  emptyEditor,
  guardLeaving,
  isDirty,
  saveButton,
  type EditorState,
} from "../features/console/files/editor";
import { statusSegments } from "../features/console/files/status";
import { restoreFor } from "../features/offline/restore";
import { emptyOutbox, enqueue, markConflict, markRejected } from "../features/offline/outbox";
import type { OpenNote } from "../features/console/files/types";

/**
 * The editor's half of offline: what the person sees when a save has been
 * written down instead of written, and what happens when they come back to a
 * note that had work waiting for it.
 *
 * `editor.ts` and `status.ts` are pure and have no React in them, which is the
 * whole reason these transitions are testable — a conflict arriving on a note
 * reopened four hours later is not a thing anybody reproduces by hand.
 */

function note(text = "on the server", etag = "e1"): OpenNote {
  return {
    path: "a.md",
    text,
    etag,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

function opened(over: Partial<Parameters<typeof editorReducer>[1]> = {}): EditorState {
  return editorReducer(emptyEditor, { type: "opened", note: note(), ...over } as never);
}

const zero = { pending: 0, conflicted: 0, rejected: 0 };

function segments(state: EditorState, sync?: Parameters<typeof statusSegments>[0]["sync"]) {
  return statusSegments({ editor: state, storageLabel: null, now: 0, sync });
}

const byId = (list: ReturnType<typeof segments>, id: string) => list.find((s) => s.id === id);

/* -------------------------------------------------------------------------- */

describe("a save that was written down instead of written", () => {
  test("it is neither saved nor unsaved, and it never wears the saved tone", () => {
    /*
      The line this state exists to not cross. The whole product is that the
      customer's bucket is the thing that is real, so a draft sitting in a queue
      on a laptop may not be reported in the same words or the same colour as a
      draft that reached it.
    */
    const queued = editorReducer(
      editorReducer(opened(), { type: "edited", text: "typed on a train" }),
      { type: "saveQueued", message: "No connection, so this is written down." },
    );

    expect(queued.status).toBe("queued");
    const save = byId(segments(queued), "save")!;
    expect(save.text).toBe("Queued");
    expect(save.tone).toBe("warn");
    expect(save.detail).toContain("written down");
  });

  test("typing more does not turn it back into unsaved changes", () => {
    // The queue supersedes, so the newest text is still written down. Calling
    // it "unsaved" would send somebody looking for a Save button with nothing
    // left to do — which is why that button says "Queued" and is dead.
    const queued = editorReducer(opened(), { type: "saveQueued", message: "queued" });
    const more = editorReducer(queued, { type: "edited", text: "and more" });

    expect(more.status).toBe("queued");
    expect(more.draft).toBe("and more");
    expect(saveButton(more)).toEqual({ label: "Queued", disabled: true });
  });

  test("you may leave a queued note, and still not a merely dirty one", () => {
    /*
      The guard exists to stop a draft being lost to navigation. A queued draft
      cannot be — it is in the queue, which outlives the component and, on a
      durable store, the app. Refusing anyway strands somebody on a train: no
      connection, no way to save, and the console will not let them open
      anything else.
    */
    const queued = editorReducer(
      editorReducer(opened(), { type: "edited", text: "changed" }),
      { type: "saveQueued", message: "queued" },
    );
    const dirty = editorReducer(opened(), { type: "edited", text: "changed" });

    expect(isDirty(queued)).toBe(true);
    expect(guardLeaving(queued).allowed).toBe(true);
    expect(guardLeaving(dirty).allowed).toBe(false);
  });

  test("when the queue drains it, the editor moves onto the etag the bucket now holds", () => {
    /*
      Without this the note in front of you still carries the etag its queued
      draft was typed against, which your own drain has just superseded — so the
      very next Save conflicts you with yourself.
    */
    const queued = editorReducer(
      editorReducer(opened(), { type: "edited", text: "changed" }),
      { type: "saveQueued", message: "queued" },
    );
    const settled = editorReducer(queued, { type: "queueSettled", etag: "e2" });

    expect(settled.status).toBe("saved");
    expect(settled.etag).toBe("e2");
    expect(settled.baseline).toBe("changed");
    expect(isDirty(settled)).toBe(false);
  });

  test("a drain landing on a note that is no longer queued changes nothing", () => {
    // The person may have discarded, reloaded theirs, or opened something else
    // between the drain starting and finishing.
    const clean = opened();
    expect(editorReducer(clean, { type: "queueSettled", etag: "e2" })).toBe(clean);
  });
});

/* -------------------------------------------------------------------------- */

describe("a note read off the device", () => {
  test("it is not drawn as saved, and it says how old the copy is", () => {
    const cached = opened({
      fromCache: true,
      notice: "Showing the copy on this device, read 2 hours ago.",
    });

    const save = byId(segments(cached), "save")!;
    expect(save.text).toBe("Cached copy");
    expect(save.tone).toBe("warn");
    expect(save.detail).toContain("2 hours ago");
  });

  test("a note read from the bucket is still just saved", () => {
    expect(byId(segments(opened()), "save")).toEqual({
      id: "save",
      text: "Saved",
      tone: "quiet",
      detail: undefined,
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("coming back to a note that had work waiting", () => {
  test("a queued write is put back in the editor as queued", () => {
    const pending = enqueue(emptyOutbox("ws1"), {
      path: "a.md",
      text: "typed on a train",
      baseEtag: "e1",
      now: 1,
    }).writes[0]!;

    const restored = restoreFor({ note: note(), pending })!;
    const state = editorReducer(emptyEditor, { type: "opened", note: note(), restored });

    expect(state.status).toBe("queued");
    expect(state.draft).toBe("typed on a train");
    // The baseline stays the bucket's, so "unchanged" keeps meaning "the same
    // as what is stored" and the dirty marker keeps telling the truth.
    expect(state.baseline).toBe("on the server");
  });

  test("a parked conflict comes back as a conflict, with the version to compare against", () => {
    const conflicted = markConflict(
      enqueue(emptyOutbox("ws1"), { path: "a.md", text: "mine", baseEtag: "e1", now: 1 }),
      "a.md",
      { currentEtag: "e2", message: "That file changed somewhere else.", now: 2 },
    ).writes[0]!;

    const state = editorReducer(emptyEditor, {
      type: "opened",
      note: note("theirs", "e2"),
      restored: restoreFor({ note: note("theirs", "e2"), pending: conflicted })!,
    });

    expect(state.status).toBe("conflict");
    expect(state.draft).toBe("mine");
    expect(state.conflictEtag).toBe("e2");
    expect(saveButton(state)).toEqual({ label: "Overwrite theirs", disabled: false });
  });

  test("a refusal comes back as an error with the reason, not as a clean note", () => {
    const rejected = markRejected(
      enqueue(emptyOutbox("ws1"), { path: "a.md", text: "mine", baseEtag: "e1", now: 1 }),
      "a.md",
      { code: "CONTENT_TOO_LARGE", message: "A note must be at most 2000000 bytes.", now: 2 },
    ).writes[0]!;

    const restored = restoreFor({ note: note(), pending: rejected })!;
    expect(restored.status).toBe("error");
    expect(restored.message).toContain("2000000 bytes");
  });

  test("an unsaved draft whose note has moved on is a conflict, not armed unsaved changes", () => {
    /*
      The case that would otherwise be a silent overwrite. You type, you never
      press Save, the tab closes. Meanwhile Obsidian syncs, or an AI client
      writes to the note. Restoring that draft as ordinary unsaved changes arms
      a Save over a version nobody has seen — so it comes back as the same
      choice a refused save would have offered, given before the write instead
      of after it.
    */
    const stale = restoreFor({
      note: note("what somebody else wrote", "e2"),
      draft: { path: "a.md", text: "half a thought", baseEtag: "e1", savedAt: 1 },
    })!;

    expect(stale.status).toBe("conflict");
    expect(stale.conflictEtag).toBe("e2");
    expect(stale.text).toBe("half a thought");
  });

  test("an unsaved draft on the version it was typed against is just unsaved changes", () => {
    const fresh = restoreFor({
      note: note("on the server", "e1"),
      draft: { path: "a.md", text: "half a thought", baseEtag: "e1", savedAt: 1 },
    })!;
    expect(fresh).toEqual({ text: "half a thought", status: "dirty" });
  });

  test("a draft identical to the note is not restored at all", () => {
    // Otherwise every note anybody ever typed into opens showing "unsaved
    // changes" that are the same as the file.
    expect(
      restoreFor({
        note: note("same", "e1"),
        draft: { path: "a.md", text: "same", baseEtag: "e1", savedAt: 1 },
      }),
    ).toBeUndefined();
    expect(restoreFor({ note: note() })).toBeUndefined();
  });

  test("the queue outranks a draft, because it is the later of the two", () => {
    const pending = enqueue(emptyOutbox("ws1"), {
      path: "a.md",
      text: "queued",
      baseEtag: "e1",
      now: 2,
    }).writes[0]!;

    expect(
      restoreFor({
        note: note(),
        pending,
        draft: { path: "a.md", text: "older draft", baseEtag: "e1", savedAt: 1 },
      })!.text,
    ).toBe("queued");
  });
});

/* -------------------------------------------------------------------------- */

describe("the strip, when there is a connection to report", () => {
  test("the connection and the queue come before the counts", () => {
    // Somebody who has lost signal should not have to read past a word count to
    // find that out.
    const ids = segments(opened(), {
      reachability: "offline",
      counts: { ...zero, pending: 2 },
      durable: true,
    }).map((segment) => segment.id);

    expect(ids.slice(0, 2)).toEqual(["connection", "queue"]);
    expect(ids).toContain("words");
  });

  test("a console with no offline layer under it claims nothing", () => {
    // The landing page's demo has no bucket, so it cannot be offline from one.
    const ids = segments(opened()).map((segment) => segment.id);
    expect(ids).not.toContain("connection");
    expect(ids).not.toContain("queue");
  });

  test("notes that need a person are named, not just counted", () => {
    // "2 notes need you" with no way to find out which two is a count that
    // cannot be acted on.
    const queue = byId(
      segments(opened(), {
        reachability: "online",
        counts: { ...zero, conflicted: 2 },
        durable: true,
        stuckPaths: ["1-projects/a.md", "2-areas/b.md"],
      }),
      "queue",
    )!;

    expect(queue.tone).toBe("crit");
    expect(queue.detail).toContain("1-projects/a.md, 2-areas/b.md");
  });

  test("a long list of stuck notes is a floor, never a wall of paths", () => {
    const queue = byId(
      segments(opened(), {
        reachability: "online",
        counts: { ...zero, conflicted: 5 },
        durable: true,
        stuckPaths: ["a.md", "b.md", "c.md", "d.md", "e.md"],
      }),
      "queue",
    )!;
    expect(queue.detail).toContain("a.md, b.md, c.md and 2 more.");
  });
});
