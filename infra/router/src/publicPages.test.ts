/**
 * The apex's indexable surface for search and answer engines: the sitemap,
 * robots.txt's sitemap line, llms.txt, the homepage's structured data, the
 * `/shared-ai-memory` page, and the addresses that used to answer every
 * crawler with the sign-in card and the homepage as canonical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { route } from "./route";
import { LLMS_TEXT } from "./agentDocs";
import { HOME_FAQ } from "./faq";
import { injectHomeHead, homeDocumentResponse } from "./homeSite";
import { HOME_DESCRIPTION, HOME_TITLE } from "./preview/meta";
import {
  SHARED_MEMORY_DESCRIPTION,
  SHARED_MEMORY_FAQ,
  SHARED_MEMORY_H1,
  SHARED_MEMORY_TITLE,
  SITEMAP_PATHS,
} from "./publicPages";

const ENV = { EXPO_ORIGIN: "https://context.expo.app", CONVEX_ORIGIN: "https://example-deployment.convex.site" };
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const OAI_SEARCHBOT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot";
const PERPLEXITYBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)";

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error("upstream fetch attempted");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function get(url: string, userAgent?: string, method = "GET"): Promise<Response> {
  const headers = userAgent ? { "User-Agent": userAgent } : undefined;
  return worker.fetch(new Request(url, { method, headers }), ENV, CTX) as Promise<Response>;
}

/** Words new marketing copy must not carry: the held launch, and other note apps. */
const FORBIDDEN = /\bTex\b|tex\.lc|Notion|Obsidian|Instinct|\bMem\b|directory|approved|listed/i;

function jsonLd(html: string): Record<string, unknown> {
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  expect(block).not.toBeNull();
  return JSON.parse(block![1]!) as Record<string, unknown>;
}

function graphNode(data: Record<string, unknown>, type: string): Record<string, unknown> {
  const node = (data["@graph"] as Record<string, unknown>[]).find((entry) => entry["@type"] === type);
  expect(node, type).toBeDefined();
  return node!;
}

