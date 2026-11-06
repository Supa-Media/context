import { describe, expect, test } from "@jest/globals";
import { checkLine, versionLines, type RunningApp } from "../features/updates/appVersion";

/**
 * The words on Profile's "This app" card (Dev2, 2026-11-06), which say which
 * copy of the phone app is running so an update that never arrived can be
 * seen instead of guessed at.
 */
const base: RunningApp = {
  version: "1.4.0",
  build: "52",
  updatesEnabled: true,
  embedded: false,
  emergency: false,
  emergencyReason: null,
  updateId: "01a1ae79-c4d6-7be5-8fe8-bd4304f3ad30",
  createdAt: new Date(2026, 10, 6, 1, 29),
  channel: "production",
  runtimeVersion: "1.0.0",
};
const now = new Date(2026, 10, 6, 7, 0);

describe("This app", () => {
  test("a downloaded update is named by its id and time", () => {
    const lines = versionLines(base, now);
    expect(lines.app).toBe("1.4.0 (52)");
    expect(lines.update).toBe("01a1ae79 · Nov 6, 1:29 AM");
    expect(lines.detail).toBe("channel production · runtime 1.0.0");
    expect(lines.warning).toBeNull();
  });

  test("the copy built into the app says so", () => {
    expect(versionLines({ ...base, embedded: true }, now).update).toBe("Built in, no update downloaded yet");
    expect(versionLines({ ...base, updatesEnabled: false }, now).update).toBe("Built in (updates are off in this build)");
  });

  test("an update that failed to start is said out loud, with why", () => {
    const lines = versionLines({ ...base, emergency: true, emergencyReason: "launch crashed" }, now);
    expect(lines.warning).toBe("The newest update failed to start, so the app went back to an earlier copy: launch crashed");
  });

  test("an older update carries its year; missing facts are not invented", () => {
    expect(versionLines({ ...base, createdAt: new Date(2025, 0, 2, 9, 5) }, now).update).toBe("01a1ae79 · Jan 2, 2025, 9:05 AM");
    const bare = versionLines({ ...base, version: null, build: null, channel: null, runtimeVersion: null }, now);
    expect(bare.app).toBe("unknown");
    expect(bare.detail).toBe("no channel");
  });

  test("checking says where it got to", () => {
    expect(checkLine({ kind: "idle" })).toBeNull();
    expect(checkLine({ kind: "newest" })).toBe("You have the newest version.");
    expect(checkLine({ kind: "ready" })).toBe("A new version is downloaded. Restart to use it.");
    expect(checkLine({ kind: "failed", message: "offline" })).toBe("Couldn't check: offline");
  });
});
