# Open CORS on the gateway, and HSTS with nosniff on the control plane (CASA ZAP, 2026-10-29)

_Part of [Gateway protocol](../gateway-protocol.md)._

### The gateway answers any origin, because nothing it answers rides on an ambient credential

The authenticated ZAP run flagged `Access-Control-Allow-Origin: *` (Medium)
on the gateway's OAuth discovery documents and on the authenticated MCP
endpoint. It stays, on purpose:

- **Nothing is ambient.** An MCP call is authorized by the bearer token the
  client sends in `Authorization` (or, as the compatibility fallback, in the
  URL it was given), never by a cookie. The gateway sets no cookie and never
  sends `Access-Control-Allow-Credentials`, so a browser does not attach one
  to a cross-origin request, and `*` cannot be combined with credentials
  anyway. A page on another origin can therefore only make a call it could
  already make with a token it holds; CORS adds no reach.
- **Browser clients need it.** A browser-based MCP client fetches the
  discovery documents before it holds any credential, then calls the endpoint
  from its own origin (`corsResponse` in `apps/mcp/src/http/responses.js`
  allows `Authorization`, `Mcp-Session-Id` and `MCP-Protocol-Version`).
  Pinning origins would break every such client, which is the legitimate use.

The cost of "fixing" it by echoing an allow-list is broken clients for no
isolation gained; the cost of ever adding a cookie or
`Access-Control-Allow-Credentials` to the gateway is that `*` would then be a
real hole, so that is the line not to cross.

### The control plane's own answers carry HSTS and nosniff

The same run found `Strict-Transport-Security` and `X-Content-Type-Options`
missing (Low) on Convex's `/.well-known/jwks.json` and
`/.well-known/openid-configuration` and on `/gateway/*`. Every route
`gatewayRoute` builds, refusals included, and the two auth discovery
documents now answer with
`Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`: the
deployment's host is not ours to speak for beneath) and
`X-Content-Type-Options: nosniff`, through
`apps/convex/functions/lib/httpSecurityHeaders.ts`. The discovery documents
are served there with the same body, status and caching `@convex-dev/auth`
uses, and the library's own copies of those two paths are not registered; any
other route the library adds (none while sign-in is OTP only) is registered
as it is. Wrapping the library's handlers instead would mean calling a
registered function's internals, which the credential-reachability analysis
refuses, so a future OAuth sign-in route would need its headers added the
same way.
`apps/convex/__tests__/httpSecurityHeaders.test.ts` fails if either set loses
them.

The "Unix timestamp disclosure" findings (Low) in the app's public JavaScript
are left as they are: ZAP flags any ten-digit number that falls in a plausible
date range, and the bundle is public, built from this public repository. Each
literal it names is checked against the source before it is called a false
positive, not suppressed.
