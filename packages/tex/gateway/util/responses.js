// Tex's copy of apps/mcp/src/http/responses.js `json` (the gateway keeps its own).
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
