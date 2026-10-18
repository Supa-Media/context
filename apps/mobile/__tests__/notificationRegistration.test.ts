import { test, expect, jest } from "@jest/globals";
import { registerNotifications } from "../features/notifications/register";

function adapter(permission = "undetermined", canAskAgain = true) {
  return {
    prepare: jest.fn(async () => {}),
    permissions: jest.fn(async () => ({ allowed: permission === "granted", canAskAgain })),
    request: jest.fn(async () => ({ allowed: true, canAskAgain: true })),
    register: jest.fn(async () => {}),
  };
}

test("asks only after the user opts in, then registers the device", async () => {
  const api = adapter();
  expect(await registerNotifications(api)).toBe("registered");
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(api.register).toHaveBeenCalledTimes(1);
  expect(api.prepare.mock.invocationCallOrder[0]).toBeLessThan(api.request.mock.invocationCallOrder[0]);
});
test("a denial prevents device registration", async () => {
  const api = adapter();
  api.request.mockResolvedValue({ allowed: false, canAskAgain: false });
  expect(await registerNotifications(api)).toBe("denied");
  expect(api.register).not.toHaveBeenCalled();
});
test("a permanent denial never prompts again", async () => {
  const api = adapter("denied", false);
  expect(await registerNotifications(api)).toBe("denied");
  expect(api.request).not.toHaveBeenCalled();
});
test("existing permission is reused", async () => {
  const api = adapter("granted");
  expect(await registerNotifications(api)).toBe("registered");
  expect(api.request).not.toHaveBeenCalled();
});
test("registration failures are visible and retryable", async () => {
  const api = adapter("granted");
  api.register.mockRejectedValue(new Error("offline"));
  expect(await registerNotifications(api)).toBe("failed");
});

test("an unavailable push service cannot leave the button waiting forever", async () => {
  jest.useFakeTimers();
  try {
    const api = adapter("granted");
    api.register.mockImplementation(() => new Promise<void>(() => {}));
    const result = registerNotifications(api, 100);
    await jest.advanceTimersByTimeAsync(101);
    expect(await result).toBe("failed");
  } finally {
    jest.useRealTimers();
  }
});
