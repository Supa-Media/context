import { describe, expect, it } from "vitest";
import { MAX_LINKS, MAX_TEXT_CHARS, READ_SOURCE, parseReadRequest, read } from "./read";
import type { BrowserLike, PageLike } from "./shoot";

function fakeBrowser(page: { text?: string; links?: Array<{ text: string; href: string }>; href?: string; fail?: boolean }) {
  const calls: string[] = [];
  const browser: BrowserLike = {
    async newPage() {
      const fake: PageLike = {
        async setViewport() {},
        async goto(url) {
          calls.push(`goto ${url}`);
          if (page.fail) throw new Error("net::ERR_NAME_NOT_RESOLVED at https://example.com/secret?q=1");
        },
        async waitForSelector() {},
        async evaluate<T>(source: string) {
          if (source === READ_SOURCE) return { title: "Example", text: page.text ?? "Hello", links: page.links ?? [] } as T;
          if (source === "location.href") return (page.href ?? "https://example.com/") as T;
          return undefined as T;
        },
        async screenshot() {
          return "";
        },
        on() {},
        async close() {
          calls.push("page closed");
        },
      };
      return fake;
    },
    async close() {
      calls.push("browser closed");
    },
  };
  return { browser, calls };
}

describe("parseReadRequest", () => {
  it("takes a public https address and nothing else", () => {
    expect(parseReadRequest({ url: "https://example.com/a" })).toEqual({ url: "https://example.com/a" });
    for (const url of ["http://example.com", "https://localhost/", "https://10.0.0.1/", "https://user:pw@example.com/", "https://example.com:8443/", "https://printer.local/", "https://metadata.internal/", 42]) {
      expect(parseReadRequest({ url })).toBeNull();
    }
    expect(parseReadRequest(null)).toBeNull();
  });
});

describe("read", () => {
  it("returns the title, text and public links, and closes the browser", async () => {
    const { browser, calls } = fakeBrowser({
      text: "Line one\n\n\n\nLine two",
      links: [
        { text: "Docs", href: "https://example.com/docs" },
        { text: "Docs again", href: "https://example.com/docs" },
        { text: "Local", href: "http://192.168.1.1/" },
        { text: "Mail", href: "mailto:a@example.com" },
      ],
    });
    const page = await read(browser, "https://example.com/");
    expect(page).toEqual({
      url: "https://example.com/",
      title: "Example",
      text: "Line one\n\nLine two",
      truncated: false,
      links: [{ text: "Docs", href: "https://example.com/docs" }],
      via: "browser",
    });
    expect(calls).toContain("browser closed");
  });

  it("caps the text and the links", async () => {
    const links = Array.from({ length: 80 }, (_, i) => ({ text: `L${i}`, href: `https://example.com/${i}` }));
    const page = await read(fakeBrowser({ text: "x".repeat(MAX_TEXT_CHARS + 10), links }).browser, "https://example.com/");
    expect(page.text.length).toBe(MAX_TEXT_CHARS);
    expect(page.truncated).toBe(true);
    expect(page.links.length).toBe(MAX_LINKS);
  });

  it("a redirect to a private address is not reported as where it ended up", async () => {
    const page = await read(fakeBrowser({ href: "https://127.0.0.1/admin" }).browser, "https://example.com/");
    expect(page.url).toBe("https://example.com/");
  });

  it("a page that fails still closes the browser", async () => {
    const { browser, calls } = fakeBrowser({ fail: true });
    await expect(read(browser, "https://example.com/")).rejects.toThrow();
    expect(calls).toContain("browser closed");
  });
});
