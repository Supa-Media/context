import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { breathe, SLICE_MS } from "../features/offline/breathe";

/**
 * A long run of synchronous file work through `await`s lets a waiting timer
 * — where React Native delivers a tap — run part-way through, not only after
 * (Dev2, 2026-10-16: Back did nothing for a minute while the phone synced).
 * Sabotage: `breathe` returning at once fails the first test.
 */

afterEach(() => {
  jest.restoreAllMocks();
});

function busyClock(stepMs: number): void {
  let at = 0;
  jest.spyOn(performance, "now").mockImplementation(() => {
    at += stepMs;
    return at;
  });
}

describe("breathe", () => {
  test("lets a waiting timer run during a long chain of awaits", async () => {
    busyClock(SLICE_MS / 3);
    let tapped = -1;
    setTimeout(() => {
      tapped = done;
    }, 0);
    let done = 0;
    for (; done < 200; done += 1) await breathe();
    expect(tapped).toBeGreaterThanOrEqual(0);
    expect(tapped).toBeLessThan(10);
  });

  test("waits on nothing while the slice has time left", async () => {
    let at = 1e9;
    jest.spyOn(performance, "now").mockImplementation(() => at);
    await breathe(); // starts a slice
    const timeout = jest.spyOn(global, "setTimeout");
    for (let n = 0; n < 50; n += 1) await breathe();
    expect(timeout).not.toHaveBeenCalled();
    at += SLICE_MS;
    await breathe();
    expect(timeout).toHaveBeenCalledTimes(1);
  });
});
