import { describe, expect, jest, test } from "@jest/globals";
import { activityActionFor, meetingActivity } from "../features/meetings/activity";
const mockNative = {
  isAvailable: jest.fn(() => true),
  upsert: jest.fn(() => Promise.resolve()),
  end: jest.fn(() => Promise.resolve()),
  reconcile: jest.fn(() => Promise.resolve()),
};
jest.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => mockNative,
}));

describe("old-binary Live Activity fallback", () => {
  const payload = {
    meetingId: "mtg_0123456789abcdefghjk",
    title: "Design review",
    phase: "recording" as const,
    recordedMs: 4_000,
    recordingSince: 1_000,
  };

  test("is a silent no-op", () => {
    expect(meetingActivity.available()).toBe(false);
    expect(() => meetingActivity.update(payload)).not.toThrow();
    expect(() => meetingActivity.end(payload.meetingId)).not.toThrow();
    expect(() => meetingActivity.reconcile(null)).not.toThrow();
  });
});

describe("Live Activity action links", () => {
  const id = "mtg_0123456789abcdefghjk";

  test.each(["pause", "resume", "end"] as const)("allows %s for the matching live meeting", (action) => {
    expect(activityActionFor(action, id, id)).toBe(action);
  });

  test("refuses unknown, repeated, stale, and empty actions", () => {
    expect(activityActionFor("delete", id, id)).toBeNull();
    expect(activityActionFor(["pause", "end"], id, id)).toBeNull();
    expect(activityActionFor("pause", id, "mtg_someone_else")).toBeNull();
    expect(activityActionFor("pause", "", id)).toBeNull();
  });
});

describe("native bridge ordering", () => {
  test("assigns a strictly increasing generation across update and end", () => {
    const nativeActivity = require("../features/meetings/activity.native").meetingActivity;
    nativeActivity.update({
      meetingId: "mtg_0123456789abcdefghjk",
      title: "Design review",
      phase: "recording",
      recordedMs: 0,
      recordingSince: 1_000,
    });
    nativeActivity.end("mtg_0123456789abcdefghjk");
    expect(mockNative.upsert.mock.calls[0][0].generation).toBeLessThan(mockNative.end.mock.calls[0][1]);
  });
});
