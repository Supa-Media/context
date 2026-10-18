import { describe, expect, test } from "@jest/globals";
import { findSession } from "../../features/meetings/controller";
import { withSelf } from "../../features/meetings/controller/lifecycle";
import { ownName } from "../../features/meetings/useMeetings";
import { harness } from "./fixtures";

/**
 * THE PERSON RECORDING IS ON THEIR OWN MEETING (board m5, owner 2026-10-17).
 *
 * Their attendee row (`self: true`) is how a two-sided call's transcript names
 * the microphone's lines, so every meeting starts with it when the name is
 * known, and never with a blank or doubled one.
 *
 * ## Sabotage record
 *
 *  - `withSelf` returning `attendees` unchanged: "a meeting starts with the
 *    person recording it" fails.
 */

describe("the recorder's own row", () => {
  test("a meeting starts with the person recording it", async () => {
    const { controller } = await harness({ selfName: () => "Sam Rivers" });
    const id = await controller.start({ title: "Onboarding" });
    expect(findSession(controller.getSnapshot(), id)?.attendees).toEqual([{ name: "Sam Rivers", self: true }]);
  });

  test("no name yet, no row", async () => {
    const { controller } = await harness({ selfName: () => null });
    const id = await controller.start({ title: "Onboarding" });
    expect(findSession(controller.getSnapshot(), id)?.attendees).toEqual([]);
  });

  test("never blank, never twice, and the caller's own rows are kept", () => {
    expect(withSelf(undefined, "  ")).toBeUndefined();
    expect(withSelf([{ name: "Me", self: true }], "Sam")).toEqual([{ name: "Me", self: true }]);
    expect(withSelf([{ name: "Zay" }], "Sam\nRivers")).toEqual([
      { name: "Sam Rivers", self: true },
      { name: "Zay" },
    ]);
  });

  test("the name is the person's own workspace's, not one they were invited to", () => {
    expect(
      ownName([
        { kind: "shared", role: "owner", displayName: "Leadership" },
        { kind: "personal", role: "member", displayName: "Someone Else" },
        { kind: "personal", role: "owner", displayName: " Sam Rivers " },
      ]),
    ).toBe("Sam Rivers");
    expect(ownName([])).toBeNull();
  });
});
