import { describe, expect, it } from "vitest";
import { MAX_HEIGHT, mayLoad, pngHeight, withoutHints, parseRenderRequest, render, type InterceptedRequest, type RenderBrowser, type RenderPage } from "./render";

function fakeBrowser(requested: string[]) {
  const calls: string[] = [];
  const outcomes: Record<string, "continued" | "aborted"> = {};
  let handler: ((request: InterceptedRequest) => void) | null = null;
  const page: RenderPage = {
    async setViewport(viewport) {
      calls.push(`viewport ${viewport.width}x${viewport.height}`);
    },
    async setJavaScriptEnabled(on) {
      calls.push(`javascript ${on}`);
    },
    async setRequestInterception(on) {
      calls.push(`intercept ${on}`);
    },
    on(_event, h) {
      handler = h;
    },
    async setContent() {
      // The page asks for everything it names, as a real one would.
      for (const address of requested) {
        handler?.({
          url: () => address,
          continue: () => void (outcomes[address] = "continued"),
          abort: () => void (outcomes[address] = "aborted"),
        });
      }
    },
    async evaluate<T>() {
      return true as T;
    },
    async screenshot() {
      return "UE5H";
    },
    async close() {
      calls.push("page closed");
    },
  };
  const browser: RenderBrowser = {
    async newPage() {
      return page;
    },
    async close() {
      calls.push("browser closed");
    },
  };
  return { browser, calls, outcomes };
}

describe("parseRenderRequest", () => {
  it("defaults to a square and keeps only public https addresses to allow", () => {
    const parsed = parseRenderRequest({ html: "<h1>Hi</h1>", allow: ["https://images.example.com/a.jpg", "http://x.example/b.png", "https://localhost/c"] });
    expect(parsed?.width).toBe(1080);
    expect(parsed?.height).toBe(1080);
    expect([...parsed!.allow]).toEqual(["https://images.example.com/a.jpg"]);
  });

  it("refuses an empty page and a size out of bounds", () => {
    expect(parseRenderRequest({ html: "  " })).toBeNull();
    expect(parseRenderRequest({ html: "<p>x</p>", height: MAX_HEIGHT + 1 })).toBeNull();
    expect(parseRenderRequest({ html: "<p>x</p>", width: 50 })).toBeNull();
    expect(parseRenderRequest({ html: "<p>x</p>", width: 1080.5 })).toBeNull();
  });
});

describe("mayLoad", () => {
  const allow = new Set(["https://images.example.com/a.jpg"]);
  it("lets inline data, the vouched addresses and Google Fonts through", () => {
    expect(mayLoad("data:image/png;base64,AAAA", allow)).toBe(true);
    expect(mayLoad("https://images.example.com/a.jpg", allow)).toBe(true);
    expect(mayLoad("https://fonts.googleapis.com/css2?family=Inter", allow)).toBe(true);
  });
  it("stops anything else, private names included", () => {
    expect(mayLoad("https://evil.example/?q=their-address", allow)).toBe(false);
    expect(mayLoad("https://images.example.com/a.jpg?q=secret", allow)).toBe(false);
    expect(mayLoad("http://images.example.com/a.jpg", allow)).toBe(false);
    expect(mayLoad("https://10.0.0.1/x", allow)).toBe(false);
  });
});

describe("render", () => {
  it("photographs the page, refuses what was not vouched for, and closes everything", async () => {
    const requested = ["https://images.example.com/a.jpg", "https://evil.example/leak?notes=private", "data:image/png;base64,AAAA"];
    const { browser, calls, outcomes } = fakeBrowser(requested);
    const result = await render(browser, parseRenderRequest({ html: "<p>x</p>", width: 1200, height: 630, allow: [requested[0]] })!);
    expect(result).toEqual({ png: "UE5H", width: 1200, height: 630, blocked: ["https://evil.example/leak?notes=private"] });
    expect(outcomes).toEqual({ [requested[0]]: "continued", [requested[1]]: "aborted", [requested[2]]: "continued" });
    expect(calls).toEqual(["viewport 1200x630", "javascript false", "intercept true", "page closed", "browser closed"]);
  });
});

describe("withoutHints", () => {
  it("disarms every hint that could reach a host without a request", () => {
    const html = withoutHints('<link rel="dns-prefetch" href="//secret.evil.example"><link rel=preconnect href="https://x.example"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">');
    expect(html).not.toMatch(/rel="?(dns-prefetch|preconnect)/);
    expect(html).toMatch(/<link rel="none" href="https:\/\/x.example">/);
    expect(html).toMatch(/rel="stylesheet"/);
    expect(html.startsWith('<meta http-equiv="x-dns-prefetch-control" content="off">')).toBe(true);
  });
});

/** A PNG's first 24 bytes (signature, IHDR length, type, width, height) for a picture `tall` pixels high, as base64. */
function pngOf(tall: number): string {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0xb0, (tall >>> 24) & 255, (tall >>> 16) & 255, (tall >>> 8) & 255, tall & 255];
  return btoa(String.fromCharCode(...bytes)) + "AAAA";
}

describe("render fit", () => {
  function fitBrowser(tall: number) {
    const made = fakeBrowser([]);
    const shots: boolean[] = [];
    const page = { ...(made.browser as unknown as { newPage(): Promise<RenderPage> }) };
    const browser: RenderBrowser = {
      async newPage() {
        const inner = await page.newPage();
        return {
          ...inner,
          async screenshot(options) {
            shots.push(options.fullPage);
            return pngOf(tall);
          },
        };
      },
      close: made.browser.close,
    };
    return { browser, calls: made.calls, shots };
  }

  it("reads a PNG's height from its header, and nothing else as one", () => {
    expect(pngHeight(pngOf(1234))).toBe(1234);
    expect(pngHeight("UE5H")).toBeNull();
    expect(pngHeight("not base64 !!")).toBeNull();
  });

  it("is off unless asked for", () => {
    expect(parseRenderRequest({ html: "<p>x</p>" })?.fit).toBe(false);
    expect(parseRenderRequest({ html: "<p>x</p>", fit: "yes" })?.fit).toBe(false);
    expect(parseRenderRequest({ html: "<p>x</p>", fit: true })?.fit).toBe(true);
  });

  it("cuts a card to the page's own height, starting from a short viewport", async () => {
    const { browser, calls, shots } = fitBrowser(980);
    const result = await render(browser, parseRenderRequest({ html: "<p>x</p>", width: 1200, height: 1500, fit: true })!);
    expect(result.height).toBe(980);
    expect(shots).toEqual([true]);
    expect(calls[0]).toBe("viewport 1200x200");
  });

  it("never returns a picture taller than asked: a longer page is taken at the height asked", async () => {
    const { browser, calls, shots } = fitBrowser(5000);
    const result = await render(browser, parseRenderRequest({ html: "<p>x</p>", width: 1200, height: 1500, fit: true })!);
    expect(result.height).toBe(1500);
    expect(shots).toEqual([true, false]);
    expect(calls).toContain("viewport 1200x1500");
  });

  it("without fit, takes the viewport as before", async () => {
    const { browser, calls, shots } = fitBrowser(980);
    const result = await render(browser, parseRenderRequest({ html: "<p>x</p>", width: 1200, height: 1500 })!);
    expect(result.height).toBe(1500);
    expect(shots).toEqual([false]);
    expect(calls[0]).toBe("viewport 1200x1500");
  });
});
