import { describe, expect, test } from "@jest/globals";
import {
  connectEscapable,
  connectProgress,
  connectProgressLabel,
  connectSettled,
} from "../features/onboarding/verify";

const idle = { submitted: false, binding: null, timedOut: false };

describe("watching a first bind settle", () => {
  test("says nothing before anything is submitted", () => {
    expect(connectProgress(idle)).toEqual({ kind: "idle" });
    expect(connectProgress({ ...idle, binding: undefined })).toEqual({ kind: "idle" });
  });

  test("the credential going up is its own stage", () => {
    expect(connectProgress({ submitted: true, binding: null, timedOut: false })).toEqual({
      kind: "binding",
    });
    expect(connectProgress({ submitted: true, binding: undefined, timedOut: false })).toEqual({
      kind: "binding",
    });
  });

  test("a written but unverified row is the probe running", () => {
    expect(
      connectProgress({ submitted: true, binding: { status: "unverified" }, timedOut: false }),
    ).toEqual({ kind: "verifying" });
  });

  test("connected is the finish line", () => {
    const state = connectProgress({
      submitted: true,
      binding: { status: "connected" },
      timedOut: false,
    });
    expect(state).toEqual({ kind: "connected" });
    expect(connectSettled(state)).toBe(true);
  });

  test("an error carries the actionable mapping, not just the provider's prose", () => {
    const state = connectProgress({
      submitted: true,
      binding: {
        status: "error",
        errorCode: "NOT_WRITABLE",
        lastError: "AccessDenied",
      },
      timedOut: false,
    });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") throw new Error("unreachable");
    expect(state.failure.headline).toMatch(/read but not written/i);
    // The provider's own words survive — often the only thing identifying
    // which policy is wrong.
    expect(state.failure.detail).toBe("AccessDenied");
  });

  test("an unknown status keeps waiting rather than guessing", () => {
    expect(
      connectProgress({ submitted: true, binding: { status: "pondering" }, timedOut: false }),
    ).toEqual({ kind: "verifying" });
  });

  test("a connected result outranks a timeout that already fired", () => {
    expect(
      connectProgress({ submitted: true, binding: { status: "connected" }, timedOut: true }),
    ).toEqual({ kind: "connected" });
  });

  test("timing out says the check is still queued, not that it failed", () => {
    const state = connectProgress({
      submitted: true,
      binding: { status: "unverified" },
      timedOut: true,
    });
    expect(state.kind).toBe("timeout");
    if (state.kind !== "timeout") throw new Error("unreachable");
    expect(state.message).toMatch(/nothing is lost/i);
  });

  test("a timeout with no row at all is still a timeout", () => {
    expect(
      connectProgress({ submitted: true, binding: null, timedOut: true }).kind,
    ).toBe("timeout");
  });
});

describe("getting past the storage step", () => {
  test("only a connected bucket counts as done", () => {
    expect(connectSettled({ kind: "verifying" })).toBe(false);
    expect(connectSettled({ kind: "failed", failure: { headline: "x" } })).toBe(false);
  });

  test("a failure or a timeout still lets somebody move on", () => {
    // Trapping a person in a credential form because their provider is slow is
    // the hostile version of careful.
    expect(connectEscapable({ kind: "timeout", message: "" })).toBe(true);
    expect(connectEscapable({ kind: "failed", failure: { headline: "x" } })).toBe(true);
  });

  test("but not while the check is genuinely still running", () => {
    expect(connectEscapable({ kind: "verifying" })).toBe(false);
    expect(connectEscapable({ kind: "binding" })).toBe(false);
  });
});

describe("the progress line", () => {
  test("the two waiting stages read differently", () => {
    expect(connectProgressLabel({ kind: "binding" })).toMatch(/credential/i);
    expect(connectProgressLabel({ kind: "verifying" })).toMatch(/list and write/i);
  });

  test("a settled state has no progress line", () => {
    expect(connectProgressLabel({ kind: "connected" })).toBeNull();
    expect(connectProgressLabel({ kind: "idle" })).toBeNull();
  });
});
