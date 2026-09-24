/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/*
  The body reads no route and no Convex client; its module reaches expo-router,
  which this project's jest transform does not compile, so the names are
  stubbed exactly as dropboxScreens.test.ts does.
*/
jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: () => null,
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: () => {} }),
}));

// `CenteredScroll` reads the insets, and that hook throws outside a provider.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { CliConnectedBody, cliResult } from "../features/cli/CliConnectedScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(result: "connected" | "refused"): string {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(CliConnectedBody, { result, onLeave: () => {} }));
  });
  const text = container.textContent ?? "";
  act(() => root.unmount());
  container.remove();
  return text;
}

/**
 * `/connect/cli`, where the browser lands after `npx @supa-media/context`
 * signs in. The CLI's loopback page redirects here with only the outcome, so
 * this page renders with the app's own components instead of plain HTML.
 */
describe("the CLI's signed-in page", () => {
  test("a sign-in that worked says so and sends the person back to the terminal", () => {
    const text = textOf("connected");
    expect(text).toContain("signed in");
    expect(text).toContain("terminal");
    expect(text).toContain("Connections");
  });

  test("a refusal says nothing was granted and how to try again", () => {
    const text = textOf("refused");
    expect(text).toMatch(/not signed in/i);
    expect(text).toContain("npx @supa-media/context");
    expect(text).not.toContain("You are signed in");
  });

  test("only an exact `connected` reads as success", () => {
    expect(cliResult("connected")).toBe("connected");
    expect(cliResult(["connected", "x"])).toBe("connected");
    expect(cliResult("refused")).toBe("refused");
    expect(cliResult(undefined)).toBe("refused");
    expect(cliResult("CONNECTED")).toBe("refused");
  });
});
