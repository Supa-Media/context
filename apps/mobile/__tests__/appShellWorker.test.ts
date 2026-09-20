/**
 * THE WORKER THAT SITS IN FRONT OF EVERY REQUEST THE CONSOLE MAKES.
 *
 * `public/sw.js` is the only thing that can answer a navigation with no
 * network, which is what lets a browser tab open on a train at all — every
 * line of `features/offline` is JavaScript, and on the web none of it runs
 * until a document and a 4.5MB bundle have been fetched.
 *
 * It is also, by construction, the most dangerous file in the web app. The
 * drawing editor's own worker says why: *"a bug in it would be a console that
 * serves a stale app shell to everybody."* It is deployed to every visitor, it
 * outlives the page that registered it, and a person cannot get out of a bad
 * one by reloading. So it is tested at the level it actually runs: the real
 * file, evaluated in a sandbox, driven through its own event handlers.
 *
 * Three properties carry the weight, and each is a different kind of failure:
 *
 *  1. **A navigation is network-first.** Online, everybody gets the document
 *     the server has. That is what stops the stale-shell failure the drawing
 *     worker warns about, and it is the reason this may be origin-wide at all.
 *  2. **Every navigation is stored under one key.** The console is a
 *     single-page app, so `?note=1-projects/pay-review.md` is answered by the
 *     same document as `/`. A worker that cached per URL would write a list of
 *     every note somebody opened into `CacheStorage` — outside everything
 *     `forgetLocalCopies` clears at sign-out.
 *  3. **The refusals are a closed set.** Cross-origin, non-`GET`, `/api/`,
 *     `/drawing-assets/`, `Set-Cookie`, redirected, not-`ok`. Each is a way
 *     this becomes a cache of somebody's content rather than of the app.
 *
 * **Sabotage record** (temporary local edits, reverted):
 *
 *  - Keying the shell on `request` instead of `SHELL_KEY` — 1 failure, the
 *    one-key test. Nothing else noticed, which is the point of having it.
 *  - Serving the cached shell before trying the network — 2 failures, but
 *    **only after the test was fixed**: written as one navigation against an
 *    empty cache it caught nothing, because with nothing held the two
 *    precedences behave identically. It now loads the cache first and then
 *    changes what the server says.
 *  - Dropping `/api/` from `NEVER` — 1 failure.
 *  - Folding `activate`'s cleanup and its `clients.claim()` into one `try` —
 *    1 failure. The worker installs and then does not control the page that
 *    installed it, so a first visit leaves nothing behind on exactly the
 *    profiles that most need it to.
 *  - Letting `open()` reject instead of answering `null` — 3 failures, all in
 *    "a browser that refuses storage". That one is the reason this file exists
 *    at the level it does: it is invisible to every test written against a
 *    working `CacheStorage`, and it takes the origin down for private windows
 *    and locked-down profiles rather than for the author.
 *  - Dropping the `response.redirected` guard — 1 failure, "a redirected
 *    response is never stored". Not a rejected navigation: `shell()` already
 *    has a `catch`, so the `cache.put` throw lands there and the person gets
 *    the *offline* answer to a request that succeeded. On the asset path
 *    (`immutable`) there is no such catch and the same throw does reject the
 *    request — both are in the guard's comment in `sw.js`.
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const SOURCE = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://context.lc";

/** A `CacheStorage` that is a Map of Maps, and reports what it was asked. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  /*
    A browser that refuses storage rejects `caches.open` — Safari's private
    windows, blocked site data, an enterprise policy — and a full one rejects
    `put`. Both are reproduced rather than imagined, because both are how a
    service worker takes an origin down for the people least able to clear it.
  */
  const fail = { open: false, put: false };
  const keyOf = (request: RequestInfo | { url: string }) =>
    typeof request === "string" ? request : (request as { url: string }).url;
  return {
    stores,
    fail,
    api: {
      keys: async () => {
        if (fail.open) throw new DOMException("QuotaExceededError");
        return [...stores.keys()];
      },
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        if (fail.open) throw new DOMException("QuotaExceededError");
        if (!stores.has(name)) stores.set(name, new Map());
        const held = stores.get(name)!;
        return {
          match: async (request: RequestInfo) => held.get(keyOf(request)) ?? undefined,
          put: async (request: RequestInfo, response: Response) => {
            if (fail.put) throw new DOMException("QuotaExceededError");
            // The real `cache.put` throws on a redirected response. Reproduced
            // here because that throw is the whole reason `storable` checks it.
            if ((response as Response).redirected) {
              throw new TypeError("Cannot cache a redirected response");
            }
            held.set(keyOf(request), response);
          },
        };
      },
    },
  };
}

