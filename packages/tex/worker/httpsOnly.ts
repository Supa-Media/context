/**
 * Plain HTTP never reaches a route of this Worker.
 *
 * The Worker answers on its `workers.dev` address, which Cloudflare serves
 * over plain HTTP as well as HTTPS, and every provider webhook here carries
 * either a signature or a shared secret in a header (Sendblue, Whapi). Over
 * HTTP that header and the message body cross the network in the clear, so
 * the check runs first, before any route reads a header, a secret or a body.
 *
 *  - GET and HEAD are redirected to the same path on HTTPS with a 308. They
 *    carry no body, and a redirect is what a browser opening /health or a
 *    picture link expects.
 *  - Anything else is refused with 403 and its body left unread. A redirect
 *    would ask the sender to repeat a request whose secret has already
 *    crossed in the clear; refusing makes the misconfiguration visible
 *    instead of quietly working.
 *
 * Loopback is exempt, as it is for the gateway's control-plane origin
 * (apps/mcp/src/controlPlane/client.js `isLoopbackHost`): `wrangler dev`
 * serves http://localhost:8787, and a request there cannot leave the machine.
 * Exact hostnames only, so `localhost.example` is not loopback.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function plainHttpResponse(request: Request, url: URL): Response | null {
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (request.method === "GET" || request.method === "HEAD") {
    const secure = new URL(url);
    secure.protocol = "https:";
    // A redirect to the same host on a non-default port would keep the port;
    // HTTPS never runs on the HTTP port, so drop it.
    secure.port = "";
    return new Response(null, { status: 308, headers: { Location: secure.toString(), "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 403 });
}
