/**
 * `GET /` on the gateway's own host: a short page that says where the MCP
 * endpoint is. A person or a crawler that opens the bare hostname used to get
 * `404 {"error":"not_found"}` and no way to learn the address one path down.
 *
 * It reads no token, no workspace and no store, and says the same bytes to
 * everyone. The endpoint is this deployment's own public origin and the guide
 * is on its app origin, so a self-hosted gateway names its own addresses.
 */

const DEFAULT_APP_ORIGIN = "https://context.lc";

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** An `https://` (or local `http://`) origin with no path, or the default. */
function appOriginOf(env) {
  const configured = typeof env?.APP_ORIGIN === "string" ? env.APP_ORIGIN.trim().replace(/\/+$/, "") : "";
  return /^https?:\/\/[^\s/"<>]+$/.test(configured) ? configured : DEFAULT_APP_ORIGIN;
}

export function landingHtml(origin, env) {
  const endpoint = escapeHtml(`${origin}/mcp`);
  const guide = escapeHtml(`${appOriginOf(env)}/mcp`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context.LC MCP server</title>
<meta name="description" content="The Context.LC MCP endpoint is ${endpoint}. Streamable HTTP, OAuth sign-in, no API key.">
<link rel="canonical" href="${guide}">
</head>
<body>
<main>
<h1>Context.LC MCP server</h1>
<p>MCP endpoint: <code>${endpoint}</code></p>
<p>Transport: Streamable HTTP</p>
<p>Auth: OAuth (no API key)</p>
<p>Add the endpoint to an MCP client as a remote server. This address is for MCP clients, not a browser.</p>
<p><a href="${guide}">How to connect: ${guide}</a></p>
</main>
</body>
</html>
`;
}

/** The landing page for `GET /` and `HEAD /`. */
export function landingResponse(request, origin, env) {
  return new Response(request.method === "HEAD" ? null : landingHtml(origin, env), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
