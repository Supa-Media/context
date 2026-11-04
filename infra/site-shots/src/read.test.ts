import { describe, expect, it } from "vitest";
import { FRAME_TEXT_SOURCE, MAX_FRAME_CHARS_BESIDE, MAX_LINKS, MAX_TEXT_CHARS, READ_SOURCE, parseReadRequest, read, withFrames } from "./read";
import type { BrowserLike, PageLike } from "./shoot";

function fakeBrowser(page: { text?: string; links?: Array<{ text: string; href: string }>; images?: Array<{ alt: string; src: string }>; logos?: unknown[]; href?: string; fail?: boolean }) {
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
          if (source === READ_SOURCE) return { title: "Example", text: page.text ?? "Hello", links: page.links ?? [], images: page.images ?? [], logos: page.logos ?? [] } as T;
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
      images: [],
      via: "browser",
    });
    expect(calls).toContain("browser closed");
  });

  it("hands back the page's pictures, kept the same way as without a browser", async () => {
    const { browser } = fakeBrowser({
      images: [
        { alt: "Front", src: "https://cdn.example.com/dress.jpg" },
        { alt: "Logo", src: "https://example.com/static/logo.png" },
        { alt: "Relative", src: "/photos/back.jpg" },
      ],
    });
    const page = await read(browser, "https://example.com/");
    expect(page.images).toEqual([
      { alt: "Front", src: "https://cdn.example.com/dress.jpg" },
      { alt: "Relative", src: "https://example.com/photos/back.jpg" },
    ]);
  });

  it("hands back the site's logo apart from its pictures: the first public https one, resolved", async () => {
    const page = await read(fakeBrowser({ logos: ["data:image/png;base64,AA", "https://10.0.0.1/icon.png", "/apple-touch-icon.png"] }).browser, "https://example.com/");
    expect(page.logo).toBe("https://example.com/apple-touch-icon.png");
    expect((await read(fakeBrowser({ logos: [42, "javascript:alert(1)"] }).browser, "https://example.com/")).logo).toBeUndefined();
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

describe("read, a page whose words are in a frame", () => {
  /** A claude.ai-style shell: the top page says almost nothing, its frame from another site holds the content. */
  function shell(frames: Array<{ url: string; texts: string[] }>, top = "Claude Artifact") {
    const main = { url: () => "https://claude.ai/artifact/abc", evaluate: async () => "" };
    const reads = frames.map(() => 0);
    const listed = frames.map((frame, i) => ({
      url: () => frame.url,
      async evaluate<T>(source: string) {
        expect(source).toBe(FRAME_TEXT_SOURCE);
        const said = frame.texts[Math.min(reads[i], frame.texts.length - 1)];
        reads[i] += 1;
        return said as T;
      },
    }));
    const browser: BrowserLike = {
      async newPage() {
        return {
          async setViewport() {},
          async goto() {},
          async waitForSelector() {},
          async evaluate<T>(source: string) {
            if (source === READ_SOURCE) return { title: "Claude Artifact", text: top, links: [], images: [], logos: [] } as T;
            if (source === "location.href") return "https://claude.ai/artifact/abc" as T;
            return undefined as T;
          },
          async screenshot() {
            return "";
          },
          on() {},
          async close() {},
          frames: () => [main, ...listed],
          mainFrame: () => main,
        } as PageLike;
      },
      async close() {},
    };
    return { browser, reads };
  }

  const ARTIFACT = "Tex can work on your own computers\n\nConnect a laptop or a VM, and it becomes extra minions for Tex. ".repeat(4);

  it("reads the frame's words after the page's, under its site's name", async () => {
    const { browser } = shell([{ url: "https://abc.frame.claudeusercontent.com/", texts: [ARTIFACT] }]);
    const page = await read(browser, "https://claude.ai/artifact/abc", { frameWaitMs: 0 });
    expect(page.text).toBe(`Claude Artifact\n\nIn a frame from abc.frame.claudeusercontent.com:\n${ARTIFACT.trim()}`);
    expect(page.truncated).toBe(false);
  });

  it("waits for a thin shell's frame to draw its words", async () => {
    const { browser, reads } = shell([{ url: "https://abc.frame.claudeusercontent.com/", texts: ["", "", ARTIFACT] }]);
    const page = await read(browser, "https://claude.ai/artifact/abc", { frameWaitMs: 5_000 });
    expect(page.text).toContain("Tex can work on your own computers");
    expect(reads[0]).toBe(3);
  });

  it("leaves out blank, private and empty frames", async () => {
    const { browser } = shell([
      { url: "about:blank", texts: ["hidden"] },
      { url: "https://10.0.0.1/", texts: ["internal"] },
      { url: "https://ads.example.com/", texts: [""] },
      { url: "https://abc.frame.claudeusercontent.com/", texts: [ARTIFACT] },
    ]);
    const page = await read(browser, "https://claude.ai/artifact/abc", { frameWaitMs: 0 });
    expect(page.text).not.toMatch(/hidden|internal|ads\.example/);
    expect(page.text).toContain("claudeusercontent.com");
  });

  it("a page with words of its own is not held for its frames", async () => {
    const { browser, reads } = shell([{ url: "https://widget.example.com/", texts: [""] }], "A long article. ".repeat(40));
    const started = Date.now();
    await read(browser, "https://example.com/", { frameWaitMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(reads[0]).toBe(1);
  });

  it("cuts the page's words first and keeps the frame's whole", () => {
    const frame = { host: "abc.frame.claudeusercontent.com", text: "content" };
    const { text, truncated } = withFrames("x".repeat(MAX_TEXT_CHARS), [frame]);
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(text.endsWith("In a frame from abc.frame.claudeusercontent.com:\ncontent")).toBe(true);
    expect(truncated).toBe(true);
    expect(withFrames("short", [])).toEqual({ text: "short", truncated: false });
  });
});

describe("read, frames beside a page with words of its own", () => {
  it("keeps the page's words and only the start of each frame", () => {
    const top = "Article. ".repeat(100);
    const { text, truncated } = withFrames(top, [{ host: "ads.example.com", text: "y".repeat(MAX_TEXT_CHARS) }]);
    expect(text.startsWith(top.trim())).toBe(true);
    expect(text.length).toBeLessThan(top.length + MAX_FRAME_CHARS_BESIDE + 100);
    expect(truncated).toBe(true);
  });
});
