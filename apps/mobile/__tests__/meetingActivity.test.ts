import { describe, expect, jest, test } from "@jest/globals";
import { activityActionFor, meetingActivity } from "../features/meetings/activity";
import fs from "node:fs";
import path from "node:path";
const mockNative = {
  isAvailable: jest.fn(() => true),
  upsert: jest.fn<(_payload: { generation: number }) => Promise<void>>(() => Promise.resolve()),
  end: jest.fn<(_meetingId: string, _generation: number) => Promise<void>>(() => Promise.resolve()),
  reconcile: jest.fn<(_meetingId: string | null, _generation: number) => Promise<void>>(
    () => Promise.resolve(),
  ),
};
jest.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => mockNative,
}));

describe("old-binary Live Activity fallback", () => {
  const payload = {
    meetingId: "mtg_0123456789abcdefghjk",
    controlToken: "ab".repeat(32),
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
  const token = "ab".repeat(32);

  test.each(["pause", "resume", "end"] as const)("allows %s for the matching live meeting", (action) => {
    expect(activityActionFor(action, id, id, token)).toBe(action);
  });

  test("refuses unknown, repeated, stale, and empty actions", () => {
    expect(activityActionFor("delete", id, id, token)).toBeNull();
    expect(activityActionFor(["pause", "end"], id, id, token)).toBeNull();
    expect(activityActionFor("pause", id, "mtg_someone_else", token)).toBeNull();
    expect(activityActionFor("pause", "", id, token)).toBeNull();
    expect(activityActionFor("pause", id, id, undefined)).toBeNull();
    expect(activityActionFor("pause", id, id, "guessable")).toBeNull();
  });
});

describe("native bridge ordering", () => {
  test("assigns a strictly increasing generation across update and end", () => {
    const nativeActivity = require("../features/meetings/activity.native").meetingActivity;
    nativeActivity.update({
      meetingId: "mtg_0123456789abcdefghjk",
      controlToken: "cd".repeat(32),
      title: "Design review",
      phase: "recording",
      recordedMs: 0,
      recordingSince: 1_000,
    });
    nativeActivity.end("mtg_0123456789abcdefghjk");
    expect(mockNative.upsert.mock.calls[0][0].generation).toBeLessThan(mockNative.end.mock.calls[0][1]);
  });
});


describe("native lifecycle race guards", () => {
  test("queues ActivityKit mutations and guards every reentrant await before snapshot mutation", () => {
    const source = fs.readFileSync(path.join(
      __dirname,
      "..", "modules", "context-activity-kit", "ios", "ContextActivityKitModule.swift",
    ), "utf8");
    expect(source).toContain("private var tail: Task<Void, Never>?");
    expect(source).toMatch(/await keeper\.update\(using: state\)\s+guard isCurrent\(generation\)/);
    expect(source).toMatch(/await duplicate\.end\(dismissalPolicy: \.immediate\)\s+guard isCurrent\(generation\)/);
    expect(source).toMatch(/await activity\.end\(dismissalPolicy: \.immediate\)\s+guard isCurrent\(generation\)/);
    expect(source).not.toMatch(/await self\.coordinator\.end[^]*\n\s*Self\.clearWidgetRecording/);
  });

  test("embeds the one-use token in every recorder action URL", () => {
    const source = fs.readFileSync(path.join(
      __dirname, "..", "targets", "context-widgets", "ContextMeetingLiveActivity.swift",
    ), "utf8");
    expect(source).toContain('URLQueryItem(name: "controlToken", value: controlToken)');
    expect(source.match(/actionURL\([^\n]+controlToken: context\.state\.controlToken/g)).toHaveLength(4);
  });

  test("the app route consumes the capability before dispatching recorder controls", () => {
    const source = fs.readFileSync(path.join(
      __dirname, "..", "app", "(app)", "meetings", "[id].tsx",
    ), "utf8");
    const consume = source.indexOf("meetings.consumeActivityControl(meetingId, token)");
    expect(consume).toBeGreaterThan(0);
    expect(source.indexOf("meetings.pause()", consume)).toBeGreaterThan(consume);
    expect(source.indexOf("meetings.resume()", consume)).toBeGreaterThan(consume);
    expect(source.indexOf("meetings.end()", consume)).toBeGreaterThan(consume);
  });
});
