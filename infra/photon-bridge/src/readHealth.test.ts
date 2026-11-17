import { describe, expect, it } from "vitest";
import {
  DEGRADED_AFTER_MS,
  STALE_AFTER_MS,
  readHealth,
  shouldRestartContainer,
} from "../container/readHealth.mjs";

const T0 = 1_700_000_000_000;

describe("readHealth", () => {
  it("is fresh while the last read is within two poll intervals", () => {
    expect(readHealth({ now: T0 + DEGRADED_AFTER_MS, started: true, startedAt: T0, lastReadAt: T0 })).toEqual({
      ok: true,
      read: "fresh",
      readAgeMs: DEGRADED_AFTER_MS,
    });
  });

  it("is degraded once the last read is past two poll intervals, and not a restart yet", () => {
    const now = T0 + DEGRADED_AFTER_MS + 1;
    const verdict = readHealth({ now, started: true, startedAt: T0, lastReadAt: T0 });
    expect(verdict).toEqual({ ok: false, read: "degraded", readAgeMs: DEGRADED_AFTER_MS + 1 });
    expect(shouldRestartContainer({ started: true, read: verdict.read })).toBe(false);
  });

  it("is stale at three minutes and that is when the container is restarted", () => {
    const verdict = readHealth({ now: T0 + STALE_AFTER_MS, started: true, startedAt: T0, lastReadAt: T0 });
    expect(verdict).toEqual({ ok: false, read: "stale", readAgeMs: STALE_AFTER_MS });
    expect(shouldRestartContainer({ started: true, read: verdict.read })).toBe(true);
  });

  it("does not call a bridge ok when it started and has never read, once two intervals have passed", () => {
    expect(readHealth({ now: T0 + 30_000, started: true, startedAt: T0, lastReadAt: null })).toEqual({
      ok: true,
      read: "starting",
      readAgeMs: 30_000,
    });
    const degraded = readHealth({ now: T0 + DEGRADED_AFTER_MS + 1, started: true, startedAt: T0, lastReadAt: null });
    expect(degraded.ok).toBe(false);
    expect(degraded.read).toBe("degraded");
    const stale = readHealth({ now: T0 + STALE_AFTER_MS, started: true, startedAt: T0, lastReadAt: null });
    expect(stale).toEqual({ ok: false, read: "stale", readAgeMs: STALE_AFTER_MS });
    expect(shouldRestartContainer({ started: true, read: stale.read })).toBe(true);
  });

  it("does not restart a container that has not claimed to be up", () => {
    expect(readHealth({ now: T0, started: false, startedAt: null, lastReadAt: null })).toEqual({
      ok: true,
      read: "starting",
      readAgeMs: null,
    });
    expect(shouldRestartContainer(null)).toBe(false);
    expect(shouldRestartContainer({ started: false, read: "stale" })).toBe(false);
    expect(shouldRestartContainer({ started: true, read: "fresh" })).toBe(false);
  });
});
