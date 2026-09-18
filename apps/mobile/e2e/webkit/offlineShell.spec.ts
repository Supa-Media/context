import { expect, test } from "@playwright/test";

/**
 * THE ONE CHECK THAT RUNS IN A BROWSER WITH THE NETWORK OFF.
 *
 * `public/sw.js` is the only thing that can answer a navigation with no
 * network, and until this spec existed it was proven **only** in a `node:vm`
 * sandbox (`__tests__/appShellWorker.test.ts`) against a `CacheStorage` written
 * by hand. That sandbox is worth having — it drives the real file through its
 * own event handlers, and it caught six sabotages — but it has a hard limit,
 * and the limit is not theoretical:
 *
 * **#690 was a real defect the sandbox could not have caught as it stood.**
 * `cache.put` stores a response, a response carries its own `url`, and the
 * single shell entry therefore reported the note path of the navigation that
 * last filled it — a context slug and a note path, in a cache deliberately
 * exempted from `forgetLocalCopies` on the argument that it held nothing worth
 * clearing. The fake could not exhibit it, because a `Response` built in Node
 * reports an empty `url` after `clone()`. It was not wrong; it was not the
 * platform.
 *
 * `appShellWorker.test.ts` now catches that defect, because #690 taught the
 * fake to model the url first — and that ordering is the point rather than a
 * footnote. **A fake only models the platform where somebody has already been
 * surprised by the platform.** The measurement came from a real browser and
 * the fake was corrected to match it, which is exactly the direction that can
 * silently stop happening. Both layers assert this property now; only one of
 * them can find out it was wrong.
 *
 * So this file's rule is: **assert only what a real engine can disagree with
 * the fake about.** Everything here is either a navigation with the network
 * genuinely off, or a property read back out of the browser's own
 * `CacheStorage`. Anything provable in Node belongs in the unit suite, where
 * it runs in a second rather than behind a browser and an export.
 *
 * ## Why the offline navigation is the *first* assertion and not the only one
 *
 * "The page still loads" is the feature. The two `CacheStorage` assertions
 * under it are the privacy argument that lets this worker be origin-wide at
 * all, and they are exactly the pair the sandbox is blind to: what the stored
 * response says its own address is, and what the cache's keys are. A worker
 * that served offline perfectly while recording a browsing history would pass
 * the first check and fail the product.
 *
 * ## What is deliberately *not* here, having been tried
 *
 * **Network-first**, the property that makes an origin-wide worker acceptable
 * at all. A draft asserted it by intercepting the document with `page.route`
 * and expecting the newer body back. It fails, and not because the worker is
 * wrong: a service worker's own `fetch` does not pass through page-level
 * routing, so the interception never sees the request the worker makes and the
 * page gets the real document either way. A green version of that test would
 * have proved nothing.
 *
 * It stays in `appShellWorker.test.ts`, and that is the right home rather than
 * a consolation: the ordering is pure control flow, which Node models exactly,
 * and a sabotage there (serving the cache before the network) fails two cases.
 * The rule at the top of this file is the reason — a browser is needed for
 * platform behaviour, not for logic that a sandbox reproduces faithfully.
 */

/*
  ## One trap, because it cost a confusing green

  This suite drives the **built export** (`web-build/`), not `public/`. Editing
  `public/sw.js` and re-running proves nothing until `pnpm build:e2e-web` has
  run: the browser loads the worker the export shipped. Verified the hard way —
  a sabotage of the source passed here and failed the unit suite, which reads
  `public/sw.js` off disk. CI builds before it tests, so this is a local trap
  rather than a CI one, and it is the kind that reads as "the browser disagrees
  with the sandbox" when it is really "the browser is a build behind."
*/

/**
 * This one case runs in Chromium and not in WebKit, and the reason is measured.
 *
 * The first CI run against WebKit got **further than expected and failed in a
 * different place than feared.** The worry was that WebKit would refuse to
 * register a service worker on `http://127.0.0.1`; it did not. Registration
 * worked, the worker took control, `serveUnderTheWorker` completed, and 85
 * cases in this suite passed alongside it. What failed was the next line:
 *
 *     Error: page.reload: WebKit encountered an internal error
 *       - waiting for navigation until "load"
 *
 * — a reload issued while `context.setOffline(true)` is in force. That is
 * Playwright's offline emulation in its WebKit driver, not this app: nothing
 * in `sw.js` is reached, because the navigation never starts.
 *
 * So the engine that can be taken offline reliably is the one this case uses.
 * The trade is stated rather than hidden: **this check no longer runs in the
 * engine iOS Safari ships**, which is the one platform difference a service
 * worker is most likely to have. What it still buys is the thing no fake can —
 * a real `CacheStorage`, a real `Response`, and a navigation with the network
 * genuinely gone — which is exactly the class #690 escaped into.
 *
 * `docs/decisions/testing.md` already draws this line for the rest of the
 * suite ("WebKit in CI proves the JavaScript engine, not the OS gesture
 * recogniser"): what a green run proves, and what it does not. Re-check this
 * when Playwright's WebKit offline support changes; the skip is one line and
 * the case is engine-agnostic.
 */
