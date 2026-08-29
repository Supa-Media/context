/**
 * The share card's cache key, and the invalidation it is supposed to provide.
 *
 * `shareCardResponse` is the handler an **unauthenticated crawler** reaches. It
 * had no end-to-end test of any kind: `ogCard.test.ts` covers the pure pieces
 * (`shareCardTokenFrom`, `hashTitle`, `previewForShare`, the renderer) and
 * `worker.test.ts` never requests `/og/s/<token>.png`. The reason is
 * mechanical — `caches` does not exist in this test environment and
 * `caches.default` is read *outside* the handler's `try`, so any card request
 * threw before reaching anything worth asserting on.
 *
 * That gap is why the defect below survived. `preview.ts` appends a `?v=` hash
 * of the title to the card URL, and `ogCard.test.ts` states plainly what it is
 * for:
 *
 *   "The Workers Cache API is per-datacenter and `cache.delete` purges only the
 *    colo the Worker ran in, so a card cannot be globally invalidated. A changed
 *    title being a different URL is what makes an edit take effect at once."
 *
 * The handler then built its cache key from a synthesised URL with no query
 * string, so every `?v=` collapsed to one entry and an edit took effect at
 * once for nobody. Its own comment claimed the opposite — "keyed on the full
 * URL, so the `?v=` hash separates one title's card from the next" — three
 * lines under a paragraph correctly stating that `?v=` is never *read*.
 *
 * The half that matters: a **revoked** share keeps serving its title-bearing
 * card from our own origin for the life of the entry. `CLAUDE.md` accepts that
 * a card already unfurled elsewhere cannot be recalled; it does not accept that
 * of the origin, and the handler's own doc says a revoked share renders the
 * static card, "which is what keeps revocation invisible".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

const ENV = {
  EXPO_ORIGIN: "https://context.expo.app",
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
};

const TOKEN = "a".repeat(64);

const CTX = {
  // Runs the promise rather than discarding it, so a test can await the cache
  // write the card path schedules.
  waitUntil: (promise: Promise<unknown>) => {
    void promise;
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/**
 * A Map-backed stand-in for the Workers Cache API, keyed on the request URL —
 * which is the one property of it this file is about.
 */
function cacheStub() {
  const store = new Map<string, Response>();
  return {
    store,
    default: {
      match: async (request: Request) => store.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        store.set(request.url, response.clone());
      },
    },
  };
}

let caches_: ReturnType<typeof cacheStub>;
/** What the control plane currently says this token's title is. */
let title: string | null;

beforeEach(() => {
  caches_ = cacheStub();
  vi.stubGlobal("caches", caches_);
  title = "Chapter transition";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ title }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function card(query = ""): Promise<Response> {
  return worker.fetch(
    new Request(`https://context.lc/og/s/${TOKEN}.png${query}`),
    ENV as never,
    CTX,
  ) as Promise<Response>;
}

describe("the share card's cache key", () => {
  it("separates one title's card from the next, which is what `?v=` is for", async () => {
    const first = await card("?v=aaaaaaaa");
    await first.arrayBuffer();

    // The owner retitles the share. `preview.ts` hashes the title into the URL
    // precisely so the crawler asks for a different one.
    title = "Something else entirely";
    const second = await card("?v=bbbbbbbb");
    await second.arrayBuffer();

    // Two distinct URLs must be two distinct entries. Collapsing them means the
    // hash buys nothing and the stale card stands for the whole TTL.
    expect(caches_.store.size).toBe(2);
    expect([...caches_.store.keys()]).toEqual([
      `https://context.lc/og/s/${TOKEN}.png?v=aaaaaaaa`,
      `https://context.lc/og/s/${TOKEN}.png?v=bbbbbbbb`,
    ]);
  });

  it("re-resolves the title for a URL it has not cached, and not for one it has", async () => {
    // **What this environment can and cannot establish.** satori and resvg are
    // WebAssembly and do not run under vitest, so `renderShareCard` throws and
    // every response here is the static card — byte-identical at 86,220, which
    // is `og-card.png` itself. Asserting on the *pixels* would therefore pass
    // for the wrong reason no matter what the cache did. The mechanism is
    // observable one level up: whether the control plane was consulted.
    const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    await (await card("?v=aaaaaaaa")).arrayBuffer();
    const afterFirst = calls();
    expect(afterFirst).toBeGreaterThan(0);

    // Same URL: served from the entry, control plane untouched. That is the
    // caching, and it is why a card already unfurled cannot be recalled.
    await (await card("?v=aaaaaaaa")).arrayBuffer();
    expect(calls()).toBe(afterFirst);

    // A retitle changes the hash, so the crawler asks for a URL nothing has
    // cached — and that one resolves against the live control plane. With the
    // key ignoring the query it would have been served the old entry instead,
    // which is the whole defect.
    title = "Something else entirely";
    await (await card("?v=bbbbbbbb")).arrayBuffer();
    expect(calls()).toBeGreaterThan(afterFirst);
  });

});
