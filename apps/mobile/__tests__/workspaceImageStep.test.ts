/**
 * @jest-environment jsdom
 */

/**
 * THE NEW-WORKSPACE FLOW ASKS FOR AN IMAGE.
 *
 * Before this step a workspace could only be given an image from settings, so
 * every new one arrived drawn as its first letter. What these assert:
 *
 * 1. The step draws the same picker settings uses, so the emoji grid is there.
 * 2. A photo is offered only on a run with a verified bucket — the photo is an
 *    object in that bucket, and the button would otherwise only ever fail.
 * 3. "Skip for now" moves the flow on without choosing.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `allowPhoto` ignored by the picker                                1
 *   skip wired to nothing                                             1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
  useMutation: () => async () => undefined,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useConvex: () => undefined,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceImageStep } from "../features/workspace/steps/WorkspaceImageStep";
import type { CreateWorkspaceController } from "../features/workspace/useCreateWorkspace";
import type { WorkspaceStorageOutcome } from "../features/workspace/create";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

function render(storage: WorkspaceStorageOutcome, onContinue: () => void = () => {}) {
  const controller = {
    shape: { storage },
    created: { workspaceId: "w1", slug: "acme", displayName: "Acme" },
    continuePastImage: onContinue,
  } as unknown as CreateWorkspaceController;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(createElement(WorkspaceImageStep, { controller })));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    find: (testID: string) => container.querySelector(`[data-testid="${testID}"]`),
    text: () => container.textContent ?? "",
  };
}

describe("the image step", () => {
  test("draws the emoji grid, and a photo button where there is a bucket", () => {
    const screen = render("connected");
    expect(screen.find("workspace-icon-picker")).not.toBeNull();
    expect(screen.find("workspace-icon-photo")).not.toBeNull();
  });

  test.each(["skipped", "unverified"] as const)(
    "offers no photo when storage is %s, and says where one can be chosen",
    (storage) => {
      const screen = render(storage);
      expect(screen.find("workspace-icon-picker")).not.toBeNull();
      expect(screen.find("workspace-icon-photo")).toBeNull();
      expect(screen.text()).toMatch(/photo can be chosen from settings/i);
    },
  );

  test("skipping moves the flow on exactly once", () => {
    let moves = 0;
    const screen = render("connected", () => (moves += 1));
    const skip = screen.find("workspace-image-skip") as HTMLElement | null;
    act(() => skip?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(moves).toBe(1);
  });
});
