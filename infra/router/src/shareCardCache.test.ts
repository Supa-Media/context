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
 * **What this does and does not buy, stated carefully because a first draft of
 * this paragraph overstated it.** It is about retitling, not revocation. After
 * a revocation, a request to the *same* URL is served from the entry with no
 * upstream call — before this change and after it, bounded identically by
 * `CARD_CACHE_SECONDS`. Caching cannot be otherwise, and `CLAUDE.md` already
 * accepts that a card once unfurled cannot be recalled. What changes is only
 * the URL nothing has cached, and after a revocation `previewForShare(null)`
 * emits no `imageUrl` at all, so no crawler asks for one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
/**
 * What the control plane was last asked for, and what it hands back.
 *
 * The renderer used to live in this Worker and was mocked here. It does not any
 * more — the card is pre-rendered into the customer's own bucket and this
 * Worker fetches it — so the seam moved from a module mock to the upstream
 * `fetch`, which is what the card path now actually depends on.
 */
let cardRequests: string[] = [];

const ENV = {
  EXPO_ORIGIN: "https://context.expo.app",
  CONVEX_ORIGIN: "https://example-deployment.convex.site",
};

const TOKEN = "a".repeat(64);

/** Every promise the handler handed to `waitUntil`, so a test can await them. */
let scheduled: Promise<unknown>[] = [];

/**
 * A stand-in `ExecutionContext` that **keeps** what it is given.
 *
 * `worker.test.ts`'s version says it "runs the promise rather than discarding
 * it" over a body of `void promise;`, which does neither — and this file copied
 * it. The tests still passed, because a Map-backed `put` resolves without ever
 * yielding; against a `put` that awaits anything at all they both fail. That is
 * a test depending on its own stub being unrealistic, which is the same fault
 * as the comment this PR exists to fix.
 */
const CTX = {
  waitUntil: (promise: Promise<unknown>) => {
    scheduled.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Let the scheduled cache writes finish, the way the runtime would. */
async function settleWrites(): Promise<void> {
  await Promise.all(scheduled);
  scheduled = [];
}

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
        // Yields before writing, as a real `cache.put` does. Without this the
        // tests pass whether or not anything awaits the scheduled work.
        await Promise.resolve();
        store.set(request.url, response.clone());
      },
    },
  };
}

let caches_: ReturnType<typeof cacheStub>;
/** What the control plane currently says this token's title is. */
let title: string | null;
/** The bytes the control plane hands back for a card, or null for a 404. */
let cardBytes: Uint8Array | null;

beforeEach(() => {
  cardRequests = [];
  scheduled = [];
  caches_ = cacheStub();
  vi.stubGlobal("caches", caches_);
  title = "Chapter transition";
  cardBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/share/card")) {
        cardRequests.push(String(init?.body ?? ""));
        return cardBytes === null
          ? new Response(null, { status: 404 })
          : new Response(cardBytes as unknown as BodyInit, { status: 200 });
      }
      return new Response(JSON.stringify({ title }), { status: 200 });
    }),
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

