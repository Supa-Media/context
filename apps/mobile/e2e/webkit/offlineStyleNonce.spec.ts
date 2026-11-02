import { expect, test, type Page } from "@playwright/test";

/**
 * Offline, the held shell is replayed with a style nonce of its own, in a real
 * browser's `CacheStorage`, through a real service worker.
 *
 * The router mints a nonce for every shell response (`infra/router/src/
 * styleNonce.ts`), and the fixture server does the same under
 * `E2E_CSP_NONCE=1` (`csp-style-nonce.mjs`), gzipped, as production's edge
 * serves it. `public/sw.js` stores one shell, header and body together, and
 * replays it with no network; replayed as stored, every offline load would
 * carry the same nonce. `renonced` mints a new one on each replay.
 * `appShellWorker.test.ts` proves that logic against a `Response` built in
 * Node; this proves what only an engine can disagree about: the stored
 * response as the browser's own cache keeps it (decoded, still marked as
 * compressed), the document the browser builds from the replay, and the
 * policy it enforces on it.
 *
 * Chromium only, for the reason `offlineShell.spec.ts` gives: Playwright's
 * WebKit driver errors on a reload taken while offline. Run under
 * `E2E_CSP_CANDIDATE=full E2E_CSP_NONCE=1`, so the whole policy is enforced
 * and a replay whose header and body disagreed would lose the shell's own
 * styles.
 */

const ON = process.env.E2E_CSP_CANDIDATE === "full" && process.env.E2E_CSP_NONCE === "1";
const CACHE = "context-app-shell-v1";

test.skip(({ browserName }) => browserName !== "chromium" || !ON, "Chromium under E2E_CSP_CANDIDATE=full and E2E_CSP_NONCE=1");

// The shell answers again after the test, whatever it did, so nothing after it runs "offline".
test.afterEach(async ({ request }) => {
  await request.post("/_e2e-shell-unreachable", { headers: { "x-unreachable": "0" } });
});

/** The `'nonce-…'` values in every `style-src` of a policy header. */
function styleNonces(header: string | undefined): string[] {
  return (header ?? "")
    .split(/[;,]/)
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name === "style-src")
    .flatMap((sources) => sources.filter((source) => source.startsWith("'nonce-")).map((source) => source.slice(7, -1)));
}

/** The document's own state: its nonce, whether its ground style applied, and what was refused. */
const documentState = (page: Page) =>
  page.evaluate(() => ({
    nonce: (document.getElementById("context-ground") as HTMLStyleElement | null)?.nonce ?? null,
    nonced: Array.from(document.querySelectorAll("style[id]"))
      .filter((style) => (style as HTMLStyleElement).nonce !== "")
      .map((style) => style.id),
    // `#context-ground` paints the page this colour; refused, it stays the browser's white.
    ground: getComputedStyle(document.body).backgroundColor,
    refusals: (window as unknown as { __cspRefusals: { directive: string; disposition: string; element: string | null }[] }).__cspRefusals,
  }));

/** One navigation, and the response it was answered with (from the network or the worker). */
async function reload(page: Page) {
  const answered = page.waitForResponse((response) => response.request().isNavigationRequest());
  await page.reload();
  const response = await answered;
  return { response, headers: await response.allHeaders() };
}

test("each offline replay carries a nonce of its own, in the header and the document alike, and the policy still holds", async ({ page, request }) => {
  await page.addInitScript(() => {
    const holder = window as unknown as { __cspRefusals: { directive: string; disposition: string; element: string | null }[] };
    holder.__cspRefusals = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      holder.__cspRefusals.push({
        directive: event.effectiveDirective,
        disposition: event.disposition,
        element: target === null ? null : `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}`,
      });
    });
  });

  await page.goto("/e2e-fixture");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 });
  // The load that passes through the worker, and fills its cache.
  const online = await reload(page);
  expect(online.response.fromServiceWorker(), "the worker answered the online load").toBe(true);
  expect(online.headers["content-encoding"], "the fixture serves the shell compressed, as the edge does").toBe("gzip");
  const [served] = styleNonces(online.headers["content-security-policy"]);
  expect(served, "the shell was served with a nonce").toBeTruthy();
  expect((await documentState(page)).nonce).toBe(served);

  // What the browser's own cache holds: the response it was given, nonce and all, untouched by any replay.
  const held = () =>
    page.evaluate(async (name) => {
      const response = await (await caches.open(name)).match("/");
      if (!response) return null;
      return {
        enforced: response.headers.get("Content-Security-Policy") ?? "",
        encoding: response.headers.get("Content-Encoding"),
        body: await response.text(),
      };
    }, CACHE);
  const stored = await held();
  expect(stored, "the shell was stored").not.toBeNull();
  expect(styleNonces(stored!.enforced)).toEqual([served]);
  expect(stored!.body).toContain(`<style id="context-ground" nonce="${served}">`);

  /*
    Offline as the worker sees it: the shell's address stops answering. Playwright's
    `context.setOffline` does not reach a worker's own fetch in Chromium (measured: the
    worker fetched a fresh shell from the server, header and all), so it would test the
    network, not the replay. The fixture server's switch drops the connection instead.
  */
  const unreachable = async (on: boolean) => {
    const answer = await request.post("/_e2e-shell-unreachable", { headers: { "x-unreachable": on ? "1" : "0" } });
    expect(answer.status()).toBe(204);
  };
  await unreachable(true);
  const seen = new Set([served]);
  for (let replay = 0; replay < 2; replay++) {
    const offline = await reload(page);
    expect(offline.response.fromServiceWorker()).toBe(true);
    expect(offline.response.status(), "the held shell, not the worker's offline page").toBe(200);
    const enforced = styleNonces(offline.headers["content-security-policy"]);
    const reported = styleNonces(offline.headers["content-security-policy-report-only"]);
    expect(enforced, "one nonce in the enforced style-src").toHaveLength(1);
    expect(reported, "and the same one reported").toEqual(enforced);
    const nonce = enforced[0]!;
    expect(seen.has(nonce), "a nonce no earlier response carried").toBe(false);
    seen.add(nonce);
    // The body was read decoded and written again; a stale encoding would describe other bytes.
    expect(offline.headers["content-encoding"]).toBeUndefined();
    expect(offline.headers["content-length"]).toBeUndefined();

    const state = await documentState(page);
    expect(state.nonce, "the document carries the header's nonce").toBe(nonce);
    expect(state.nonced.sort(), "on the shell's two styles").toEqual(["context-ground", "expo-reset"]);
    expect(state.ground, "and the shell's own style applies under the enforced policy").toBe("rgb(255, 253, 249)");
    expect(state.refusals, "nothing the replayed shell wrote was refused").toEqual([]);
  }

  await unreachable(false);

  // The control: under that same replayed policy, a style without the nonce is still refused.
  const applied = await page.evaluate(async () => {
    const style = document.createElement("style");
    style.id = "csp-offline-control";
    style.textContent = "body { --csp-offline-probe: 1; }";
    document.head.append(style);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return getComputedStyle(document.body).getPropertyValue("--csp-offline-probe").trim() === "1";
  });
  expect(applied, "a style without the nonce is blocked offline too").toBe(false);
  const { refusals } = await documentState(page);
  expect(refusals.filter((row) => row.element === "style#csp-offline-control").map((row) => row.disposition).sort()).toEqual(["enforce", "report"]);

  // And the cache still holds the response as the network gave it: the replay changed the copy, never the store.
  const after = await held();
  expect(styleNonces(after!.enforced)).toEqual([served]);
  expect(after!.body).toBe(stored!.body);
});
