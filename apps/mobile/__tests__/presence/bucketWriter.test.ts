/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import {
  initialPresenceState,
  presenceReducer,
  savesToBucket,
  type PresenceState,
} from "../../features/console/presence/session";
import { mayPersist } from "../../features/console/presence/sharedDoc";
import { member } from "./fixtures";

describe("who actually writes the note to the bucket", () => {
  /*
    THE SEAM NOTHING CROSSED, AND IT COST EVERY SAVE IN THE PRODUCT.

    Reported by the owner: "new changes are not saved/persisted, when I refresh
    the page, or go to a page and then come back, all the new things added is
    lost."

    `electWriter` required the caller to appear in its own `members` list. The
    reducer **removes** the caller from that list — `session.ts` does it in the
    welcome branch, deliberately, because the roster is what the header counts
    as "2 here". So the guard could never be satisfied: `canWrite` was false for
    every client in every room, `mayPersist` therefore refused every change and
    every ⌘S, and the text lived in the shared document and in the room's log
    and never reached the bucket at all.

    Every test on both sides was green. The unit tests below called
    `electWriter("m2", [viewer, editor, later])` with `editor` being `m2` — a
    roster containing the caller. The browser harness built `state.members`
    from the welcome frame **unfiltered**, so it contained the caller too, and
    "exactly one browser is elected to save" passed against a roster shape the
    product never produces.

    So the checks here drive the **real reducer** with a **real welcome frame**
    and ask the question the editor asks. That is the only shape that could
    have caught this, and it is why the decision now lives in a pure function
    rather than inside the hook.
  */

  /** A room as the app builds one: a welcome through the real reducer. */
  function room(you: string, everybody: { id: string; canWrite: boolean }[]): PresenceState {
    return presenceReducer(
      { ...initialPresenceState, phase: "connecting", notePath: "a.md" },
      {
        type: "frame",
        notePath: "a.md",
        frame: {
          t: "welcome",
          you,
          members: everybody.map((one) => member({ id: one.id, canWrite: one.canWrite })),
          reconnectAfterMs: 300_000,
          heartbeatMs: 15_000,
          seed: false,
        },
      },
    );
  }

  test("somebody alone in a note saves it", () => {
    // The whole bug, in one line. A person opens a note nobody else is in,
    // types, and the text must reach the bucket.
    const alone = room("me", [{ id: "me", canWrite: true }]);
    expect(savesToBucket(alone)).toBe(true);
  });

  test("...and mayPersist agrees, which is what the editor actually calls", () => {
    // `bound` rather than the document's existence: the editor asks whether it
    // is wired to a room, not whether one was allocated. See `mayPersist`.
    const alone = room("me", [{ id: "me", canWrite: true }]);
    expect(mayPersist({ bound: true, canWrite: savesToBucket(alone) })).toBe(true);
  });

  test("exactly one of two editors saves, and it is the lower id", () => {
    const mine = room("m2", [
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]);
    const theirs = room("m9", [
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]);
    expect([savesToBucket(mine), savesToBucket(theirs)]).toEqual([true, false]);
  });

  test("a read-only viewer never saves, even alone in a room", () => {
    // The other half, and the reason the caller's own authority has to travel
    // rather than be assumed: a viewer alone would otherwise elect itself
    // against an empty field and push a draft the room refuses.
    const viewer = room("m1", [{ id: "m1", canWrite: false }]);
    expect(savesToBucket(viewer)).toBe(false);
  });

  test("...and the lowest id being a viewer does not stop the editor saving", () => {
    // A room whose lowest member id belongs to a read-only viewer used to
    // elect that viewer, and then nobody saved at all.
    const editor = room("m2", [
      { id: "m1", canWrite: false },
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]);
    expect(savesToBucket(editor)).toBe(true);
  });

  test("a client with no live room saves, exactly as it did before presence", () => {
    /*
      **Presence is never allowed to break the editor**, and this is the half
      the election quietly took away. `shared` is created the moment the hook
      runs, before any socket connects and whether or not one ever does — so
      `mayPersist`'s "no room at all" escape hatch could not fire, and a
      gateway with no presence binding, a refused socket or a dead network left
      the editor unable to save anything.

      Nobody else is coordinating in any of these states, so this client is the
      one that saves.
    */
    for (const phase of ["idle", "connecting", "unavailable", "reconnecting"] as const) {
      const state = { ...initialPresenceState, phase, notePath: "a.md" };
      expect([phase, savesToBucket(state)]).toEqual([phase, true]);
    }
  });

  /*
    THE SOCKET OPENING IS NOT THE ROOM NAMING YOU.

    `connected` fires from `live.onopen` and sets `phase: "live"` — before any
    frame, so with `you: null` and `youCanWrite: false`. `savesToBucket` then
    takes the live branch and `electWriter` refuses, because there is nobody to
    elect: this client has no id and no roster yet.

    That is the same sentence this whole change exists to delete — nobody is
    elected, so nothing is written — reached by a different route, and every
    reconnect passes through it as well as every first connect. Nobody is
    coordinating this client in that window either: the escape hatch's
    condition drifted from the state it describes, because `live` is one label
    over two different states and only one of them has an identity in it.

    The loop above could not see it: it enumerates phases against
    `initialPresenceState`, and this is a phase-and-identity pair.
  */
  test("a socket that is open but not yet welcomed still saves", () => {
    const open = presenceReducer(initialPresenceState, { type: "open", notePath: "a.md" });
    const connected = presenceReducer(open, { type: "connected" });
    expect([connected.phase, connected.you]).toEqual(["live", null]);
    expect(savesToBucket(connected)).toBe(true);
  });

  test("...and so does a reconnected socket waiting for its welcome", () => {
    const dropped = presenceReducer(room("m9", [
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]), { type: "dropped" });
    const reopened = presenceReducer(dropped, { type: "connected" });
    expect([reopened.phase, reopened.you]).toEqual(["live", null]);
    expect(savesToBucket(reopened)).toBe(true);
  });

  test("...and the welcome still hands the decision back to the election", () => {
    // The positive control: without it, "always save when live" would pass
    // both checks above and take the election away entirely.
    const viewer = room("m9", [{ id: "m2", canWrite: true }, { id: "m9", canWrite: false }]);
    expect([viewer.phase, savesToBucket(viewer)]).toEqual(["live", false]);
  });

  test("...including a reconnect that still remembers the roster", () => {
    // `dropped` keeps the members and clears `you`. Saving during the gap can
    // cost a conflict; not saving costs the work, and a conflict is the one
    // the person can see and recover from.
    const dropped = presenceReducer(room("m9", [
      { id: "m2", canWrite: true },
      { id: "m9", canWrite: true },
    ]), { type: "dropped" });
    expect(dropped.phase).toBe("reconnecting");
    expect(savesToBucket(dropped)).toBe(true);
  });
});
