/** @jest-environment jsdom */
import { test, expect, jest, afterEach } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NotificationSettings } from "../features/notifications/NotificationSettings.tsx";

const mockEnable = jest.fn<() => Promise<"registered" | "denied" | "failed">>();
jest.mock("../features/notifications/device", () => ({ enableNotifications: () => mockEnable() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => mockEnable.mockReset());

for (const state of ["registered", "denied", "failed"] as const) {
  test(`permission is requested only on press and ${state} has visible feedback`, async () => {
    mockEnable.mockResolvedValue(state);
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(NotificationSettings)));
      expect(mockEnable).not.toHaveBeenCalled();
      const enable = host.querySelector('[data-testid="notifications-enable"]') as HTMLElement;
      await act(async () => enable.click());
      expect(mockEnable).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain({ registered: "This device is registered", denied: "Notifications are off", failed: "Registration did not finish" }[state]);
      expect(host.textContent).toContain("keep using Context without them");
    } finally { act(() => root.unmount()); }
  });
}
