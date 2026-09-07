// A thin wrapper over the two Google Chat REST calls this product makes —
// `spaces.list` and `spaces.messages.list` — nothing else. `fetch` and
// `Bearer` tokens only, so this runs unmodified on the Workers runtime
// (`CLAUDE.md`, "The gateway is a Cloudflare Worker"). No OAuth here: a
// caller hands this an already-decrypted access token per request
// (`docs/decisions/storage-and-credentials.md`, "Never cache a decrypted
// credential across requests") and this module never stores it, logs it, or
// puts it anywhere but the one `Authorization` header of the one request it
// is used for.
//
// `sync.js` depends on the *shape* this returns (`{items, nextPageToken}` for
// a page, or `{unavailable: {reason}}` for a space this connection cannot
// read), never on `fetch` or a base URL directly — that boundary is what the
// fixture Chat API server in the test suite stands in for.

const CHAT_API_BASE = "https://chat.googleapis.com/v1";

/** A structured error carrying Google's reason, so a caller can branch on it without parsing prose. */
class ChatApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "ChatApiError";
    this.code = code;
    this.status = status;
  }
}

async function chatGet({ fetchImpl, path, accessToken, params }) {
  const url = new URL(`${CHAT_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 403 || response.status === 404) {
    // Chat returns 403 PERMISSION_DENIED for a space this grant can no
    // longer read (membership revoked, scope too narrow) and 404 for one
    // that has been deleted out from under the connection — both are
    // "we cannot read this space's messages," never "retry this request."
    let code = "PERMISSION_DENIED";
    try {
      const body = await response.json();
      code = body?.error?.status ?? code;
    } catch {
      // Google always sends a JSON error body for these; an unparsable one
      // is still treated as access denied rather than thrown as a surprise.
    }
    throw new ChatApiError(`Google Chat API refused ${path}: ${response.status}`, "PERMISSION_DENIED", response.status);
  }
  if (!response.ok) {
    throw new ChatApiError(`Google Chat API error on ${path}: ${response.status}`, "UNAVAILABLE", response.status);
  }
  return response.json();
}

/**
 * One page of the spaces this account can list.
 *
 * @param {{fetchImpl: typeof fetch, accessToken: string, pageToken?: string}} args
 * @returns {Promise<{items: object[], nextPageToken?: string}>}
 */
export async function listSpacesPage({ fetchImpl, accessToken, pageToken }) {
  const body = await chatGet({ fetchImpl, path: "spaces", accessToken, params: { pageSize: 100, pageToken } });
  return { items: Array.isArray(body?.spaces) ? body.spaces : [], nextPageToken: body?.nextPageToken };
}

/**
 * One page of one space's messages, created at or after `sinceCreateTime`
 * (ISO 8601), oldest first — the shape `sync.js` pages through until a page
 * comes back with no `nextPageToken`.
 *
 * Chat's list filter syntax is a string, not structured params
 * (`filter=create_time > "2026-09-07T00:00:00Z"`); the quoting is fixed here
 * rather than left to a caller, so a timestamp can never be built into a
 * filter expression a caller controls the syntax of.
 *
 * @param {{fetchImpl: typeof fetch, accessToken: string, spaceName: string,
 *          sinceCreateTime: string, pageToken?: string}} args
 * @returns {Promise<{items: object[], nextPageToken?: string}>}
 */
export async function listMessagesPage({ fetchImpl, accessToken, spaceName, sinceCreateTime, pageToken }) {
  const filter = `create_time > "${sinceCreateTime}"`;
  const body = await chatGet({
    fetchImpl,
    path: `${spaceName}/messages`,
    accessToken,
    params: { pageSize: 100, pageToken, filter, orderBy: "create_time asc" },
  });
  return { items: Array.isArray(body?.messages) ? body.messages : [], nextPageToken: body?.nextPageToken };
}

export { ChatApiError };
