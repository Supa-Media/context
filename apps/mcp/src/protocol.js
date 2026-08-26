/**
 * MCP protocol revisions, and the two different shapes of MCP this gateway
 * speaks.
 *
 * ## Two eras, not five versions
 *
 * Revision `2026-07-28` is not an increment on `2025-11-25`; it is a different
 * protocol wearing the same name. It deletes the `initialize` handshake, the
 * concept of a session, `Mcp-Session-Id`, the GET stream, SSE resumability and
 * `ping`, and replaces them with per-request metadata, a mandatory
 * `server/discover` RPC, and errors where there used to be counter-offers. The
 * specification calls the two shapes **modern** (`2026-07-28` and later,
 * version declared on every request) and **legacy** (`2025-11-25` and earlier,
 * version agreed once by handshake), and a server that speaks both is
 * **dual-era**. This gateway is dual-era.
 *
 *   https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 *
 * The two lists below are therefore deliberately separate rather than one
 * sorted array. Merging them would be the natural-looking cleanup and would be
 * a lie in both directions: a legacy client that was counter-offered
 * `2026-07-28` through `initialize` cannot speak it — it has no `initialize` —
 * and a modern client told that `2025-06-18` is available on the per-request
 * path would be sent to a shape this server will not serve there.
 *
 * ## What "supported" has to mean
 *
 * A revision belongs in one of these lists only when its semantics are
 * implemented. Advertising one we do not speak is worse than lagging: a client
 * that believes the answer starts using features we then fail on, and it has no
 * way to distinguish that from a broken server. The `SPEC.md`-level accounting
 * of what is implemented, what is not applicable to a tools-only server, and
 * what was deliberately skipped lives beside each list here.
 */

/**
 * Modern revisions: version carried per request, no handshake.
 *
 * `2026-07-28` is implemented for this server's surface, which is tools-only:
 * `server/discover`, per-request version validation and the header/body match,
 * `UnsupportedProtocolVersionError`, `HeaderMismatchError`, `resultType` on
 * every result, `ttlMs`/`cacheScope` on cacheable results, `404` + `-32601` for
 * unknown methods, `405` for GET/DELETE, and no sessions.
 *
 * Not implemented, because this server has no surface that uses them:
 * `subscriptions/listen` (nothing to notify about — no resources, no prompts,
 * no `listChanged`), Multi Round-Trip Requests (the server never needs input
 * from the client), the tasks extension, and `x-mcp-header` parameter mirroring
 * (optional for servers; no tool annotates a parameter with it). Sampling,
 * roots and logging are deprecated in this revision and were never implemented.
 */
export const MODERN_PROTOCOLS = ["2026-07-28"];

/**
 * Legacy revisions, newest first — the order is load-bearing, because
 * `initialize` counter-offers `LEGACY_PROTOCOLS[0]` to a client that asked for
 * something this server does not speak.
 */
export const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** Every revision this server implements, in either era. */
export const ALL_PROTOCOLS = [...MODERN_PROTOCOLS, ...LEGACY_PROTOCOLS];

/**
 * `MODERN_ONLY_VERSION_LISTS` — why `server/discover.supportedVersions` and
 * `UnsupportedProtocolVersionError.data.supported` name modern revisions only,
 * even though this server speaks four legacy ones too.
 *
 * The specification is genuinely underspecified here, and its two examples
 * disagree with each other: the `server/discover` page ships
 * `supportedVersions: ["2026-07-28"]` — modern-only — while the `-32022` schema
 * example ships `supported: ["2026-07-28", "2025-11-25"]` — mixed. Neither
 * field carries a MUST or a SHOULD about era partitioning. So this is a
 * decision, and it rests on two things rather than taste:
 *
 *  - **The field's own gloss.** "Protocol versions the server supports. The
 *    client should choose one of these *for subsequent requests*." A client
 *    that chose `2025-11-25` could not use it for subsequent requests on the
 *    path it is on — it would have to abandon the per-request envelope and open
 *    an `initialize` handshake. That is not choosing a version; it is changing
 *    era.
 *  - **A mixed list contradicts the fallback rule.** A recognized modern error
 *    tells a client "the server speaks a modern version — retry using the
 *    advertised `supported` versions *rather than falling back*". Hand it a
 *    list whose only usable entry requires falling back and the instruction
 *    eats itself. A modern-only list cannot reach that state.
 *
 * The cost is narrow and accepted: a client speaking some future modern
 * revision plus our legacy ones, but not `2026-07-28`, hard-fails rather than
 * salvaging an `initialize`. The spec sanctions exactly that — "surface an
 * error to the user if no compatible version exists" — and no such client
 * exists.
 *
 * **Revisit this if a stdio transport is ever added.** On stdio there is no
 * per-request HTTP status to drive fallback, so `server/discover` doubles as
 * the era probe, and there a modern-only list genuinely withholds something a
 * dual-era client could use. This gateway is HTTP-only, where body inspection
 * governs instead, so that case does not arise today.
 */

/* --------------------------- per-request metadata -------------------------- */

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/* -------------------------------- error codes ------------------------------ */
//
// `-32020`–`-32099` is the range the specification reserves for itself; the
// numbers below are the ones it allocated, not ones chosen here.
// https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes

/** Headers do not match the body, or a required header is missing. HTTP 400. */
export const ERROR_HEADER_MISMATCH = -32020;
/** The requested protocol version is not one this server implements. HTTP 400. */
export const ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** JSON-RPC's own "method not found". On the modern transport, HTTP 404. */
export const ERROR_METHOD_NOT_FOUND = -32601;

/* ------------------------------ header values ------------------------------ */

const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";