interface Worker {
  fire: (type: string, event: Record<string, unknown>) => void;
  caches: ReturnType<typeof fakeCaches>;
  fetches: string[];
  skipWaiting: number;
  claimed: number;
  setFetch: (fn: (request: Request) => Promise<Response>) => void;
}

/** Evaluate the real `sw.js` against fakes, and hand back the controls. */
function load(): Worker {
  const handlers = new Map<string, (event: unknown) => void>();
  const caches = fakeCaches();
  const fetches: string[] = [];
  let answer: (request: Request) => Promise<Response> = async () =>
    new Response("<!doctype html>the shell", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  const counts = { skipWaiting: 0, claimed: 0 };

  const self = {
    location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, handler);
    },
    skipWaiting: () => {
      counts.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        counts.claimed += 1;
      },
    },
  };

  const sandbox = {
    self,
    caches: caches.api,
    fetch: async (request: Request) => {
      fetches.push(typeof request === "string" ? request : request.url);
      return answer(request);
    },
    URL,
    Request,
    Response,
    Headers,
    TypeError,
    DOMException,
    Promise,
  };
  runInContext(SOURCE, createContext(sandbox));

  return {
    fire: (type, event) => {
      const handler = handlers.get(type);
      if (handler === undefined) throw new Error(`sw.js registered no "${type}" handler`);
      handler(event);
    },
    caches,
    fetches,
    get skipWaiting() {
      return counts.skipWaiting;
    },
    get claimed() {
      return counts.claimed;
    },
    setFetch: (fn) => {
      answer = fn;
    },
  };
}

/**
 * A request the worker can read.
 *
 * A plain object rather than a real `Request`, because `mode` and `method` are
 * getter-only on the platform class and `navigate` is not a mode any
 * constructor will accept — the browser sets it, which is exactly the case
 * that matters here. The worker only ever reads `method`, `url` and `mode`,
 * and hands the object to `fetch` and the cache, both of which are fakes.
 */
function fakeRequest(url: string, init: { method?: string; mode?: string } = {}) {
  return { url, method: init.method ?? "GET", mode: init.mode ?? "no-cors" };
}

/** Drive one `fetch` event and return what the worker answered, or `null`. */
async function request(
  worker: Worker,
  url: string,
  init: { method?: string; mode?: string } = {},
): Promise<Response | null> {
  let answered: Promise<Response> | null = null;
  const waits: Promise<unknown>[] = [];
  worker.fire("fetch", {
    request: fakeRequest(url, init),
    respondWith: (value: Promise<Response>) => {
      answered = value;
    },
    waitUntil: (value: Promise<unknown>) => waits.push(value),
  });
  if (answered === null) return null;
  const response = await (answered as Promise<Response>);
  await Promise.all(waits);
  return response;
}

const navigate = (worker: Worker, url: string) => request(worker, url, { mode: "navigate" });

/**
 * Mark a response as having come through a redirect.
 *
 * `defineProperty` rather than assignment: `redirected` is a getter on the
 * prototype, so an own property is the only way to shadow it — and the real
 * `cache.put` refuses exactly this, which is what the fake reproduces.
 */
function redirected(response: Response): Response {
  Object.defineProperty(response, "redirected", { value: true });
  return response;
}

