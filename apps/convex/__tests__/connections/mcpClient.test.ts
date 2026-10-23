import { describe, expect, test } from "vitest";
import { mcpCall } from "../../functions/lib/providers/mcpClient";

/**
 * When an app's MCP server can't be used, the outcome says why (a status, a
 * redirect, a refused connection), so Tex can tell the person and a bug report
 * names the cause instead of "could not be reached just now".
 */

const fetchAnswering = (response: () => Response) => (async () => response()) as unknown as typeof fetch;

describe("an MCP call that fails says why", () => {
  test("a status, with what the server said", async () => {
    const outcome = await mcpCall("https://mcp.example.invalid/mcp", "token", "tools/list", {}, fetchAnswering(() => new Response("Not Found", { status: 404 })));
    expect(outcome).toEqual({ kind: "failed", reason: "initialize: the server answered 404: Not Found" });
  });

  test("a redirect, with where to", async () => {
    const outcome = await mcpCall(
      "https://mcp.example.invalid/mcp",
      "token",
      "tools/list",
      {},
      fetchAnswering(() => new Response(null, { status: 308, headers: { location: "https://mcp.example.invalid/mcp/" } })),
    );
    expect(outcome).toEqual({ kind: "failed", reason: "initialize: the server answered 308 to https://mcp.example.invalid/mcp/" });
  });

  test("a connection that never opened", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await mcpCall("https://mcp.example.invalid/mcp", "token", "tools/list", {}, refused)).toEqual({
      kind: "failed",
      reason: "initialize: could not connect (fetch failed)",
    });
  });

  test("a reply with no answer in it", async () => {
    const outcome = await mcpCall("https://mcp.example.invalid/mcp", "token", "tools/list", {}, fetchAnswering(() => new Response("<html>", { headers: { "content-type": "text/html" } })));
    expect(outcome).toEqual({ kind: "failed", reason: "initialize: no answer could be read from the server's reply (text/html)" });
  });
});