describe("/sitemap.xml", () => {
  it("is XML listing exactly the indexable pages, for a crawler and a person, with no upstream", async () => {
    for (const ua of [GOOGLEBOT, BROWSER, undefined]) {
      const response = await get("https://context.lc/sitemap.xml", ua);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
      const body = await response.text();
      expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
      expect(locs).toEqual([
        "https://context.lc/",
        "https://context.lc/claude",
        "https://context.lc/claude.md",
        "https://context.lc/agents",
        "https://context.lc/grokbot.md",
        "https://context.lc/llms.txt",
        "https://context.lc/shared-ai-memory",
      ]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers HEAD with no body", async () => {
    const response = await get("https://context.lc/sitemap.xml", BROWSER, "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(await response.text()).toBe("");
  });

  // The invariant the list exists for: nothing in it is a stub, a redirect, or noindex.
  it.each(SITEMAP_PATHS)("%s is a 200, indexable, self-canonical page for Googlebot", async (path) => {
    const response = await get(`https://context.lc${path}`, GOOGLEBOT);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    const body = await response.text();
    expect(body).not.toMatch(/noindex/i);
    expect(body).not.toContain("Sign in to open this link");
    if ((response.headers.get("Content-Type") ?? "").startsWith("text/html")) {
      expect(body).toContain(`<link rel="canonical" href="https://context.lc${path}">`);
    }
  });

  it("is not served on a Tex host", () => {
    expect(route(new URL("https://tex.lc/sitemap.xml"), BROWSER).kind).toBe("proxy");
    expect(route(new URL("https://context.lc/sitemap.xml"), BROWSER)).toEqual({ kind: "public-page", page: "sitemap" });
  });
});

describe("robots.txt", () => {
  it("names the sitemap and the content signals", async () => {
    const body = await (await get("https://context.lc/robots.txt", GOOGLEBOT)).text();
    expect(body).toContain("Content-Signal: search=yes,ai-input=yes,ai-train=no,use=reference");
    expect(body).toContain("Sitemap: https://context.lc/sitemap.xml");
  });
});

describe("/llms.txt", () => {
  it("is plain text with the settled summary", async () => {
    const response = await get("https://context.lc/llms.txt", OAI_SEARCHBOT);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    expect(body).toBe(LLMS_TEXT);
    for (const sentence of [
      "Shared Markdown notes for people, groups, and the AI tools they use.",
      "An agent connects at https://mcp.context.lc/mcp and signs in with OAuth.",
      "The same portable Markdown files give those tools shared memory, instead of a separate memory inside each assistant.",
      "ChatGPT, Claude, Cursor, and other MCP-compatible clients can read and write the same notes.",
      "Context does not charge for an account.",
      "A new address joins the waitlist.",
      "One connection reaches every workspace that account belongs to, addressed as @name.",
      "Notes are plain Markdown in storage you own.",
      "You can download everything as folders.",
    ]) {
      expect(body).toContain(sentence);
    }
  });

  it("links only real indexable pages", () => {
    const links = [...LLMS_TEXT.matchAll(/\]\((https:\/\/context\.lc[^)]*)\)/g)].map((match) => match[1]);
    expect(links.sort()).toEqual(
      [
        "https://context.lc/agents",
        "https://context.lc/claude",
        "https://context.lc/claude.md",
        "https://context.lc/grokbot.md",
        "https://context.lc/shared-ai-memory",
      ].sort(),
    );
    for (const link of links) expect(SITEMAP_PATHS).toContain(link!.slice("https://context.lc".length));
    expect(LLMS_TEXT).not.toMatch(FORBIDDEN);
  });
});

describe("the homepage a crawler reads", () => {
  it("keeps WebSite and Organization, and adds SoftwareApplication and FAQPage", async () => {
    const html = await (await get("https://context.lc/", OAI_SEARCHBOT)).text();
    const data = jsonLd(html);
    graphNode(data, "WebSite");
    graphNode(data, "Organization");
    const app = graphNode(data, "SoftwareApplication");
    expect(app.offers).toEqual({
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Context does not charge for an account. A new address joins the waitlist.",
    });
    const faq = graphNode(data, "FAQPage");
    const questions = (faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[]).map((entry) => entry.name);
    expect(questions).toEqual([
      "What is Context.LC?",
      "How do I add Context to Claude?",
      "Is Context free?",
      "Where do my notes live?",
    ]);
  });

  it("shows every question and answer the FAQPage data names", async () => {
    const html = await (await get("https://context.lc/", GOOGLEBOT)).text();
    for (const entry of HOME_FAQ) {
      expect(html).toContain(`<h3>${entry.question}</h3>`);
      expect(html).toContain(`<p>${entry.answer}</p>`);
    }
    expect(html).toContain('href="https://context.lc/shared-ai-memory"');
    expect(html).toContain(`<meta name="description" content="${HOME_DESCRIPTION}">`);
    expect(html).not.toMatch(/Notion|Obsidian|\bTex\b/);
  });
});

describe("/shared-ai-memory", () => {
  it.each([
    ["a person", BROWSER],
    ["Googlebot", GOOGLEBOT],
    ["OAI-SearchBot", OAI_SEARCHBOT],
    ["PerplexityBot", PERPLEXITYBOT],
  ])("is the same indexable page for %s", async (_name, ua) => {
    const response = await get("https://context.lc/shared-ai-memory", ua);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    const html = await response.text();
    expect(html).toContain(
      "<title>Shared AI memory across ChatGPT, Claude, and Cursor, backed by notes you own | Context.LC</title>",
    );
    expect(SHARED_MEMORY_TITLE).toBe(
      "Shared AI memory across ChatGPT, Claude, and Cursor, backed by notes you own | Context.LC",
    );
    expect(html).toContain(`<meta name="description" content="${SHARED_MEMORY_DESCRIPTION}">`);
    expect(SHARED_MEMORY_DESCRIPTION).toBe(
      "Share memory between ChatGPT, Claude, Cursor, and other MCP-compatible clients with Context.LC. " +
        "The same plain Markdown notes stay in files you own.",
    );
    expect(html).toContain('<link rel="canonical" href="https://context.lc/shared-ai-memory">');
    expect(html).toContain(`<h1>${SHARED_MEMORY_H1}</h1>`);
    expect(SHARED_MEMORY_H1).toBe("Shared AI memory, backed by notes you own");
    expect(html).not.toMatch(/noindex/i);
    expect(html).toContain("<code>https://mcp.context.lc/mcp</code>");
    expect(html).toContain('<a href="/claude">');
    for (const heading of [
      "How Context gives AI tools shared memory",
      "Share memory between ChatGPT and Claude",
      "An MCP memory server in files you own",
      "Persistent context across Claude Code and Cursor",
      "What stays true",
    ]) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
  });

  it("has six questions, shown on the page and matched word for word by its FAQPage data", async () => {
    const html = await (await get("https://context.lc/shared-ai-memory/", BROWSER)).text();
    expect(SHARED_MEMORY_FAQ).toHaveLength(6);
    const faq = graphNode(jsonLd(html), "FAQPage");
    const entries = faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[];
    expect(entries.map((entry) => [entry.name, entry.acceptedAnswer.text])).toEqual(
      SHARED_MEMORY_FAQ.map((entry) => [entry.question, entry.answer]),
    );
    for (const entry of SHARED_MEMORY_FAQ) {
      expect(html).toContain(`<h3>${entry.question}</h3>`);
      expect(html).toContain(`<p>${entry.answer}</p>`);
    }
  });

  it("makes no claim the guardrails rule out", async () => {
    const html = await (await get("https://context.lc/shared-ai-memory", BROWSER)).text();
    expect(html).not.toMatch(FORBIDDEN);
    expect(html).not.toMatch(/\$\d|per month|\/mo\b|notes? limit|up to [\d,]+ notes/i);
    expect(html).toContain("Context does not charge for an account. A new address joins the waitlist.");
  });

  it("is not served on a Tex host, and refuses writes", async () => {
    expect(route(new URL("https://tex.lc/shared-ai-memory"), BROWSER).kind).toBe("proxy");
    expect((await get("https://context.lc/shared-ai-memory", BROWSER, "POST")).status).toBe(405);
  });
});

describe("addresses that used to be the sign-in card with the homepage as canonical", () => {
  it.each([
    ["/privacy", "https://context.lc/legal/privacy/"],
    ["/privacy/", "https://context.lc/legal/privacy/"],
    ["/terms", "https://context.lc/legal/terms/"],
    ["/terms?ref=x", "https://context.lc/legal/terms/"],
  ])("%s moves to its complete public document", async (path, location) => {
    for (const ua of [GOOGLEBOT, BROWSER]) {
      const response = await get(`https://context.lc${path}`, ua);
      expect(response.status).toBe(301);
      expect(response.headers.get("Location")).toBe(location);
    }
  });

  it("the terms document is a static file for everyone, like the privacy one", () => {
    for (const path of ["/legal/terms", "/legal/terms/"]) {
      for (const ua of [GOOGLEBOT, BROWSER]) {
        expect(route(new URL(`https://context.lc${path}`), ua)).toEqual({ kind: "proxy", upstream: "expo", path });
      }
    }
  });

  it("/connect is a real 404 for a crawler, and the app for a person", async () => {
    const response = await get("https://context.lc/connect", GOOGLEBOT);
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    const html = await response.text();
    expect(html).not.toContain("Sign in to open this link");
    expect(html).not.toContain('rel="canonical"');
    expect(route(new URL("https://context.lc/connect"), BROWSER).kind).toBe("proxy");
    // The Slack connect link keeps its own card.
    expect(route(new URL(`https://context.lc/connect/slack/${"a".repeat(24)}`), GOOGLEBOT).kind).toBe("preview");
  });

  it("a homepage website page is its own card, with its own canonical", async () => {
    fetchSpy.mockImplementation(async () =>
      Response.json({ title: "devlog", description: "What we are improving.", siteName: "Context.LC", cardVersion: null }),
    );
    const response = await get("https://context.lc/devlog", GOOGLEBOT);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>devlog</title>");
    expect(html).toContain('<link rel="canonical" href="https://context.lc/devlog">');
    expect(html).not.toContain("Sign in to open this link");
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({
      handle: "context-lc",
      routePath: "/devlog",
    });
  });

  it("an address the homepage website does not have is a 404", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ title: null, description: null, siteName: null, cardVersion: null }));
    const response = await get("https://context.lc/use-cases-that-do-not-exist", GOOGLEBOT);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Sign in to open this link");
  });

  it("a control plane that cannot be asked is a 503, never a 404 for a page that may exist", async () => {
    const response = await get("https://context.lc/devlog", GOOGLEBOT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
  });

  it("a path the site's router would refuse is a 404 that asks nobody", async () => {
    for (const path of ["/a%2fb", "/x%5cy", "/.env", "/x/.hidden"]) {
      const decision = route(new URL(`https://context.lc${path}`), GOOGLEBOT);
      expect(decision.kind === "not-found" || decision.kind === "preview", path).toBe(true);
    }
    expect(route(new URL("https://context.lc/a%2fb"), GOOGLEBOT)).toEqual({ kind: "not-found" });
    expect(route(new URL("https://context.lc/.x/y"), GOOGLEBOT)).toEqual({ kind: "not-found" });
    expect(route(new URL("https://context.lc/use-cases/"), GOOGLEBOT)).toEqual({ kind: "home-page-preview", routePath: "/use-cases" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a retired homepage address still moves for a crawler", async () => {
    const response = await get("https://context.lc/pricing", GOOGLEBOT);
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://context.lc/");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a console address still gets the frozen card and asks nobody", async () => {
    const response = await get("https://context.lc/console/@alice/notes", GOOGLEBOT);
    expect(await response.text()).toContain("Sign in to open this link");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("plain HTTP", () => {
  it.each([
    ["http://context.lc/claude?x=1", "https://context.lc/claude?x=1"],
    ["http://www.context.lc/a", "https://context.lc/a"],
    ["http://tex.lc/", "https://tex.lc/"],
    ["http://www.tex.lc/b", "https://tex.lc/b"],
  ])("%s moves to HTTPS in one hop", (from, to) => {
    expect(route(new URL(from), BROWSER)).toEqual({ kind: "redirect", location: to });
  });

  it("leaves local development and previews alone", () => {
    expect(route(new URL("http://localhost:8787/claude"), BROWSER)).toEqual({ kind: "agent-doc", doc: "claude" });
    expect(route(new URL("http://context-router.example.workers.dev/claude"), BROWSER)).toEqual({ kind: "agent-doc", doc: "claude" });
  });
});

describe("the app shell's head on /", () => {
  const SHELL = `<!DOCTYPE html><html><head><title>Context</title><meta name="description" content="x"></head><body><div id="root"></div></body></html>`;

  it("carries the homepage's title, canonical and OpenGraph tags", () => {
    const html = injectHomeHead(SHELL);
    expect(html).toContain(`<title>${HOME_TITLE}</title>`);
    expect(html).not.toContain("<title>Context</title>");
    expect(html).toContain('<link rel="canonical" href="https://context.lc/"');
    expect(html).toContain('<meta property="og:url" content="https://context.lc/">');
    expect(html).toContain(`<meta property="og:description" content="${HOME_DESCRIPTION}">`);
    expect(html).toContain('<meta property="og:image" content="https://context.lc/og/card.png">');
    expect(html.indexOf('rel="canonical"')).toBeLessThan(html.indexOf("</head>"));
    expect(injectHomeHead(html)).toBe(html);
  });

  it("is added to / only, never to another app address", async () => {
    const upstream = () => new Response(SHELL, { headers: { "Content-Type": "text/html" } });
    const home = await (await homeDocumentResponse(upstream(), Promise.resolve(null), "/")).text();
    expect(home).toContain('<link rel="canonical" href="https://context.lc/"');
    const alias = await (await homeDocumentResponse(upstream(), Promise.resolve(null), "/a")).text();
    expect(alias).not.toContain('rel="canonical"');
  });

  it("the static shell's description is the homepage's", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(new URL("../../../apps/mobile/public/index.html", import.meta.url), "utf8");
    expect(shell).toContain(`content="${HOME_DESCRIPTION}"`);
  });
});
