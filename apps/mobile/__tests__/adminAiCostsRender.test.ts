/**
 * @jest-environment jsdom
 */

/**
 * The console's AI costs tab, actually rendered.
 *
 *  1. **The figures reach the screen**: the four tiles, the features, the
 *     models and the accounts, from the report the section is given.
 *  2. **The Cloudflare check is honest**: the no-account rows appear only when
 *     Cloudflare is configured, and an unconfigured deployment says so.
 *  3. **The accounts list says how many it did not show**: "+ 2 more accounts".
 *  4. **An account opens**: pressing its row calls `onOpenAccount` with its id.
 *  5. **The drawer shows one account's rows** and says that nothing else is kept.
 *  6. **The tab is wired**: the AI costs tab draws the section from `AdminPane`.
 *
 * Sabotage record (temporary local edits, reverted):
 *
 *   the no-account rows added without `cloudflare.configured`          2 red (helpers + render)
 *   the "+ N more accounts" line dropped                                2 red (view + phone)
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { ReactElement } from "react";
import type { AiCostsAccount as AccountShape, AiCostsCloudflare, AiCostsReport } from "@context/convex/functions/lib/adminFns/aiCostsShape";

const mockAnswers = new Map<string, unknown>();

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never) => mockAnswers.get(getFunctionName(reference)),
    useQueries: () => ({}),
    useAction: () => async () => {
      throw new Error("not used in this test");
    },
    useMutation: () => async () => {
      throw new Error("not used in this test");
    },
  };
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AdminPane } from "../features/admin/AdminPane";
import { AiCostsAccount } from "../features/admin/AiCostsAccount";
import { AiCostsView } from "../features/admin/AiCostsView";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
});

/*
  jsdom performs no layout, so the window reports a width of zero and every
  test would land in the phone branch. Pin the width the way the app-frame
  fixtures do, and dispatch the resize that invalidates the cached value.
*/
function setWidth(px: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: px, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

const WIDE = 1280;
const PHONE = 390;

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
  return container;
}

