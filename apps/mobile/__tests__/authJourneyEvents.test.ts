/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { usePhoneSignIn } from "../features/auth/usePhoneSignIn";
import { useEmailSignIn } from "../features/auth/useEmailSignIn";
import { trackEvent } from "../features/observability/client";

const mockStart = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSignIn = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockEnter = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("convex/react", () => ({ useAction: () => mockStart, useMutation: () => mockEnter }));
jest.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn: mockSignIn }) }));
jest.mock("../features/observability/client", () => ({ trackEvent: jest.fn() }));
jest.mock("../features/auth/xPixel", () => ({ reportWaitlistSignUp: jest.fn() }));
jest.mock("../features/auth/metaPixel", () => ({ reportMetaLead: jest.fn() }));
jest.mock("../features/tex/launch/receipt", () => ({ saveReceipt: jest.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); jest.clearAllMocks(); });
function mount<T>(hook: () => T) {
  let state!: T;
  function Harness() { state = hook(); return null; }
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  act(() => root.render(createElement(Harness)));
  cleanups.push(() => { act(() => root.unmount()); node.remove(); });
  return () => state;
}

describe("phone funnel at the operation boundary", () => {
  test("waitlist success follows the server reply, and includes no contact or receipt", async () => {
    mockStart.mockResolvedValue({ status: "joined", receipt: "private-receipt", conversionId: "private-id" });
    const flow = mount(() => usePhoneSignIn({ onSignedIn: jest.fn(), onUnavailable: jest.fn() }));
    act(() => flow().setPhone("+15555550123"));
    await act(async () => { await flow().send(); });
    expect(trackEvent).toHaveBeenNthCalledWith(2, "signup_submitted", { method: "phone", resend: false });
    expect(trackEvent).toHaveBeenNthCalledWith(3, "signup_result", { method: "phone", result: "joined", resend: false });
    expect(JSON.stringify(jest.mocked(trackEvent).mock.calls)).not.toMatch(/15555550123|private/);
  });
  test("a refused verification is a failure, never a conversion", async () => {
    mockStart.mockResolvedValue({ status: "sent", phone: "+15555550123" });
    mockSignIn.mockResolvedValue({ signingIn: false });
    const signed = jest.fn();
    const flow = mount(() => usePhoneSignIn({ onSignedIn: signed, onUnavailable: jest.fn() }));
    await act(async () => { await flow().send(); });
    await act(async () => { await flow().verify("123456"); });
    expect(trackEvent).toHaveBeenLastCalledWith("signin_code_result", { method: "phone", result: "failed" });
    expect(signed).not.toHaveBeenCalled();
  });
  test("a server exception produces a coarse failure without quoting it", async () => {
    mockStart.mockRejectedValue(new Error("private phone and credentials"));
    const flow = mount(() => usePhoneSignIn({ onSignedIn: jest.fn(), onUnavailable: jest.fn() }));
    await act(async () => { await flow().send(); });
    expect(trackEvent).toHaveBeenLastCalledWith("signup_result", { method: "phone", result: "failed", resend: false });
  });
});

describe("email funnel at the operation boundary", () => {
  test.each([true, false])("verification success is the auth result (%s)", async (signingIn) => {
    mockSignIn.mockResolvedValue({ signingIn });
    const signed = jest.fn();
    const flow = mount(() => useEmailSignIn({ source: "login", onSignedIn: signed }));
    act(() => flow().setEmail("person@example.com"));
    await act(async () => { await flow().verify("123456"); });
    expect(trackEvent).toHaveBeenLastCalledWith("signin_code_result", { method: "email", source: "login", result: signingIn ? "success" : "failed" });
    expect(signed).toHaveBeenCalledTimes(signingIn ? 1 : 0);
    expect(JSON.stringify(jest.mocked(trackEvent).mock.calls)).not.toMatch(/person@example.com|123456/);
  });
});
