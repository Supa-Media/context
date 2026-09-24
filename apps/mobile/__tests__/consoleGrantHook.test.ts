/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, jest, test } from "@jest/globals";

const mockClient = {};
let mockSession: string | null = "alpha-session";
const mockMint = jest.fn(async () => ({ accessToken: "grant", expiresAt: Date.now() + 3600000, scopes: [] }));
jest.mock("convex/react", () => ({ useConvex: () => mockClient, useAction: () => mockMint }));
jest.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => mockSession }));
import { useConsoleGrant } from "../features/agent/useConsoleGrant";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("all consumers share a session grant and an account change refuses stale consumers", async () => {
  const root = createRoot(document.createElement("div"));
  const consumers: ReturnType<typeof useConsoleGrant>[] = [];
  function Consumer({ index }: { index: number }) {
    consumers[index] = useConsoleGrant();
    return null;
  }
  function render() {
    act(() => root.render(createElement("div", null, ...[0, 1, 2].map(index => createElement(Consumer, { key: index, index })))));
  }
  try {
    render();
    const args = { workspaceId: "alpha" as never };
    await Promise.all(consumers.map(mint => mint(args)));
    expect(mockMint).toHaveBeenCalledTimes(1);
    const previous = consumers[0]!;
    mockSession = "beta-session";
    render();
    await expect(previous(args)).rejects.toThrow("Not authenticated");
    await consumers[0]!(args);
    expect(mockMint).toHaveBeenCalledTimes(2);
    expect(mockMint.mock.calls[0]).not.toEqual(mockMint.mock.calls[1]);
    mockSession = null;
    render();
    await expect(consumers[0]!(args)).rejects.toThrow("Not authenticated");
  } finally {
    act(() => root.unmount());
  }
});
