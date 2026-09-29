/**
 * @jest-environment jsdom
 */

/**
 * The Estate tab's encryption card, actually rendered.
 *
 * `managedEncryptionCard.test.ts` holds the words; these hold the claims the
 * card makes as a screen:
 *
 *  1. **A failed read is a sentence, not an unmounted tab.** The status comes
 *     through `useQueries`, and an `Error` there draws "Couldn't load".
 *  2. **Start opens the scope dialog with ours selected** and the button
 *     saying how many; pressing it sends that scope.
 *  3. **Pause asks for a reason** and sends nothing without one.
 *  4. **A failed workspace has its own Retry**, which retries that workspace.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockCalls: { name: string; args: Record<string, unknown> }[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  const callable = (reference: never) => async (args: Record<string, unknown>) => {
    mockCalls.push({ name: getFunctionName(reference), args });
    return null;
  };
  return {
    useQuery: (reference: never) => mockAnswers.get(getFunctionName(reference)),
    useQueries: (spec: Record<string, { query: never }>) =>
      Object.fromEntries(
        Object.entries(spec).map(([key, request]) => [key, mockAnswers.get(getFunctionName(request.query))]),
      ),
    useMutation: callable,
    useAction: callable,
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EncryptionCard } from "../features/admin/EncryptionCard";

const STATUS = "functions/managedEncryption:rolloutStatus";
const CANDIDATES = "functions/managedEncryption:rolloutCandidates";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockCalls.length = 0;
});

function mount(): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(EncryptionCard)));
}

function find(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function text(testID: string): string {
  return find(testID)?.textContent ?? "";
}

async function click(testID: string): Promise<void> {
  const node = find(testID);
  if (node === null) throw new Error(`no control called ${testID}`);
  await act(async () => {
    node.click();
  });
}

function type(testID: string, value: string): void {
  const field = find(testID);
  if (field === null) throw new Error(`no field called ${testID}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function status(over: Record<string, unknown> = {}) {
  return {
    state: "off",
    managedTotal: 4,
    counts: { waiting: 0, encrypting: 0, checking: 0, encrypted: 0, failed: 0, notStarted: 4 },
    files: { done: 0, total: 0 },
    workspaces: [],
    ...over,
  };
}

describe("the encryption card", () => {
  test("loading, then couldn't load", () => {
    mount();
    expect(find("admin-encryption-loading")).not.toBeNull();
    roots.pop()!();
    mockAnswers.set(STATUS, new Error("boom"));
    mount();
    expect(text("admin-encryption-error")).toBe(
      "Couldn't load the rollout. Workspaces carry on as they were.",
    );
    expect(find("admin-encryption-retry-load")).not.toBeNull();
  });

  test("off: Start opens the dialog with ours first, and starts with that scope", async () => {
    mockAnswers.set(STATUS, status());
    mockAnswers.set(CANDIDATES, [
      { workspaceId: "a", slug: "context-lc", ours: true },
      { workspaceId: "b", slug: "jon", ours: false },
      { workspaceId: "c", slug: "seyi", ours: true },
      { workspaceId: "d", slug: "supa", ours: true },
    ]);
    mount();
    expect(text("admin-encryption-state")).toBe("Off");
    await click("admin-encryption-start");
    expect(find("admin-encryption-start-dialog") ?? find("admin-encryption-start")).not.toBeNull();
    expect(text("admin-encryption-start-confirm")).toBe("Start with 3");
    await click("admin-encryption-start-confirm");
    expect(mockCalls).toEqual([{ name: "functions/managedEncryption:startRollout", args: { scope: "ours" } }]);
  });

  test("running: Pause asks for a reason and sends it", async () => {
    mockAnswers.set(
      STATUS,
      status({
        state: "running",
        scope: "all",
        counts: { waiting: 1, encrypting: 1, checking: 0, encrypted: 2, failed: 0, notStarted: 0 },
        files: { done: 10, total: 20 },
        workspaces: [{ workspaceId: "a", slug: "northwind", state: "encrypting", filesDone: 10, filesTotal: 20, updatedAt: 0 }],
      }),
    );
    mount();
    expect(text("admin-encryption-state")).toBe("Running");
    expect(text("admin-encryption-workspaces")).toContain("@northwind");
    await click("admin-encryption-pause");
    expect(find("admin-encryption-pause-confirm")?.getAttribute("aria-disabled")).toBe("true");
    await click("admin-encryption-pause-confirm");
    expect(mockCalls).toEqual([]);
    type("admin-encryption-pause-reason", "checking read times");
    await click("admin-encryption-pause-confirm");
    expect(mockCalls).toEqual([
      { name: "functions/managedEncryption:pauseRollout", args: { reason: "checking read times" } },
    ]);
  });

  test("failed: Retry for that workspace, and Resume the others", async () => {
    mockAnswers.set(
      STATUS,
      status({
        state: "failed",
        counts: { waiting: 1, encrypting: 0, checking: 0, encrypted: 2, failed: 1, notStarted: 0 },
        workspaces: [
          { workspaceId: "w-north", slug: "northwind", state: "failed", filesDone: 5, filesTotal: 9, errorCode: "WALK_FAILED", updatedAt: 0 },
        ],
      }),
    );
    mount();
    expect(text("admin-encryption-state")).toBe("Failed check");
    await click("admin-encryption-retry-northwind");
    expect(mockCalls).toEqual([
      { name: "functions/managedEncryption:retryWorkspace", args: { workspaceId: "w-north" } },
    ]);
    expect(text("admin-encryption-resumeOthers")).toBe("Resume the others");
  });

  test("complete: stopping new workspaces asks first", async () => {
    mockAnswers.set(
      STATUS,
      status({
        state: "complete",
        acceptsNew: true,
        counts: { waiting: 0, encrypting: 0, checking: 0, encrypted: 4, failed: 0, notStarted: 0 },
      }),
    );
    mount();
    await click("admin-encryption-stopNew");
    expect(mockCalls).toEqual([]);
    expect(find("admin-encryption-stop-confirm")).not.toBeNull();
    await click("admin-encryption-stop");
    expect(mockCalls).toEqual([{ name: "functions/managedEncryption:stopStartingNew", args: {} }]);
  });
});
