/**
 * The MCP transport: the legacy JSON-RPC era (`handleRpc`), the modern era
 * (`handleModernMcp`), and `handleMcp`, which tells them apart.
 */

import { actorFor, contextsFor } from "../context/identity.js";
import {
  CACHEABLE,
  jsonRpcError,
  jsonRpcErrorObj,
  modernErrorResponse,
  modernResultResponse,
  rpcResult,
  SERVER_INFO,
} from "./responses.js";
import { callToolForSession } from "../tools/session.js";
import {
  declaredProtocolVersion,
  ERROR_HEADER_MISMATCH,
  ERROR_METHOD_NOT_FOUND,
  ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  isModernRequest,
  LEGACY_PROTOCOLS,
  legacyProtocolHeaderIsAcceptable,
  MODERN_PROTOCOLS,
  modernHeaderMismatch,
} from "../protocol.js";
import { instructionsForSession } from "./sessionInstructions.js";
import { json } from "../http/responses.js";
import { reportSessionUsage } from "./usage.js";
import { toolsForSession } from "../tools/advertised.js";

export async function handleMcp(request, store, session) {
  /**
   * The acting identity, carried on the per-request store instance so that
   * `recordChange` can put it in the audit record without every tool signature
   * growing a parameter.
   *
   * This is request-scoped metadata on an adapter this request built for
   * itself, not part of the ContextStore contract — `storeForSession` returns a
   * fresh store per request, so there is nothing here for a reused isolate to
   * carry into the next tenant's call.
   *
   * `actor_scope: "team"` stops meaning anything the moment "team" is four
   * people, so the record names the human and the client too.
   */
  store.actor = actorFor(session);
  store.contexts = contextsFor(session);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }

  // Era routing. A modern request declares its revision on itself; a legacy one
  // relies on a handshake that already happened. Serving the wrong shape is
  // worse than refusing, so this decision is made once, from the request, and
  // the two paths below never fall through into each other.
  if (isModernRequest(request, Array.isArray(body) ? body[0] : body)) {
    return handleModernMcp(request, body, store, session);
  }

  if (!legacyProtocolHeaderIsAcceptable(request.headers.get("MCP-Protocol-Version"))) {
    return jsonRpcError(
      null,
      -32000,
      "unsupported MCP-Protocol-Version header",
      400
    );
  }

  // JSON-RPC batching was removed in 2025-06-18 and never existed in the modern
  // era. It survives here only for `2024-11-05` and `2025-03-26`, which are
  // still in `LEGACY_PROTOCOLS` and did define it.
  if (Array.isArray(body)) {
    const results = [];
    for (const msg of body) {
      const r = await handleRpc(msg, store, session);
      if (r) results.push(r);
    }
    return results.length ? json(results) : new Response(null, { status: 202 });
  }
  const result = await handleRpc(body, store, session);
  return result ? json(result) : new Response(null, { status: 202 });
}

/* ------------------------------ modern MCP -------------------------------- */

/**
 * Serve one request under `2026-07-28` semantics.
 *
 * The modern era is stateless by construction, which is why this gateway can
 * speak it at all: there was never a session to remove. What it does add is a
 * stricter envelope — the version is declared per request and mirrored into
 * headers, every result is tagged, and the transport carries real HTTP status
 * codes instead of answering `200` with an error inside.
 *
 * Everything that decides *what a caller may see or do* is delegated to the
 * same helpers the legacy path uses. That is deliberate and load-bearing: a
 * scope check written twice is a scope check that will eventually differ, and
 * the difference would be a privilege escalation reachable by adding one header
 * to a request.
 */
