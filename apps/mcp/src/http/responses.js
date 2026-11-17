/** JSON and CORS response helpers every HTTP surface of the gateway answers with. Moved verbatim out of `src/index.js`. */

/* -------------------------------- helpers --------------------------------- */

/** On a 503 that is a real upstream failure: callers that honor it wait, instead of retrying at once. */
export const RETRY_AFTER = { "Retry-After": "5" };

export function json(obj, status = 200, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...(extraHeaders ?? {}),
    },
  });
}

export function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      // GET is here for the two discovery documents, which a browser-based
      // client fetches cross-origin before it holds any credential at all.
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    },
  });
}