function find(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function click(testID: string): void {
  const node = find(testID);
  if (node === null) throw new Error(`no control called ${testID}`);
  act(() => {
    node.click();
  });
}

function report(over: Partial<AiCostsReport> = {}): AiCostsReport {
  return {
    days: 30,
    since: "2026-09-09",
    totalUsd: 3.27,
    priorUsd: 1.37,
    payingAccounts: 8,
    perPayingAccountUsd: 0.24,
    textedQuestions: 412,
    perQuestionUsd: 0.0018,
    features: [
      {
        feature: "whatChanged",
        label: "What changed",
        models: ["@cf/zai-org/glm-4.7-flash"],
        uses: 640,
        unit: "new items",
        eachUsd: 0.0016,
        costUsd: 1.01,
      },
      {
        feature: "assistant",
        label: "Texting assistant (built-in model)",
        models: ["@cf/zai-org/glm-4.7-flash", "@cf/cloudflare/clef"],
        uses: 412,
        unit: "questions",
        eachUsd: 0.0018,
        costUsd: 0.75,
      },
      {
        feature: "organizer",
        label: "Auto-organize",
        models: ["@cf/cloudflare/clef"],
        uses: 398,
        unit: "notes",
        eachUsd: 0.00046,
        costUsd: 0.18,
      },
    ],
    models: [
      {
        model: "@cf/zai-org/glm-4.7-flash",
        label: "GLM-4.7 Flash",
        inputTokens: 14_400_000,
        outputTokens: 2_200_000,
        price: { input: 0.06, output: 0.4, cacheRead: 0, cacheWrite: 0 },
        costUsd: 1.75,
      },
    ],
    unrecordedModelUsd: 0.2,
    daily: [
      {
        day: "2026-10-06",
        byFeature: [
          { feature: "assistant", costUsd: 0.2 },
          { feature: "whatChanged", costUsd: 0.1 },
        ],
      },
      {
        day: "2026-10-07",
        byFeature: [
          { feature: "assistant", costUsd: 0.31 },
          { feature: "whatChanged", costUsd: 0.1 },
        ],
      },
    ],
    accounts: [
      {
        userId: "user-maya",
        email: "maya@example.invalid",
        plan: "Premium",
        workspaces: 3,
        costUsd: 0.62,
        byFeature: [
          { feature: "assistant", costUsd: 0.34 },
          { feature: "whatChanged", costUsd: 0.22 },
          { feature: "organizer", costUsd: 0.06 },
        ],
        questionsToday: 34,
        questionsCap: 100,
      },
      {
        userId: "user-jon",
        email: "jon@example.invalid",
        plan: "Premium",
        workspaces: 1,
        costUsd: 0.48,
        byFeature: [{ feature: "whatChanged", costUsd: 0.48 }],
        questionsToday: 6,
        questionsCap: 100,
      },
    ],
    moreAccounts: 2,
    truncated: false,
    ...over,
  };
}

const cloudflareOn: AiCostsCloudflare = {
  configured: true,
  error: null,
  billedUsd: 3.27,
  workersAi: [
    { model: "@cf/openai/whisper-large-v3-turbo", neurons: 9000, usd: 1.29 },
    { model: "@cf/baai/bge-m3", neurons: 60, usd: 0.04 },
  ],
  gateway: [],
};

function account(over: Partial<NonNullable<AccountShape>> = {}): AccountShape {
  return {
    userId: "user-maya",
    email: "maya@example.invalid",
    plan: "Premium",
    days: 30,
    totalUsd: 0.62,
    planUsd: 5,
    questionsTexted: 188,
    perQuestionUsd: 0.0018,
    busiestDay: { day: "2026-10-06", costUsd: 0.06 },
    today: [
      { feature: "assistant", label: "Texting assistant", used: 34, cap: 100 },
      { feature: "whatChanged", label: "What changed", used: 12, cap: 100 },
    ],
    rows: [
      { workspace: "maya", feature: "assistant", label: "Texting assistant", models: ["@cf/zai-org/glm-4.7-flash", "@cf/cloudflare/clef"], costUsd: 0.34 },
      { workspace: "maya", feature: "whatChanged", label: "What changed", models: ["@cf/zai-org/glm-4.7-flash"], costUsd: 0.15 },
      { workspace: "northwind", feature: "organizer", label: "Auto-organize", models: ["@cf/cloudflare/clef"], costUsd: 0.04 },
    ],
    ...over,
  };
}

describe("the AI costs view, wide", () => {
  beforeEach(() => setWidth(WIDE));

  test("the tiles, the features, the models and the accounts reach the screen", () => {
    const container = mount(createElement(AiCostsView, { report: report(), cloudflare: undefined, onOpenAccount: () => {} }));
    expect(find("admin-ai-costs")).not.toBeNull();
    expect(find("ai-costs-tile-spent")?.textContent).toContain("$3.27");
    expect(find("ai-costs-tile-spent")?.textContent).toContain("+$1.90 vs the 30 days before");
    expect(find("ai-costs-tile-per-account")?.textContent).toContain("$0.24");
    expect(find("ai-costs-tile-top-feature")?.textContent).toContain("What changed");
    expect(find("ai-costs-tile-per-question")?.textContent).toContain("$0.0018");
    expect(find("ai-costs-feature-assistant")?.textContent).toContain("Texting assistant");
    expect(find("ai-costs-model-@cf/zai-org/glm-4.7-flash")?.textContent).toContain("GLM-4.7 Flash");
    expect(find("ai-costs-model-unrecorded")?.textContent).toContain("Before models were recorded");
    expect(find("ai-costs-model-unrecorded")?.textContent).toContain("$0.20");
    expect(container.textContent).toContain("Spent on AI");
    expect(find("ai-costs-account-user-maya")?.textContent).toContain("maya@example.invalid");
    expect(find("ai-costs-days")).not.toBeNull();
  });

  test("the no-account rows appear with Cloudflare configured", () => {
    mount(createElement(AiCostsView, { report: report(), cloudflare: cloudflareOn, onOpenAccount: () => {} }));
    expect(find("ai-costs-no-account-transcription")?.textContent).toBe("no account");
    expect(find("ai-costs-no-account-meaning")?.textContent).toBe("no account");
    expect(find("ai-costs-check")?.textContent).toContain("billed $3.27");
    expect(find("ai-costs-not-linked")?.textContent).toContain("$1.33 not linked to an account");
  });

  test("without Cloudflare there is no no-account row, and the strip says it is not connected", () => {
    mount(
      createElement(AiCostsView, {
        report: report(),
        cloudflare: { configured: false },
        onOpenAccount: () => {},
      }),
    );
    expect(find("ai-costs-no-account-transcription")).toBeNull();
    expect(find("ai-costs-no-account-meaning")).toBeNull();
    expect(find("ai-costs-check")?.textContent).toContain("Cloudflare's own count isn't connected yet");
  });

  test("the accounts list says how many it did not show", () => {
    mount(createElement(AiCostsView, { report: report(), cloudflare: undefined, onOpenAccount: () => {} }));
    expect(find("ai-costs-more-accounts")?.textContent).toBe("+ 2 more accounts");
  });

  test("pressing an account opens it by its id", () => {
    const onOpenAccount = jest.fn<(userId: string) => void>();
    mount(createElement(AiCostsView, { report: report(), cloudflare: undefined, onOpenAccount }));
    click("ai-costs-account-user-jon");
    expect(onOpenAccount).toHaveBeenCalledWith("user-jon");
  });

  test("the loading state draws skeletons, not figures", () => {
    const container = mount(createElement(AiCostsView, { report: undefined, cloudflare: undefined, onOpenAccount: () => {} }));
    expect(find("admin-ai-costs-loading")).not.toBeNull();
    expect(container.textContent).not.toContain("Spent on AI");
  });
});

describe("the AI costs view, on a phone", () => {
  beforeEach(() => setWidth(PHONE));

  test("the tiles and the two plain lists, with no daily bars and no model table", () => {
    mount(createElement(AiCostsView, { report: report(), cloudflare: cloudflareOn, onOpenAccount: () => {} }));
    expect(find("ai-costs-tile-spent")).not.toBeNull();
    expect(find("ai-costs-feature-whatChanged")).not.toBeNull();
    expect(find("ai-costs-no-account-transcription")).not.toBeNull();
    expect(find("ai-costs-days")).toBeNull();
    expect(find("ai-costs-models")).toBeNull();
    expect(find("ai-costs-more-accounts")?.textContent).toBe("+ 2 more accounts");
  });

  test("an account opens from its row", () => {
    const onOpenAccount = jest.fn<(userId: string) => void>();
    mount(createElement(AiCostsView, { report: report(), cloudflare: undefined, onOpenAccount }));
    click("ai-costs-account-user-maya");
    expect(onOpenAccount).toHaveBeenCalledWith("user-maya");
  });
});

describe("the account drawer", () => {
  test("on a pointer it draws the figures, the workspaces and the promise about what is kept", () => {
    setWidth(WIDE);
    const onClose = jest.fn<() => void>();
    const container = mount(createElement(AiCostsAccount, { account: account(), onClose }));
    expect(find("ai-costs-drawer")).not.toBeNull();
    expect(find("ai-costs-drawer-spent")?.textContent).toContain("$0.62");
    expect(find("ai-costs-drawer-spent")?.textContent).toContain("12% of the $5 plan");
    expect(find("ai-costs-drawer-questions")?.textContent).toContain("188");
    expect(find("ai-costs-drawer-busiest")?.textContent).toContain("6 Oct");
    expect(find("ai-costs-drawer-today")?.textContent).toContain("Texting assistant today: 34 of 100 questions");
    expect(find("ai-costs-drawer-row-0")?.textContent).toContain("@maya");
    expect(find("ai-costs-drawer-row-2")?.textContent).toContain("@northwind");
    expect(container.textContent).toContain("Numbers only. No question, answer or note is kept for this page.");
    click("ai-costs-drawer-close");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("on a phone it is the whole screen, with a back control", () => {
    setWidth(PHONE);
    const onClose = jest.fn<() => void>();
    mount(createElement(AiCostsAccount, { account: account(), onClose }));
    expect(find("ai-costs-drawer-close")).toBeNull();
    expect(find("ai-costs-drawer-row-0")?.textContent).toContain("@maya");
    click("ai-costs-drawer-back");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("an account that cannot be found says so", () => {
    setWidth(WIDE);
    const onClose = jest.fn<() => void>();
    const container = mount(createElement(AiCostsAccount, { account: null, onClose }));
    expect(container.textContent).toContain("Account not found");
  });
});

describe("the tab", () => {
  test("the AI costs tab draws its section, waiting for the data", () => {
    mockAnswers.set("functions/admin:amIAdmin", true);
    mockAnswers.set("functions/admin:listSecrets", []);
    mount(createElement(AdminPane));
    click("admin-tab-aiCosts");
    expect(find("admin-ai-costs-section")).not.toBeNull();
    expect(find("admin-ai-costs-loading")).not.toBeNull();
  });
});
