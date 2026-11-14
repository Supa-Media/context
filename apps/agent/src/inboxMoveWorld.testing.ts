import { placeGate, type GatewayFetch, type MoveStorage } from "./inboxMove";

/** A Durable Object's key-value storage and alarm, in memory. */
export function memoryStorage(): MoveStorage & { data: Map<string, unknown>; alarm: number | null } {
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
export class TestInbox {
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
    const opened = await placeGate(request, this.storage, (name) => this.world.stub(name), this.busy, block, () => this.world.now, this.world.gateway);
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

export class World {
  now = 1_000_000;
  inboxes = new Map<string, TestInbox>();
  calls: string[] = [];
  fail: ((name: string, path: string) => Response | null) | null = null;
  /** The gateway binding a gateway-moved inbox forwards to; absent until a test gives one. */
  gateway: GatewayFetch | undefined = undefined;
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

export const PHONE = "+15555550100";

export async function oldInboxWith(world: World) {
  const old = world.inbox(PHONE);
  await old.storage.put("pending:1", { text: "hi", at: 5, tags: ["a"], nested: { n: 1, flag: true, none: null } });
  await old.storage.put("media:chunk:0", new Uint8Array([1, 2, 3, 250]));
  await old.storage.put("count", 3);
  await old.storage.setAlarm(1_234_567);
  return old;
}

