/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://context.lc/"}
 */

/**
 * The one panel that replaced Email, Calendar and Chats.
 *
 * Those three each drew the same Google accounts again, so two connected
 * accounts filled the Integrations page with six cards, eighteen schedule
 * buttons and three copies of Disconnect. The split was answering a real
 * question — "why isn't my mail here" — in the wrong unit: the question is
 * about mail, the *thing* is an account, and an account carries all three
 * whether or not we draw it three times.
 *
 * What this file pins:
 *
 *  1. **One list of connected things**, with the Google accounts drawn once.
 *  2. **Nothing on it is a setting** except who may send to the forwarding
 *     address, which decides who can write into somebody's bucket.
 *  3. **A workspace is never told it can connect somebody's Gmail** — it is
 *     told why, in the panel's own words.
 *  4. **The owner gates survived the merge**: connecting or removing an
 *     account, and changing who may send, are an owner's.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

jest.mock("convex/react", () => ({
  useAction: () => () =>
    Promise.resolve({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=google-state",
      completionSecret: "completion-secret",
    }),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
  useConvex: () => undefined,
  useMutation: () => async () => {
    throw new Error("no mutation should run in this harness");
  },
}));

jest.mock("../features/console/google/leaveForGoogle", () => ({
  leaveForGoogle: () => {},
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SourcesPanel } from "../features/console/settings/panels/SourcesPanel";
import type { ConsoleData } from "../features/console/types";
import type { GoogleConnection } from "../features/console/google/GoogleConnectionsCard";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

/** The demo console, with one of its contexts selected — the slug it is known by. */
function demoData(slug: string): ConsoleData {
  let latest: ConsoleData | null = null;
  function Probe() {
    latest = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  act(() => {
    latest!.selectContext(slug);
  });
  return latest!;
}

/** The demo's own names: a personal context, and a shared workspace. */
const OWNED = "seyi";
const WORKSPACE = "pw";

function personal(overrides: Partial<ConsoleData> = {}): ConsoleData {
  return { ...demoData(OWNED), ...overrides };
}

function shared(overrides: Partial<ConsoleData> = {}): ConsoleData {
  return { ...demoData(WORKSPACE), ...overrides };
}

/**
 * Mount the panel over data built first.
 *
 * `demoData` mounts a probe of its own, and building it *inside* another
 * root's render callback leaves the probe's own state unread — so the data is
 * always a value by the time the panel is asked for.
 */
function panel(data: ConsoleData): HTMLElement {
  return mount(() => createElement(SourcesPanel, { data }));
}

const CONNECTION: GoogleConnection = {
  connectionId: "google_1",
  email: "person@example.invalid",
  syncServices: { gmail: true, calendar: true, chat: true },
  syncStatus: "active",
  sync: {
    intervalMinutes: 5,
    everSynced: true,
    cursorReady: true,
    catchingUp: false,
    nextDueAt: Date.parse("2026-09-09T09:05:00.000Z"),
  },
};

describe("one list, not three panels", () => {
  test("a connected account appears once, however many services it carries", () => {
    const container = panel(personal({ googleConnections: [CONNECTION] }));
    const text = container.textContent ?? "";
    expect(text.match(/person@example\.invalid/g)).toHaveLength(1);
  });

  test("the three headings that drew it three times are gone", () => {
    const container = panel(personal({ googleConnections: [CONNECTION] }));
    const text = container.textContent ?? "";
    expect(text).toContain("Accounts we read");
    expect(text).not.toContain("Accounts we read mail from");
    expect(text).not.toContain("Accounts we read calendars from");
    expect(text).not.toContain("Accounts we read Chat from");
  });

  test("the forwarding address is on the same page, because it is the other way mail arrives", () => {
    const container = panel(personal());
    expect(container.textContent ?? "").toContain("Forwarding address");
  });
});

describe("nothing here is a setting, except who may send", () => {
  test("no destination field anywhere on the panel", () => {
    const container = panel(personal({ googleConnections: [CONNECTION] }));
    const text = container.textContent ?? "";
    expect(text).not.toContain("Where it lands");
    expect(text).not.toContain("Target folder");
  });

  test("no schedule picker, and the interval is stated once as a fact", () => {
    const container = panel(personal({ googleConnections: [CONNECTION] }));
    const text = container.textContent ?? "";
    expect(text).not.toContain("Sync schedule");
    expect(text).toContain("every five minutes");
  });

  test("no attachment policy: the choice is gone from the panel entirely", () => {
    const container = panel(personal());
    const text = container.textContent ?? "";
    expect(text).not.toContain("What happens to attachments");
    expect(text).not.toContain("Describe them only");
  });

  test("...and where mail actually arrives, the panel says what happens to them instead", () => {
    /*
      Only on a context that receives: the card deliberately says nothing about
      folders, senders or attachments while mail sent to the address bounces,
      and a sentence about attachments there would be a promise about a message
      that is never delivered.
    */
    const base = personal();
    const container = panel({
      ...base,
      ingestion: {
        ...base.ingestion,
        availability: "available",
        settings: {
          ...(base.ingestion.settings ?? { targetFolder: "0-inbox/", allowedSenders: [], allowedDomains: [], allowAnySender: false, attachmentPolicy: "metadata", address: "seyi@context.lc" }),
          receiving: true,
        },
      },
    } as ConsoleData);
    expect(container.textContent ?? "").toContain("never written to your bucket");
  });

  test("who may send stays, because it decides who can write into the bucket", () => {
    const container = panel(personal());
    expect(container.textContent ?? "").toContain("Who may send to it");
  });
});

describe("a shared workspace is told why, not offered a control", () => {
  test("it is never told it can connect a mailbox", () => {
    const container = panel(shared());
    const text = container.textContent ?? "";
    expect(text).toContain("personal workspace");
    expect(container.querySelector('[data-testid="connect-google"]')).toBeNull();
  });

  test("...and it is told it has no address of its own rather than shown an empty field", () => {
    const container = panel(shared());
    expect(container.textContent ?? "").toContain("no address of its own");
  });
});

describe("the owner gate", () => {
  test("no Google actions means no Add account at all", () => {
    const container = panel(personal({ googleConnections: [CONNECTION], googleActions: undefined }));
    expect(container.querySelector('[data-testid="connect-google"]')).toBeNull();
    expect(container.textContent ?? "").toContain("Only an owner");
  });
});
