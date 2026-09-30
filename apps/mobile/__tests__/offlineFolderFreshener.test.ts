/**
 * An open project folder's fetch is remembered until it can run.
 *
 * Reported by the owner the night #1156 shipped: "mobile is still stale". The
 * phone opens onto the page it was last on before it knows it is online or
 * which contexts it has, and the request that page made was thrown away.
 * Dropping requests that are not ready fails "a request made too early runs
 * once it can"; not retrying fails "a page left open is fetched again".
 */
import { describe, expect, test } from "@jest/globals";
import { folderFreshener } from "../features/offline/folderFreshener";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  let ready = false;
  const runs: string[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const freshener = folderFreshener({
    ready: () => ready,
    run: async (workspaceId, folder) => {
      runs.push(`${workspaceId}:${folder}`);
      if (hold) await new Promise<void>((resolve) => (release = resolve));
    },
  });
  return {
    freshener,
    runs,
    setReady: (value: boolean) => (ready = value),
    holdRuns: () => (hold = true),
    release: () => {
      hold = false;
      release?.();
    },
  };
}

describe("fetching an open project folder", () => {
  test("a request made too early runs once it can", async () => {
    const h = harness();
    h.freshener.request("ws", "1-projects");
    await flush();
    expect(h.runs).toEqual([]);
    h.setReady(true);
    h.freshener.retry();
    await flush();
    expect(h.runs).toEqual(["ws:1-projects"]);
  });

  test("a page left open is fetched again on every retry", async () => {
    const h = harness();
    h.setReady(true);
    h.freshener.request("ws", "1-projects");
    await flush();
    h.freshener.retry();
    await flush();
    expect(h.runs).toEqual(["ws:1-projects", "ws:1-projects"]);
  });

  test("one run per context at a time, then once more for the folder asked for last", async () => {
    const h = harness();
    h.setReady(true);
    h.holdRuns();
    h.freshener.request("ws", "1-projects");
    await flush();
    h.freshener.request("ws", "1-projects/premium");
    h.freshener.request("ws", "1-projects/websites");
    await flush();
    expect(h.runs).toEqual(["ws:1-projects"]);
    h.release();
    await flush();
    await flush();
    expect(h.runs).toEqual(["ws:1-projects", "ws:1-projects/websites"]);
  });

  test("a failed run does not stop the next one", async () => {
    let calls = 0;
    const freshener = folderFreshener({
      ready: () => true,
      run: async () => {
        calls += 1;
        throw new Error("timed out");
      },
    });
    freshener.request("ws", "1-projects");
    await flush();
    freshener.retry();
    await flush();
    expect(calls).toBe(2);
  });
});
