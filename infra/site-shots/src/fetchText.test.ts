import { describe, expect, it } from "vitest";
import { MAX_REDIRECTS, fetchMarkdown, fromMarkdown } from "./fetchText";
import { MAX_LINKS, MAX_TEXT_CHARS } from "./read";

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

describe("fetchMarkdown", () => {
  it("asks for Markdown and reads a page that sends it, with no browser", async () => {
    const { impl, asked } = fakeFetch({
      "https://example.com/pricing": {
        type: "text/markdown; charset=utf-8",
        body: "# Pricing\n\nPro is $12. See [Teams](/teams) and ![logo](/logo.png).",
      },
    });
    const page = await fetchMarkdown("https://example.com/pricing", impl);
    expect(asked).toEqual([{ url: "https://example.com/pricing", accept: "text/markdown", redirect: "manual" }]);
    expect(page).toEqual({
      url: "https://example.com/pricing",
      title: "Pricing",
      text: "# Pricing\n\nPro is $12. See [Teams](/teams) and ![logo](/logo.png).",
      truncated: false,
      links: [{ text: "Teams", href: "https://example.com/teams" }],
      via: "markdown",
    });
  });

  it("an HTML answer, an error or a failed request means the browser, not a guess", async () => {
    const { impl } = fakeFetch({
      "https://example.com/html": { type: "text/html", body: "<p>hi</p>" },
      "https://example.com/gone": { status: 404, type: "text/markdown", body: "# Not found" },
      "https://example.com/down": { throws: true },
    });
    expect(await fetchMarkdown("https://example.com/html", impl)).toBeNull();
    expect(await fetchMarkdown("https://example.com/gone", impl)).toBeNull();
    expect(await fetchMarkdown("https://example.com/down", impl)).toBeNull();
  });

  it("follows a redirect to another public page, and reports where it ended", async () => {
    const { impl } = fakeFetch({
      "https://example.com/old": { status: 301, location: "/new" },
      "https://example.com/new": { type: "text/markdown", body: "# New" },
    });
    expect((await fetchMarkdown("https://example.com/old", impl))?.url).toBe("https://example.com/new");
  });

  it("never follows a redirect to a private or internal address", async () => {
    for (const location of ["https://127.0.0.1/admin", "http://example.com/plain", "https://metadata.internal/", "https://example.com:8443/", "https://user:pw@example.com/"]) {
      const { impl, asked } = fakeFetch({
        "https://example.com/hop": { status: 302, location },
        [location]: { type: "text/markdown", body: "# Secret" },
      });
      expect(await fetchMarkdown("https://example.com/hop", impl)).toBeNull();
      expect(asked.map((a) => a.url)).toEqual(["https://example.com/hop"]);
    }
  });

  it("gives up on a redirect loop", async () => {
    const { impl, asked } = fakeFetch({
      "https://example.com/a": { status: 302, location: "/b" },
      "https://example.com/b": { status: 302, location: "/a" },
    });
    expect(await fetchMarkdown("https://example.com/a", impl)).toBeNull();
    expect(asked.length).toBe(MAX_REDIRECTS + 1);
  });

  it("refuses to start at an address the browser would refuse", async () => {
    const { impl, asked } = fakeFetch({});
    expect(await fetchMarkdown("https://10.0.0.1/", impl)).toBeNull();
    expect(asked).toEqual([]);
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