async function handleModernMcp(request, msg, store, session) {
  if (Array.isArray(msg)) {
    // "The body of the HTTP POST MUST be a single JSON-RPC request or
    // notification." Batching does not exist in this era.
    return modernErrorResponse(null, ERROR_HEADER_MISMATCH, "batched requests are not supported", 400);
  }

  const id = msg?.id;
  // A notification gets `202` and nothing else. This revision defines no
  // client-to-server notification over HTTP and explicitly leaves header
  // requirements for a notification POST unspecified, so none are imposed.
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  const mismatch = modernHeaderMismatch(request, msg);
  if (mismatch) return modernErrorResponse(id, ERROR_HEADER_MISMATCH, mismatch, 400);

  const requested = declaredProtocolVersion(msg);
  if (!MODERN_PROTOCOLS.includes(requested)) {
    // The modern counterpart of the legacy counter-offer: an error carrying the
    // versions the client could retry with. See `MODERN_ONLY_VERSION_LISTS` in
    // `protocol.js` for why a legacy revision must never appear here.
    //
    // The body is not optional. A `400` whose body is *not* a recognized modern
    // error is how a dual-era client concludes the server is legacy and falls
    // back to `initialize` — so a bare `400` here does not merely lose detail,
    // it routes the client into the era it just declined to use.
    return modernErrorResponse(
      id,
      ERROR_UNSUPPORTED_PROTOCOL_VERSION,
      "Unsupported protocol version",
      400,
      { supported: MODERN_PROTOCOLS, requested: requested ?? null }
    );
  }

  const params = msg.params || {};
  try {
    switch (msg.method) {
      case "server/discover":
        // A connection opening. Counted here on the modern transport and at
        // `initialize` on the legacy one, because those are the two shapes of
        // "a client just arrived" — see `reportSessionUsage`.
        reportSessionUsage(store, session.workspaceId);
        // MUST be implemented. It is how a modern client learns what this
        // server is without probing every list endpoint in turn. Modern-only
        // `supportedVersions` — see `MODERN_ONLY_VERSION_LISTS`.
        // The instructions carry a sketch of *this* caller's context, which is
        // safe to cache only because `CACHEABLE` is `cacheScope: "private"` —
        // the same property that stops a shared intermediary handing one grant's
        // tool list to another. If that ever becomes `public`, this line is the
        // second thing it breaks.
        return modernResultResponse(id, {
          supportedVersions: MODERN_PROTOCOLS,
          capabilities: { tools: {} },
          instructions: await instructionsForSession(store, session),
          ...CACHEABLE,
        });
      case "tools/list":
        return modernResultResponse(id, {
          tools: await toolsForSession(session, store),
          ...CACHEABLE,
        });
      case "tools/call":
        return modernResultResponse(id, await callToolForSession(params, store, session));
      default:
        // On this transport an unknown method is `404`, not `200` with an error
        // body. The status is what lets a dual-era client tell "this server
        // does not have that method" from "this server is not modern at all".
        return modernErrorResponse(
          id,
          ERROR_METHOD_NOT_FOUND,
          `method not found: ${msg.method}`,
          404
        );
    }
  } catch (err) {
    return modernErrorResponse(id, -32603, `internal error: ${err.message}`, 200);
  }
}

async function handleRpc(msg, store, session) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const scope = session.scope;

  try {
    switch (method) {
      case "initialize": {
        reportSessionUsage(store, session.workspaceId);
        // MCP lifecycle: if the requested revision is one we speak, echo it.
        // Otherwise counter-offer — in a normal result, never a JSON-RPC error
        // — with the newest revision we do speak, and let the client decide
        // whether it can live with that.
        //
        // Two ways to get this wrong, both seen in the wild:
        //
        //  - Answering with an error. A server that replied `-32602 unsupported
        //    protocol version` to a client asking for a newer revision simply
        //    failed to connect, where a counter-offer would have worked. The
        //    counter-offer is a MUST for exactly this reason.
        //  - Counter-offering something other than the newest. This used to
        //    return a hardcoded "2025-03-26", so a client asking for a revision
        //    from the future was talked down further than necessary and lost
        //    capability for nothing.
        //
        // Derived from the array, which is ordered newest first, so the two
        // cannot drift apart. Only *legacy* revisions are offerable here: a
        // client that sent `initialize` has declared it speaks the handshake
        // era, and answering it with `2026-07-28` — which deleted `initialize`
        // — would name a revision it cannot possibly use.
        const requested = params?.protocolVersion;
        const protocolVersion = LEGACY_PROTOCOLS.includes(requested)
          ? requested
          : LEGACY_PROTOCOLS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: await instructionsForSession(store, session),
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null; // notifications get no response
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: await toolsForSession(session, store) });
      case "tools/call": {
        if (isNotification) return null;
        return rpcResult(id, await callToolForSession(params, store, session));
      }
      default:
        return isNotification ? null : jsonRpcErrorObj(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return jsonRpcErrorObj(id, -32603, `internal error: ${err.message}`);
  }
}
