import { describe, expect, jest, test } from "@jest/globals";

/**
 * Crash reports as the app's Sentry client sends them, now that feedback no
 * longer rides the same client.
 *
 * Reports go to the control plane (`features/feedback/transport.ts`, proven in
 * `feedbackTransport.test.ts`), so this client carries errors only: every one
 * is cleaned of the workspace and the note before it leaves, the crash-report
 * switch drops them, and the client offers no way to send a report at all.
 */

process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public@example.invalid/1";
// React Native's build flag; the Jest setup does not define it.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

type Processor = (event: Record<string, unknown>) => Record<string, unknown> | null;
const mockSdk = {
  options: null as null | { beforeSend: Processor },
  processors: [] as Processor[],
  feedback: [] as Array<{ params: Record<string, unknown>; hint: { attachments?: Array<{ filename: string }> }; scopeProcessors: Processor[]; tags: Record<string, string> }>,
};

jest.mock("@sentry/react-native", () => ({
  init: (options: { beforeSend: Processor }) => {
    mockSdk.options = options;
  },
  addEventProcessor: (processor: Processor) => mockSdk.processors.push(processor),
  setUser: () => {},
  flush: async () => true,
  withScope: (callback: (scope: unknown) => void) => {
    const scopeProcessors: Processor[] = [];
    const tags: Record<string, string> = {};
    callback({
      addEventProcessor: (p: Processor) => scopeProcessors.push(p),
      setTag: (key: string, value: string) => {
        tags[key] = value;
      },
      setContext: () => {},
      __scopeProcessors: scopeProcessors,
      __tags: tags,
    });
  },
  captureFeedback: (
    params: Record<string, unknown>,
    hint: { attachments?: Array<{ filename: string }> },
    scope: { __scopeProcessors: Processor[]; __tags: Record<string, string> },
  ) => {
    mockSdk.feedback.push({ params, hint, scopeProcessors: scope.__scopeProcessors, tags: scope.__tags });
    return "0123456789abcdef0123456789abcdef";
  },
}));

jest.mock("../features/offline/store", () => {
  const { memoryStore } = jest.requireActual<typeof import("../features/offline/memory")>(
    "../features/offline/memory",
  );
  const store = memoryStore();
  return { openStore: () => store };
});

const client = require("../features/observability/client") as typeof import("../features/observability/client");
// `import()` does not run under this suite's Jest, so the loader hands over
// the mocked module the way the dynamic import would.
client.sentryLoader.load = async () =>
  require("@sentry/react-native") as typeof import("@sentry/react-native");
const prefs = require("../features/observability/preferences") as typeof import("../features/observability/preferences");

describe("crash reports in Sentry", () => {
  test("an error's page URL is cleaned of the workspace and the note", async () => {
    await client.initObservability();
    const event = mockSdk.options!.beforeSend({
      message: "boom",
      request: { url: "https://context.lc/console/@seyi?note=1-projects/secret-plan.md" },
    });
    const url = String((event?.request as { url?: string }).url);
    expect(url).not.toMatch(/seyi|secret-plan/);
  });

  test("crash reports switched off drop every error", async () => {
    const beforeSend = mockSdk.options!.beforeSend;
    expect(beforeSend({ message: "boom" })).not.toBeNull();
    await prefs.setPreferences({ crashReports: false });
    expect(beforeSend({ message: "boom" })).toBeNull();
    await prefs.setPreferences({ crashReports: true });
  });

  test("feedback no longer travels through this client", () => {
    expect((client as Record<string, unknown>).sendFeedbackReport).toBeUndefined();
    expect(mockSdk.processors).toEqual([]);
    expect(mockSdk.feedback).toEqual([]);
  });
});
