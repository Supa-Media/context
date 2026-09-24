/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import {
  initialPresenceState,
  presenceReducer,
  presenceSummary,
  reconnectDelayMs,
} from "../../features/console/presence/session";
import { member, live, at } from "./fixtures";

describe("the presence state machine", () => {
  test("a frame for another note is dropped", () => {
    // The failure this guard exists for: a socket opened for a.md delivering
    // after b.md was opened, painting b.md with a.md's offsets.
    const state = live([member()]);
    const next = presenceReducer(state, {
      type: "frame",
      notePath: "b.md",
      frame: { t: "leave", id: "m1" },
    });
    expect(next).toBe(state);
    expect(next.members).toHaveLength(1);
  });

  test("opening a different note keeps nothing from the last one", () => {
    const next = presenceReducer(live([member()]), { type: "open", notePath: "b.md" });
    expect(next.members).toEqual([]);
    expect(next.you).toBeNull();
    expect(next.notePath).toBe("b.md");
    expect(next.phase).toBe("connecting");
  });

  test("a welcome replaces the roster and leaves yourself out of it", () => {
    const next = presenceReducer(
      { ...initialPresenceState, phase: "connecting", notePath: "a.md" },
      {
        type: "frame",
        notePath: "a.md",
        frame: {
          t: "welcome",
          you: "me",
          members: [member({ id: "me" }), member({ id: "m2" })],
          reconnectAfterMs: 300_000,
          heartbeatMs: 15_000,
          seed: false,
        },
      },
    );
    expect(next.members.map((one) => one.id)).toEqual(["m2"]);
    expect(next.phase).toBe("live");
  });

  test("a join for an id already present replaces rather than duplicates", () => {
    const next = presenceReducer(live([member({ id: "m2", head: at(4) })]), {
      type: "frame",
      notePath: "a.md",
      frame: { t: "join", member: member({ id: "m2", head: at(9) }) },
    });
    expect(next.members).toHaveLength(1);
    expect(next.members[0].head).toBe(at(9));
  });

  test("a cursor for somebody not in the roster is dropped", () => {
    // Otherwise it becomes a nameless, colourless caret: a rendering bug
    // wearing a person's clothes.
    const state = live([member({ id: "m2" })]);
    const next = presenceReducer(state, {
      type: "frame",
      notePath: "a.md",
      frame: { t: "cursor", id: "ghost", anchor: at(1), head: at(2) },
    });
    expect(next).toBe(state);
  });

  test("a drop keeps the roster but stops the carets being drawn", () => {
    // A reconnect happens every five minutes by design. Emptying the header
    // each time would make everybody blink; drawing stale offsets would put
    // carets in the wrong place.
    const next = presenceReducer(live([member({ id: "m2" })]), { type: "dropped" });
    expect(next.phase).toBe("reconnecting");
    expect(next.members).toHaveLength(1);
    expect(next.stale).toBe(true);
    expect(next.you).toBeNull();
  });

  test("unavailable is terminal and cannot be talked back out of", () => {
    const dead = presenceReducer(live([member()]), { type: "unavailable" });
    expect(dead.phase).toBe("unavailable");
    expect(dead.members).toEqual([]);
    expect(presenceReducer(dead, { type: "connected" }).phase).toBe("unavailable");
    expect(
      presenceReducer(dead, {
        type: "frame",
        notePath: dead.notePath as string,
        frame: { t: "join", member: member() },
      }).members,
    ).toEqual([]);
  });

  test("the backoff is fast once and then bounded", () => {
    expect(reconnectDelayMs(1)).toBe(250);
    expect(reconnectDelayMs(4)).toBe(2_000);
    // A console left open overnight against a gateway that is down must not be
    // retrying every second by morning.
    expect(reconnectDelayMs(40)).toBe(30_000);
  });

  test("the header says nothing when there is nothing to say", () => {
    expect(presenceSummary(live([]))).toBe("");
    expect(presenceSummary(live([member()]))).toBe("1 here");
    expect(presenceSummary(live([member({ id: "a" }), member({ id: "b" })]))).toBe("2 here");
    expect(presenceSummary({ ...live([member()]), phase: "reconnecting" })).toBe("Reconnecting");
  });
});
