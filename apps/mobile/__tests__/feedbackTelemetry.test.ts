import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * The telemetry half of in-app feedback: the activity log a report may carry,
 * and the Feedback & diagnostics switches.
 *
 * The log is only what already went to the vendors, already cleaned — never an
 * error's message, which can quote whatever the failing code held. The switches
 * default on (the early-beta notice says so) and a stored value that will not
 * parse never turns one off by accident.
 */

jest.mock("../features/offline/store", () => {
  const { memoryStore } = jest.requireActual<typeof import("../features/offline/memory")>(
    "../features/offline/memory",
  );
  const store = memoryStore();
  return { openStore: () => store };
});

const activity = require("../features/observability/activity") as typeof import("../features/observability/activity");
const prefs = require("../features/observability/preferences") as typeof import("../features/observability/preferences");
const client = require("../features/observability/client") as typeof import("../features/observability/client");

beforeEach(() => {
  activity.resetActivityForTests();
  prefs.resetPreferencesForTests();
});

describe("the activity log a report can carry", () => {
  test("keeps the last ten minutes, and one line per visit", () => {
    const t0 = new Date(2026, 8, 29, 14, 0).getTime();
    activity.recordActivity("screen", "/console/:context", t0);
    activity.recordActivity("screen", "/console/:context", t0 + 1000);
    activity.recordActivity("screen", "/console/:context/settings", t0 + 11 * 60_000);
    const recent = activity.recentActivity(t0 + 12 * 60_000);
    expect(recent.map((entry) => entry.text)).toEqual(["/console/:context/settings"]);
    expect(activity.formatActivity(recent)).toBe("14:11  opened  /console/:context/settings");
  });

  test("screens are logged as cleaned routes, never a note's address", () => {
    client.trackScreen("/console/@seyi/1-projects/launch-plan.md");
    client.trackScreen("/note/@seyi/1-projects/secret.md");
    const text = activity.formatActivity(activity.recentActivity());
    expect(text).not.toMatch(/seyi|launch-plan|secret/);
    expect(text).toContain("/console/:context");
  });

  test("an error is logged by its class name, never its message", () => {
    const error = new TypeError("cannot read 'Secret plan' of undefined at seyi@example.com");
    client.reportError(error);
    const text = activity.formatActivity(activity.recentActivity());
    expect(text).toContain("TypeError");
    expect(text).not.toMatch(/Secret|seyi|example/);
  });

  test("a made-up error name is not trusted either", () => {
    const error = new Error("boom");
    error.name = "Note: Secret plan";
    client.reportError(error);
    expect(activity.formatActivity(activity.recentActivity())).not.toContain("Secret");
  });
});

describe("the Feedback & diagnostics switches", () => {
  test("everything is on until somebody turns it off", async () => {
    expect(await prefs.loadPreferences()).toEqual({ crashReports: true, screenCounts: true, recordings: true });
  });

  test("a switch turned off stays off across a reload", async () => {
    await prefs.setPreferences({ recordings: false });
    prefs.resetPreferencesForTests();
    expect((await prefs.loadPreferences()).recordings).toBe(false);
  });

  test("an unreadable stored value falls back per switch, never to off", () => {
    expect(prefs.parsePreferences("{not json")).toEqual(prefs.DEFAULT_PREFERENCES);
    expect(prefs.parsePreferences('{"crashReports":"no","screenCounts":false}')).toEqual({
      crashReports: true,
      screenCounts: false,
      recordings: true,
    });
  });
});
