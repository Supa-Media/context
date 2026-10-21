/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { UsageAnalytics } from "@context/convex/functions/lib/adminFns/usageAnalyticsShape";

const mockReport = jest.fn<(_args: { days: number }) => Promise<UsageAnalytics>>();
jest.mock("convex/react", () => ({ useAction: () => mockReport }));
import { useUsageData } from "../features/admin/useUsageData";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); mockReport.mockReset(); });

test("refresh retries missing credentials and ignores an older request that finishes last", async () => {
  const pending: Array<(value: UsageAnalytics) => void> = [];
  mockReport.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  function Probe({ refresh }: { refresh: number }) {
    const answer = useUsageData(30, refresh);
    return createElement("span", null, answer === undefined ? "loading" : JSON.stringify(answer));
  }
  act(() => root.render(createElement(Probe, { refresh: 0 })));
  await act(async () => { pending[0]({ connected: false }); });
  expect(container.textContent).toContain('"connected":false');
  act(() => root.render(createElement(Probe, { refresh: 1 })));
  expect(container.textContent).toBe("loading");
  act(() => root.render(createElement(Probe, { refresh: 2 })));
  await act(async () => { pending[2]({ connected: true, error: "latest" }); });
  await act(async () => { pending[1]({ connected: false }); });
  expect(container.textContent).toContain("latest");
  expect(mockReport).toHaveBeenCalledTimes(3);
});
