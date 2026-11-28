/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * "How did you hear about us?" on the handle screen (`features/onboarding/steps/HeardChips.tsx`; boards
 * `signup-channel-chip/c1.png`, `c2.png`). The server half is `apps/convex/__tests__/signupChannels.test.ts`.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `HeardChips` without `touchSaidWhere()`: "hidden when this browser saw where it came from" fails.
 */

let mockAsk: { ask: boolean; answered?: string } | undefined = { ask: true };
const mockAnswers: unknown[] = [];
let mockTouch: Record<string, string> | undefined = {};

jest.mock("convex/react", () => ({
  useQuery: () => mockAsk,
  useMutation: () => async (args: Record<string, unknown>) => {
    mockAnswers.push(args);
    return true;
  },
}));
jest.mock("../features/auth/firstTouch", () => ({
  firstTouch: () => mockTouch,
  firstTouchSent: () => true,
  markFirstTouchSent: () => {},
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HeardChips } = require("../features/onboarding/steps/HeardChips") as typeof import("../features/onboarding/steps/HeardChips");

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(HeardChips)));
  return {
    text: () => container.textContent ?? "",
    press: async (id: string) => {
      const el = container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      await act(async () => {
        el.click();
      });
    },
    checked: () => [...container.querySelectorAll('[aria-checked="true"]')].map((el) => el.textContent),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  mockAsk = { ask: true };
  mockTouch = {};
  mockAnswers.length = 0;
});

describe("How did you hear about us?", () => {
  test("asks with the five choices, optional, and one tap sends the answer and marks it", async () => {
    const view = mount();
    expect(view.text()).toContain("How did you hear about us? Optional");
    for (const label of ["Search", "ChatGPT or another AI", "X", "A friend or invite", "Other"]) expect(view.text()).toContain(label);
    await view.press("welcome-heard-x");
    expect(mockAnswers).toEqual([{ answer: "x" }]);
    expect(view.checked()).toEqual(["X"]);
    view.unmount();
  });

  test("hidden when this browser saw where it came from", () => {
    mockTouch = { referrer: "https://www.google.com" };
    const view = mount();
    expect(view.text()).toBe("");
    view.unmount();
  });

  test("hidden when the server already knows the channel, and shows an earlier answer as picked", () => {
    mockAsk = { ask: false };
    const hidden = mount();
    expect(hidden.text()).toBe("");
    hidden.unmount();
    mockAsk = { ask: true, answered: "friend" };
    const answered = mount();
    expect(answered.checked()).toEqual(["A friend or invite"]);
    answered.unmount();
  });
});
