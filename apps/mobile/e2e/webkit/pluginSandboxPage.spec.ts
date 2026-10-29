import { expect, test, type Page, type Route } from "@playwright/test";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * The plugin sandbox loaded **by URL**, in a real engine, from the router's
 * own response.
 *
 * `pluginSandbox.spec.ts` proves the sandbox document's boundary as a
 * `srcdoc` frame. The console no longer loads it that way: it loads
 * `/drawing-assets/plugin-sandbox/index.html` (`PluginSandbox.web.tsx`), which
 * the router answers from `infra/router/src/pluginSandbox.ts` with its own
 * CSP, and `securityHeaders.ts` adds `X-Frame-Options`. jsdom loads no frame
 * and enforces no sandbox, so the unit tests can only read attributes and
 * headers. This runs both halves together:
 *
 *  - the page is fulfilled with exactly what the router code returns for that
 *    path (status, body, every header), the real `pluginSandboxDocument()` as
 *    its asset;
 *  - the host is a page on the same origin that does what the component does:
 *    `sandbox="allow-scripts"`, `src` set once, the bundle posted on the first
 *    `load` only, behind the package's own `sandboxFrameIsOurs`.
 *
 * Dummy bundle and nonce only; nothing here reaches the network (every request
 * is fulfilled or aborted by `page.route`).
 */

const ORIGIN = "https://context.test";
const SANDBOX_PATH = "/drawing-assets/plugin-sandbox/index.html";
const REPO = join(__dirname, "..", "..", "..", "..");

/** A module's exports, loaded by a path the compiler does not follow (the router is typed for Workers, not this app). */
async function load(path: string): Promise<Record<string, unknown>> {
  // The runtime is an ES module package; the router's TypeScript is compiled
  // by Playwright's own loader, which `require` goes through.
  const loaded: unknown = path.startsWith("@") ? await import(path) : createRequire(__filename)(join(REPO, path));
  if (typeof loaded !== "object" || loaded === null) throw new Error(`${path} exported nothing`);
  return { ...loaded };
}

function fn<T extends (...args: never[]) => unknown>(module: Record<string, unknown>, name: string): T {
  const value = module[name];
  if (typeof value !== "function") throw new Error(`${name} is not a function`);
  return value as T;
}

type Served = { status: number; headers: Record<string, string>; body: string };

/** What the router answers for `url`, with the real sandbox page as its asset. */
async function routerAnswer(url: string, method = "GET"): Promise<Served> {
  const runtime = await load("@context/obsidian-runtime");
  const page = fn<() => string>(runtime, "pluginSandboxDocument")();
  const sandbox = await load("infra/router/src/pluginSandbox.ts");
  const headers = await load("infra/router/src/securityHeaders.ts");
  const respond = fn<(request: Request, url: URL, env: unknown) => Promise<Response>>(sandbox, "pluginSandboxResponse");
  const harden = fn<(response: Response, pathname: string) => Response>(headers, "withSecurityHeaders");
  const env = { ASSETS: { fetch: async () => new Response(page, { headers: { "Content-Type": "text/html" } }) } };
  const parsed = new URL(url);
  const response = harden(await respond(new Request(url, { method }), parsed, env), parsed.pathname);
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
}

async function serve(page: Page, hostHtml: string) {
  const served: Served[] = [];
  await page.route("**/*", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN && url.pathname === "/host") {
      return route.fulfill({ contentType: "text/html", body: hostHtml });
    }
    if (url.origin === ORIGIN && url.pathname.startsWith("/drawing-assets/plugin-sandbox/")) {
      const answer = await routerAnswer(url.href, route.request().method());
      served.push(answer);
      return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
    }
    if (url.pathname === "/successor") {
      return route.fulfill({
        contentType: "text/html",
        body: "<script>window.__fromHost=[];addEventListener('message',e=>window.__fromHost.push(e.data))</script>",
      });
    }
    return route.abort();
  });
  return served;
}

type HostState = {
  loads: number;
  posts: number;
  disowned: boolean;
  rpcAnswered: number;
  messages: Array<{ origin: string; data: Record<string, unknown> }>;
};

