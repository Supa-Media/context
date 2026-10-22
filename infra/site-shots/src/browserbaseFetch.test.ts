import { describe, expect, it } from "vitest";
import { browserbaseFetch } from "./browserbaseFetch";
import { fetchPage, fetchRead } from "./fetchText";

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };

type Answer = { statusCode: number; contentType?: string; content?: unknown; headers?: Record<string, unknown> };

/** Browserbase's Fetch API, answering for each address; records every request made of it. */
function fakeApi(answers: Record<string, Answer>, refuseProxies = false) {
  const asked: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push({ url: String(input), key: new Headers(init?.headers).get("X-BB-API-Key"), body });
    if (refuseProxies && body.proxies) return new Response("{\"error\":\"plan\"}", { status: 402 });
    const answer = answers[body.url];
    if (!answer) return new Response("{}", { status: 500 });
    return Response.json({ id: "f1", encoding: "utf-8", headers: {}, ...answer });
  }) as typeof fetch;
  return { fetcher, asked };
}

const ARTICLE = `<!doctype html><html><head><title>Fares</title></head><body><main><h1>Fares</h1>
  ${"<p>A return ticket to the coast is $40 and children under five travel free on every route.</p>".repeat(5)}
  <a href="/timetable">Timetable</a></main></body></html>`;

describe("browserbaseFetch", () => {
  it("reads a page through Browserbase, proxied, asking it never to follow a redirect itself", async () => {
    const api = fakeApi({ "https://rail.example/fares": { statusCode: 200, contentType: "text/html; charset=utf-8", content: ARTICLE } });
    const page = await fetchPage("https://rail.example/fares", browserbaseFetch(ENV, api.fetcher));
    expect(page?.via).toBe("html");
    expect(page?.text).toContain("children under five travel free");
    expect(page?.links.map((l) => l.href)).toEqual(["https://rail.example/timetable"]);
    expect(api.asked).toEqual([{
      url: "https://api.browserbase.com/v1/fetch",
      key: "bb_test_key",
      body: { url: "https://rail.example/fares", allowRedirects: false, proxies: true, format: "raw" },
    }]);
  });

  it("follows a redirect by hand, and never to a private address", async () => {
    const api = fakeApi({
      "https://rail.example/old": { statusCode: 301, headers: { Location: "/fares" } },
      "https://rail.example/fares": { statusCode: 200, contentType: "text/html", content: ARTICLE },
      "https://rail.example/sneaky": { statusCode: 302, headers: { location: "https://169.254.169.254/latest" } },
    });
    expect((await fetchPage("https://rail.example/old", browserbaseFetch(ENV, api.fetcher)))?.url).toBe("https://rail.example/fares");
    api.asked.length = 0;
    expect(await fetchPage("https://rail.example/sneaky", browserbaseFetch(ENV, api.fetcher))).toBeNull();
    expect(api.asked.map((a) => a.body.url)).toEqual(["https://rail.example/sneaky"]);
  });

  it("asks without a proxy when the plan refuses one", async () => {
    const api = fakeApi({ "https://rail.example/fares": { statusCode: 200, contentType: "text/html", content: ARTICLE } }, true);
    expect((await fetchPage("https://rail.example/fares", browserbaseFetch(ENV, api.fetcher)))?.via).toBe("html");
    expect(api.asked.map((a) => a.body.proxies)).toEqual([true, false]);
  });

  it("anything but HTML or Markdown reads as unreadable, so a PDF sent as text is never mangled", async () => {
    const api = fakeApi({ "https://rail.example/map.pdf": { statusCode: 200, contentType: "application/pdf", content: "%PDF-1.4 mangled" } });
    expect(await fetchPage("https://rail.example/map.pdf", browserbaseFetch(ENV, api.fetcher))).toBeNull();
  });

  it("a failed call or a nonsense answer is a page not read, never a throw", async () => {
    const down = fakeApi({});
    expect(await fetchRead("https://rail.example/x", browserbaseFetch(ENV, down.fetcher))).toEqual({ page: null, refused: true });
    const odd = fakeApi({ "https://rail.example/x": { statusCode: 42, content: "?" } });
    expect((await fetchRead("https://rail.example/x", browserbaseFetch(ENV, odd.fetcher))).page).toBeNull();
    const empty = fakeApi({ "https://rail.example/x": { statusCode: 204 } });
    expect((await fetchRead("https://rail.example/x", browserbaseFetch(ENV, empty.fetcher))).page).toBeNull();
  });
});
