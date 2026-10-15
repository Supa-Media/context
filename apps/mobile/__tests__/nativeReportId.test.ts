/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

let mockSequence = 0;
jest.mock("expo-crypto", () => ({
  getRandomBytes: jest.fn((size: number) => Uint8Array.from({ length: size }, () => ++mockSequence % 256)),
}));
// Metro selects this on iOS; this suite normally selects web implementations.
jest.mock("../features/feedback/clientReportId", () =>
  jest.requireActual("../features/feedback/clientReportId.native"));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const { newClientReportId } = require("../features/feedback/model");
const { ReportDialogView } = require("../features/report/ReportDialog");
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
});

function withoutWebCrypto() {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
}

describe("reports on Hermes without browser Web Crypto", () => {
  test("creates distinct server-compatible ids using the native random provider", () => {
    withoutWebCrypto();
    const first = newClientReportId();
    const second = newClientReportId();
    expect(first).toMatch(/^[0-9a-f]{24}$/);
    expect(second).toMatch(/^[0-9a-f]{24}$/);
    expect(second).not.toBe(first);
    expect(require("expo-crypto").getRandomBytes).toHaveBeenCalledWith(12);
  });

  test("opens the actual report dialog rather than throwing during mount", async () => {
    withoutWebCrypto();
    const errors: unknown[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container, { onUncaughtError: error => errors.push(error) });
    try {
      await act(async () => root.render(createElement(ReportDialogView, {
        target: { kind: "share", token: "fictional-share" },
        person: { handle: "demo", name: null },
        onClose: () => {},
        submit: jest.fn(),
      })));
      expect(errors).toEqual([]);
      expect(document.body.textContent).toContain("Report or block");
      expect(document.body.querySelector('[data-testid="report-also-block"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
