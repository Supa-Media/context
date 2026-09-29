import { describe, expect, jest, test } from "@jest/globals";

/**
 * A feedback report as Sentry receives it.
 *
 * Feedback events do not pass through `beforeSend` — Sentry runs that for
 * errors only — so the cleaning every error gets had to be attached a second
 * way, and this proves it is: the page URL the web SDK stamps on every event
 * (which names the workspace and the note) is cleaned, the breadcrumb trail is
 * dropped so only the ticked log goes, and only the listed attachments travel.
 * It also proves the crash-report switch drops errors and leaves a report
 * alone, since both go through the same client.
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

describe("a feedback report reaching Sentry", () => {
  test("goes out with only the listed attachments, and answers the event id", async () => {
    const id = await client.sendFeedbackReport({
      clientReportId: "abc",
      message: "The board lost my card",
      source: "top_bar",
      screen: "/console/:context",
      activity: "14:02  opened  /console/:context",
      screenshot: { data: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" },
    });
    expect(id).toBe("0123456789abcdef0123456789abcdef");
    const sent = mockSdk.feedback.at(-1)!;
    expect(sent.hint.attachments?.map((a) => a.filename)).toEqual(["activity.txt", "screenshot.jpg"]);
    expect(sent.params).toMatchObject({ message: "The board lost my card", url: "/console/:context", source: "top_bar" });
    expect(sent.tags["feedback.client_report_id"]).toBe("abc");
  });

  test("an unticked log and a removed screenshot are not attached at all", async () => {
    await client.sendFeedbackReport({
      clientReportId: "def",
      message: "Hi",
      source: "menu",
      screen: "/console/:context",
    });
    expect(mockSdk.feedback.at(-1)!.hint.attachments).toEqual([]);
  });

  test("the breadcrumb trail is dropped from the report", async () => {
    const sent = mockSdk.feedback.at(-1)!;
    const event = sent.scopeProcessors.reduce<Record<string, unknown> | null>(
      (e, p) => (e === null ? null : p(e)),
      { type: "feedback", breadcrumbs: [{ message: "/console/:context" }] },
    );
    expect(event?.breadcrumbs).toEqual([]);
  });

  test("the page URL on the event is cleaned of the workspace and the note", () => {
    const event = mockSdk.processors.reduce<Record<string, unknown> | null>(
      (e, p) => (e === null ? null : p(e)),
      {
        type: "feedback",
        request: { url: "https://context.lc/console/@seyi?note=1-projects/secret-plan.md" },
      },
    );
    const url = String((event?.request as { url?: string }).url);
    expect(url).not.toMatch(/seyi|secret-plan/);
  });

  test("crash reports switched off drop errors, and never touch a report", async () => {
    const beforeSend = mockSdk.options!.beforeSend;
    expect(beforeSend({ message: "boom" })).not.toBeNull();
    await prefs.setPreferences({ crashReports: false });
    expect(beforeSend({ message: "boom" })).toBeNull();
    // Feedback is not an error event, so `beforeSend` is never asked about it:
    // the report still goes.
    const id = await client.sendFeedbackReport({
      clientReportId: "ghi",
      message: "Still works",
      source: "settings",
      screen: "/console/:context",
    });
    expect(id).not.toBeNull();
  });
});
