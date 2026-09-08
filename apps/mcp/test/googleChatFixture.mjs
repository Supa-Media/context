// A fixture Google Chat API, replayed over `fetch`'s own interface rather
// than mocked at the module boundary — so `client.js`'s query-string
// building, its `filter=` quoting, and its pagination are exercised exactly
// as they would run against the real API. Response envelopes match Google's
// documented shapes:
// https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces
// https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages
//
// This is a fake `fetch`, not a listening socket — the Workers runtime this
// gateway ships on has no way to bind one, and a fixture that could not run
// on the same runtime as the code it tests would prove less than it
// appears to (`docs/decisions/testing.md`, "A guard nobody has checked is
// not a guard").

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * @param {{
 *   spaces?: object[],
 *   messagesBySpace?: Record<string, object[]>,
 *   deniedSpaces?: Set<string>,
 *   failingSpaces?: Set<string>,
 *   pageSize?: number,
 * }} world
 * @returns {typeof fetch}
 */
export function createChatFixture({
  spaces = [],
  messagesBySpace = {},
  deniedSpaces = new Set(),
  failingSpaces = new Set(),
  pageSize = 2,
} = {}) {
  const calls = [];

  async function fixtureFetch(url, init) {
    const parsed = new URL(String(url));
    const auth = init?.headers?.authorization ?? "";
    calls.push({ url: parsed.pathname + parsed.search, auth });

    if (!auth.startsWith("Bearer ")) return jsonResponse(401, { error: { code: 401, status: "UNAUTHENTICATED" } });

    if (parsed.pathname === "/v1/spaces") {
      const pageToken = parsed.searchParams.get("pageToken");
      const start = pageToken ? Number(pageToken) : 0;
      const page = spaces.slice(start, start + pageSize);
      const nextPageToken = start + pageSize < spaces.length ? String(start + pageSize) : undefined;
      return jsonResponse(200, { spaces: page, nextPageToken });
    }

    const messagesMatch = /^\/v1\/(spaces\/[^/]+)\/messages$/.exec(parsed.pathname);
    if (messagesMatch) {
      const spaceName = messagesMatch[1];
      if (deniedSpaces.has(spaceName)) {
        return jsonResponse(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } });
      }
      if (failingSpaces.has(spaceName)) {
        // A transient server error — the shape a real outage or a rate limit
        // takes, as opposed to the two provider-classified reasons above.
        return jsonResponse(500, { error: { code: 500, status: "INTERNAL" } });
      }
      if (!(spaceName in messagesBySpace)) return jsonResponse(404, { error: { code: 404, status: "NOT_FOUND" } });

      const filter = parsed.searchParams.get("filter") ?? "";
      const sinceMatch = /create_time > "([^"]+)"/.exec(filter);
      const sinceMs = sinceMatch ? Date.parse(sinceMatch[1]) : Number.NEGATIVE_INFINITY;

      const all = [...(messagesBySpace[spaceName] ?? [])].sort((a, b) => Date.parse(a.createTime) - Date.parse(b.createTime));
      const filtered = all.filter((message) => Date.parse(message.createTime) > sinceMs);

      const pageToken = parsed.searchParams.get("pageToken");
      const start = pageToken ? Number(pageToken) : 0;
      const page = filtered.slice(start, start + pageSize);
      const nextPageToken = start + pageSize < filtered.length ? String(start + pageSize) : undefined;
      return jsonResponse(200, { messages: page, nextPageToken });
    }

    return jsonResponse(404, { error: { code: 404, status: "NOT_FOUND" } });
  }

  fixtureFetch.calls = calls;
  return fixtureFetch;
}

/** A Space resource, Google's documented shape, with fake values only. */
export function fixtureSpace(overrides = {}) {
  return {
    name: "spaces/AAAAAAAAAAA",
    spaceType: "GROUP_CHAT",
    displayName: "Engineering Team",
    spaceHistoryState: "HISTORY_ON",
    ...overrides,
  };
}

/** A Message resource, Google's documented shape, with fake values only. */
export function fixtureMessage(overrides = {}) {
  return {
    name: "spaces/AAAAAAAAAAA/messages/msg-1",
    sender: { name: "users/1000001", displayName: "Adam Okonkwo", type: "HUMAN" },
    createTime: "2026-09-07T09:00:00Z",
    text: "Morning! Can we push the release to Thursday?",
    thread: { name: "spaces/AAAAAAAAAAA/threads/thr-1" },
    space: { name: "spaces/AAAAAAAAAAA" },
    ...overrides,
  };
}
