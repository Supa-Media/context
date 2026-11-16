import { describe, expect, it } from "vitest";
import { browseOnBrowserbase } from "./browserbaseRoute";
import { IdleTimer, type IdleNamespace, type IdleStorage } from "./idle";
import { LEASE_MS, RUN_LEASE_MS, claimLease, holderOf } from "./lease";

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
const OWNER = "a".repeat(64);
const JOB = "job-pass-one-0001";
const TURN = "chat-turn-two-0002";

function fakeStorage() {
  const data = new Map<string, unknown>();
  const storage: IdleStorage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => void data.set(key, value),
    delete: async (key) => data.delete(key),
    deleteAll: async () => data.clear(),
    getAlarm: async () => null,
    setAlarm: async () => undefined,
  };
  return { storage, data };
}

/** One real IdleTimer behind a namespace, as the Durable Object would be. */
function oneObject(now: () => number) {
  const store = fakeStorage();
  const timer = new IdleTimer(store.storage, ENV, (async () => Response.json([])) as typeof fetch, now);
  const namespace: IdleNamespace = {
    idFromName: (name) => ({ name }) as unknown as DurableObjectId,
    get: () => ({
      touch: (owner, ms) => timer.touch(owner, ms),
      claim: (holder, ms) => timer.claim(holder, ms),
      release: (holder) => timer.release(holder),
    }),
  };
  return { timer, namespace, store };
}

/** Browserbase with no browser running and none it will start: the run stops at "no browser is free". */
function fakeApi() {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (String(input).endsWith("/sessions?status=RUNNING")) return Response.json([]);
    return new Response("", { status: 500 });
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("the browser lease: one driver at a time", () => {
  it("is taken when free, refreshed by its own holder, and refused to another live holder", async () => {
    let now = 1_000;
    const { timer } = oneObject(() => now);
    expect(await timer.claim(JOB, LEASE_MS)).toEqual({ ok: true });
    now += 60_000;
    expect(await timer.claim(JOB, LEASE_MS)).toEqual({ ok: true });
    expect(await timer.claim(TURN, LEASE_MS)).toEqual({ ok: false, leftMs: LEASE_MS });
  });

  it("frees itself when its holder never comes back", async () => {
    let now = 0;
    const { timer } = oneObject(() => now);
    await timer.claim(JOB, LEASE_MS);
    now += LEASE_MS + 1;
    expect(await timer.claim(TURN, LEASE_MS)).toEqual({ ok: true });
    expect(await timer.claim(JOB, LEASE_MS)).toMatchObject({ ok: false });
  });

  it("is let go only by its own holder", async () => {
    const { timer } = oneObject(() => 0);
    await timer.claim(JOB, LEASE_MS);
    expect(await timer.release(TURN)).toBe(false);
    expect(await timer.claim(TURN, LEASE_MS)).toMatchObject({ ok: false });
    expect(await timer.release(JOB)).toBe(true);
    expect(await timer.claim(TURN, LEASE_MS)).toEqual({ ok: true });
  });

  it("claims inside the object's exclusive section", async () => {
    const order: string[] = [];
    const store = fakeStorage();
    const exclusive = async <T>(fn: () => Promise<T>) => {
      order.push("lock");
      const out = await fn();
      order.push("unlock");
      return out;
    };
    const timer = new IdleTimer(store.storage, ENV, fetch, () => 0, exclusive);
    await timer.claim(JOB, LEASE_MS);
    await timer.release(JOB);
    expect(order).toEqual(["lock", "unlock", "lock", "unlock"]);
  });

  it("reads only a holder id, and nothing else, from a request", () => {
    expect(holderOf({ holder: JOB })).toBe(JOB);
    expect(holderOf({ holder: "x" })).toBeNull();
    expect(holderOf({ holder: "../../etc" })).toBeNull();
    expect(holderOf({})).toBeNull();
  });

  it("runs every call when the object cannot be reached or is not bound", async () => {
    const broken: IdleNamespace = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ touch: async () => undefined, claim: async () => Promise.reject(new Error("overloaded")) }),
    };
    expect(await claimLease(broken, OWNER, JOB, LEASE_MS)).toEqual({ busy: false });
    expect(await claimLease(undefined, OWNER, JOB, LEASE_MS)).toEqual({ busy: false });
  });
});

describe("/browse with a holder", () => {
  const browse = (env: Record<string, unknown>, holder: string | null, api = fakeApi(), path = "/browse") =>
    browseOnBrowserbase(env as typeof ENV, path, { provider: "browserbase", owner: OWNER, steps: [{ do: "read" }], ...(holder ? { holder } : {}) }, api.fetcher);

  it("answers 409 busy and runs nothing while another holder drives the browser", async () => {
    const { namespace } = oneObject(() => 0);
    const env = { ...ENV, BROWSER_IDLE: namespace };
    await browse(env, JOB);
    const api = fakeApi();
    const response = await browse(env, TURN, api);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ busy: true });
    expect(api.calls).toEqual([]);
  });

  it("keeps the browser past a step for two minutes, then frees it", async () => {
    let now = 0;
    const { namespace, store } = oneObject(() => now);
    const env = { ...ENV, BROWSER_IDLE: namespace };
    await browse(env, JOB);
    expect(store.data.get("lease")).toEqual({ holder: JOB, until: LEASE_MS });
    now += LEASE_MS + 1;
    expect((await browse(env, TURN)).status).not.toBe(409);
  });

  it("holds the browser for the run while a call is under way", async () => {
    const { namespace, store } = oneObject(() => 0);
    let during: unknown = null;
    const api = fakeApi();
    const watching = (async (input: RequestInfo | URL, init?: RequestInit) => {
      during = store.data.get("lease");
      return await api.fetcher(input, init);
    }) as typeof fetch;
    await browseOnBrowserbase({ ...ENV, BROWSER_IDLE: namespace }, "/browse", { owner: OWNER, steps: [{ do: "read" }], holder: JOB }, watching);
    expect(during).toEqual({ holder: JOB, until: RUN_LEASE_MS });
  });

  it("lets the next holder in at once after /browse/release", async () => {
    const { namespace } = oneObject(() => 0);
    const env = { ...ENV, BROWSER_IDLE: namespace };
    await browse(env, JOB);
    const released = await browseOnBrowserbase(env, "/browse/release", { owner: OWNER, holder: JOB }, fakeApi().fetcher);
    expect(await released.json()).toEqual({ released: true });
    expect((await browse(env, TURN)).status).not.toBe(409);
  });

  it("runs a call with no holder as before, neither taking nor checking the lease", async () => {
    const { namespace, store } = oneObject(() => 0);
    const env = { ...ENV, BROWSER_IDLE: namespace };
    await browse(env, JOB);
    const api = fakeApi();
    expect((await browse(env, null, api)).status).not.toBe(409);
    expect(api.calls.length).toBeGreaterThan(0);
    expect(store.data.get("lease")).toMatchObject({ holder: JOB });
  });
});
