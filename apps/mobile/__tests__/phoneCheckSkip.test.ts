/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

/**
 * "Skip for now" on the phone step (board S1, Dev2 2026-10-29: "Ask, but let
 * them skip"). Shown only when the server says this account may skip; tapping
 * it saves the skip on the account, and the layout stops drawing the screen
 * once the server answers "not required". The rule is the server's
 * (`apps/convex/__tests__/phoneCheckSkip.test.ts`); this is only the screen.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));
jest.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: jest.fn(async () => {}) }) }));
jest.mock("../features/observability/client", () => ({ resetObservabilityUser: jest.fn() }));
jest.mock("../features/offline/forget", () => ({
  unsentOnDevice: async () => ({ pending: 0, conflicted: 0, rejected: 0 }),
  forgetLocalCopies: async () => {},
}));

const mockSkip = jest.fn(async () => ({ status: "skipped" }));
jest.mock("convex/react", () => ({
  useAction: () => async () => ({ status: "sent", phone: "+15555550100" }),
  useMutation: () => mockSkip,
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PhoneCheckScreen } from "../features/auth/PhoneCheckScreen";
import { PHONE_CHECK_LATER, PHONE_CHECK_WHY, PHONE_CHECK_WHY_SKIPPABLE } from "../features/auth/phoneCheck";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(props: { canSkip?: boolean; initialSentTo?: string }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    const Screen = PhoneCheckScreen as (p: typeof props) => ReturnType<typeof PhoneCheckScreen>;
    root.render(createElement(Screen, props));
  });
  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return {
    text: () => container.textContent ?? "",
    byId,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("skipping the phone step", () => {
  test("offered: a Skip for now link and where to add one later", async () => {
    mockSkip.mockClear();
    const view = mount({ canSkip: true });
    expect(view.text()).toContain(PHONE_CHECK_WHY_SKIPPABLE);
    expect(view.text()).toContain(PHONE_CHECK_LATER);
    expect(view.byId("phone-check-sign-out")).not.toBeNull();
    await act(async () => {
      view.byId("phone-check-skip")!.click();
    });
    expect(mockSkip).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("not offered: no link, and the old words", () => {
    const view = mount({});
    expect(view.byId("phone-check-skip")).toBeNull();
    expect(view.text()).toContain(PHONE_CHECK_WHY);
    expect(view.text()).not.toContain(PHONE_CHECK_LATER);
    view.unmount();
  });

  test("on the code step the skip is gone", () => {
    const view = mount({ canSkip: true, initialSentTo: "+15555550100" });
    expect(view.byId("phone-check-skip")).toBeNull();
    expect(view.text()).not.toContain(PHONE_CHECK_LATER);
    view.unmount();
  });
});
