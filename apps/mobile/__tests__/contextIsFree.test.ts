/**
 * @jest-environment jsdom
 */

/**
 * CONTEXT IS FREE (decided by the owner, 2026-10-20).
 *
 * `billing.status` answers `free: true`, and with that answer no screen draws a
 * plan, a price, a note limit or a fast-search switch. Each case here mounts
 * the real component against a control plane that says so, and the Plan row
 * case also mounts it against one that sells, so the assertion is proved to
 * be about `free` rather than about a row that never renders.
 *
 * The priced path is dormant rather than deleted: `premium*.test.ts` keep
 * driving it with `free: false` fixtures.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

let mockBilling: unknown = null;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useConvex: () => ({ mutation: async () => ({}), action: async () => ({}), query: async () => null }),
    useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
    useMutation: () => async () => ({}),
    useAction: () => async () => ({}),
    useQuery: () => undefined,
    useQueries: (spec: Record<string, { query: unknown }>) => {
      const out: Record<string, unknown> = {};
      for (const [key, request] of Object.entries(spec)) {
        out[key] =
          getFunctionName(request.query as never) === "functions/billing:status" ? mockBilling : undefined;
      }
      return out;
    },
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { Platform } from "react-native";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SettingsOverlay } from "../features/console/settings/SettingsOverlay";
import { SettingsStorageChoice } from "../features/console/storage/SettingsStorageChoice";
import { FreeTierNudge } from "../features/console/settings/panels/FreeTierNudge";
import { ManagedSettling } from "../features/onboarding/steps/ManagedSettling";
import { noteLimitFrom } from "../features/console/noteLimit";
import { isSelling } from "../features/console/settings/panels/selling";
import type { ConsoleData } from "../features/console/types";
import type { PremiumStatus } from "../features/console/settings/panels/premium";

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

/** A free context on a bucket we run, carrying every field a stale status could still send. */
function status(over: Partial<PremiumStatus> = {}): PremiumStatus {
  return {
    free: true,
    status: "none",
    selected: { managedStorage: false, fastSearch: false },
    active: { managedStorage: false, fastSearch: false },
    canManage: true,
    configured: false,
    priceCents: 500,
    currency: "usd",
    interval: "month",
    ceilingBytes: 50_000_000_000,
    storageIsManaged: false,
    managedStorageAvailable: true,
    freeManagedAvailable: true,
    freeManagedEligible: true,
    freeManagedNoteCap: 1000,
    noteCap: 1000,
    notes: 990,
    ...over,
  };
}

