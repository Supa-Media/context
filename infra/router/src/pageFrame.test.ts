/**
 * The page runtime on `<handle>.ctxlc.site/_page/` (`pageFrame.ts`), and the
 * one platform file left framable for it.
 *
 * Sabotage record (temporary edits, reverted):
 *   the marker check removed                         → "never the console" fails
 *   `isPageFrameRequest` checked after the lookup     → "before any lookup" fails
 *   `withSecurityHeaders` not reading `isPageBoxPath` → "leaves it off the box framed inside it" fails
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

const CTX = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

const FILES: Record<string, string> = {
  "/drawing-assets/page/": '<!doctype html><main id="page" class="pg"></main><script src="./frame.js"></script>',
  "/drawing-assets/page/frame.js": '(()=>{const CHANNEL="context-page"})()',
  "/drawing-assets/page/box": '<!doctype html><script src="./box.js"></script>',
  "/drawing-assets/page/box.js": '(()=>{const CHANNEL="context-page-box"})()',
};

/** The export, with its trailing-slash redirects and its single-page fallback. */
function exportAssets(files: Record<string, string>) {
  return vi.fn(async (request: Request) => {
    const { pathname, origin } = new URL(request.url);
    if (pathname.endsWith("/index.html")) return new Response(null, { status: 307, headers: { Location: `${origin}${pathname.slice(0, -10)}` } });
    if (pathname.endsWith(".html")) return new Response(null, { status: 307, headers: { Location: `${origin}${pathname.slice(0, -5)}` } });
    if (files[pathname] !== undefined) return new Response(files[pathname]);
    if (pathname === "/drawing-assets/page/box") return new Response("<!doctype html><div id=root>console</div>", { headers: { "Content-Type": "text/html" } });
    return new Response("<!doctype html><div id=root>console</div>", { headers: { "Content-Type": "text/html" } });
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => new Response(JSON.stringify({ handle: null }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function get(url: string, assets = exportAssets(FILES)) {
  const env = { CONVEX_ORIGIN: "https://example-deployment.convex.site", ASSETS: { fetch: assets } as unknown as Fetcher };
  return worker.fetch(new Request(url), env, CTX) as Promise<Response>;
}

describe("the page runtime on the sites domain", () => {
  it("serves the runtime's files on any label, before any lookup", async () => {
    const page = await get("https://seyi.ctxlc.site/_page/index.html");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain('<main id="page"');
    expect(page.headers.get("X-Frame-Options")).toBeNull();
    const script = await get("https://whoever.ctxlc.site/_page/frame.js");
    expect(script.headers.get("Content-Type")).toMatch(/^text\/javascript/);
    expect((await get("https://seyi.ctxlc.site/_page/box.html")).status).toBe(200);
    expect((await get("https://seyi.ctxlc.site/_page/box.js")).status).toBe(200);
    // No workspace was looked up for any of them.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers nothing but those four files", async () => {
    for (const path of ["/_page/", "/_page/../index.html", "/_page/editor.js", "/_page/index.html/x"]) {
      expect((await get(`https://seyi.ctxlc.site${path}`)).status).toBe(404);
    }
  });

  it("never the console, if the export is missing the runtime", async () => {
    const response = await get("https://seyi.ctxlc.site/_page/index.html", exportAssets({}));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("console");
  });
});

describe("the deployment's own copy", () => {
  it("keeps the framing rule on the runtime, and leaves it off the box framed inside it", async () => {
    const page = await get("https://context.lc/drawing-assets/page/index.html");
    expect(page.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const box = await get("https://context.lc/drawing-assets/page/box");
    expect(box.headers.get("X-Frame-Options")).toBeNull();
    expect(box.headers.get("Content-Security-Policy")).toBeNull();
    expect(box.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    expect(box.headers.get("Strict-Transport-Security")).not.toBeNull();
  });
});
