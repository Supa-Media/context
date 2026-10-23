/**
 * A minimal MCP client over Streamable HTTP, for calling an app's official
 * MCP server as the person who connected it (`docs/decisions/connectors.md`).
 * Each call is its own short session: initialize, the initialized
 * notification, then the one request. Answers come back as JSON or as an
 * event stream; both are read here.
 */

import type { AppTool } from "./types";

type Fetch = typeof fetch;

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type McpOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  /** `reason` says what went wrong (a status, a refused connection), never anything from the token. */
  | { kind: "failed"; reason?: string };

/** The JSON-RPC message answering `id` in a response body, JSON or `text/event-stream`. */
export function readRpcAnswer(contentType: string, raw: string, id: number): Record<string, unknown> | null {
  const messages: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of raw.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // A keep-alive or a message we don't read.
      }
    }
  } else {
    try {
      const parsed = JSON.parse(raw);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return null;
    }
  }
  for (const message of messages) {
    if (message !== null && typeof message === "object" && (message as { id?: unknown }).id === id) {
      return message as Record<string, unknown>;
    }
  }
  return null;
}

type Session = { serverUrl: string; accessToken: string; sessionId?: string; fetchImpl: Fetch; nextId: number };

async function post(session: Session, body: Record<string, unknown>): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  if (session.sessionId !== undefined) headers["Mcp-Session-Id"] = session.sessionId;
  return await session.fetchImpl(session.serverUrl, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
}

async function request(session: Session, method: string, params: Record<string, unknown>): Promise<McpOutcome> {
  const id = session.nextId++;
  let response: Response;
  try {
    response = await post(session, { jsonrpc: "2.0", id, method, params });
  } catch (error) {
    return { kind: "failed", reason: `${method}: could not connect (${error instanceof Error ? error.message.slice(0, 120) : "network error"})` };
  }
  if (response.status === 401 || response.status === 403) return { kind: "unauthorized" };
  if (!response.ok) {
    const where = response.status >= 300 && response.status < 400 ? ` to ${response.headers.get("location") ?? "elsewhere"}` : "";
    const said = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160);
    return { kind: "failed", reason: `${method}: the server answered ${response.status}${where}${said === "" ? "" : `: ${said}`}` };
  }
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId !== null && sessionId !== "") session.sessionId = sessionId;
  const contentType = response.headers.get("content-type") ?? "";
  const answer = readRpcAnswer(contentType, await response.text(), id);
  if (answer === null) return { kind: "failed", reason: `${method}: no answer could be read from the server's reply (${contentType || "no content type"})` };
  if (answer.error !== undefined) {
    const message = (answer.error as { message?: unknown })?.message;
    return { kind: "error", message: typeof message === "string" ? message.slice(0, 500) : "The app refused that." };
  }
  return { kind: "ok", result: answer.result };
}

/** Open a session and run one request in it. */
export async function mcpCall(
  serverUrl: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown>,
  fetchImpl: Fetch = fetch,
): Promise<McpOutcome> {
  const session: Session = { serverUrl, accessToken, fetchImpl, nextId: 1 };
  const opened = await request(session, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "Tex by Context", version: "1.0.0" },
  });
  if (opened.kind !== "ok") return opened;
  try {
    await post(session, { jsonrpc: "2.0", method: "notifications/initialized" });
  } catch {
    return { kind: "failed", reason: "notifications/initialized: could not connect" };
  }
  return await request(session, method, params);
}

/** A server's tools as Tex sees them; only a tool annotated read-only counts as one. */
export function readTools(result: unknown): { tools: AppTool[]; nextCursor?: string } {
  const body = (result ?? {}) as { tools?: unknown; nextCursor?: unknown };
  const tools: AppTool[] = [];
  for (const entry of Array.isArray(body.tools) ? body.tools : []) {
    const tool = entry as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
    if (typeof tool.name !== "string" || tool.name === "") continue;
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema:
        tool.inputSchema !== null && typeof tool.inputSchema === "object" ? (tool.inputSchema as Record<string, unknown>) : { type: "object" },
      readOnly: tool.annotations?.readOnlyHint === true,
    });
  }
  return typeof body.nextCursor === "string" && body.nextCursor !== "" ? { tools, nextCursor: body.nextCursor } : { tools };
}

/** Every tool, a few pages at most. */
export async function mcpListTools(serverUrl: string, accessToken: string, fetchImpl: Fetch = fetch): Promise<McpOutcome & { tools?: AppTool[] }> {
  const all: AppTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const outcome = await mcpCall(serverUrl, accessToken, "tools/list", cursor === undefined ? {} : { cursor }, fetchImpl);
    if (outcome.kind !== "ok") return outcome;
    const read = readTools(outcome.result);
    all.push(...read.tools);
    if (read.nextCursor === undefined) break;
    cursor = read.nextCursor;
  }
  return { kind: "ok", result: null, tools: all };
}
