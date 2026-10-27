import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES, MAX_REDIRECTS, fetchPage, fetchRead, fromMarkdown, htmlToText } from "./fetchText";
import { MAX_IMAGES, MAX_LINKS, MAX_TEXT_CHARS, keepImages } from "./read";

type Reply = { status?: number; type?: string; body?: string; location?: string; throws?: boolean };

/** A fetch that serves fixed replies and records every address and header asked for. */
function fakeFetch(replies: Record<string, Reply>) {
  const asked: Array<{ url: string; accept: string | null; redirect: string | undefined }> = [];
  const impl = async (url: string, init: RequestInit) => {
    asked.push({ url, accept: new Headers(init.headers).get("accept"), redirect: init.redirect });
    const reply = replies[url];
    if (!reply || reply.throws) throw new Error("network");
    const headers = new Headers();
    if (reply.type) headers.set("content-type", reply.type);
    if (reply.location) headers.set("location", reply.location);
    return new Response(reply.body ?? "", { status: reply.status ?? 200, headers });
  };
  return { impl, asked };
}

describe("fetchPage", () => {
  it("asks for Markdown and reads a page that sends it, with no browser", async () => {
    const { impl, asked } = fakeFetch({
      "https://example.com/pricing": {
        type: "text/markdown; charset=utf-8",
        body: "# Pricing\n\nPro is $12. See [Teams](/teams) and ![logo](/logo.png).",
      },
    });
    const page = await fetchPage("https://example.com/pricing", impl);
    expect(asked).toEqual([{ url: "https://example.com/pricing", accept: "text/markdown, text/html;q=0.9", redirect: "manual" }]);
    expect(page).toEqual({
      url: "https://example.com/pricing",
      title: "Pricing",
      text: "# Pricing\n\nPro is $12. See [Teams](/teams) and ![logo](/logo.png).",
      truncated: false,
      links: [{ text: "Teams", href: "https://example.com/teams" }],
      images: [], // the logo is the site's furniture, not its subject
      via: "markdown",
    });
  });

  it("an HTML page with no readable text, an error or a failed request means the browser", async () => {
    const { impl } = fakeFetch({
      "https://example.com/html": { type: "text/html", body: "<div id=root></div><script src=/app.js></script>" },
      "https://example.com/gone": { status: 404, type: "text/markdown", body: "# Not found" },
      "https://example.com/down": { throws: true },
    });
    expect(await fetchPage("https://example.com/html", impl)).toBeNull();
    expect(await fetchPage("https://example.com/gone", impl)).toBeNull();
    expect(await fetchPage("https://example.com/down", impl)).toBeNull();
  });

  it("says when the site turned the request away, so Browserbase's Fetch API is worth a try", async () => {
    const challenged = new Headers({ "content-type": "text/html", "cf-mitigated": "challenge" });
    const { impl } = fakeFetch({
      "https://shop.example/403": { status: 403, type: "text/html", body: "Access denied" },
      "https://shop.example/429": { status: 429 },
      "https://shop.example/down": { throws: true },
      "https://shop.example/404": { status: 404, type: "text/html", body: "Not found" },
      "https://shop.example/js": { type: "text/html", body: "<div id=root></div>" },
    });
    for (const path of ["403", "429", "down"]) {
      expect(await fetchRead(`https://shop.example/${path}`, impl)).toEqual({ page: null, refused: true });
    }
    // Not refusals: a page that is not there, and one only a browser can draw.
    for (const path of ["404", "js"]) {
      expect(await fetchRead(`https://shop.example/${path}`, impl)).toEqual({ page: null, refused: false });
    }
    for (const status of [200, 403]) {
      const challenge = async () => new Response("Just a moment", { status, headers: challenged });
      expect(await fetchRead("https://shop.example/", challenge)).toEqual({ page: null, refused: true });
    }
  });

  it("follows a redirect to another public page, and reports where it ended", async () => {
    const { impl } = fakeFetch({
      "https://example.com/old": { status: 301, location: "/new" },
      "https://example.com/new": { type: "text/markdown", body: "# New" },
    });
    expect((await fetchPage("https://example.com/old", impl))?.url).toBe("https://example.com/new");
  });

  it("never follows a redirect to a private or internal address", async () => {
    for (const location of ["https://127.0.0.1/admin", "http://example.com/plain", "https://metadata.internal/", "https://example.com:8443/", "https://user:pw@example.com/"]) {
      const { impl, asked } = fakeFetch({
        "https://example.com/hop": { status: 302, location },
        [location]: { type: "text/markdown", body: "# Secret" },
      });
      expect(await fetchPage("https://example.com/hop", impl)).toBeNull();
      expect(asked.map((a) => a.url)).toEqual(["https://example.com/hop"]);
    }
  });

  it("gives up on a redirect loop", async () => {
    const { impl, asked } = fakeFetch({
      "https://example.com/a": { status: 302, location: "/b" },
      "https://example.com/b": { status: 302, location: "/a" },
    });
    expect(await fetchPage("https://example.com/a", impl)).toBeNull();
    expect(asked.length).toBe(MAX_REDIRECTS + 1);
  });

  it("refuses to start at an address the browser would refuse", async () => {
    const { impl, asked } = fakeFetch({});
    expect(await fetchPage("https://10.0.0.1/", impl)).toBeNull();
    expect(asked).toEqual([]);
  });
});