describe("what reaches the renderer, and what reaches the cache key", () => {
  it("collapses junk query variants onto one entry", async () => {
    // The key is rebuilt from the token and a **validated** `v`, so the six
    // spellings below are one card. Keying on the URL as sent would make them
    // six entries, six upstream POSTs and — for anyone holding a real token —
    // six wasm renders, on a path that needs no sign-in.
    for (const query of [
      "?v=aaaaaaaa&x=1",
      "?x=1&v=aaaaaaaa",
      "?v=AAAAAAAA",
      "?v=notavalidhash",
      `?v=${"a".repeat(4000)}`,
      "",
    ]) {
      await (await card(query)).arrayBuffer();
      await settleWrites();
    }

    // Two: the valid `?v=aaaaaaaa` (whatever else rides along with it) and the
    // bare key every malformed one falls back to.
    expect([...caches_.store.keys()].sort()).toEqual([
      `https://context.lc/og/s/${TOKEN}.png`,
      `https://context.lc/og/s/${TOKEN}.png?v=aaaaaaaa`,
    ]);
  });

  /**
   * The card is fetched by **token**, never by title.
   *
   * When the renderer lived here there was a bound to enforce — the edge spent
   * wasm CPU proportional to whatever title it was handed. There is no such
   * exposure now: this Worker sends a token and receives bytes, so a title of
   * any length costs it nothing and never reaches it. The property worth
   * asserting is that the title is not in the request at all.
   */
  it("asks for a card by token, and never sends a title", async () => {
    title = "x".repeat(100_000);
    await (await card("?v=aaaaaaaa")).arrayBuffer();
    await settleWrites();

    expect(cardRequests).toHaveLength(1);
    expect(cardRequests[0]).toBe(JSON.stringify({ token: TOKEN }));
    expect(cardRequests[0]).not.toContain("x".repeat(100));
  });

  it("falls back to the static card when the control plane has none", async () => {
    cardBytes = null;
    const response = await card("?v=aaaaaaaa");
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    // The static product card, which is what every absence renders as.
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("an empty 200 is not a card", async () => {
    // Guarded because an empty body would otherwise be cached and served as a
    // broken image for the whole TTL.
    cardBytes = new Uint8Array(0);
    const bytes = new Uint8Array(await (await card("?v=aaaaaaaa")).arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("still serves a card where there is no cache at all", async () => {
    // `caches` is a global the runtime supplies. Reading `caches.default`
    // unguarded threw out of `fetch` — a 5xx, which is a crawler showing *no
    // card*, the one outcome this handler exists to avoid.
    vi.stubGlobal("caches", undefined);
    const response = await card("?v=aaaaaaaa");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    // The card the control plane returned, served without a cache to put it in.
    // This asserted the *static* card's exact byte length when the renderer
    // lived here and always returned null; now a real card comes back, and the
    // property under test was never the size — it was that the handler answers
    // 200 with an image rather than throwing.
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("serves a card when the colo cache is unavailable", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: async () => {
          throw new Error("colo cache unavailable");
        },
        put: async () => {},
      },
    });
    const response = await card("?v=aaaaaaaa");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });
});

describe("the share card's cache key", () => {
  it("separates one title's card from the next, which is what `?v=` is for", async () => {
    const first = await card("?v=aaaaaaaa");
    await first.arrayBuffer();
    await settleWrites();

    // The owner retitles the share. `preview.ts` hashes the title into the URL
    // precisely so the crawler asks for a different one.
    title = "Something else entirely";
    const second = await card("?v=bbbbbbbb");
    await second.arrayBuffer();
    await settleWrites();

    // Two distinct URLs must be two distinct entries. Collapsing them means the
    // hash buys nothing and the stale card stands for the whole TTL.
    expect(caches_.store.size).toBe(2);
    expect([...caches_.store.keys()]).toEqual([
      `https://context.lc/og/s/${TOKEN}.png?v=aaaaaaaa`,
      `https://context.lc/og/s/${TOKEN}.png?v=bbbbbbbb`,
    ]);
  });

  it("re-resolves the title for a URL it has not cached, and not for one it has", async () => {
    // **What this environment can and cannot establish.** Every response here
    // is the static card — byte-identical at 86,220, which is `og-card.png`
    // itself — so asserting on the *pixels* would pass for the wrong reason no
    // matter what the cache did.
    //
    // The reason, checked rather than guessed after a first draft of this
    // comment blamed WebAssembly: `vitest.config.ts` teaches Vite that a `.png`
    // import is bytes and says nothing about `.ttf`, so `import onest from
    // "./fonts/Onest.ttf"` resolves to the *string* `/src/fonts/Onest.ttf` and
    // `fontCoverage` throws on the `DataView` constructor. satori is never
    // reached at all.
    //
    // The mechanism is observable one level up: whether the control plane was
    // consulted.
    const calls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    await (await card("?v=aaaaaaaa")).arrayBuffer();
    await settleWrites();
    const afterFirst = calls();
    expect(afterFirst).toBeGreaterThan(0);

    // Same URL: served from the entry, control plane untouched. That is the
    // caching, and it is why a card already unfurled cannot be recalled.
    await (await card("?v=aaaaaaaa")).arrayBuffer();
    await settleWrites();
    expect(calls()).toBe(afterFirst);

    // A retitle changes the hash, so the crawler asks for a URL nothing has
    // cached — and that one resolves against the live control plane. With the
    // key ignoring the query it would have been served the old entry instead,
    // which is the whole defect.
    title = "Something else entirely";
    await (await card("?v=bbbbbbbb")).arrayBuffer();
    await settleWrites();
    expect(calls()).toBeGreaterThan(afterFirst);
  });

});