/** The demo console's data, as a signed-in console with a client behind it. */
function liveData(over: Partial<ConsoleData> = {}): ConsoleData {
  let data: ConsoleData | null = null;
  function Probe() {
    data = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  if (data === null) throw new Error("the demo console did not resolve");
  return { ...(data as ConsoleData), demo: false, ...over };
}

const MONEY = /\$\d|Premium|Upgrade|free plan|both plans|Founding|1,000 notes|after you cancel/i;

test("only an explicit free: false sells: in flight and an older control plane do not", () => {
  expect(isSelling(null)).toBe(false);
  expect(isSelling({})).toBe(false);
  expect(isSelling({ free: true })).toBe(false);
  expect(isSelling({ free: false })).toBe(true);
});

describe("Settings, while Context is free", () => {
  test.each([
    [true, false],
    [false, true],
  ])("free: %p lists the Plan row: %p", (free, listed) => {
    mockBilling = status({ free });
    const data = liveData();
    mount(() =>
      createElement(SettingsOverlay, {
        data,
        section: "workspace",
        startOnList: true,
        onSelect: () => {},
        onDismiss: () => {},
      }),
    );
    expect(document.body.querySelector('[data-testid="settings-section-storage"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="settings-section-premium"]') !== null).toBe(listed);
  });

  test("a stale ?settings=premium lands on General, not on a plan", () => {
    mockBilling = status();
    const data = liveData();
    mount(() =>
      createElement(SettingsOverlay, { data, section: "premium", onSelect: () => {}, onDismiss: () => {} }),
    );
    expect(document.body.querySelector('[data-testid="premium-title"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(MONEY);
  });

  test("Storage has no fast-search switch, even for an owner whose index is off", () => {
    mockBilling = status();
    const data = liveData({ fastSearch: { status: { state: "off", canChange: true }, loading: false } });
    mount(() =>
      createElement(SettingsOverlay, { data, section: "storage", onSelect: () => {}, onDismiss: () => {} }),
    );
    const body = document.body.textContent ?? "";
    expect(body).toContain("Download everything");
    expect(body).not.toMatch(/Fast search|Turn it on|search index/i);
    expect(document.body.querySelector('[data-testid="fast-search-enable"]')).toBeNull();
    expect(body).not.toMatch(MONEY);
  });
});

describe("choosing storage, while Context is free", () => {
  test.each(["web", "ios", "android"] as const)("%s offers storage we run first, with no price", (os) => {
    const before = Platform.OS;
    Object.defineProperty(Platform, "OS", { configurable: true, value: os });
    try {
      mockBilling = status();
      const root = mount(() =>
        createElement(SettingsStorageChoice, {
          workspaceId: "w1",
          contextName: "@seyi",
          connect: async () => ({ status: "ok" }),
        }),
      );
      const cards = [...root.querySelectorAll('[data-testid^="choose-"]')].map((card) =>
        card.getAttribute("data-testid"),
      );
      expect(cards).toEqual(["choose-ours", "choose-own-storage"]);
      expect(root.textContent).toContain("Storage we run");
      expect(root.textContent).not.toMatch(MONEY);
    } finally {
      Object.defineProperty(Platform, "OS", { configurable: true, value: before });
    }
  });

  test("the priced card comes back only where the deployment sells", () => {
    mockBilling = status({ free: false, freeManagedEligible: false });
    const root = mount(() =>
      createElement(SettingsStorageChoice, {
        workspaceId: "w1",
        contextName: "@seyi",
        connect: async () => ({ status: "ok" }),
      }),
    );
    expect(root.querySelector('[data-testid="choose-managed"]')).not.toBeNull();
  });

  test("setting up says nothing about money", () => {
    const root = mount(() =>
      createElement(ManagedSettling, {
        state: { paid: false, free: true, storageReady: false, slow: false },
        contextName: "@seyi",
        onUseOwnStorage: () => {},
        onRetry: () => {},
      }),
    );
    expect(root.textContent).toContain("Creating your bucket");
    expect(root.textContent).not.toMatch(/Free|no card|Paid|payment/i);
  });
});

describe("no note limit, while Context is free", () => {
  test("a stale cap and a full count draw no chip", () => {
    expect(noteLimitFrom(status())).toBeNull();
    expect(noteLimitFrom(status({ free: false }))).toEqual({ used: 990, cap: 1000, full: false });
  });

  test("and no nudge", () => {
    const root = mount(() => createElement(FreeTierNudge, { status: status({ notes: 1000 }), onLevelUp: () => {} }));
    expect(root.textContent).toBe("");
  });
});

describe("the exit promise, said without a plan", () => {
  /*
    The promise stays (non-negotiable #1) and loses its plans: "free, always"
    or "any time", never "on every plan" or "after you cancel".
  */
  const read = (path: string) => require("node:fs").readFileSync(require("node:path").join(__dirname, "..", path), "utf8") as string;
  const OLD = /every plan|both plans|after you cancel|free plan|1,000 notes|free bucket/;

  test.each([
    ["features/console/storage/handoff/copy.ts", "Free, always."],
    ["features/console/setupWidget/SetupDone.tsx", "If we run your storage, you can move every file to a bucket of your own"],
    ["features/legal/content.ts", "use Download everything in Settings. It is free, always."],
    ["features/landing/variants.web.tsx", "Either way you can download everything, any time, for free."],
    ["features/onboarding/steps/PointAtBucket.tsx", "Start on a bucket we run instead"],
  ])("%s", (path, sentence) => {
    const source = read(path);
    expect(source).toContain(sentence);
    expect(source).not.toMatch(OLD);
  });
});
