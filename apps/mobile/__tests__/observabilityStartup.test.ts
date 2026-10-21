import { beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("../features/observability/runtime", () => ({
  analyticsEnvironment: () => "development", hasSentryNativeRuntime: () => false,
  createAnalyticsClient: jest.fn(),
}));
jest.mock("../features/observability/activity", () => ({ recordActivity: jest.fn() }));
jest.mock("../features/observability/preferences", () => {
  const current = { screenCounts: true, recordings: true, crashReports: false };
  return { preferences: () => current, loadPreferences: async () => current, onPreferencesChange: jest.fn() };
});

describe("events before the SDK is ready", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_fixture";
    process.env.EXPO_PUBLIC_SENTRY_DSN = "";
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = true;
  });
  function setup() {
    const calls: unknown[][] = [];
    let ready!: () => void;
    const pending = new Promise<void>((resolve) => { ready = resolve; });
    const client = {
      ready: () => pending,
      register: jest.fn(), identify: jest.fn(), reset: jest.fn(), setCapturing: jest.fn(), stopRecording: jest.fn(),
      getSessionId: () => "fixture-session",
      capture: jest.fn((name: string, properties?: unknown) => { calls.push(["event", name, properties]); }),
      screen: jest.fn((name: string) => { calls.push(["screen", name]); }),
    };
    const runtime = require("../features/observability/runtime");
    runtime.createAnalyticsClient.mockResolvedValue(client);
    const telemetry = require("../features/observability/client") as typeof import("../features/observability/client");
    const prefs = require("../features/observability/preferences");
    return { calls, ready, client, telemetry, prefs };
  }
  test("keeps screens and product events in their original order, redacted", async () => {
    const { calls, ready, telemetry } = setup();
    telemetry.trackScreen("/");
    telemetry.trackEvent("signup_submitted", { method: "phone", token: "private" });
    telemetry.trackScreen("/login");
    const started = telemetry.initObservability();
    await Promise.resolve();
    expect(calls).toEqual([]);
    ready();
    await started;
    expect(calls).toEqual([
      ["screen", "/"],
      ["event", "signup_submitted", { method: "phone", token: "[redacted]" }],
      ["screen", "/login"],
    ]);
  });
  test("a preference turned off during startup discards the queue", async () => {
    const { calls, ready, telemetry, prefs, client } = setup();
    telemetry.trackEvent("signup_submitted");
    const started = telemetry.initObservability();
    await Promise.resolve();
    prefs.preferences().screenCounts = false;
    ready();
    await started;
    expect(calls).toEqual([]);
    expect(client.setCapturing).toHaveBeenCalledWith(false);
    expect(client.stopRecording).toHaveBeenCalled();
  });
  test("logging out discards pending events from the previous account", async () => {
    const { calls, ready, telemetry, client } = setup();
    telemetry.setObservabilityUser("fixture-user");
    telemetry.trackEvent("note_save_started");
    telemetry.resetObservabilityUser();
    const started = telemetry.initObservability();
    ready();
    await started;
    expect(calls).toEqual([]);
    expect(client.identify).not.toHaveBeenCalled();
  });
  test("a vendor capture failure cannot turn a successful operation into an error", async () => {
    const { ready, telemetry, client } = setup();
    ready(); await telemetry.initObservability();
    client.capture.mockImplementation(() => { throw new Error("transport failed"); });
    expect(() => telemetry.trackEvent("signin_code_result", { result: "success" })).not.toThrow();
  });
});
