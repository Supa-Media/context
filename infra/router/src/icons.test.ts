/**
 * The favicons and the search-result markup that points at them.
 *
 * Google showed context.lc with the grey globe it draws for a site with no
 * icon: Googlebot reads `renderPreviewHtml`'s page, which linked none. These
 * tests pin every link in that head to a path the Worker itself answers with
 * image bytes, for a crawler and a person alike, without touching an upstream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { icoFromPng, ICON_PATHS } from "./icons";
import { renderPreviewHtml, previewFor, GENERIC_PREVIEW } from "./preview";
import { route } from "./route";

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const GOOGLE_FAVICON =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 (compatible; Google-Favicon)";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const ENV = { EXPO_ORIGIN: "https://context.expo.app", CONVEX_ORIGIN: "https://example-deployment.convex.site" };
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error("upstream fetch attempted");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function get(url: string, userAgent: string): Promise<Response> {
  return worker.fetch(new Request(url, { headers: { "User-Agent": userAgent } }), ENV, CTX) as Promise<Response>;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Width and height from a PNG's IHDR, which always follows the signature. */
function pngSize(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

const home = renderPreviewHtml(previewFor("/"));

function hrefs(html: string): string[] {
  return [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
}

describe("the home page a search engine reads", () => {
  it("links a favicon Google accepts: square, a multiple of 48px", async () => {
    const links = hrefs(home);
    expect(links).toContain("https://context.lc/favicon.ico");
    for (const href of links) {
      const response = await get(href, GOOGLE_FAVICON);
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const png = response.headers.get("Content-Type") === "image/x-icon" ? bytes.subarray(22) : bytes;
      expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      const [w, h] = pngSize(png);
      expect(w).toBe(h);
      if (!href.includes("apple-touch-icon")) expect(w % 48).toBe(0);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names the site in WebSite structured data, the source Google reads first", () => {
    const block = home.match(/<script type="application\/ld\+json">([^<]*)<\/script>/);
    expect(block).not.toBeNull();
    const data = JSON.parse(block![1]!) as { "@graph": Array<Record<string, unknown>> };
    const site = data["@graph"].find((node) => node["@type"] === "WebSite")!;
    expect(site.name).toBe("Context.LC");
    expect(site.url).toBe("https://context.lc/");
    expect(home).toContain('<meta property="og:site_name" content="Context.LC">');
  });

  it("carries structured data on the home page only", () => {
    expect(renderPreviewHtml(previewFor("/login"))).not.toContain("ld+json");
    expect(renderPreviewHtml(GENERIC_PREVIEW)).not.toContain("ld+json");
  });

  it("leaves somebody's website to its own icon", () => {
    const page = renderPreviewHtml({ ...GENERIC_PREVIEW, siteName: "Globex", canonical: "https://docs.acme-test.com/" });
    expect(hrefs(page)).toEqual([]);
  });
});

describe("the icon paths", () => {
  it.each(Object.values(ICON_PATHS))("%s is the Worker's own bytes, for anyone", async (path) => {
    for (const ua of [GOOGLEBOT, GOOGLE_FAVICON, BROWSER]) {
      const response = await get(`https://context.lc${path}`, ua);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toMatch(/^image\//);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("matches exact paths only", () => {
    expect(route(new URL("https://context.lc/favicon.ico"), BROWSER)).toEqual({ kind: "icon", name: "ico" });
    expect(route(new URL("https://context.lc/favicon.icon"), BROWSER).kind).toBe("proxy");
    expect(route(new URL("https://context.lc/x/favicon.ico"), BROWSER).kind).toBe("proxy");
  });

  it("redirects www like everything else", () => {
    expect(route(new URL("https://www.context.lc/favicon.ico"), GOOGLEBOT)).toEqual({
      kind: "redirect",
      location: "https://context.lc/favicon.ico",
    });
  });
});

describe("robots.txt", () => {
  it("allows every crawler everything, as plain text, without an upstream", async () => {
    for (const ua of [GOOGLEBOT, BROWSER]) {
      const response = await get("https://context.lc/robots.txt", ua);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      const body = await response.text();
      expect(body).toMatch(/^User-agent: \*$/m);
      expect(body).toMatch(/^Allow: \/$/m);
      expect(body).not.toMatch(/Disallow:\s*\//);
      expect(body).not.toContain("<");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("icoFromPng", () => {
  it("writes a one-image ICO directory in front of the PNG", () => {
    const png = new Uint8Array([...PNG_SIGNATURE, 1, 2, 3]).buffer;
    const ico = new Uint8Array(icoFromPng(png, 48));
    const view = new DataView(ico.buffer);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 1]);
    expect([ico[6], ico[7]]).toEqual([48, 48]);
    expect(view.getUint32(14, true)).toBe(png.byteLength);
    expect(view.getUint32(18, true)).toBe(22);
    expect([...ico.subarray(22)]).toEqual([...new Uint8Array(png)]);
  });
});