/** The component's host logic, in the page: `src` once, bundle on the first load only. */
async function mountHost(page: Page, mainJs: string) {
  const runtime = await load("@context/obsidian-runtime");
  const guard = fn(runtime, "sandboxFrameIsOurs").toString();
  await page.evaluate(
    ([src, guardSource, bundle]) => {
      const sandboxFrameIsOurs = eval(`(${guardSource})`) as (n: number) => boolean;
      const state = { loads: 0, posts: 0, disowned: false, rpcAnswered: 0, messages: [] as Array<{ origin: string; data: unknown }> };
      (window as Window & { hostState?: typeof state }).hostState = state;
      const nonce = "url-proof-nonce";
      const frame = document.createElement("iframe");
      frame.id = "plugin";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.addEventListener("load", () => {
        state.loads += 1;
        if (!sandboxFrameIsOurs(state.loads)) {
          state.disowned = true;
          return;
        }
        state.posts += 1;
        frame.contentWindow?.postMessage(
          {
            source: "context-plugin-host",
            version: 1,
            nonce,
            type: "load",
            manifestJson: JSON.stringify({ id: "url-proof", name: "URL proof", version: "1" }),
            mainJs: bundle,
          },
          "*",
        );
      });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        state.messages.push({ origin: event.origin, data: event.data });
        if (state.disowned) return;
        const message = event.data as { type?: string; request?: { requestId: string } };
        if (message.type !== "rpc" || !message.request) return;
        state.rpcAnswered += 1;
        frame.contentWindow?.postMessage(
          {
            source: "context-plugin-host",
            version: 1,
            type: "rpc-result",
            response: { version: 1, requestId: message.request.requestId, ok: true, result: { kind: "file", text: "# dummy", etag: "one" } },
          },
          "*",
        );
      });
      frame.src = src;
      document.body.appendChild(frame);
    },
    [SANDBOX_PATH, guard, mainJs] as const,
  );
}

function hostState(page: Page): Promise<HostState | undefined> {
  return page.evaluate(() => (window as Window & { hostState?: HostState }).hostState);
}

