import { beforeEach, describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { clearOldLineCache, OLD_LINE_CACHE_MS, readOldLine, type OldLine } from "./oldLine";

const NUMBER = "+18133350746";
const SECRET = "a-worker-secret-long-enough";
const redirect: OldLine = { mode: "redirect", number: NUMBER, archiveOn: null };

beforeEach(() => clearOldLineCache());

describe("reading the setting", () => {
  it("asks the control plane with the worker's secret, and keeps the answer for 60 seconds", async () => {
    let calls = 0;
    const auth: Array<string | null> = [];
    const urls: string[] = [];
    let clock = 0;
    const fetcher = (async (url: string, init: RequestInit) => {
      calls++;
      urls.push(url);
      auth.push(new Headers(init.headers).get("authorization"));
      return Response.json({ mode: "redirect", number: NUMBER, archiveOn: null });
    }) as unknown as Fetch;
    const deps = { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: SECRET, now: () => clock };

    expect(await readOldLine(deps)).toEqual(redirect);
    clock = OLD_LINE_CACHE_MS - 1;
    expect(await readOldLine(deps)).toEqual(redirect);
    expect(calls).toBe(1);
    clock = OLD_LINE_CACHE_MS;
    await readOldLine(deps);
    expect(calls).toBe(2);
    expect(urls[0]).toBe("https://cp.example/agent-texts/old-line");
    expect(auth[0]).toBe(`Bearer ${SECRET}`);
  });

  it("reads an answer it does not understand as off, so no text goes out on a guess", async () => {
    const fetcher = (async () => Response.json({ mode: "redirect", number: "8133350746" })) as unknown as Fetch;
    expect(await readOldLine({ fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: SECRET, now: () => 0 })).toEqual({
      mode: "off",
      number: null,
      archiveOn: null,
    });
  });

  it("throws, and keeps nothing, when the control plane does not answer", async () => {
    let calls = 0;
    const fetcher = (async () => (calls++, new Response("no", { status: 500 }))) as unknown as Fetch;
    const deps = { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: SECRET, now: () => 0 };
    await expect(readOldLine(deps)).rejects.toThrow("control_plane request failed (500)");
    await expect(readOldLine(deps)).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
