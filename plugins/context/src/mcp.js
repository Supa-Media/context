/**
 * The two MCP requests this CLI makes: call a tool, list the tools.
 *
 * One plain JSON-RPC POST each and no handshake: the gateway is dual-era and
 * has never had a protocol session, so a single request is a complete
 * interaction on the legacy revision.
 *
 * Neither throws. Every failure is `null`, because both run from hooks, where
 * a stack trace printed over somebody's session is worse than doing nothing,
 * and from commands, which turn `null` into one sentence.
 */

const TIMEOUT_MS = 8_000;

async function rpc({ url, token, method, params, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || body.error) return null;
    return body.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `{ text, isError }` from one tool call, or `null` when no answer came back.
 *
 * `isError` is kept rather than folded into `null`: a refusal from the gateway
 * is an answer a person should read, where a dropped connection is not.
 */
export async function callTool({ url, token, name, args = {}, fetchImpl, timeoutMs }) {
  const result = await rpc({ url, token, method: "tools/call", params: { name, arguments: args }, fetchImpl, timeoutMs });
  if (!result) return null;
  const text = (result.content || [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return { text, isError: result.isError === true };
}

/** The tool definitions this connection is offered, or `null`. */
export async function listTools({ url, token, fetchImpl, timeoutMs }) {
  const result = await rpc({ url, token, method: "tools/list", params: {}, fetchImpl, timeoutMs });
  return Array.isArray(result?.tools) ? result.tools : null;
}

/**
 * The workspaces a sign-in reaches, from `scope_info { workspaces: true }`.
 *
 * `null` when the gateway is older than that argument, which refuses it: the
 * caller falls back to the sign-in's default workspace and says so.
 */
export async function listWorkspaces({ url, token, fetchImpl }) {
  const answer = await callTool({ url, token, name: "scope_info", args: { workspaces: true }, fetchImpl });
  if (!answer || answer.isError) return null;
  const block = /## Workspaces\n+```json\n([\s\S]*?)\n```/.exec(answer.text);
  if (!block) return null;
  try {
    const list = JSON.parse(block[1]);
    return Array.isArray(list) ? list.filter((entry) => typeof entry?.slug === "string") : null;
  } catch {
    return null;
  }
}