const ARTICLE = `<!doctype html><html><head><title>Pricing | Example</title></head><body>
  <nav><a href="/">Home</a> <a href="/teams">Teams</a> <a href="http://10.0.0.1/">Router</a></nav>
  <main><article><h1>Pricing</h1>
  ${"<p>Pro is $12 a month and includes everything a small team needs to get started with shared notes.</p>".repeat(6)}
  </article></main><footer>Cookie banner</footer></body></html>`;

describe("a PDF at the address", () => {
  it("is handed on whole for the gateway to read, since a browser shows it with no text", async () => {
    const pdf = "%PDF-1.4\n1 0 obj << /URI (https://pay.example/x) >> endobj\n%%EOF";
    const { impl } = fakeFetch({ "https://race.example/map.pdf": { type: "application/pdf", body: pdf } });
    const page = await fetchPage("https://race.example/map.pdf", impl);
    expect(page?.via).toBe("file");
    expect(page?.text).toBe("");
    expect(page?.file?.type).toBe("application/pdf");
    expect(atob(page!.file!.data)).toBe(pdf);
  });

  it("is not handed on when it is not a PDF after all, or is over the size the gateway reads", async () => {
    const { impl } = fakeFetch({
      "https://a.example/fake.pdf": { type: "application/pdf", body: "<html>not a pdf</html>" },
      "https://a.example/huge.pdf": { type: "application/pdf", body: `%PDF-${"x".repeat(MAX_PDF_BYTES)}` },
    });
    expect(await fetchPage("https://a.example/fake.pdf", impl)).toBeNull();
    expect(await fetchPage("https://a.example/huge.pdf", impl)).toBeNull();
  });
});

