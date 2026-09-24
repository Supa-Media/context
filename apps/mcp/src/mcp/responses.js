/**
 * JSON-RPC and Streamable-HTTP response shapes for both MCP protocol
 * generations: legacy JSON-RPC results and errors, the modern transport's
 * result/error responses, and the server info both advertise. Moved verbatim
 * out of `src/index.js`; the handlers that choose between them stay there.
 */

import { json } from "../http/responses.js";
import { META_SERVER_INFO } from "../protocol.js";

/**
 * Freshness hints required on every cacheable result in this revision.
 *
 * `cacheScope` is `private` and not negotiable: `tools/list` is filtered by the
 * calling grant's scopes, so a shared intermediary that cached one caller's
 * answer and served it to another would hand a read-only client the write
 * tools. `public` would be a cross-grant leak dressed as a performance hint.
 *
 * One minute of `ttlMs` bounds how long a downgraded grant can keep seeing the
 * wider tool list. A revoked grant is not a concern here — it fails
 * authentication long before any cached list is consulted.
 */
export const CACHEABLE = { ttlMs: 60_000, cacheScope: "private" };

/** The server's own identity, reported in `_meta` on every modern result. */
export const SERVER_INFO = {
  name: "context",
  version: "1.0.0",
  description: "A scoped MCP server over a customer-owned bucket of markdown notes.",
};

export function modernResultResponse(id, result, status = 200) {
  return json(
    {
      jsonrpc: "2.0",
      id,
      result: {
        // Required on every result. `input_required` is the other value, for
        // the multi-round-trip pattern; this server never needs input from a
        // client, so every result it produces is complete.
        resultType: "complete",
        ...result,
        _meta: { ...(result?._meta || {}), [META_SERVER_INFO]: SERVER_INFO },
      },
    },
    status
  );
}

export function modernErrorResponse(id, code, message, status, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return json({ jsonrpc: "2.0", id: id ?? null, error }, status);
}

export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcErrorObj(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function jsonRpcError(id, code, message, status = 200) {
  return json(jsonRpcErrorObj(id, code, message), status);
}
