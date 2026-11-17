import { describe, expect, it, vi } from "vitest";
import {
  ALARM_MS,
  WAKE_AGAIN_MS,
  containerErrorDetail,
  containerGapDelayMs,
  isMissingContainer,
  nextAlarmDelay,
  retryWake,
} from "./wake";

const missing = () => new Error("There is no container instance that can be provided to this Durable Object, try again later");

describe("retryWake", () => {
  it("retries a missing container with a short backoff and then succeeds", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async (_ms: number) => {});
    const logged: Record<string, unknown>[] = [];
    await expect(retryWake(run, { sleep, log: (record) => logged.push(record) })).resolves.toBe("up");
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
    expect(logged.map((record) => record.event)).toEqual(["wake.retry", "wake.retry"]);
    expect(logged[0]?.detail).toMatch(/no container instance/);
  });

  it("logs wake.failed when the container is still missing, and does not wait after the last try", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const logged: Record<string, unknown>[] = [];
    const outcome = await retryWake(async () => {
      throw missing();
    }, { sleep, log: (record) => logged.push(record) });
    expect(outcome).toBe("missing");
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(logged.at(-1)).toMatchObject({ event: "wake.failed", detail: expect.stringMatching(/no container instance/) });
  });

  it("retries a wake that failed for another reason, then reports down", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const logged: Record<string, unknown>[] = [];
    const outcome = await retryWake(async () => {
      throw new Error("start 500");
    }, { sleep, log: (record) => logged.push(record), backoffs: [10, 20] });
    expect(outcome).toBe("down");
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([10, 20]);
    expect(logged.at(-1)).toEqual({ event: "wake.failed", error: "Error", detail: "start 500" });
  });

  it("does not retry a fatal error and does not log it as a failed wake", async () => {
    const fatal = new Error("unconfigured");
    fatal.name = "Unconfigured";
    const sleep = vi.fn(async (_ms: number) => {});
    const logged: Record<string, unknown>[] = [];
    await expect(retryWake(async () => {
      throw fatal;
    }, { sleep, log: (record) => logged.push(record), isFatal: (error) => error instanceof Error && error.name === "Unconfigured" })).rejects.toBe(fatal);
    expect(sleep).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });
});

describe("next alarm after a wake", () => {
  it("comes back in a few seconds only when the container instance is missing", () => {
    expect(nextAlarmDelay("missing")).toBe(WAKE_AGAIN_MS);
    expect(nextAlarmDelay("up")).toBe(ALARM_MS);
    expect(nextAlarmDelay("down")).toBe(ALARM_MS);
    expect(WAKE_AGAIN_MS).toBeLessThan(ALARM_MS);
  });

  it("keeps the in-loop gap short, and does not quote an unexpected error", () => {
    expect([0, 1, 2, 3].map(containerGapDelayMs)).toEqual([1000, 2000, 4000, 4000]);
    expect(isMissingContainer(missing())).toBe(true);
    expect(isMissingContainer(new Error("container not ready"))).toBe(true);
    expect(isMissingContainer(new Error("start 500"))).toBe(false);
    expect(containerErrorDetail(new Error("chat text +15550100123"))).toBeUndefined();
  });
});
