/**
 * THE DRAWING EDITOR, OFFLINE.
 *
 * The editor is a page fetched on demand rather than part of the console, for
 * a measured reason: bundling it took the console's web JavaScript from 5.7MB
 * to 14.6MB on every page load. The cost of that, stated when it shipped, was
 * that **editing a drawing needed a network**. A service worker scoped to the
 * editor's own directory closes the gap without giving the 14.6MB back.
 *
 * A worker is a file the browser runs, so the thing worth testing is not that
 * it registers. It is the three decisions inside it, each of which is a way to
 * make the console worse than it was:
 *
 *  1. **What it will answer for.** Its scope is `/drawing-assets/editor/` and
 *     nothing else. A worker that answered for the origin would sit in front of
 *     every console request, and a bug in it would serve a stale app shell to
 *     people who never open a drawing.
 *  2. **What it stores.** A failed response cached here is served offline for
 *     ever, which is worse than not answering at all.
 *  3. **That it still revalidates.** `editor.js` keeps its name across deploys,
 *     so cache-first with no refresh pins somebody to the version they first
 *     opened.
 *
 * ## How a worker is tested at all
 *
 * By running it. The file is loaded into a `vm` context carrying a fake `self`
 * that records its listeners, so the handlers under test are the ones the
 * browser would run rather than a copy of them written for the test. `caches`
 * and `fetch` are stubs the assertions read afterwards.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests here.
 *
 *   `cacheable` dropping the same-origin check                      1
 *   `cacheable` dropping the scope check                            1
 *   caching a response regardless of `response.ok`                  1
 *   returning the cache hit without refetching                      1
 *   awaiting the refetch before answering from the cache            1
 *
 * The first row started at **zero**, and is the reason this record is run
 * rather than written. The cross-origin case used a URL whose path was also
 * out of scope, so the scope clause refused it and the origin clause was never
 * reached: deleting that clause passed every check in this file. The URL now
 * sits inside the scope by path and outside it by host, so only the clause
 * under test can refuse it.
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const SW = path.join(__dirname, "..", "drawing-editor", "sw.js");
const ORIGIN = "https://context.lc";
const SCOPE = `${ORIGIN}/drawing-assets/editor/`;

interface Recorded {
  listeners: Record<string, (event: unknown) => void>;
  puts: string[];
  fetched: string[];
  deleted: string[];
}

/** A `Response`-ish object, since jsdom is not loaded for this file. */
function response(body: string, ok = true) {
  return { ok, body, clone: () => response(body, ok) };
}

/**
 * Load the worker with a fake global, and hand back what it registered.
 *
 * `cache` is what is already stored, keyed by URL; `network` is what a fetch
 * would answer, and a URL missing from it is a network that is down.
 */
function load(options: {
  cache?: Record<string, unknown>;
  network?: Record<string, { body: string; ok?: boolean }>;
}): Recorded {
  const stored: Record<string, unknown> = { ...(options.cache ?? {}) };
  const recorded: Recorded = { listeners: {}, puts: [], fetched: [], deleted: [] };

  const cache = {
    match: async (request: { url: string }) => stored[request.url],
    put: async (request: { url: string }, value: unknown) => {
      recorded.puts.push(request.url);
      stored[request.url] = value;
    },
  };

  const context = {
    self: {
      location: { href: `${SCOPE}sw.js`, origin: ORIGIN },
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        recorded.listeners[type] = handler;
      },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => cache,
      keys: async () => ["context-drawing-editor-v1", "context-drawing-editor-v0", "other"],
      delete: async (name: string) => {
        recorded.deleted.push(name);
        return true;
      },
    },
    fetch: async (request: { url: string }) => {
      recorded.fetched.push(request.url);
      const answer = (options.network ?? {})[request.url];
      if (answer === undefined) throw new Error("offline");
      return response(answer.body, answer.ok ?? true);
    },
    URL,
    Response: class {
      status: number;
      constructor(_body: string, init?: { status?: number }) {
        this.status = init?.status ?? 200;
      }
    },
    Promise,
  };

  vm.createContext(context);
  vm.runInContext(readFileSync(SW, "utf8"), context);
  return recorded;
}

/** Drive the fetch handler and return what it answered with. */
async function handle(
  recorded: Recorded,
  url: string,
  method = "GET",
): Promise<{ answered: boolean; value: unknown; waited: unknown[] }> {
  let answered = false;
  let value: unknown = undefined;
  const waited: unknown[] = [];
  recorded.listeners.fetch?.({
    request: { url, method },
    respondWith: (promise: unknown) => {
      answered = true;
      value = promise;
    },
    waitUntil: (promise: unknown) => waited.push(promise),
  });
  return { answered, value: answered ? await value : undefined, waited };
}

