import { describe, expect, test } from "@jest/globals";
import { appSearchBody, appSearchUrl, readAppSearch, readAppSearchEverywhere, searchEverywhereThroughGateway, searchThroughGateway } from "../features/console/search/gatewaySearch";

/**
 * The search bar's wire to the gateway's `POST /app/search` (`apps/mcp/src/http/appSearch.js`), the same search an AI
 * client runs (the search revamp, 2026-11-04). An answer that does not come, or that this build cannot read, is
 * `null`, and the bar asks the control plane as before.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `readAppSearch` keeping another workspace's hits     → "keeps only this workspace's hits" fails
 *   the re-mint after a refusal removed                  → "a refused grant is replaced once" fails
 *   a failed response read as an empty answer            → "anything but an answer is null" fails
 */

const answer = (hits: unknown[], extra: Record<string, unknown> = {}) => ({ hits, matchCount: hits.length, matchCountIsFloor: false, incomplete: false, ...extra });
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("the bar's gateway search", () => {
  test("asks the gateway that serves the MCP endpoint, for one workspace", () => {
    expect(appSearchUrl("https://mcp.example.test/mcp")).toBe("https://mcp.example.test/app/search");
    expect(appSearchUrl("not a url")).toBeNull();
    expect(appSearchUrl("ftp://x.test/mcp")).toBeNull();
    expect(appSearchBody("plan", "seyi")).toEqual({ query: "plan", workspaces: ["@seyi"] });
    expect(appSearchBody("plan", "seyi", "projects/")).toEqual({ query: "plan", workspaces: ["@seyi"], prefix: "projects/" });
  });

  test("keeps only this workspace's hits, field by field", () => {
    const read = readAppSearch(
      answer([
        { workspace: "@seyi", path: "a.md", title: "A", snippet: "about a", meaningOnly: true, secret: "x" },
        { workspace: "@other", path: "b.md", title: "B", snippet: "" },
        { workspace: "@seyi", path: "c.md", title: "C", snippet: "" },
      ], { incomplete: true }),
      "seyi",
    );
    expect(read).toEqual({
      hits: [
        { path: "a.md", title: "A", snippets: ["about a"], meaningOnly: true },
        { path: "c.md", title: "C", snippets: [] },
      ],
      indexMissing: false,
      indexIncomplete: true,
      reducedRecall: false,
      reducedRecallNotes: [],
    });
    expect(readAppSearch({ hits: [{ path: 1 }] }, "seyi")).toBeNull();
    expect(readAppSearch("nope", "seyi")).toBeNull();
  });

  test("a refused grant is replaced once, never in a loop", async () => {
    const tokens: Array<false | { rejected: string }> = [];
    const sent: string[] = [];
    const found = await searchThroughGateway({
      url: "https://mcp.example.test/app/search",
      token: async (refresh) => (tokens.push(refresh), refresh === false ? "old" : "new"),
      query: "plan",
      slug: "seyi",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const auth = String((init.headers as Record<string, string>).Authorization);
        sent.push(auth);
        return auth.endsWith("old") ? ok({ error: "forbidden" }, 403) : ok(answer([{ workspace: "@seyi", path: "p.md", title: "P", snippet: "" }]));
      }) as unknown as typeof fetch,
    });
    expect(found?.hits.map((hit) => hit.path)).toEqual(["p.md"]);
    expect(tokens).toEqual([false, { rejected: "old" }]);
    expect(sent).toEqual(["Bearer old", "Bearer new"]);
  });

  test("anything but an answer is null, so the bar asks the control plane", async () => {
    const ask = (fetchImpl: unknown) =>
      searchThroughGateway({ url: "https://mcp.example.test/app/search", token: async () => "t", query: "plan", slug: "seyi", fetchImpl: fetchImpl as typeof fetch });
    expect(await ask(async () => ok({ error: "unavailable" }, 503))).toBeNull();
    expect(await ask(async () => { throw new Error("offline"); })).toBeNull();
    expect(await ask(async () => new Response("not json", { status: 200 }))).toBeNull();
    expect(await searchThroughGateway({ url: "https://x.test/app/search", token: async () => { throw new Error("Not authenticated"); }, query: "q", slug: "s" })).toBeNull();
  });

  test("every workspace in one answer, in the gateway's order, each row named by its workspace", async () => {
    const contexts = [
      { workspaceId: "ws_a", slug: "shyoh", displayName: "Shyoh" },
      { workspaceId: "ws_b", slug: "v2l", displayName: "V2L" },
    ];
    const read = readAppSearchEverywhere(
      answer([
        { workspace: "@shyoh", path: "bible/deuteronomy-23.md", title: "Deuteronomy 23", snippet: "" },
        { workspace: "@stranger", path: "x.md", title: "X", snippet: "" },
        { workspace: "@v2l", path: "meetings/a.md", title: "A", snippet: "s", loose: true },
      ]),
      contexts,
    );
    expect(read?.results.map((row) => [row.workspaceId, row.slug, row.path, row.loose ?? false])).toEqual([
      ["ws_a", "shyoh", "bible/deuteronomy-23.md", false],
      ["ws_b", "v2l", "meetings/a.md", true],
    ]);
    expect(read?.cursor).toBeNull();
    expect(read?.sources.map((source) => source.matchCount)).toEqual([1, 1]);
    const sent: unknown[] = [];
    const found = await searchEverywhereThroughGateway({
      url: "https://mcp.example.test/app/search",
      token: async () => "t",
      query: "Deut 23",
      contexts,
      fetchImpl: (async (_url: string, init: RequestInit) => (sent.push(JSON.parse(String(init.body))), ok(answer([])))) as unknown as typeof fetch,
    });
    expect(found?.results).toEqual([]);
    expect(sent).toEqual([{ query: "Deut 23", workspaces: ["@shyoh", "@v2l"] }]);
    expect(await searchEverywhereThroughGateway({ url: "https://x.test/app/search", token: async () => "t", query: "q", contexts: [] })).toBeNull();
  });
});
