import { describe, expect, it } from "vitest";
import { browseOnBrowserbase } from "./browserbaseRoute";
import { IDLE_MS, IdleTimer, touchIdle, type IdleNamespace, type IdleStorage } from "./idle";

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);

function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: IdleStorage = {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async deleteAll() {
      data.clear();
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(at) {
      alarm = at;
    },
  };
  return { storage, data, alarm: () => alarm, clearAlarm: () => (alarm = null) };
}

function fakeApi(running: Array<Record<string, unknown>>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/sessions?status=RUNNING")) return Response.json(running);
    if (url.endsWith("/sessions") && init?.method === "POST") throw new Error("stop after the session is found");
    return Response.json({});
  }) as typeof fetch;
  return { calls, fetcher };
}

const released = (calls: Array<{ method: string; url: string; body: unknown }>) =>
  calls.filter((c) => c.method === "POST" && (c.body as { status?: string } | null)?.status === "REQUEST_RELEASE").map((c) => c.url);

describe("a Browserbase browser ends five minutes after its last use", () => {
  it("sets the end five minutes from each use, keeping the owner tag and nothing else", async () => {
    const store = fakeStorage();
    let now = 1_000_000;
    const timer = new IdleTimer(store.storage, ENV, fakeApi([]).fetcher, () => now);
    await timer.touch(OWNER);
    expect(store.alarm()).toBe(1_000_000 + IDLE_MS);
    now += 4 * 60 * 1000;
    await timer.touch(OWNER);
    expect(store.alarm()).toBe(now + IDLE_MS);
    expect([...store.data.keys()]).toEqual(["owner"]);
    expect(IDLE_MS).toBe(5 * 60 * 1000);
  });

  it("releases only this person's browser when the alarm fires, then forgets them", async () => {
    const store = fakeStorage();
    const api = fakeApi([
      { id: "theirs", connectUrl: "wss://c/theirs", userMetadata: { owner: OTHER } },
      { id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } },
    ]);
    let now = 0;
    const timer = new IdleTimer(store.storage, ENV, api.fetcher, () => now);
    await timer.touch(OWNER);
    now += IDLE_MS;
    store.clearAlarm(); // the runtime clears the alarm it is running
    await timer.alarm();
    expect(released(api.calls)).toEqual(["https://api.browserbase.com/v1/sessions/mine"]);
    expect(store.data.size).toBe(0);
  });

  it("keeps a browser that was used again while the alarm was looking it up", async () => {
    const store = fakeStorage();
    let now = 0;
    const api = fakeApi([{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }]);
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // A step arrives during the lookup and pushes the end out again.
      if (String(input).endsWith("?status=RUNNING")) await store.storage.setAlarm(now + IDLE_MS);
      return await api.fetcher(input, init);
    }) as typeof fetch;
    const timer = new IdleTimer(store.storage, ENV, racing, () => now);
    await timer.touch(OWNER);
    now += IDLE_MS;
    store.clearAlarm();
    await timer.alarm();
    expect(released(api.calls)).toEqual([]);
    expect(store.data.get("owner")).toBe(OWNER);
  });

  it("is touched by every Browserbase step, for the owner's tag", async () => {
    const touched: string[] = [];
    const namespace: IdleNamespace = {
      idFromName: (name) => ({ name }) as unknown as DurableObjectId,
      get: (id) => ({ touch: async (owner) => void touched.push(`${(id as unknown as { name: string }).name}:${owner}`) }),
    };
    const api = fakeApi([{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }]);
    // The connect fails (no socket in this fake); the browser was still in use.
    await browseOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/browse", { owner: OWNER, steps: [{ do: "read" }] }, api.fetcher);
    expect(touched).toEqual([`${OWNER}:${OWNER}`]);
  });

  it("never fails a step when the timer cannot be reached", async () => {
    const broken: IdleNamespace = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ touch: async () => Promise.reject(new Error("overloaded")) }),
    };
    await expect(touchIdle(broken, OWNER)).resolves.toBeUndefined();
    await expect(touchIdle(undefined, OWNER)).resolves.toBeUndefined();
  });
});

describe("the person's own view counts as use", () => {
  it("touches the timer when they look at their browser", async () => {
    const { viewOnBrowserbase } = await import("./view");
    const touched: string[] = [];
    const namespace: IdleNamespace = {
      idFromName: (name) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ touch: async (owner) => void touched.push(owner) }),
    };
    const api = fakeApi([{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }]);
    await viewOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/view/frame", { owner: OWNER }, api.fetcher);
    expect(touched).toEqual([OWNER]);
  });

  it("does not start a timer for someone with no browser", async () => {
    const { viewOnBrowserbase } = await import("./view");
    const touched: string[] = [];
    const namespace: IdleNamespace = {
      idFromName: (name) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ touch: async (owner) => void touched.push(owner) }),
    };
    await viewOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/view/frame", { owner: OWNER }, fakeApi([]).fetcher);
    expect(touched).toEqual([]);
  });
});
