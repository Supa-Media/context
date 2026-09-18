/**
 * The console's app shell, so the app can *start* with no network.
 *
 * ## What was missing, and why nothing else could fix it
 *
 * `features/offline` holds the customer's notes on the device, and since the
 * remembered context list landed it can serve them on a cold start. All of
 * that is JavaScript, and on the web JavaScript does not run until the browser
 * has fetched a document and a 4.5MB bundle over the network. So a browser tab
 * opened on a train showed the browser's own "you are offline" page, with a
 * complete copy of somebody's notes sitting in `localStorage` one origin away
 * and no code running to read it.
 *
 * A service worker is the only thing that can answer a navigation with no
 * network. This is that worker, and it is deliberately the smallest one that
 * closes the gap.
 *
 * ## Why an origin-wide worker, when the drawing editor's own worker argues
 * against exactly that
 *
 * `drawing-editor/sw.js` says it plainly: *"A worker registered at the origin
 * root would sit in front of every request the console makes, and a bug in it
 * would be a console that serves a stale app shell to everybody."* That
 * warning is right, and it is the reason this file is shaped the way it is
 * rather than a reason not to write it.
 *
 * The danger it names is **staleness**, and it comes from a fact about that
 * page rather than about workers: `editor.js` and `editor.css` keep their
 * names across deploys, so a cache-first worker pins you to whatever you first
 * fetched. The console has the opposite property — `infra/router` marks
 * `/_expo/` immutable precisely because *"the filename changes when the bytes
 * do"* — so the only unhashed thing here is the document, and the document is
 * the one thing this worker fetches from the network first, every time it can.
 *
 * So the split is:
 *
 *  - **A navigation is network-first.** Online you always get the document the
 *    server has, which is the one naming the current bundle. A deploy is
 *    picked up by the next online load, with no version lag at all.
 *  - **`/_expo/` and `/assets/` are cache-first.** Their names contain a hash
 *    of their bytes, so a cached one can never be the wrong version of
 *    anything: a deploy asks for different names.
 *
 * A stale shell is therefore only ever served when the alternative is nothing,
 * and it points at hashed assets that are cached beside it.
 *
 * ## The one document, under one key — this is a privacy property
 *
 * The console is a single-page app: `/`, `/console`, `/console/@someone` and
 * `/console/@someone?note=1-projects/pay-review.md` are all answered by the
 * same `index.html`. The obvious worker caches a navigation under its own URL,
 * and the obvious worker would therefore build, in `CacheStorage`, a list of
 * every context and every note path somebody had opened — a browsing history
 * of their private notes, written by us, outside everything `forgetLocalCopies`
 * clears.
 *
 * So the shell is stored under exactly one key, `SHELL_KEY`, and every
 * navigation is answered from it. The cache holds one generic HTML document
 * and a handful of public build artefacts, and it is the same for every person
 * who ever loads this origin. There is nothing in it to leak and nothing in it
 * worth clearing at sign-out.
 *
 * ## What it will not touch
 *
 * A closed set, and each clause is a way this could otherwise become a cache
 * of somebody's content rather than of the app:
 *
 *  - **Anything that is not a `GET`.** A cache cannot answer one.
 *  - **Anything cross-origin.** Notes come from the Convex deployment, on
 *    another origin, and the fonts come from Google. An opaque response is one
 *    we cannot inspect before storing, and the drawing worker refuses these
 *    for the same reason.
 *  - **`/api/`.** Same-origin and proxied to the control plane by
 *    `infra/router` — the sign-in routes among them. It is the one same-origin
 *    prefix that answers differently per person.
 *  - **`/drawing-assets/`.** The editor has its own worker at a narrower
 *    scope, which wins for its own page; declining here keeps the console's
 *    requests for it off this cache too, so there is one owner of those bytes.
 *  - **Any response carrying `Set-Cookie`.** Belt and braces: nothing that
 *    reaches the store below should have one, and a response that does is
 *    per-session by definition. The same refusal `apps/desktop`'s mirror makes.
 *  - **Any response that is not `ok`.** A 404 or a 503 cached here would be
 *    served offline for ever, which is worse than not answering.
 *
 * ## Updating, and getting out
 *
 * `CACHE` is bumped when the *shape* of what is stored changes, never per
 * deploy — deploys are handled by the hashes. Activation drops every other
 * cache this worker has ever owned.
 *
 * `skipWaiting` and `clients.claim` are both deliberate: without them the load
 * that registers this worker is not the load it caches, so the very first
 * visit would still be a visit that leaves nothing behind for the train.
 */

/** Bumped only when the shape of what is stored changes, never per deploy. */
const CACHE = "context-app-shell-v1";

/**
 * The single key every navigation is stored under and served from.
 *
 * A constant, so neither `put` nor `match` can be handed a URL that quietly
 * varies with whatever somebody had open — see the privacy note above. It is
 * resolved against the worker's own scope rather than written as `"/"`, so
 * this stays correct if the app is ever served from a sub-path.
 */
const SHELL_KEY = new URL("./", self.location.href).pathname;

/** Prefixes whose names contain a hash of their own bytes. */
const HASHED = ["/_expo/", "/assets/"];

/** Same-origin prefixes this worker must never answer or store. */
const NEVER = ["/api/", "/drawing-assets/"];

