/**
 * A bench world set up in its objects, one workspace and one person at a time: the same calls for the standing bench
 * objects (`route.js`, over `BENCH_STORE`) and for the local object world (`apps/mcp/bench/evals/objectWorld.mjs`,
 * over node's SQLite). `env` is a bench environment (`env.js`): its `WORKSPACE_STORE` holds `BenchStore` objects.
 */

import { workspaceClient, workspaceStub } from "../../../../apps/mcp/src/workspaceStore/api.js";
import { ACCESS_HOMES, objectToken } from "../../../../apps/mcp/src/workspaceStore/access.js";
import { sha256Hex } from "../../../../apps/mcp/src/controlPlane/client.js";

/** One `/bench/*` call to a bench object. */
export async function benchCall(env, workspaceId, path, body = {}) {
  const response = await workspaceStub(env, workspaceId).fetch(new Request(`https://bench.internal${path}`, { method: "POST", body: JSON.stringify(body) }));
  if (!response.ok) throw new Error(`${path}: the bench object answered ${response.status}`);
  return await response.json();
}

/** A bench workspace's rows, rules, members and binding, its notes read from its object. Answers `{ids}` by path. */
export async function setUpWorkspace(env, { workspaceId, name, kind, files, rules, members, opens = [] }) {
  const client = workspaceClient(env, workspaceId);
  await client.setHome("object");
  await client.setEncryption("none");
  await client.rules.put(rules, "member");
  const answer = await benchCall(env, workspaceId, "/bench/setup", { workspaceId, name, kind, files, rules, members });
  // The world's open history (`workspaceStore/opens.js`): who opened which note how often, in the app or by an AI.
  for (const open of opens) await client.opens.record(open);
  return answer;
}

/**
 * A bench person's access token, derived from the bench's gateway secret and their person object's id: never kept,
 * the same on every call, and of no use outside the bench objects (no real person object holds its hash).
 */
export async function benchToken(env, personalWorkspaceId) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GATEWAY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`bench-person-token\u0000${personalWorkspaceId}`)));
  const secret = btoa(String.fromCharCode(...mac)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return objectToken("access", personalWorkspaceId, secret);
}

/** A bench person's own object: who they are, the workspaces they reach, and one connection. Answers their token. */
export async function setUpPerson(env, { personalWorkspaceId, userId, reach }) {
  const token = await benchToken(env, personalWorkspaceId);
  const access = workspaceClient(env, personalWorkspaceId).access;
  await access.pin(userId);
  await access.reach.put(reach);
  await access.connections.put([{ grantId: `g_${personalWorkspaceId}`, clientId: "bench-search", clientName: "Bench search", workspaceId: personalWorkspaceId, scopes: ["context:read", "context:private"], tokenHash: await sha256Hex(token), refreshHash: await sha256Hex(`${token}r`), expiresAt: Date.now() + 365 * 86_400_000, status: "active", at: 1 }]);
  await access.setHome(ACCESS_HOMES.OBJECT);
  return token;
}

/** One `search_notes` through the gateway's MCP endpoint (`gateway(request, env)`), as a person's AI client asks it. */
export async function searchOnce(gateway, env, token, query, context = null) {
  const response = await gateway(
    new Request("https://mcp.bench.invalid/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_notes", arguments: { query, ...(context ? { context } : {}) } } }),
    }),
    env,
  );
  const body = await response.json().catch(() => null);
  const text = (body?.result?.content ?? []).map((block) => block.text ?? "").join("\n");
  return { ok: response.status === 200 && body?.result?.isError !== true, text, status: response.status };
}
