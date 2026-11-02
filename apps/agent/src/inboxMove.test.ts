import { describe, expect, test } from "vitest";
import { KEEP_OLD_MS, PLACE_KEY, RETRY_MOVE_MS, decodeValue, encodeValue, movedAlarm, placeGate, type MoveStorage, type Place } from "./inboxMove";

/** A Durable Object's key-value storage and alarm, in memory. */
function memoryStorage(): MoveStorage & { data: Map<string, unknown>; alarm: number | null } {
  const data = new Map<string, unknown>();
  const store = {
    data,
    alarm: null as number | null,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrEntries === "string") data.set(keyOrEntries, structuredClone(value));
      else for (const [key, item] of Object.entries(keyOrEntries)) data.set(key, structuredClone(item));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async deleteAll() {
      data.clear();
    },
    async list<T>(options: { prefix?: string } = {}) {
      const out = new Map<string, T>();
      for (const key of [...data.keys()].sort()) if (key.startsWith(options.prefix ?? "")) out.set(key, data.get(key) as T);
      return out;
    },
    async getAlarm() {
      return store.alarm;
    },
    async setAlarm(at: number) {
      store.alarm = at;
    },
    async deleteAlarm() {
      store.alarm = null;
    },
  };
  return store as never;
}

/**
 * A tiny inbox, gated as `SenderInbox` is: `POST /put?k=` keeps the body,
 * `GET /get?k=` answers it, `POST /slow` holds a call open until released.
 */
class TestInbox {
  storage = memoryStorage();
  busy = 0;
  served = 0;
  release: (() => void) | null = null;
  constructor(private readonly world: World) {}
  async fetch(request: Request): Promise<Response> {
    let gate = Promise.resolve();
    const block = <T>(run: () => Promise<T>) => {
      const turn = gate.then(run);
      gate = turn.then(() => {}, () => {});
      return turn;
    };
    const opened = await placeGate(request, this.storage, (name) => this.world.stub(name), this.busy, block, () => this.world.now);
    if ("response" in opened) return opened.response;
    this.busy += 1;
    try {
      this.served += 1;
      const url = new URL(opened.request.url);
      if (url.pathname === "/put") {
        await this.storage.put(url.searchParams.get("k")!, await opened.request.text());
        return new Response("ok");
      }
      if (url.pathname === "/slow") {
        await new Promise<void>((resolve) => (this.release = resolve));
        return new Response("slow");
      }
      return new Response(String((await this.storage.get(url.searchParams.get("k")!)) ?? ""));
    } finally {
      this.busy -= 1;
    }
  }
}

class World {
  now = 1_000_000;
  inboxes = new Map<string, TestInbox>();
  calls: string[] = [];
  fail: ((name: string, path: string) => Response | null) | null = null;
  inbox(name: string) {
    if (!this.inboxes.has(name)) this.inboxes.set(name, new TestInbox(this));
    return this.inboxes.get(name)!;
  }
  stub(name: string) {
    return {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        this.calls.push(`${name} ${path}`);
        const failed = this.fail?.(name, path) ?? null;
        if (failed) return failed;
        return await this.inbox(name).fetch(request);
      },
    };
  }
  /** The Worker's own stub (`inboxByName`): the placed name, naming the inbox. */
  placed(name: string) {
    return {
      fetch: (url: string, init?: RequestInit) => {
        const request = new Request(url, init);
        request.headers.set("x-inbox-name", name);
        return this.stub(`enam:${name}`).fetch(request);
      },
    };
  }
}

const PHONE = "+15555550100";

async function oldInboxWith(world: World) {
  const old = world.inbox(PHONE);
  await old.storage.put("pending:1", { text: "hi", at: 5, tags: ["a"], nested: { n: 1, flag: true, none: null } });
  await old.storage.put("media:chunk:0", new Uint8Array([1, 2, 3, 250]));
  await old.storage.put("count", 3);
  await old.storage.setAlarm(1_234_567);
  return old;
}

