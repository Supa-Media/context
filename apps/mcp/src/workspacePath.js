/**
 * Which first path segment names a workspace, and which names a route.
 *
 * Split out of `session.js`, where it sat beside the session resolution it
 * feeds. It is pure: no imports, no I/O, no session. The HTTP router reads
 * `splitWorkspacePath` to select a workspace before anything else runs, and
 * `session.js` reads `SLUG_PATTERN` and `RESERVED_FIRST_SEGMENTS` to refuse a
 * context name the same way, so the two cannot disagree about what a slug is.
 */

/**
 * Slugs come from the control plane's global name namespace: 2–32 characters of
 * lowercase `a–z`, `0–9`, and `-`. Validated here so a hostile path segment
 * becomes a refusal instead of a control-plane round trip.
 */
export const SLUG_PATTERN = /^[a-z0-9-]{2,32}$/;

/**
 * Percent-decode one path segment, or `null` if it is not decodable.
 *
 * Case is preserved: this is also how the token-in-path route decodes an
 * access token, and a token is case-sensitive. Callers that want a slug
 * lowercase the result themselves.
 *
 * Exported so every place this worker decodes a caller-supplied path segment
 * agrees that "malformed" is a routing answer, not an exception.
 */
export function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Pull an optional workspace selector off the front of a path.
 *
 * `mcp.context.lc/@seyi/mcp` and `mcp.context.lc/seyi/mcp` both select the
 * workspace `seyi`; `mcp.context.lc/mcp` selects the grant's default. The `@`
 * is cosmetic and normalised away.
 *
 * ## What the slug in the URL is, and emphatically is not
 *
 * **It is not a security boundary and provides no isolation.** Cloudflare
 * routes every path on a hostname to the same Worker, and isolates are reused
 * across paths exactly as they are across requests. Nobody reading this later
 * should conclude that putting the tenant in the URL bought them safety: the
 * OAuth grant decides what a caller may reach, and the slug only *selects*
 * among workspaces that grant already covers. A slug the grant does not cover
 * is refused, and refused identically whether or not it names a real workspace.
 *
 * What it does buy, and the actual reason it exists:
 *
 * - **Cache keys are tenant-scoped by construction.** The Cache API keys on the
 *   full URL. Any future caching of non-secret data — resolved workspace
 *   metadata, discovery documents, directory listings — cannot cross-hit
 *   between tenants by accident, because two tenants can no longer produce the
 *   same key. This is a structural property, not a rule someone has to
 *   remember. (For `/mcp` itself the HTTP-caching win is close to nil: it is
 *   POST JSON-RPC and not cacheable. The win is keying and discovery
 *   documents.)
 * - **Observability.** Logs and analytics segment per tenant without anyone
 *   parsing a token to do it.
 * - **Legibility.** People see this URL in their MCP client settings.
 *   `mcp.context.lc/@seyi/mcp` reads as theirs.
 */
export function splitWorkspacePath(pathname) {
  const match = pathname.match(/^\/@?([^/]+)(\/.*)?$/);
  if (!match) return { slug: null, path: pathname };
  // `decodeURIComponent` throws a URIError on a malformed escape ("%zz", or a
  // truncated multi-byte sequence). This runs at the very top of `fetch`,
  // before any routing or auth, so an unhandled throw here turns
  // `GET /%zz/mcp` — which anyone on the internet can send — into a Worker
  // exception instead of a 404. A path that cannot be decoded names no
  // workspace, which is exactly what "no slug" already means.
  const decoded = decodePathSegment(match[1]);
  if (decoded === null) return { slug: null, path: pathname };
  const candidate = decoded.toLowerCase();
  // A first segment that is a known top-level route is a route, not a slug.
  if (RESERVED_FIRST_SEGMENTS.has(candidate)) return { slug: null, path: pathname };
  if (!SLUG_PATTERN.test(candidate)) return { slug: null, path: pathname };
  return { slug: candidate, path: match[2] || "/" };
}

/**
 * First path segments that name a route rather than a workspace.
 *
 * These are also reserved in the control plane's name namespace, so no
 * workspace can ever be called one of them — but the gateway does not get to
 * assume the two lists stayed in sync, so it checks its own.
 */
export const RESERVED_FIRST_SEGMENTS = new Set([
  "mcp",
  "inbox",
  "oauth",
  "t",
  ".well-known",
  "granola-webhook",
  // Meeting ingestion. `POST /meetings/sessions` read as "the context called
  // meetings, at the path /sessions" until this line, which is no route at all
  // — and `index.js` worked around it by taking the raw pathname off the
  // selector for meeting paths only. Worse than a dead route: whoever claimed
  // the username `meetings` would have been the workspace every meeting client
  // in the product appeared to be addressing.
  "meetings",
  // The agent turn, `POST /agent`. The same defect `meetings` above records,
  // caught the same way — by a route that answered 404 while the suite was
  // green — and it lands the same way: whoever claimed the handle `agent` would
  // have been the workspace every agent turn in the product appeared to be
  // addressed to, and, because ingestion is on the apex, the mailbox too.
  "agent",
  // The presence socket, `GET /presence`. Third instance of the same defect
  // `meetings` and `agent` above record, and listed here before it could become
  // one: without this line `/presence` reads as "the context called presence",
  // so whoever claimed that handle would have been the workspace every open
  // editor in the product appeared to be joining — and, because ingestion is on
  // the apex, would hold the mailbox too.
  "presence",
  // The collaboration HTTP transport. Keeping it in the top-level namespace
  // prevents `/collaboration` from being parsed as a workspace slug.
  "collaboration",
  // Which notes agents touched recently, for the console's file tree. Also in
  // the control plane's RESERVED_NAMES, for the reason `presence` is.
  "agent-activity",
  // What the egress gate is holding for a person, and their answer, at
  // `/approvals` (`http/approvals.js`). Reserved on the same terms, and caught
  // the same way as `agent`: a route that answered 404 while its suite was
  // green, because the path read as a workspace called `approvals`.
  "approvals",
]);