describe("what the worker will answer for", () => {
  let sw: Recorded;
  beforeEach(() => {
    sw = load({ network: { [`${SCOPE}editor.js`]: { body: "fresh" } } });
  });

  test("its own directory, which is the whole of its reach", async () => {
    expect((await handle(sw, `${SCOPE}editor.js`)).answered).toBe(true);
  });

  test("not the console around it", async () => {
    // The positive control above matters here: without it this passes on a
    // worker that answers for nothing at all.
    expect((await handle(sw, `${ORIGIN}/index.html`)).answered).toBe(false);
    expect((await handle(sw, `${ORIGIN}/console/@seyi`)).answered).toBe(false);
    expect((await handle(sw, `${ORIGIN}/drawing-assets/other/x.js`)).answered).toBe(false);
  });

  test("nothing on another origin, even at the same path", async () => {
    /*
      `#503` verified this page makes zero requests off our own origin, fonts
      included. A worker that cached one would be a way for that to stop being
      true without anybody noticing.

      **The path has to match for this to test anything.** The first version of
      this check used `https://esm.sh/excalidraw`, whose path is nowhere near
      the scope — so the scope clause refused it and the origin clause was
      never reached. Deleting the origin check passed the whole file. This URL
      is in scope by path and off-origin by host, so only the origin clause can
      refuse it.
    */
    expect((await handle(sw, "https://esm.sh/drawing-assets/editor/editor.js")).answered).toBe(
      false,
    );
    expect((await handle(sw, "https://esm.sh/excalidraw")).answered).toBe(false);
  });

  test("and never a write", async () => {
    expect((await handle(sw, `${SCOPE}editor.js`, "POST")).answered).toBe(false);
  });
});

describe("what it stores, and what it refuses to", () => {
  test("a good response is kept", async () => {
    const sw = load({ network: { [`${SCOPE}editor.js`]: { body: "fresh" } } });
    await handle(sw, `${SCOPE}editor.js`);
    await Promise.resolve();
    expect(sw.puts).toEqual([`${SCOPE}editor.js`]);
  });

  test("a 404 is not", async () => {
    // Cached, this is a 404 served offline for ever — a drawing that never
    // opens again on that device, from one bad deploy.
    const sw = load({ network: { [`${SCOPE}editor.js`]: { body: "gone", ok: false } } });
    await handle(sw, `${SCOPE}editor.js`);
    await Promise.resolve();
    expect(sw.puts).toEqual([]);
  });
});

describe("offline, and still fresh", () => {
  test("a stored page is answered without waiting for the network", async () => {
    const sw = load({
      cache: { [`${SCOPE}index.html`]: response("stored") },
      network: { [`${SCOPE}index.html`]: { body: "fresh" } },
    });
    const { value, waited } = await handle(sw, `${SCOPE}index.html`);
    expect((value as { body: string }).body).toBe("stored");
    // The refetch is handed to `waitUntil` rather than awaited: awaiting it is
    // network-first wearing a cache's clothes, and offline it would hang.
    expect(waited).toHaveLength(1);
  });

  test("and is refetched anyway, because the filenames never change", async () => {
    const sw = load({
      cache: { [`${SCOPE}editor.js`]: response("stored") },
      network: { [`${SCOPE}editor.js`]: { body: "fresh" } },
    });
    const { waited } = await handle(sw, `${SCOPE}editor.js`);
    await Promise.all(waited);
    expect(sw.fetched).toEqual([`${SCOPE}editor.js`]);
    expect(sw.puts).toEqual([`${SCOPE}editor.js`]);
  });

  test("with nothing stored and no network, it says so rather than hanging", async () => {
    // First open on a plane. The console watches for exactly this and falls
    // back to `DrawingView`, so the drawing is still readable.
    const sw = load({});
    const { value } = await handle(sw, `${SCOPE}index.html`);
    expect((value as { status: number }).status).toBe(504);
  });
});

describe("an older cache is dropped rather than upgraded", () => {
  test("activate deletes this worker's previous versions and nothing else", async () => {
    const sw = load({});
    const waited: unknown[] = [];
    sw.listeners.activate?.({ waitUntil: (promise: unknown) => waited.push(promise) });
    await Promise.all(waited);
    // Its own old cache goes; a cache belonging to anything else is not this
    // worker's to delete.
    expect(sw.deleted).toEqual(["context-drawing-editor-v0"]);
  });
});
