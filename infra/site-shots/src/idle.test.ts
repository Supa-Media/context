import { describe, expect, it } from "vitest";
import { browseOnBrowserbase } from "./browserbaseRoute";
import { HOLD_MS, IDLE_MS, IdleTimer, RETRY_MS, touchIdle, type IdleNamespace, type IdleStorage } from "./idle";

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
    expect([...store.data.keys()].sort()).toEqual(["owner", "until"]);
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

  it("releases every browser this person has, when two were started at once", async () => {
    const store = fakeStorage();
    const api = fakeApi([
      { id: "one", connectUrl: "wss://c/one", userMetadata: { owner: OWNER } },
      { id: "theirs", connectUrl: "wss://c/theirs", userMetadata: { owner: OTHER } },
      { id: "two", connectUrl: "wss://c/two", userMetadata: { owner: OWNER } },
    ]);
    let now = 0;
    const timer = new IdleTimer(store.storage, ENV, api.fetcher, () => now);
    await timer.touch(OWNER);
    now += IDLE_MS;
    store.clearAlarm();
    await timer.alarm();
    expect(released(api.calls)).toEqual(["https://api.browserbase.com/v1/sessions/one", "https://api.browserbase.com/v1/sessions/two"]);
  });

  it("keeps a browser used since the alarm was set, even when an old alarm runs again", async () => {
    const store = fakeStorage();
    let now = 0;
    const api = fakeApi([{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }]);
    const timer = new IdleTimer(store.storage, ENV, api.fetcher, () => now);
    await timer.touch(OWNER);
    now += IDLE_MS - 1000;
    await timer.touch(OWNER); // used just before the first deadline
    const deadline = now + IDLE_MS;
    now += 1000;
    store.clearAlarm(); // the first alarm, delivered (again) with getAlarm saying nothing
    await timer.alarm();
    expect(released(api.calls)).toEqual([]);
    expect(store.alarm()).toBe(deadline);
    expect(store.data.get("owner")).toBe(OWNER);
  });

  it("keeps its state and asks again in a minute when Browserbase cannot be asked", async () => {
    const store = fakeStorage();
    let now = 0;
    const down = (async () => new Response("", { status: 500 })) as typeof fetch;
    const timer = new IdleTimer(store.storage, ENV, down, () => now);
    await timer.touch(OWNER);
    now += IDLE_MS;
    store.clearAlarm();
    await timer.alarm();
    expect(store.data.get("owner")).toBe(OWNER);
    expect(store.alarm()).toBe(now + RETRY_MS);
  });

  it("arms the next try before asking Browserbase, so a handler cut off mid-call still retries", async () => {
    const store = fakeStorage();
    let now = 0;
    let armedDuringLookup: number | null = null;
    const hanging = (async () => {
      armedDuringLookup = store.alarm();
      return await new Promise<Response>(() => {});
    }) as typeof fetch;
    const timer = new IdleTimer(store.storage, ENV, hanging, () => now);
    await timer.touch(OWNER);
    now += IDLE_MS;
    store.clearAlarm();
    void timer.alarm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(armedDuringLookup).toBe(now + RETRY_MS);
  });

  it("looks up and releases with no touch let in between", async () => {
    const store = fakeStorage();
    const api = fakeApi([{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }]);
    const order: string[] = [];
    const exclusive = async <T,>(fn: () => Promise<T>) => {
      order.push("lock");
      const out = await fn();
      order.push("unlock");
      return out;
    };
    const logged = (async (input: RequestInfo | URL, init?: RequestInit) => {
      order.push(init?.method === "POST" ? "release" : "lookup");
      return await api.fetcher(input, init);
    }) as typeof fetch;
    let now = 0;
    const timer = new IdleTimer(store.storage, ENV, logged, () => now, exclusive);
    await timer.touch(OWNER);
    now += IDLE_MS;
    store.clearAlarm();
    await timer.alarm();
    expect(order).toEqual(["lock", "lookup", "release", "unlock"]);
  });

  it("is touched by every Browserbase step, for the owner's tag, before the browser is looked up", async () => {
    const touched: string[] = [];
    const namespace: IdleNamespace = {
      idFromName: (name) => ({ name }) as unknown as DurableObjectId,
      get: (id) => ({ touch: async (owner) => void touched.push(`${(id as unknown as { name: string }).name}:${owner}`) }),
    };
    const api = fakeApi([{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }]);
    const lookedUp = api.fetcher;
    api.fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("?status=RUNNING")) touched.push(`lookup after ${touched.length} touch`);
      return await lookedUp(input, init);
    }) as typeof fetch;
    // The connect fails (no socket in this fake); the browser was still in use.
    await browseOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/browse", { owner: OWNER, steps: [{ do: "read" }] }, api.fetcher);
    expect(touched).toEqual([`${OWNER}:${OWNER}`, "lookup after 1 touch"]);
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

