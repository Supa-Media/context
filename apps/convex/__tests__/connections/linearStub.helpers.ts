import { vi } from "vitest";

/**
 * Linear's MCP server and its authorization server, as their metadata and
 * JSON-RPC answer, for the tests that connect an app end to end.
 */

export const APP = "https://app.context.invalid";
export const SERVER = "https://mcp.linear.app/mcp";
export const ACCESS = "lin-access-0000-fake";
export const REFRESHED = "lin-access-1111-fake";
export const REFRESH = "lin-refresh-0000-fake";

export type Seen = { url: string; method: string; body: string; auth: string | null };

/** Linear's MCP server and its authorization server, as their metadata and JSON-RPC answer. */
export function stubLinear(options: { expiredToken?: string; scopes?: () => string[] } = {}) {
  const seen: Seen[] = [];
  vi.stubEnv("APP_ORIGIN", APP);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      const auth = new Headers(init?.headers).get("Authorization");
      seen.push({ url, method, body, auth });
      if (url === "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp") {
        const scopes = options.scopes?.();
        return Response.json({ resource: SERVER, authorization_servers: ["https://mcp.linear.app"], ...(scopes === undefined ? {} : { scopes_supported: scopes }) });
      }
      if (url === "https://mcp.linear.app/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://mcp.linear.app",
          authorization_endpoint: "https://mcp.linear.app/authorize",
          token_endpoint: "https://mcp.linear.app/token",
          registration_endpoint: "https://mcp.linear.app/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === "https://mcp.linear.app/register") return Response.json({ client_id: "dcr-client-1" }, { status: 201 });
      if (url === "https://mcp.linear.app/token") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "refresh_token") {
          return Response.json({ access_token: REFRESHED, refresh_token: REFRESH, expires_in: 3600, token_type: "Bearer" });
        }
        if (form.get("code") !== "code-1") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: "Bearer" });
      }
      if (url === SERVER) {
        if (auth === `Bearer ${options.expiredToken}`) return new Response("", { status: 401 });
        const rpc = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
        if (rpc.id === undefined) return new Response(null, { status: 202 });
        const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers: { "Mcp-Session-Id": "s1" } });
        if (rpc.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "linear" } });
        if (rpc.method === "tools/list") {
          return answer({
            tools: [
              {
                name: "list_issues",
                description: "List issues.",
                // As Planning Center's server sends it: Convex refuses a field named `$schema`.
                inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { team: { type: "string" } } },
                annotations: { readOnlyHint: true },
              },
              { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
              { name: "unmarked", description: "Says nothing about itself.", inputSchema: { type: "object" } },
            ],
          });
        }
        if (rpc.method === "tools/call") return answer({ content: [{ type: "text", text: `ran ${rpc.params?.name}` }] });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return seen;
}