test("the router's sandbox page loads by URL with an opaque origin and completes the handshake", async ({ page }) => {
  const served = await serve(page, "<main id=host>trusted</main>");
  await page.goto(`${ORIGIN}/host`);
  await mountHost(
    page,
    `
    const { Plugin, Notice } = require("obsidian");
    module.exports = class Proof extends Plugin {
      async onload() {
        let parentBlocked = false;
        try { parent.document.querySelector("#host").textContent = "owned"; } catch (_) { parentBlocked = true; }
        let cspRefused = false;
        document.addEventListener("securitypolicyviolation", (event) => {
          if (String(event.violatedDirective || "").startsWith("connect-src")) cspRefused = true;
        });
        let directBlocked = false;
        try {
          await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", "${ORIGIN}/drawing-assets/plugin-sandbox/index.html");
            xhr.onerror = () => reject(new Error("refused"));
            xhr.onload = resolve;
            xhr.send();
          });
        } catch (_) { directBlocked = true; }
        let storageBlocked = false;
        try { localStorage.getItem("x"); } catch (_) { storageBlocked = true; }
        const text = await this.app.vault.read({ path: "1-projects/proof.md" });
        new Notice(JSON.stringify({ origin: self.origin, parentBlocked, directBlocked, cspRefused, storageBlocked, text }));
      }
    };
  `,
  );

  await expect.poll(async () => (await hostState(page))?.messages.some((one) => one.data.type === "loaded") ?? false).toBe(true);
  const state = (await hostState(page))!;
  const types = state.messages.map((one) => one.data.type);
  // The handshake, in order: the page's bootstrap ran (inline script under its own policy), then the bundle.
  expect(types.indexOf("ready")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("ready")).toBeLessThan(types.indexOf("loaded"));
  // Every message came from an opaque origin.
  expect(new Set(state.messages.map((one) => one.origin))).toEqual(new Set(["null"]));
  const notice = state.messages.find((one) => one.data.type === "notice")!.data as { message: string };
  expect(JSON.parse(notice.message)).toEqual({
    origin: "null",
    parentBlocked: true,
    directBlocked: true,
    cspRefused: true,
    storageBlocked: true,
    text: "# dummy",
  });
  expect(state.posts).toBe(1);
  expect(await page.locator("#host").textContent()).toBe("trusted");
  expect(await page.locator("#plugin").getAttribute("sandbox")).toBe("allow-scripts");

  // What the frame was handed is the router's answer, headers and all.
  expect(served).toHaveLength(1);
  const [answer] = served;
  expect(answer.status).toBe(200);
  expect(answer.body).toBe(fn<() => string>(await load("@context/obsidian-runtime"), "pluginSandboxDocument")());
  const sandboxPolicy = String((await load("infra/router/src/pluginSandbox.ts")).SANDBOX_POLICY);
  expect(answer.headers["content-security-policy"]).toBe(`${sandboxPolicy}; frame-ancestors 'self'`);
  expect(answer.headers["content-security-policy-report-only"]).toBe(`${sandboxPolicy}; report-uri /_csp-report`);
  expect(answer.headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(answer.headers["x-content-type-options"]).toBe("nosniff");
});

test("a sandbox page that reloads itself or navigates away gets no second bundle", async ({ page }) => {
  for (const [name, move] of [
    ["reload", "location.reload()"],
    ["navigation", `location.href = "${ORIGIN}/successor?q=" + encodeURIComponent("SECRET")`],
  ] as const) {
    await test.step(name, async () => {
      const served = await serve(page, "<main id=host>trusted</main>");
      await page.goto(`${ORIGIN}/host`);
      await mountHost(page, `module.exports = class { async onload() { ${move}; } };`);
      await expect.poll(async () => (await hostState(page))?.disowned ?? false).toBe(true);
      const state = (await hostState(page))!;
      expect(state.loads).toBe(2);
      // The successor, even the real sandbox page loaded a second time, is handed nothing.
      expect(state.posts).toBe(1);
      expect(state.rpcAnswered).toBe(0);
      if (name === "reload") {
        expect(served.filter((one) => one.status === 200)).toHaveLength(2);
        // The reloaded page says ready again and is never answered with a load.
        await expect.poll(async () => (await hostState(page))!.messages.filter((one) => one.data.type === "ready").length).toBe(2);
        expect((await hostState(page))!.messages.filter((one) => one.data.type === "loaded")).toHaveLength(1);
      } else {
        const successor = page.frames().find((one) => one.url().includes("/successor"));
        expect(successor, "the frame navigated itself").toBeTruthy();
        expect(await successor!.evaluate(() => (window as Window & { __fromHost?: unknown[] }).__fromHost ?? [])).toEqual([]);
      }
      expect(await page.locator("#host").textContent()).toBe("trusted");
      await page.unrouteAll({ behavior: "wait" });
    });
  }
});

test("another site cannot frame the sandbox page", async ({ page }) => {
  const elsewhere = "https://elsewhere.test";
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === elsewhere) return route.fulfill({ contentType: "text/html", body: "<main>other</main>" });
    if (url.origin === ORIGIN && url.pathname.startsWith("/drawing-assets/plugin-sandbox/")) {
      const answer = await routerAnswer(url.href);
      return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
    }
    return route.abort();
  });
  await page.goto(`${elsewhere}/`);
  await page.evaluate((src) => {
    const received: unknown[] = [];
    (window as Window & { received?: unknown[] }).received = received;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = src;
    addEventListener("message", (event) => received.push(event.data));
    document.body.appendChild(frame);
  }, `${ORIGIN}${SANDBOX_PATH}`);
  // Long enough for a framed page to boot and say ready (it does within a few hundred ms above).
  await page.waitForTimeout(1_500);
  expect(await page.evaluate(() => (window as Window & { received?: unknown[] }).received ?? [])).toEqual([]);
});

test("the path answers only the sandbox page, never the console's fallback", async () => {
  const other = await routerAnswer(`${ORIGIN}/drawing-assets/plugin-sandbox/other.html`);
  expect(other.status).toBe(404);
  const post = await routerAnswer(`${ORIGIN}${SANDBOX_PATH}`, "POST");
  expect(post.status).toBe(405);
});
