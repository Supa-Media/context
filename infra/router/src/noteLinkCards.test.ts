/**
 * A note link Tex texted, `/note/@slug/<path>?t=<name>&k=<key>`, unfurls with
 * the note's name and card when the control plane says the key is Tex's, and
 * as the frozen "A note in Context" card otherwise (Dev, 2026-11-23;
 * `docs/decisions/privacy-and-sharing/note-link-previews.md`). This Worker
 * holds no secret: what is checked here is that it forwards only well-shaped
 * links, never answers a name the control plane did not confirm, and keys the
 * card's cache on the checked parts rather than the URL as sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { noteCardUrl, signedNoteLinkFrom } from "./noteLinkCards";

const ENV = { EXPO_ORIGIN: "https://context.expo.app", CONVEX_ORIGIN: "https://example-deployment.convex.site" };
const CTX = { waitUntil: (promise: Promise<unknown>) => void promise, passThroughOnException: () => {} } as unknown as ExecutionContext;
const IMESSAGE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
const KEY = "AbCdEfGhIjKlMnOpQrSt_-";
const LINK = `https://context.lc/note/@seyi/areas/spirit/1-timothy-1.md?t=1%20Timothy%201&k=${KEY}`;

let preview: () => Response;
let card: () => Response;
let asked: Array<{ path: string; body: unknown }>;
let stored: Map<string, Response>;

beforeEach(() => {
  preview = () => Response.json({ title: "1 Timothy 1", description: "Spirit", card: true });
  card = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      asked.push({ path: url.pathname, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (url.pathname === "/note/preview") return preview();
      if (url.pathname === "/note/card") return card();
      if (url.pathname === "/share/note") return Response.json({ title: null });
      return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
    }),
  );
  stored = new Map();
  vi.stubGlobal("caches", {
    default: {
      match: async (request: Request) => stored.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => void stored.set(request.url, response),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const crawl = (url: string) => worker.fetch(new Request(url, { headers: { "User-Agent": IMESSAGE } }), ENV as never, CTX);
const html = async (url: string) => await (await crawl(url)).text();

describe("a signed note link's tags", () => {
  it("carry the note's name, its folders and its card, once the control plane confirms the key", async () => {
    const page = await html(LINK);
    expect(page).toContain('<meta property="og:title" content="1 Timothy 1">');
    expect(page).toContain('<meta property="og:description" content="Spirit">');
    const image = /<meta property="og:image" content="([^"]+)">/.exec(page)?.[1]?.replace(/&amp;/g, "&");
    expect(image).toBe(noteCardUrl({ slug: "seyi", path: "areas/spirit/1-timothy-1.md", title: "1 Timothy 1", key: KEY }));
    expect(asked.find((call) => call.path === "/note/preview")?.body).toEqual({ slug: "seyi", path: "areas/spirit/1-timothy-1.md", title: "1 Timothy 1", key: KEY });
  });

  it("are the frozen note card when the control plane refuses the key", async () => {
    preview = () => Response.json({ title: null, description: null, card: null });
    const page = await html(LINK);
    expect(page).toContain('<meta property="og:title" content="A note in Context">');
    expect(page).not.toContain("1 Timothy 1");
  });

  it("never show a name the control plane did not answer with", async () => {
    preview = () => Response.json({ title: "Something else", description: "", card: true });
    expect(await html(LINK)).toContain('<meta property="og:title" content="A note in Context">');
  });

  it("are the frozen card when the control plane is down", async () => {
    preview = () => new Response("nope", { status: 502 });
    expect(await html(LINK)).toContain('<meta property="og:title" content="A note in Context">');
  });

  it("keep the product picture for a name the card cannot draw", async () => {
    preview = () => Response.json({ title: "1 Timothy 1", description: "", card: false });
    const page = await html(LINK);
    expect(page).toContain('<meta property="og:title" content="1 Timothy 1">');
    expect(page).toContain("/og/card.png");
    expect(asked.some((call) => call.path === "/note/card")).toBe(false);
  });

  it("escape the name", async () => {
    const link = `https://context.lc/note/@seyi/a.md?t=${encodeURIComponent('<script>"x"')}&k=${KEY}`;
    preview = () => Response.json({ title: '<script>"x"', description: "", card: false });
    const page = await html(link);
    expect(page).not.toContain("<script>\"x\"");
    expect(page).toContain("&lt;script&gt;");
  });

  it("are not asked for at all for a link without a well-formed key, or one into plumbing", async () => {
    for (const link of [
      "https://context.lc/note/@seyi/a.md?t=A",
      "https://context.lc/note/@seyi/a.md?t=A&k=short",
      `https://context.lc/note/@seyi/.context/a.md?t=A&k=${KEY}`,
      `https://context.lc/note/@seyi/files/a.png?t=A&k=${KEY}`,
      `https://context.lc/note/@seyi/a.md?t=${"x".repeat(201)}&k=${KEY}`,
    ]) {
      expect(await html(link)).toContain('<meta property="og:title" content="A note in Context">');
    }
    expect(asked.some((call) => call.path === "/note/preview")).toBe(false);
  });

  it("read a page's link the same way", () => {
    expect(signedNoteLinkFrom(new URL(`https://context.lc/p/@Seyi/site/home.page.md?t=Home&k=${KEY}`))).toEqual({ slug: "seyi", path: "site/home.page.md", title: "Home", key: KEY });
  });
});

describe("a signed note link's card", () => {
  const cardUrl = noteCardUrl({ slug: "seyi", path: "areas/spirit/1-timothy-1.md", title: "1 Timothy 1", key: KEY });

  it("is the control plane's PNG, asked with the checked link, and kept", async () => {
    const response = await crawl(cardUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(asked.filter((call) => call.path === "/note/card")).toEqual([{ path: "/note/card", body: { slug: "seyi", path: "areas/spirit/1-timothy-1.md", title: "1 Timothy 1", key: KEY } }]);
    await crawl(cardUrl);
    expect(asked.filter((call) => call.path === "/note/card")).toHaveLength(1);
  });

  it("is one cache entry however the query is written", async () => {
    await crawl(cardUrl);
    const shuffled = `https://context.lc/og/note.png?k=${KEY}&t=1+Timothy+1&p=areas%2Fspirit%2F1-timothy-1.md&s=SEYI&x=1`;
    expect((await crawl(shuffled)).status).toBe(200);
    expect(asked.filter((call) => call.path === "/note/card")).toHaveLength(1);
    expect([...stored.keys()]).toEqual([cardUrl]);
  });

  it("is a 404, never cached, when the control plane refuses it", async () => {
    card = () => new Response(null, { status: 404 });
    const response = await crawl(cardUrl);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(stored.size).toBe(0);
  });

  it("asks nothing for a card address missing a part", async () => {
    const response = await crawl(`https://context.lc/og/note.png?s=seyi&p=a.md&t=A`);
    expect(asked.some((call) => call.path === "/note/card")).toBe(false);
    expect(response.headers.get("Content-Type")).not.toBe("image/png");
  });
});