describe("a browser is held fifteen minutes while Tex waits on the person", () => {
  const recording = () => {
    const touched: Array<{ owner: string; ms: number | undefined }> = [];
    const namespace: IdleNamespace = {
      idFromName: (name) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ touch: async (owner, ms) => void touched.push({ owner, ms }) }),
    };
    return { touched, namespace };
  };

  it("holds to fifteen minutes, and a step or a look during the hold never brings the end closer", async () => {
    const store = fakeStorage();
    let now = 1_000_000;
    const timer = new IdleTimer(store.storage, ENV, fakeApi([]).fetcher, () => now);
    await timer.touch(OWNER, HOLD_MS);
    expect(store.alarm()).toBe(1_000_000 + HOLD_MS);
    now += 60 * 1000;
    await timer.touch(OWNER);
    expect(store.alarm()).toBe(1_000_000 + HOLD_MS);
    // Past the hold, a step is five minutes again.
    now = 1_000_000 + HOLD_MS + 1;
    await timer.touch(OWNER);
    expect(store.alarm()).toBe(now + IDLE_MS);
    expect(HOLD_MS).toBe(15 * 60 * 1000);
  });

  it("holds the owner's running browser on /browse/hold", async () => {
    const { touched, namespace } = recording();
    const api = fakeApi([{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }]);
    const response = await browseOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/browse/hold", { owner: OWNER }, api.fetcher);
    expect(await response.json()).toEqual({ held: true });
    expect(touched).toEqual([{ owner: OWNER, ms: HOLD_MS }]);
    expect(released(api.calls)).toEqual([]);
  });

  it("holds nothing, and arms no timer, when the owner has no browser running", async () => {
    const { touched, namespace } = recording();
    const api = fakeApi([{ id: "theirs", connectUrl: "wss://c/theirs", userMetadata: { owner: OTHER } }]);
    const response = await browseOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/browse/hold", { owner: OWNER }, api.fetcher);
    expect(await response.json()).toEqual({ held: false });
    expect(touched).toEqual([]);
  });

  it("refuses a hold with no owner tag", async () => {
    const { touched, namespace } = recording();
    const response = await browseOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/browse/hold", {}, fakeApi([]).fetcher);
    expect(response.status).toBe(400);
    expect(touched).toEqual([]);
  });

  it("holds a browser being handed to the person, and only five minutes for an ordinary step", async () => {
    const { touched, namespace } = recording();
    const api = fakeApi([{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }]);
    await browseOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/browse", { owner: OWNER, steps: [{ do: "read" }], handoff: true }, api.fetcher);
    await browseOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/browse", { owner: OWNER, steps: [{ do: "read" }] }, api.fetcher);
    expect(touched.map((t) => t.ms)).toEqual([HOLD_MS, IDLE_MS]);
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

  it("touches the timer before looking the browser up, so a release under way finishes first", async () => {
    const { viewOnBrowserbase } = await import("./view");
    const order: string[] = [];
    const namespace: IdleNamespace = {
      idFromName: (name) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ touch: async () => void order.push("touch") }),
    };
    const api = fakeApi([]);
    const logged = (async (input: RequestInfo | URL, init?: RequestInit) => {
      order.push("lookup");
      return await api.fetcher(input, init);
    }) as typeof fetch;
    await viewOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/view/frame", { owner: OWNER }, logged);
    expect(order).toEqual(["touch", "lookup"]);
  });
});