/** Everything currently held, as `cacheName -> [keys]`. */
function held(worker: Worker): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, store] of worker.caches.stores) out[name] = [...store.keys()];
  return out;
}

let worker: Worker;
beforeEach(() => {
  worker = load();
});

describe("taking over", () => {
  test("it claims the load that registered it, rather than the one after", async () => {
    worker.fire("install", {});
    const waits: Promise<unknown>[] = [];
    worker.fire("activate", { waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);

    expect(worker.skipWaiting).toBe(1);
    expect(worker.claimed).toBe(1);
  });

  /**
   * Housekeeping is allowed to fail; taking over is not. Written as one block,
   * a `caches.keys()` rejection on a storage-refusing browser would skip
   * `clients.claim()` — so the worker would not control the page that
   * installed it, and a first visit would leave nothing behind for the train
   * on exactly the profiles that most need it to.
   */
  test("it still claims the page when storage will not answer at all", async () => {
    worker.caches.fail.open = true;
    const waits: Promise<unknown>[] = [];
    worker.fire("activate", { waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);

    expect(worker.claimed).toBe(1);
  });

  test("a cache from an older shape of this worker is dropped, not upgraded", async () => {
    worker.caches.stores.set("context-app-shell-v0", new Map());
    worker.caches.stores.set("context-drawing-editor-v1", new Map());

    const waits: Promise<unknown>[] = [];
    worker.fire("activate", { waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);

    // Its own old cache goes; the drawing editor's is not this worker's to take.
    expect([...worker.caches.stores.keys()]).toEqual(["context-drawing-editor-v1"]);
  });
});

describe("a navigation", () => {
  /**
   * The property that justifies an origin-wide worker existing at all, and the
   * one a naive test cannot see.
   *
   * Written as a single navigation against an empty cache, this passed even
   * with the precedence deliberately inverted — there was nothing held, so
   * "cache first" and "network first" do the same thing. It has to load the
   * cache, *then* change what the server says, and check which one comes back.
   * That is also the real scenario: a deploy, on a device that has been here
   * before.
   */
  test("online, the server's document wins over anything held", async () => {
    worker.setFetch(async () => new Response("yesterday's deploy", { status: 200 }));
    await navigate(worker, `${ORIGIN}/console`);

    worker.setFetch(async () => new Response("today's deploy", { status: 200 }));
    const response = await navigate(worker, `${ORIGIN}/console`);

    expect(await response!.text()).toBe("today's deploy");
  });

  test("and the fresh one replaces what was held, rather than sitting beside it", async () => {
    worker.setFetch(async () => new Response("yesterday's deploy", { status: 200 }));
    await navigate(worker, `${ORIGIN}/console`);
    worker.setFetch(async () => new Response("today's deploy", { status: 200 }));
    await navigate(worker, `${ORIGIN}/console`);

    worker.setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const offline = await navigate(worker, `${ORIGIN}/console`);

    expect(await offline!.text()).toBe("today's deploy");
  });

  test("offline, the last good document is served", async () => {
    await navigate(worker, `${ORIGIN}/console`);
    worker.setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const response = await navigate(worker, `${ORIGIN}/console/@acme?note=1-projects/a.md`);

    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe("<!doctype html>the shell");
  });

  /**
   * Property 2, and the one nothing else would catch. Written as the obvious
   * worker — `cache.put(request, …)` — this test is the only one that fails,
   * and what it is protecting is a list of every context and note path
   * somebody opened, sitting in `CacheStorage` after they signed out.
   */
  test("every navigation is stored under one key, whatever the URL said", async () => {
    await navigate(worker, `${ORIGIN}/console/@acme?note=1-projects/pay-review.md`);
    await navigate(worker, `${ORIGIN}/console/@other?note=0-inbox/offer.md`);
    await navigate(worker, `${ORIGIN}/`);

    expect(held(worker)).toEqual({ "context-app-shell-v1": ["/"] });
  });

  test("a first visit with no network says so, rather than failing silently", async () => {
    worker.setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const response = await navigate(worker, `${ORIGIN}/console`);

    expect(response!.status).toBe(503);
    expect(await response!.text()).toContain("no connection");
  });
});

describe("content-hashed files", () => {
  test("a second request for one is answered without a round trip", async () => {
    const url = `${ORIGIN}/_expo/static/js/web/entry-c41fd75d.js`;
    worker.setFetch(async () => new Response("bundle bytes", { status: 200 }));

    await request(worker, url);
    const again = await request(worker, url);

    expect(await again!.text()).toBe("bundle bytes");
    expect(worker.fetches).toEqual([url]);
  });

  test("assets are treated the same, because their names are hashed too", async () => {
    const url = `${ORIGIN}/assets/__node_modules/back-icon.35ba0eae.png`;
    worker.setFetch(async () => new Response("png", { status: 200 }));

    await request(worker, url);
    await request(worker, url);

    expect(worker.fetches).toHaveLength(1);
  });
});

describe("what it refuses to touch", () => {
  test.each([
    ["a cross-origin request", "https://fonts.googleapis.com/css2?family=Instrument+Sans", {}],
    ["the control plane", `${ORIGIN}/api/auth/signin/email`, {}],
    ["the drawing editor's own scope", `${ORIGIN}/drawing-assets/editor/index.html`, {}],
    ["anything that is not a GET", `${ORIGIN}/_expo/static/js/web/x.js`, { method: "POST" }],
  ])("%s is passed straight through", async (_label, url, init) => {
    const response = await request(worker, url, init);

    expect(response).toBeNull();
    expect(worker.fetches).toEqual([]);
    expect(held(worker)).toEqual({});
  });

  test("a navigation to /api is not answered from the shell either", async () => {
    await navigate(worker, `${ORIGIN}/`);

    const response = await navigate(worker, `${ORIGIN}/api/auth/callback/resend`);

    expect(response).toBeNull();
  });

  test.each([
    [
      "a response carrying Set-Cookie",
      () => new Response("shell", { status: 200, headers: { "Set-Cookie": "session=abc" } }),
    ],
    ["a response that is not ok", () => new Response("nope", { status: 503 })],
    ["a redirected response", () => redirected(new Response("shell", { status: 200 }))],
  ])("%s is never stored", async (_label, make) => {
    worker.setFetch(async () => make() as Response);

    const response = await navigate(worker, `${ORIGIN}/console`);

    // Answered — the person still gets whatever the server said — but nothing
    // was kept, so a later offline load falls through to the 503 rather than
    // replaying it for ever.
    expect(response).not.toBeNull();
    expect(held(worker)["context-app-shell-v1"] ?? []).toEqual([]);
  });

  /**
   * The redirect case is not merely "not stored": `cache.put` **throws** on
   * one, and a throw inside `respondWith` is a navigation that fails. Without
   * the guard this is a page that does not load, which is why it is checked
   * here as an answered navigation rather than only as an empty cache.
   */
  test("a redirected response still resolves the navigation", async () => {
    worker.setFetch(async () => redirected(new Response("shell", { status: 200 })));

    await expect(navigate(worker, `${ORIGIN}/console`)).resolves.not.toBeNull();
  });
});

/**
 * THE FAILURE MODE THAT IS NOT A CACHE MISS.
 *
 * A service worker survives the tab and cannot be reloaded out of, so a
 * rejection inside `respondWith` is not a slow page — it is an origin that
 * will not load until a fix is deployed *and* picked up. The browsers that
 * reject `caches.open` are private windows and locked-down profiles: exactly
 * the people who cannot be walked through clearing site data.
 *
 * Written the obvious way, with `await caches.open(CACHE)` at the top of each
 * handler and outside its `try`, every one of them gets a broken origin. These
 * are the tests that say otherwise.
 */
describe("a browser that refuses storage", () => {
  test("still gets the document, straight from the network", async () => {
    worker.caches.fail.open = true;
    worker.setFetch(async () => new Response("the real document", { status: 200 }));

    const response = await navigate(worker, `${ORIGIN}/console`);

    expect(await response!.text()).toBe("the real document");
  });

  test("still gets the bundle", async () => {
    worker.caches.fail.open = true;
    worker.setFetch(async () => new Response("bundle bytes", { status: 200 }));

    const response = await request(worker, `${ORIGIN}/_expo/static/js/web/entry-abc.js`);

    expect(await response!.text()).toBe("bundle bytes");
  });

  test("and offline it says so, rather than failing the navigation", async () => {
    worker.caches.fail.open = true;
    worker.setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const response = await navigate(worker, `${ORIGIN}/console`);

    expect(response!.status).toBe(503);
  });

  /**
   * The half-broken case, which is the more likely one: storage opens and then
   * a write does not fit. The response has already been fetched, so failing
   * here would throw away a perfectly good answer to save a cache entry.
   */
  test("a full cache costs the storing, never the response", async () => {
    worker.caches.fail.put = true;
    worker.setFetch(async () => new Response("the real document", { status: 200 }));

    const response = await navigate(worker, `${ORIGIN}/console`);

    expect(await response!.text()).toBe("the real document");
    expect(held(worker)["context-app-shell-v1"] ?? []).toEqual([]);
  });
  /**
   * THE KEY IS ONE KEY, AND THE ENTRY UNDER IT CARRIES A URL OF ITS OWN.
   *
   * The privacy argument at the top of `sw.js` is that the shell lives under a
   * single constant key, so `CacheStorage` cannot become "a list of every
   * context and every note path somebody had opened". The key half of that is
   * true and is held by the one-key test above.
   *
   * A `Response` also carries its own `url`, and `cache.put` stores the
   * response. Measured in Chromium rather than reasoned about: after
   * `cache.put(SHELL_KEY, fetched)`, `(await cache.match(SHELL_KEY)).url` is
   * the URL the document was fetched from — on this product a context slug and
   * a note path, since `/console/@someone?note=1-projects/pay-review.md` is a
   * navigation like any other and a reload on an open note is a navigation.
   *
   * One entry, so one path rather than the history the file was written to
   * prevent — and it sits in the cache the file argues has "nothing in it to
   * leak and nothing worth clearing at sign-out", which is why the claim
   * mattered enough to check.
   *
   * The fake cache cannot show this on its own: a `Response` built in Node has
   * an empty `url`, so the network answer here is given one the way a browser
   * would, with the same `defineProperty` device `redirected()` above uses.
   */
  test("the stored shell carries no note path in its own url", async () => {
    const opened = `${ORIGIN}/console/@seyi?note=1-projects/pay-review.md`;
    /*
      `url` is set on the clone as well as on the original, because `store()`
      caches `response.clone()` and a clone of a Node-built `Response` reports
      an empty `url`. Without that, this case passes against the unfixed worker
      and proves nothing — it did, on the first run, which is why the harness
      models the platform here rather than the other way round.
    */
    const withUrl = (body: string) => {
      const response = new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
      Object.defineProperty(response, "url", { value: opened });
      const clone = response.clone.bind(response);
      Object.defineProperty(response, "clone", {
        value: () => {
          const copy = clone();
          Object.defineProperty(copy, "url", { value: opened });
          return copy;
        },
      });
      return response;
    };
    worker.setFetch(async () => withUrl("<!doctype html>the shell"));

    await navigate(worker, opened);

    const stored = worker.caches.stores.get("context-app-shell-v1")!.get("/")!;
    expect(stored.url).not.toContain("pay-review");
    expect(stored.url).not.toContain("@seyi");
    // And the shell is still a usable shell: the point is to drop the label,
    // not the document.
    expect(await stored.clone().text()).toBe("<!doctype html>the shell");
    expect(stored.status).toBe(200);
    expect(stored.headers.get("Content-Type")).toBe("text/html");
  });
});