describe("moving a texting inbox to US East", () => {
  test("the first call copies the idle old inbox whole, checked, alarm too, and the old one passes later calls on", async () => {
    const world = new World();
    const old = await oldInboxWith(world);
    expect(await (await world.placed(PHONE).fetch("https://inbox/get?k=count")).text()).toBe("3");
    const placed = world.inbox(`enam:${PHONE}`);
    expect(placed.storage.data.get("pending:1")).toEqual({ text: "hi", at: 5, tags: ["a"], nested: { n: 1, flag: true, none: null } });
    expect(placed.storage.data.get("media:chunk:0")).toEqual(new Uint8Array([1, 2, 3, 250]));
    expect(placed.storage.alarm).toBe(1_234_567);
    expect((placed.storage.data.get(PLACE_KEY) as Place).arrivedAt).toBe(world.now);
    const left = old.storage.data.get(PLACE_KEY) as Place;
    expect(left.movedTo).toBe(`enam:${PHONE}`);
    expect(old.storage.alarm).toBe(world.now + KEEP_OLD_MS);

    // A late call by the old name or id: passed on, never kept in the old copy.
    await world.stub(PHONE).fetch(new Request("https://inbox/put?k=late", { method: "POST", body: "x" }));
    expect(placed.storage.data.get("late")).toBe("x");
    expect(old.storage.data.has("late")).toBe(false);
  });

  test("an old inbox with work running is not moved; the call is answered there, and the move is tried again later", async () => {
    const world = new World();
    const old = await oldInboxWith(world);
    const slow = world.stub(PHONE).fetch(new Request("https://inbox/slow", { method: "POST" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(old.busy).toBe(1);
    await world.placed(PHONE).fetch("https://inbox/put?k=during", { method: "POST", body: "kept" });
    expect(old.storage.data.get("during")).toBe("kept");
    expect(old.storage.data.has(PLACE_KEY)).toBe(false);
    const placed = world.inbox(`enam:${PHONE}`);
    expect([...placed.storage.data.keys()]).toEqual([PLACE_KEY]);
    old.release!();
    await slow;
    // Too soon: still answered by the old one, no second ask.
    world.calls.length = 0;
    await world.placed(PHONE).fetch("https://inbox/get?k=count");
    expect(world.calls.filter((call) => call.endsWith("/__move_out"))).toEqual([]);
    world.now += RETRY_MOVE_MS;
    expect(await (await world.placed(PHONE).fetch("https://inbox/get?k=during")).text()).toBe("kept");
    expect((placed.storage.data.get(PLACE_KEY) as Place).arrivedAt).toBeDefined();
  });

  test("a value the copy cannot carry fails the move, nothing is kept in the new inbox, and the old one takes its calls again", async () => {
    const world = new World();
    const old = await oldInboxWith(world);
    await old.storage.put("odd", new Map([["a", 1]]));
    expect(await (await world.placed(PHONE).fetch("https://inbox/get?k=count")).text()).toBe("3");
    // Refused before it was marked: the Map is read while the old one dumps, so it is answered as a failure there.
    const placed = world.inbox(`enam:${PHONE}`);
    expect([...placed.storage.data.keys()]).toEqual([PLACE_KEY]);
    expect(old.storage.data.has(PLACE_KEY)).toBe(false);
    expect(old.storage.alarm).toBe(1_234_567);
  });

  test("a copy that does not match the old inbox is thrown away and the old inbox is restored, alarm and all", async () => {
    const world = new World();
    const old = await oldInboxWith(world);
    let garble = true;
    const realStub = world.stub.bind(world);
    world.stub = (name: string) => ({
      fetch: async (request: Request) => {
        const answer = await realStub(name).fetch(request);
        if (!garble || !new URL(request.url).pathname.endsWith("/__move_out")) return answer;
        const body = (await answer.json()) as { entries: Record<string, unknown> };
        body.entries.count = 4;
        return Response.json(body);
      },
    });
    expect(await (await world.placed(PHONE).fetch("https://inbox/get?k=count")).text()).toBe("3");
    const placed = world.inbox(`enam:${PHONE}`);
    expect([...placed.storage.data.keys()]).toEqual([PLACE_KEY]);
    expect(old.storage.data.has(PLACE_KEY)).toBe(false);
    expect(old.storage.alarm).toBe(1_234_567);
    garble = false;
    world.now += RETRY_MOVE_MS;
    expect(await (await world.placed(PHONE).fetch("https://inbox/get?k=count")).text()).toBe("3");
    expect(placed.storage.data.get("count")).toBe(3);
  });

  test("the old inbox's alarm runs nothing once moved, and clears the old copy after three days", async () => {
    const world = new World();
    const old = await oldInboxWith(world);
    await world.placed(PHONE).fetch("https://inbox/get?k=count");
    expect(await movedAlarm(old.storage, world.now + 10)).toBe(true);
    expect(old.storage.data.get("count")).toBe(3);
    expect(await movedAlarm(old.storage, world.now + KEEP_OLD_MS)).toBe(true);
    expect([...old.storage.data.keys()]).toEqual([PLACE_KEY]);
    expect(old.storage.alarm).toBeNull();
    // A late call still finds where it went.
    expect(await (await world.stub(PHONE).fetch(new Request("https://inbox/get?k=count"))).text()).toBe("3");
  });

  test("a call through the Worker's stub can never ask an inbox to move out or back", async () => {
    const world = new World();
    const old = await oldInboxWith(world);
    await world.placed(PHONE).fetch("https://inbox/get?k=count");
    for (const path of ["/__move_out", "/__move_back"]) {
      const answer = await world.placed(PHONE).fetch(`https://inbox${path}`, { method: "POST", body: JSON.stringify({ name: PHONE }) });
      expect(answer.status).toBe(400);
    }
    const placed = world.inbox(`enam:${PHONE}`);
    expect((placed.storage.data.get(PLACE_KEY) as Place).movedTo).toBeUndefined();
    expect(placed.storage.data.get("count")).toBe(3);
    expect((old.storage.data.get(PLACE_KEY) as Place).movedTo).toBe(`enam:${PHONE}`);
    // And an arrived inbox asked directly refuses too.
    expect((await world.stub(`enam:${PHONE}`).fetch(new Request("https://inbox/__move_out", { method: "POST", body: JSON.stringify({ name: "x" }) }))).status).toBe(400);
  });

  test("a brand-new inbox arrives empty after one ask to an empty old name", async () => {
    const world = new World();
    await world.placed("+15555550199").fetch("https://inbox/put?k=a", { method: "POST", body: "1" });
    expect(world.inbox("enam:+15555550199").storage.data.get("a")).toBe("1");
  });

  test("values are carried exactly, and anything else is refused rather than changed", () => {
    const value = { a: [1, "x", null, true, { b: new Uint8Array([0, 255]) }] };
    expect(decodeValue(JSON.parse(JSON.stringify(encodeValue(value))))).toEqual(value);
    for (const bad of [new Map(), new Set(), new Date(0), NaN, Infinity, () => 1, new ArrayBuffer(2), { __bytes: "x" }]) {
      expect(() => encodeValue(bad)).toThrow();
    }
  });
});

test("the Worker reaches every inbox under its placed name, in eastern North America, naming the inbox", async () => {
  const { inboxByName } = await import("./objectPlace");
  const seen: [string, string | undefined, string | null][] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string, options?: { locationHint?: string }) => ({
      fetch: async (input: RequestInfo, init?: RequestInit) => {
        seen.push([id, options?.locationHint, new Headers(init?.headers ?? (input as Request).headers).get("x-inbox-name")]);
        return new Response(null);
      },
    }),
  } as unknown as DurableObjectNamespace;
  await inboxByName(namespace, PHONE).fetch("https://inbox/accept", { method: "POST", body: "{}" });
  await inboxByName(namespace, "job:j1").fetch(new Request("https://inbox/job-pass"));
  expect(seen).toEqual([
    [`enam:${PHONE}`, "enam", PHONE],
    ["enam:job:j1", "enam", "job:j1"],
  ]);
});
