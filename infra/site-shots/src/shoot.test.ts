import { describe, expect, it } from "vitest";
import * as entry from "./index";
import {
  MAX_SHOT_HEIGHT,
  MEASURE_SOURCE,
  SIZES,
  parseShootRequest,
  shoot,
  type BrowserLike,
  type Measurements,
  type PageLike,
} from "./shoot";

const MEASURED: Measurements = {
  overflowX: 0,
  wide: [],
  bottomReachable: true,
  scrollHeight: 2000,
  viewportHeight: 844,
  clipped: [],
  brokenImages: [],
  headings: ["h1 Welcome"],
  textLength: 120,
};

function fakeBrowser(options: { pageHeight?: number; failOn?: number } = {}) {
  const calls: string[] = [];
  let opened = 0;
  let closed = false;
  const browser: BrowserLike = {
    async newPage() {
      const index = opened++;
      const page: PageLike = {
        async setViewport(viewport) {
          calls.push(`viewport ${viewport.width}x${viewport.height}`);
        },
        async goto(url) {
          calls.push(`goto ${url}`);
          if (options.failOn === index) throw new Error("Navigation timeout of 25000 ms exceeded");
        },
        async waitForSelector() {},
        async evaluate<T>(source: string) {
          return (source === MEASURE_SOURCE ? MEASURED : options.pageHeight ?? 1500) as T;
        },
        async addStyleTag() {
          calls.push("unroll");
        },
        async screenshot() {
          return new Uint8Array([0xff, 0xd8, 0xff]);
        },
        on() {},
        async close() {
          calls.push("page closed");
        },
      };
      return page;
    },
    async close() {
      closed = true;
    },
  };
  return { browser, calls, closed: () => closed };
}

describe("which addresses a browser may be pointed at", () => {
  it("takes a public https page, and every size by default", () => {
    expect(parseShootRequest({ url: "https://context.lc/@atlas/about" })).toEqual({
      url: "https://context.lc/@atlas/about",
      sizes: ["phone", "tablet", "desktop"],
    });
    expect(parseShootRequest({ url: "https://atlas.ctxlc.site/", sizes: ["phone", "phone", "watch"] })).toEqual({
      url: "https://atlas.ctxlc.site/",
      sizes: ["phone"],
    });
  });

  it("refuses anything that could reach a private network or carry a credential", () => {
    for (const url of [
      "http://context.lc/@atlas",
      "https://127.0.0.1/",
      "https://10.0.0.8/",
      "https://[::1]/",
      "https://localhost/",
      "https://metadata.internal/",
      "https://printer.local/",
      "https://intranet/",
      "https://user:pass@context.lc/",
      "https://context.lc:8443/",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      expect(parseShootRequest({ url }), url).toBeNull();
    }
    expect(parseShootRequest({ url: "https://context.lc/", sizes: ["watch"] })).toBeNull();
    expect(parseShootRequest(null)).toBeNull();
  });
});

describe("photographing a page", () => {
  it("measures each width as a visitor gets it, then photographs it full length", async () => {
    const fake = fakeBrowser({ pageHeight: 1500 });
    const result = await shoot(fake.browser, { url: "https://context.lc/@atlas", sizes: ["phone", "desktop"] });
    expect(result.failures).toEqual([]);
    expect(result.shots.map((shot) => [shot.size, shot.width, shot.height, shot.truncated])).toEqual([
      ["phone", SIZES.phone.width, 1500, false],
      ["desktop", SIZES.desktop.width, 1500, false],
    ]);
    expect(result.shots[0]!.measurements).toEqual(MEASURED);
    expect(result.shots[0]!.jpeg).toBe(btoa(String.fromCharCode(0xff, 0xd8, 0xff)));
    // Measured before the scroll box is opened out, and every page closed.
    expect(fake.calls.slice(0, 4)).toEqual(["viewport 390x844", "goto https://context.lc/@atlas", "unroll", "viewport 390x1500"]);
    expect(fake.calls.filter((call) => call === "page closed")).toHaveLength(2);
    expect(fake.closed()).toBe(true);
  });

  it("cuts a very long page at the cap and says so", async () => {
    const fake = fakeBrowser({ pageHeight: MAX_SHOT_HEIGHT * 3 });
    const [shot] = (await shoot(fake.browser, { url: "https://context.lc/@atlas", sizes: ["phone"] })).shots;
    expect(shot).toMatchObject({ height: MAX_SHOT_HEIGHT, truncated: true });
  });

  it("a width that fails is reported, the others still come back, and the browser is closed", async () => {
    const fake = fakeBrowser({ failOn: 1 });
    const result = await shoot(fake.browser, { url: "https://context.lc/@atlas", sizes: ["phone", "tablet", "desktop"] });
    expect(result.shots.map((shot) => shot.size)).toEqual(["phone", "desktop"]);
    expect(result.failures).toEqual([{ size: "tablet", reason: "Navigation timeout of 25000 ms exceeded" }]);
    expect(fake.closed()).toBe(true);
  });

  it("the measuring script is a string, so the bundler cannot wrap it in helpers the page lacks", () => {
    expect(typeof MEASURE_SOURCE).toBe("string");
    expect(MEASURE_SOURCE).not.toMatch(/__name/);
    expect(() => new Function(`return ${MEASURE_SOURCE.replace("})()", "})")}`)).not.toThrow();
  });
});

describe("the entry module", () => {
  it("exports only its handler, which is all workerd accepts", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(typeof entry.default.fetch).toBe("function");
  });

  it("answers nothing but POST /shoot, and refuses a bad address before any browser opens", async () => {
    const env = { BROWSER: { fetch: () => Promise.reject(new Error("no browser in tests")) } } as never;
    expect((await entry.default.fetch(new Request("https://shots/"), env)).status).toBe(404);
    const bad = await entry.default.fetch(
      new Request("https://shots/shoot", { method: "POST", body: JSON.stringify({ url: "https://127.0.0.1/" }) }),
      env,
    );
    expect(bad.status).toBe(400);
  });
});