/**
 * Decode an `Mcp-Name` (or `Mcp-Param-*`) header value.
 *
 * HTTP field values are visible ASCII only, so a tool name or resource URI that
 * is not plain ASCII travels as `=?base64?<base64 of UTF-8>?=`. The server
 * **MUST** decode before comparing against the body — otherwise a client with a
 * perfectly legal non-ASCII tool name is rejected for a mismatch that is really
 * an encoding difference.
 *
 * The markers are case-sensitive and must appear exactly. A value that merely
 * looks like the sentinel but does not decode is returned unchanged, so it
 * fails the comparison rather than throwing.
 */
export function decodeHeaderValue(value) {
  if (typeof value !== "string") return value;
  if (!value.startsWith(BASE64_SENTINEL_PREFIX) || !value.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return value;
  }
  const encoded = value.slice(
    BASE64_SENTINEL_PREFIX.length,
    value.length - BASE64_SENTINEL_SUFFIX.length
  );
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

/* --------------------------------- eras ----------------------------------- */

/** The `_meta` of a JSON-RPC message's params, if it has one. */
function messageMeta(msg) {
  const meta = msg?.params?._meta;
  return meta && typeof meta === "object" ? meta : null;
}

/** The protocol version a modern message declares in its body, if any. */
export function declaredProtocolVersion(msg) {
  const value = messageMeta(msg)?.[META_PROTOCOL_VERSION];
  return typeof value === "string" ? value : null;
}

/**
 * Should this request be served as modern MCP?
 *
 * A request is modern if it declares a version the modern way — in `_meta`, or
 * in the `MCP-Protocol-Version` header naming a revision only the modern era
 * has. Either alone is enough *to route it*, deliberately: a modern client that
 * sends one and omits the other has made a header/body mismatch, and the useful
 * answer to that is `HeaderMismatchError` from the modern path, not silent
 * demotion to a handshake protocol it is not speaking.
 *
 * A legacy client can never trip this. It sends no `_meta`, and the only
 * version it can hold is one this server counter-offered through `initialize`,
 * which never names a modern revision.
 */
export function isModernRequest(request, msg) {
  if (declaredProtocolVersion(msg) !== null) return true;
  const header = request.headers.get("MCP-Protocol-Version");
  return typeof header === "string" && MODERN_PROTOCOLS.includes(header);
}

/**
 * Is the `MCP-Protocol-Version` header on a **legacy** request acceptable?
 *
 * From `2025-06-18` on, a legacy client must echo the negotiated revision on
 * every request after `initialize`, and a server must refuse a version it does
 * not implement with `400`. Two deliberate leniencies:
 *
 *  - **Absent is fine.** The header only arrived in `2025-06-18`, and the spec
 *    lets a server that still serves older clients read its absence as
 *    `2025-03-26`. This one does. Rejecting absence would break every client
 *    predating the header for no security gain: it is routing metadata, not a
 *    credential.
 *  - **Any revision this server implements is fine, in either era.** At least
 *    one shipping client sends *its own latest* revision here instead of the
 *    negotiated one. That is a client bug, but it is a live one, and refusing
 *    it would break a session that negotiated perfectly well. Accepting the
 *    full set costs nothing: this header is routing metadata for
 *    intermediaries, not a credential, and the semantics in play were already
 *    settled by the handshake.
 *
 * A revision that is not on either list is still refused, because that is a
 * client speaking something this server has never implemented, and telling it
 * so is more useful than guessing.
 */
export function legacyProtocolHeaderIsAcceptable(headerValue) {
  if (headerValue === null || headerValue === undefined) return true;
  return ALL_PROTOCOLS.includes(headerValue);
}

/* --------------------------- modern header rules --------------------------- */

/** Methods whose `Mcp-Name` header mirrors a body field, and which field. */
const NAME_HEADER_SOURCE = {
  "tools/call": (params) => params?.name,
  "resources/read": (params) => params?.uri,
  "prompts/get": (params) => params?.name,
};

/**
 * Validate the mirrored request headers a modern POST must carry.
 *
 * These exist so an intermediary — a load balancer, a gateway, a rate limiter —
 * can route on a header without parsing the body. That is only safe if the two
 * agree, so the server that *does* parse the body has to be the one that proves
 * they agree. A component routing on `Mcp-Name: read_note` while this worker
 * executes `archive_note` from the body is the vulnerability the check exists
 * to close, which is why a mismatch is refused rather than resolved in favour
 * of either side.
 *
 * Returns `null` when the request is well-formed, or a message describing the
 * first failure. Every failure is `HeaderMismatchError` (`-32020`) with HTTP
 * `400`, including a header that is simply missing.
 */
export function modernHeaderMismatch(request, msg) {
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  const bodyVersion = declaredProtocolVersion(msg);
  if (headerVersion === null) {
    return "missing required header: MCP-Protocol-Version";
  }
  if (bodyVersion === null) {
    return `missing required body field: params._meta["${META_PROTOCOL_VERSION}"]`;
  }
  if (headerVersion !== bodyVersion) {
    return "MCP-Protocol-Version header does not match the protocol version in the request body";
  }

  const method = typeof msg?.method === "string" ? msg.method : "";
  const headerMethod = request.headers.get("Mcp-Method");
  if (headerMethod === null) return "missing required header: Mcp-Method";
  // Header *names* are case-insensitive; header *values* are not, and a method
  // name is a value.
  if (headerMethod !== method) {
    return "Mcp-Method header does not match the method in the request body";
  }

  const nameSource = NAME_HEADER_SOURCE[method];
  if (nameSource) {
    const bodyName = nameSource(msg?.params);
    const headerName = request.headers.get("Mcp-Name");
    if (headerName === null) return "missing required header: Mcp-Name";
    if (decodeHeaderValue(headerName) !== bodyName) {
      return "Mcp-Name header does not match the corresponding value in the request body";
    }
  }
  return null;
}