describe("ordinary HTML, without a browser", () => {
  it("reads the main text and every public link on the page", async () => {
    const { impl } = fakeFetch({ "https://example.com/pricing": { type: "text/html; charset=utf-8", body: ARTICLE } });
    const page = await fetchPage("https://example.com/pricing", impl);
    expect(page?.via).toBe("html");
    expect(page?.text).toContain("Pro is $12 a month");
    expect(page?.text).not.toContain("Cookie banner");
    expect(page?.links.map((l) => l.href)).toEqual(["https://example.com/", "https://example.com/teams"]);
  });

  it("the extractor never reaches the network on its own, even on a site it has an extractor for", async () => {
    const real = globalThis.fetch;
    let reached = 0;
    globalThis.fetch = (async () => {
      reached += 1;
      throw new Error("no");
    }) as typeof fetch;
    try {
      for (const url of ["https://www.youtube.com/watch?v=abc", "https://www.reddit.com/r/x/comments/1/y/", "https://x.com/a/status/1"]) {
        const { impl, asked } = fakeFetch({ [url]: { type: "text/html", body: ARTICLE } });
        await fetchPage(url, impl);
        expect(asked.length).toBe(1);
      }
      expect(reached).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("a page's pictures, for visual answers", () => {
  it("keeps the share picture first, then the page's own photos, public https only, without logos, icons or SVG", async () => {
    const shop = `<!doctype html><html><head><title>Wrap midi | Shop</title>
      <meta property="og:image" content="https://cdn.shop.example/wrap-midi-front.jpg"></head><body>
      <img src="/assets/logo.png" alt="Shop"><img src="https://cdn.shop.example/icons/cart.svg" alt="">
      <main><article><h1>Wrap midi dress</h1>
      <img src="/media/wrap-midi-back.jpg" alt="Back view">
      <img data-src="https://cdn.shop.example/wrap-midi-side.jpg" alt="Side view">
      <img src="http://insecure.example/x.jpg" alt="Insecure"><img src="https://10.0.0.1/x.jpg" alt="Private">
      <img src="data:image/gif;base64,R0lGOD" alt="Pixel">
      ${"<p>A wrap dress in black crepe, cut to the midi length, with a tie at the waist and a lined skirt.</p>".repeat(4)}
      </article></main></body></html>`;
    const { impl } = fakeFetch({ "https://shop.example/wrap-midi": { type: "text/html", body: shop } });
    const page = await fetchPage("https://shop.example/wrap-midi", impl);
    expect(page?.images).toEqual([
      { alt: "", src: "https://cdn.shop.example/wrap-midi-front.jpg" },
      { alt: "Back view", src: "https://shop.example/media/wrap-midi-back.jpg" },
      { alt: "Side view", src: "https://cdn.shop.example/wrap-midi-side.jpg" },
    ]);
  });

  // Dev2, 2026-10-26: a card of restaurants "didn't even fill in the dishes, or logos".
  it("names the site's logo from its home-screen icon, kept apart from the photos", async () => {
    const place = `<!doctype html><html><head><title>Hav &amp; Mar</title>
      <link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"></head><body><main>
      ${"<p>Marcus Samuelsson's Chelsea restaurant, Ethiopian and Nordic cooking, open daily from five.</p>".repeat(4)}
      </main></body></html>`;
    const { impl } = fakeFetch({ "https://havandmar.example/": { type: "text/html", body: place } });
    const page = await fetchPage("https://havandmar.example/", impl);
    expect(page?.logo).toBe("https://havandmar.example/apple-touch-icon.png");
    expect(page?.images).toEqual([]);
  });

  it("takes a Markdown page's pictures, resolved against the page, at most MAX_IMAGES", () => {
    const many = Array.from({ length: 20 }, (_, i) => `![Dish ${i}](/menu/dish-${i}.jpg)`).join("\n");
    const page = fromMarkdown("https://food.example/menu", `# Menu\n\n${many}`);
    expect(page.images?.length).toBe(MAX_IMAGES);
    expect(page.images?.[0]).toEqual({ alt: "Dish 0", src: "https://food.example/menu/dish-0.jpg" });
  });

  it("keepImages leaves out anything not a public https picture", () => {
    expect(
      keepImages(
        [{ src: "javascript:alert(1)" }, { src: "https://localhost/a.jpg" }, { src: "https://a.example/favicon.ico" }, { src: 42 }, { src: "https://a.example/p.jpg", alt: "  A  photo " }, { src: "https://a.example/p.jpg" }],
        "https://a.example/",
      ),
    ).toEqual([{ alt: "A photo", src: "https://a.example/p.jpg" }]);
  });
});

describe("htmlToText", () => {
  it("keeps one line per block and marks list items", () => {
    expect(htmlToText("<h2>Plans</h2><p>Pro is <b>$12</b>.</p><ul><li>Notes</li><li>Sharing</li></ul>A<br>B")).toBe(
      "Plans\nPro is $12.\n- Notes\n- Sharing\n\nA\nB",
    );
  });
});

describe("fromMarkdown", () => {
  it("keeps only public https links, once each, and caps text and links", () => {
    const links = Array.from({ length: 80 }, (_, i) => `[L${i}](https://example.com/${i})`).join(" ");
    const page = fromMarkdown(
      "https://example.com/",
      `[a](https://example.com/0) [local](https://192.168.1.1/) [mail](mailto:a@example.com) ${links} ${"x".repeat(MAX_TEXT_CHARS)}`,
    );
    expect(page.links[0]).toEqual({ text: "a", href: "https://example.com/0" });
    expect(page.links.some((l) => l.href.includes("192.168") || l.href.startsWith("mailto"))).toBe(false);
    expect(page.links.length).toBe(MAX_LINKS);
    expect(page.text.length).toBe(MAX_TEXT_CHARS);
    expect(page.truncated).toBe(true);
  });
});
