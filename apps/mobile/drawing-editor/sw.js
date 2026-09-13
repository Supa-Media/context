/**
 * The drawing editor's own service worker, so a drawing can be edited offline.
 *
 * ## Why this exists
 *
 * The editor is a page rather than part of the console, for a measured reason
 * `scripts/build-drawing-editor.mjs` records: importing Excalidraw into the
 * console took its web JavaScript from 5.7MB to 14.6MB **on every page load**,
 * because Expo's Metro puts a dynamic import in a blocking `__common` chunk.
 * Built as its own page, the console's bundle is unchanged and the 2.4MB
 * gzipped editor is fetched the first time somebody opens a drawing.
 *
 * The honest cost of that was stated when it shipped: **editing a drawing
 * needed a network**. A drawing still rendered offline, because `DrawingView`
 * draws from the file the console already holds, so losing connectivity cost
 * the editor rather than the content. This closes that gap without giving back
 * the 14.6MB: the page is cached the first time it is fetched, and served from
 * the cache after that.
 *
 * ## Scope is the whole design
 *
 * A worker's scope is the directory it is served from, so this one lives
 * beside the editor at `/drawing-assets/editor/sw.js` and controls
 * `/drawing-assets/editor/` and nothing else. That is deliberate rather than
 * incidental. A worker registered at the origin root would sit in front of
 * **every** request the console makes, and a bug in it would be a console that
 * serves a stale app shell to everybody, including the people who never open a
 * drawing. Confined here, the worst it can do is serve a stale editor.
 *
 * ## Stale while revalidate, because the filenames are not hashed
 *
 * `editor.js` and `editor.css` keep their names across deploys, so a
 * cache-first worker with no refresh would pin somebody to the version they
 * first opened, for ever. Every response is therefore served from the cache
 * *and* refetched in the background, and the next open gets the new one.
 *
 * The one-version lag is safe here in a way it would not be for the console:
 * the page and its bundle always deploy together, and what crosses between the
 * console and this page is a versioned protocol (`context.drawing.v1` in
 * `drawingBridge.ts`), so a console that has moved on can tell rather than
 * guess. A cache-first worker with no revalidation would be the wrong trade;
 * network-first would give back the offline case this exists for.
 *
 * ## What it never does
 *
 * No precache manifest. The build emits a page, a bundle, a stylesheet and a
 * directory of fonts whose names change when the font list does, and a manifest
 * is a second list to keep in step — the failure `bundle.generated.ts` needs a
 * whole CI job to prevent. Caching what was actually fetched needs no list and
 * cannot go stale against one.
 *
 * No opaque responses, and nothing cross-origin. `#503` verified that this page
 * makes zero requests off our own origin, fonts included, and this worker
 * declines anything that is not a same-origin GET so that stays true rather
 * than being reasserted.
 */

/** Bumped only when the shape of what is stored changes, never per deploy. */
const CACHE = "context-drawing-editor-v1";

self.addEventListener("install", () => {
  // Nothing to precache: the first load fills the cache. Taking over
  // immediately means the load that registered this worker is also the one
  // that gets cached, rather than the one after it.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // A cache from an older shape of this worker is not upgraded, it is
      // dropped: it holds responses this version may not understand, and the
      // cost of throwing it away is one fetch.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("context-drawing-editor-") && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * Is this a request this worker is willing to answer from its cache?
 *
 * Narrow on purpose, and every clause is load-bearing. `GET` because a cache
 * cannot answer anything else. Same origin because a cached opaque response is
 * a response we cannot inspect. In scope because a worker that answered outside
 * its own directory would be the origin-wide worker this deliberately is not.
 */
function cacheable(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith(new URL("./", self.location.href).pathname);
}

self.addEventListener("fetch", (event) => {
  if (!cacheable(event.request)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(event.request);

      const fresh = fetch(event.request)
        .then((response) => {
          // Only a real answer is stored. A 404 or a 500 cached here would be
          // served offline for ever, which is worse than not answering.
          if (response.ok) void cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => null);

      if (hit) {
        // Refetch, but do not wait for it: this is the whole of "offline".
        event.waitUntil(fresh);
        return hit;
      }

      const response = await fresh;
      if (response) return response;

      // First open, no network. The console is watching for exactly this and
      // falls back to `DrawingView`, so the reader still sees their drawing.
      return new Response("The drawing editor is not available offline yet.", {
        status: 504,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    })(),
  );
});