self.addEventListener("install", () => {
  /*
    Nothing is precached, and that is the same decision `drawing-editor/sw.js`
    made for the same reason: a manifest is a second list of filenames to keep
    in step with the build, and this repository already needs a whole CI job to
    stop one list drifting from its sources. Caching what was actually fetched
    needs no list and cannot go stale against one.

    The cost is that the *first* load must succeed. That is not a real gap: a
    person with no network on their first ever visit has no account, no
    context and no notes on the device either.
  */
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      /*
        The cleanup is allowed to fail and the claim is not, which is why they
        are in separate `try`s rather than one.

        `caches.keys()` rejects on a browser that refuses storage, the same as
        `caches.open` does — and written as one block that rejection would skip
        `clients.claim()`, so this worker would not control the page that
        installed it and the very first visit would still leave nothing behind
        for the train. Dropping an old cache is housekeeping; taking over is
        the feature.
      */
      try {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter((name) => name.startsWith("context-app-shell-") && name !== CACHE)
            .map((name) => caches.delete(name)),
        );
      } catch {
        // Nothing to clean, or nowhere to clean it. Either way there is no
        // stale cache to serve from, because there is no cache.
      }
      await self.clients.claim();
    })(),
  );
});

/** Is this a same-origin `GET` this worker is allowed to have an opinion on? */
function mine(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return !NEVER.some((prefix) => url.pathname.startsWith(prefix));
}

/** Is this one of the build's content-hashed files? */
function hashed(url) {
  return HASHED.some((prefix) => url.pathname.startsWith(prefix));
}

/**
 * May this response be stored?
 *
 * `ok` because a failure served offline for ever is worse than no answer, and
 * `Set-Cookie` because a response carrying one is per-session by construction.
 * `response.type` is checked rather than assumed: a redirect chain can hand
 * back an opaque response for a request that started same-origin.
 *
 * `redirected` is refused because `cache.put` **throws** on one, and the two
 * callers below fail differently when it does — which is worth knowing rather
 * than guessing, because it decides whether this is a guard or a tidy-up:
 *
 *  - `shell()` already has a `catch`, so the throw lands there and somebody
 *    gets the *offline* answer to a navigation that actually succeeded.
 *  - `immutable()` has none, so the same throw rejects `respondWith` and the
 *    request fails outright — a missing bundle rather than a stale one.
 *
 * The console is served directly rather than through a redirect today, so this
 * costs nothing now and is exactly the kind of thing a later routing change
 * introduces silently.
 */
function storable(response) {
  if (!response || !response.ok || response.redirected) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  return !response.headers.has("Set-Cookie");
}

/**
 * The three cache operations, each of which answers rather than throws.
 *
 * **This is the difference between a worker that degrades and one that takes
 * the site down.** A service worker is sticky in a way nothing else in the app
 * is: it survives the tab, and somebody cannot reload their way out of a bad
 * one. So a rejection inside `respondWith` is not "the cache missed", it is a
 * page that will not load, on every navigation, until a fix is deployed and
 * picked up.
 *
 * `caches.open` is the one that makes this concrete rather than theoretical:
 * it **rejects** where a browser refuses storage — a private window in Safari,
 * blocked site data, an enterprise policy — which is exactly the population
 * that cannot easily be told to clear anything. Written the obvious way, with
 * `await caches.open(CACHE)` at the top of each handler and outside its
 * `try`, every one of those people gets a broken origin instead of a normal
 * one.
 *
 * A `null` cache therefore means "no cache", and every caller goes straight to
 * the network, which is precisely how the console behaved before this file
 * existed. `store` swallowing its own failure is the same rule one level down:
 * a quota exceeded mid-write must cost the *storing*, never the response.
 */
async function open() {
  try {
    return await caches.open(CACHE);
  } catch {
    return null;
  }
}

async function lookup(cache, key) {
  if (!cache) return undefined;
  try {
    return await cache.match(key);
  } catch {
    return undefined;
  }
}

async function store(cache, key, response) {
  if (!cache) return;
  try {
    await cache.put(key, response.clone());
  } catch {
    // Quota, a shape `put` refuses, a store that went away mid-write. The
    // response has already been answered with; this only decides whether the
    // next load is faster.
  }
}

/**
 * A navigation: the server's document if it can be had, this device's last
 * good one if it cannot.
 *
 * The fallback is what somebody on a train sees, and from there the app's own
 * offline layer takes over — `useRememberedContexts` knows which contexts
 * exist and the note cache has the bodies.
 */
async function shell(request) {
  const cache = await open();
  try {
    const fresh = await fetch(request);
    if (storable(fresh)) await store(cache, SHELL_KEY, fresh);
    return fresh;
  } catch {
    const held = await lookup(cache, SHELL_KEY);
    if (held) return held;
    /*
      No network and nothing held: a first visit that never completed. Answered
      by this worker rather than by the browser's offline page only because the
      browser's page offers a reload that does the same thing — and a sentence
      that says what is wrong is worth more than a dinosaur.
    */
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Offline</title>" +
        "<p>Context has not finished loading on this device yet, and there is " +
        "no connection. Open this page once with a network and it will work " +
        "offline afterwards.",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

/** A content-hashed file: the cache is authoritative, because the name is. */
async function immutable(request) {
  const cache = await open();
  const cached = await lookup(cache, request);
  if (cached) return cached;

  const fresh = await fetch(request);
  if (storable(fresh)) await store(cache, request, fresh);
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!mine(request)) return;

  if (request.mode === "navigate") {
    event.respondWith(shell(request));
    return;
  }

  if (hashed(new URL(request.url))) {
    event.respondWith(immutable(request));
  }

  /*
    Everything else same-origin — the favicon, `metadata.json`, anything added
    later — falls through to the network untouched. A worker that answered for
    files nobody has thought about is the origin-wide worker this is trying not
    to be.
  */
});