test.skip(
  ({ browserName }) => browserName === "webkit",
  "Playwright's WebKit driver errors on a reload taken while offline — see the header",
);

/** The cache `sw.js` owns. Spelled here so a rename has to be deliberate. */
const CACHE = "context-app-shell-v1";

/**
 * Load once online and wait until the worker is actually in charge.
 *
 * Registration is not control: `sw.js` calls `skipWaiting` and `clients.claim`
 * precisely so the load that registers it is also the load it caches, and
 * `navigator.serviceWorker.controller` is how a page finds out that worked.
 * Waiting on it rather than on a timeout is also what keeps this honest about
 * a browser that refuses service workers outright — there, this throws with a
 * named reason instead of going quietly green on a page that has no worker.
 */
async function serveUnderTheWorker(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/e2e-fixture");

  const supported = await page.evaluate(() => "serviceWorker" in navigator);
  expect(
    supported,
    "this browser exposes no navigator.serviceWorker, so the app cannot start offline here",
  ).toBe(true);

  /*
    Waited on `controller`, not on `navigator.serviceWorker.ready`.

    `ready` was the obvious call and it hung: the app registers the worker from
    a `load` listener, and `page.goto` already resolves on `load`, so the
    promise is created in a window where the registration it is waiting for has
    not been asked for yet. `controller` is also the stronger fact — `ready`
    says a worker is active somewhere in scope, and what this file needs is
    that this page's requests are going *through* it.
  */
  try {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 15_000,
    });
  } catch {
    /*
      A named failure rather than a bare timeout, because the most likely cause
      is a fact about the engine rather than a bug in the app: a browser that
      declines to register a worker on `http://127.0.0.1` has nothing wrong
      with it, and the person reading this run needs to know which of the two
      they are looking at. If it is the engine, the answer is to say so here
      and run this spec where a worker is allowed — not to delete the check.
    */
    const state = await page.evaluate(async () => ({
      secure: window.isSecureContext,
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
    }));
    throw new Error(
      `no service worker took control within 15s. isSecureContext=${state.secure}, ` +
        `registrations=${state.registrations}. A registration count of 0 on a secure ` +
        `context means this engine refused the worker on this origin; a count above 0 ` +
        `means it registered and never activated, which is sw.js's problem.`,
    );
  }

  /*
    A reload, because the *first* load was fetched before any worker existed.
    `clients.claim()` puts the worker in charge of that page, but the document
    it is looking at never passed through the fetch handler, so nothing was
    stored. The reload is the load that fills the cache — which is also exactly
    what a person's second visit is.
  */
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test("the app still loads with the network off, and the shell it serves remembers nobody", async ({
  page,
  context,
}) => {
  await serveUnderTheWorker(page);

  // The network goes away between the load that filled the cache and the load
  // that has to survive without one. This is the train.
  await context.setOffline(true);
  await page.reload();

  /*
    The document came from somewhere. Without the worker this is the browser's
    own error page, which has no root element and none of the app in it — so
    this assertion is the whole feature, stated as the thing a person would
    notice.
  */
  await expect(page.locator("#root")).toBeAttached();
  await expect(page).toHaveTitle(/.+/);

  /*
    And the privacy half, read out of the engine's own CacheStorage.

    **The shell entry only.** The first draft asserted every stored response
    reported an empty url and failed on the bundle — correctly, because a
    hashed asset *does* carry its own address and that address is public build
    output (`/_expo/static/js/web/entry-<hash>.js`). #690 was never about
    those; it was about the one entry a navigation fills, whose address on this
    product is a context slug and a note path. Asserting it of everything made
    the check louder and wrong, which is a worse failure than making it narrow
    and right.
  */
  const shell = await page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    const paths = requests.map((request) => new URL(request.url).pathname);
    const entry = requests.find((request) => new URL(request.url).pathname === "/");
    const response = entry === undefined ? null : await cache.match(entry);
    return { paths, present: response !== null, url: response?.url ?? null };
  }, CACHE);

  expect(shell.present, "the navigation this worker answered was never stored").toBe(true);
  expect(
    shell.url,
    "a stored shell that knows its own address puts a note path in a cache sign-out does not clear",
  ).toBe("");

  /*
    And the key half of the same argument: one shell entry, under the scope
    root, whatever was open when it was filled. The fixture route stands in for
    a note path here — it is the address this page was actually at, and it must
    not appear anywhere in the cache's keys.
  */
  for (const path of shell.paths) {
    expect(path).not.toContain("e2e-fixture");
  }
});
