import { describe, expect, it, vi } from "vitest";

import { MAX_PICTURE_BYTES, pagePicture, PREVIEW_USER_AGENT, previewImageOf, publicHttps } from "./pagePicture";
import type { Fetch } from "./clients";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
const html = (head: string) => new Response(`<html><head>${head}</head><body></body></html>`, { headers: { "content-type": "text/html" } });
const png = (bytes: Uint8Array = PNG, headers: Record<string, string> = {}) => new Response(bytes, { headers: { "content-type": "image/png", ...headers } });

/** A web of fixed answers by address; every request is recorded with what it sent. */
function web(answers: Record<string, () => Response>, seen: Array<{ url: string; init: RequestInit }> = []): Fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const answer = answers[url];
    return answer ? answer() : new Response(null, { status: 404 });
  }) as unknown as Fetch;
}

describe("a page's preview picture address", () => {
  it("prefers og:image, in either attribute order, then twitter:image, then image_src", () => {
    expect(previewImageOf('<meta content="https://a.example/1.png?a=1&amp;b=2" property="og:image">')).toBe("https://a.example/1.png?a=1&b=2");
    expect(previewImageOf('<meta name="twitter:image" content="/t.jpg"><meta property="og:image" content="/o.jpg">')).toBe("/o.jpg");
    expect(previewImageOf('<meta name="twitter:image" content="/t.jpg">')).toBe("/t.jpg");
    expect(previewImageOf('<link rel="image_src" href="/l.jpg">')).toBe("/l.jpg");
    expect(previewImageOf("<title>none</title>")).toBeNull();
  });
});

describe("what may be fetched", () => {
  it("is a public https address only", () => {
    for (const bad of [
      "http://a.example/",
      "https://user:pw@a.example/",
      "https://a.example:8443/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "https://printer.local/",
      "https://intranet/",
      "javascript:alert(1)",
    ]) {
      expect(publicHttps(bad), bad).toBeNull();
    }
    expect(publicHttps("https://www.reddit.com/r/x/")?.href).toBe("https://www.reddit.com/r/x/");
  });
});

describe("fetching a link's picture", () => {
  it("reads the page, follows its picture against the page's address, and sends no credential", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const picture = await pagePicture(
      web({ "https://a.example/post": () => html('<meta property="og:image" content="/img/share.png">'), "https://a.example/img/share.png": () => png() }, seen),
      "https://a.example/post",
    );
    expect(picture).toEqual({ name: "preview.png", mediaType: "image/png", data: btoa(String.fromCharCode(...PNG)) });
    expect(seen.map((call) => call.url)).toEqual(["https://a.example/post", "https://a.example/img/share.png"]);
    for (const { init } of seen) {
      const headers = init.headers as Record<string, string>;
      expect(Object.keys(headers).sort()).toEqual(["accept", "user-agent"]);
      expect(headers["user-agent"]).toBe(PREVIEW_USER_AGENT);
      expect(init.redirect).toBe("manual");
    }
  });

  it("takes a link straight to a picture as its own preview", async () => {
    expect((await pagePicture(web({ "https://a.example/cat.png": () => png() }), "https://a.example/cat.png"))?.mediaType).toBe("image/png");
  });

  it("follows a redirect only to another public https address", async () => {
    const ok = await pagePicture(
      web({
        "https://a.example/s": () => new Response(null, { status: 301, headers: { location: "https://b.example/p" } }),
        "https://b.example/p": () => html('<meta property="og:image" content="https://b.example/i.png">'),
        "https://b.example/i.png": () => png(),
      }),
      "https://a.example/s",
    );
    expect(ok).not.toBeNull();
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const bad = await pagePicture(
      web(
        {
          "https://a.example/s": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
          "https://a.example/p": () => html('<meta property="og:image" content="https://127.0.0.1/i.png">'),
        },
        seen,
      ),
      "https://a.example/s",
    );
    expect(bad).toBeNull();
    expect(await pagePicture(web({ "https://a.example/p": () => html('<meta property="og:image" content="https://127.0.0.1/i.png">') }, seen), "https://a.example/p")).toBeNull();
    expect(seen.map((call) => call.url)).toEqual(["https://a.example/s", "https://a.example/p"]);
  });

  it("never fetches a link that is not public https", async () => {
    const fetcher = vi.fn();
    expect(await pagePicture(fetcher as unknown as Fetch, "http://a.example/")).toBeNull();
    expect(await pagePicture(fetcher as unknown as Fetch, "https://10.0.0.1/")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is null for a picture too big, of another kind, or Context's own catch-all card", async () => {
    const big = new Uint8Array(MAX_PICTURE_BYTES + 1);
    const page = html('<meta property="og:image" content="https://a.example/i">');
    expect(await pagePicture(web({ "https://a.example/p": () => page, "https://a.example/i": () => png(big) }), "https://a.example/p")).toBeNull();
    const declared = html('<meta property="og:image" content="https://a.example/i">');
    expect(
      await pagePicture(web({ "https://a.example/p": () => declared, "https://a.example/i": () => png(PNG, { "content-length": String(MAX_PICTURE_BYTES + 1) }) }), "https://a.example/p"),
    ).toBeNull();
    const svg = html('<meta property="og:image" content="https://a.example/i.svg">');
    expect(
      await pagePicture(web({ "https://a.example/p": () => svg, "https://a.example/i.svg": () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }) }), "https://a.example/p"),
    ).toBeNull();
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const own = html('<meta property="og:image" content="https://context.lc/og/card.png">');
    expect(await pagePicture(web({ "https://context.lc/messages/threads": () => own }, seen), "https://context.lc/messages/threads?k=a.b")).toBeNull();
    expect(await pagePicture(web({ "https://context.lc/messages/threads?k=a.b": () => own }, seen), "https://context.lc/messages/threads?k=a.b")).toBeNull();
    expect(seen.map((call) => call.url)).not.toContain("https://context.lc/og/card.png");
  });

  it("is null, never a throw, when the site refuses, is not a page, or the network dies", async () => {
    expect(await pagePicture(web({ "https://a.example/p": () => new Response(null, { status: 403 }) }), "https://a.example/p")).toBeNull();
    expect(await pagePicture(web({ "https://a.example/p": () => new Response("{}", { headers: { "content-type": "application/json" } }) }), "https://a.example/p")).toBeNull();
    const dead = (async () => {
      throw new TypeError("network");
    }) as unknown as Fetch;
    expect(await pagePicture(dead, "https://a.example/p")).toBeNull();
  });
});
