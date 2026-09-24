// Shared fixtures for the Gmail sync suite: a tiny in-memory ContextStore and
// a fake Gmail API, data-driven from a small mailbox.
//
// The fixture server is data-driven rather than a hand-rolled mock of one
// call: it holds a small mailbox (a `Map` of message resources, shaped like
// Google's documented `Message` resource — see
// https://developers.google.com/gmail/api/reference/rest/v1/users.messages)
// and answers `messages.list`, `messages.get`, `users.getProfile` and
// `history.list` the way the real API does for that mailbox, including
// pagination and history's documented 404-on-expired-cursor. Nothing here
// touches the network; `gmailSync.js` never imports one either — it takes
// `fetchImpl` as a parameter, which is what makes this possible.
//
// Split out of gmailSync.test.mjs; see that file's sections for the checks
// built on these fixtures.

/* -------------------------------------------------------------------------- */
/* A tiny in-memory ContextStore, per the contract in src/store/index.js      */
/* -------------------------------------------------------------------------- */

export function createMemoryStore({ conditionalWrite = true } = {}) {
  const objects = new Map();
  let nextEtag = 1;
  return {
    capabilities: { conditionalWrite },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { etag: object.etag, text: async () => object.text, arrayBuffer: async () => new TextEncoder().encode(object.text).buffer };
    },
    async put(key, value, options) {
      const existing = objects.get(key);
      if (conditionalWrite && options?.onlyIf?.etagMatches !== undefined) {
        const expected = options.onlyIf.etagMatches;
        if (!existing || existing.etag !== expected) return null;
      }
      const etag = String(nextEtag++);
      // Attachment bytes arrive as a `Uint8Array`; everything else is a
      // string. Decoding bytes as UTF-8 is a test-only convenience — every
      // fixture attachment in this suite is plain ASCII content precisely so
      // `.text()` round-trips it exactly, the same way the real bytes a
      // customer's PDF is made of are opaque to this module either way.
      const text = value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
      objects.set(key, { text, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return { objects: keys.map((key) => ({ key, size: objects.get(key).text.length, uploaded: new Date() })), truncated: false };
    },
    // Test-only inspection, not part of the ContextStore contract.
    _dump: () => new Map(objects),
  };
}

/* -------------------------------------------------------------------------- */
/* A fake Gmail, data-driven from a small mailbox                             */
/* -------------------------------------------------------------------------- */

export function base64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One Gmail `Message` resource, `format=full` shaped. */
export function fixtureMessage({ id, threadId, date, from, to, subject, text, html, attachments = [] }) {
  const headers = [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Subject", value: subject },
  ];
  const parts = [];
  if (text !== undefined) parts.push({ mimeType: "text/plain", body: { size: text.length, data: base64Url(text) } });
  if (html !== undefined) parts.push({ mimeType: "text/html", body: { size: html.length, data: base64Url(html) } });
  for (const attachment of attachments) {
    parts.push({
      filename: attachment.filename,
      mimeType: attachment.contentType,
      // A real message with a real attachment carries an `attachmentId` and
      // NO `data` here — the bytes are reachable only through
      // `attachments.get`. An attachment fixture with no `attachmentId` (the
      // metadata-only tests above) proves `extractBody` never needed one.
      body: { size: attachment.size, attachmentId: attachment.attachmentId },
    });
  }
  return {
    id,
    threadId,
    internalDate: String(Date.parse(date)),
    payload: { mimeType: "multipart/mixed", headers, parts },
  };
}

/**
 * @param {{messages: object[], history?: {pages: object[]} | {expired: true},
 *          profileHistoryId?: string,
 *          attachmentContents?: Record<string, string>}} config
 *   `attachmentContents` is keyed `${messageId}/${attachmentId}`, plain text
 *   for test readability — real bytes are arbitrary binary, and nothing in
 *   this module's attachment path treats them as anything but bytes.
 */
export function createFixtureGmail(config) {
  const byId = new Map(config.messages.map((message) => [message.id, message]));
  const calls = [];

  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname + parsed.search);

    if (parsed.pathname === "/gmail/v1/users/me/profile") {
      return jsonResponse({ historyId: config.profileHistoryId ?? "1000" });
    }

    if (parsed.pathname === "/gmail/v1/users/me/history") {
      if (config.history?.expired) return jsonResponse({ error: { code: 404 } }, 404);
      const pageToken = parsed.searchParams.get("pageToken");
      const index = pageToken ? Number(pageToken) : 0;
      const page = config.history?.pages?.[index];
      if (!page) return jsonResponse({ history: [] });
      const body = { history: page.history ?? [], historyId: page.historyId };
      if (index + 1 < (config.history.pages?.length ?? 0)) body.nextPageToken = String(index + 1);
      return jsonResponse(body);
    }

    const attachmentMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(
      parsed.pathname,
    );
    if (attachmentMatch) {
      const key = `${decodeURIComponent(attachmentMatch[1])}/${decodeURIComponent(attachmentMatch[2])}`;
      const content = config.attachmentContents?.[key];
      if (content === undefined) return jsonResponse({ error: { code: 404 } }, 404);
      return jsonResponse({ size: content.length, data: base64Url(content) });
    }

    const idMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(parsed.pathname);
    if (idMatch) {
      const message = byId.get(decodeURIComponent(idMatch[1]));
      if (!message) return jsonResponse({ error: { code: 404 } }, 404);
      return jsonResponse(message);
    }

    if (parsed.pathname === "/gmail/v1/users/me/messages") {
      const query = parsed.searchParams.get("q") ?? "";
      const afterMatch = /after:(\d+)/.exec(query);
      const beforeMatch = /before:(\d+)/.exec(query);
      const afterMs = afterMatch ? Number(afterMatch[1]) * 1000 : -Infinity;
      const beforeMs = beforeMatch ? Number(beforeMatch[1]) * 1000 : Infinity;
      const matching = config.messages.filter((message) => {
        const at = Number(message.internalDate);
        return at >= afterMs && at < beforeMs;
      });
      const maxResults = Number(parsed.searchParams.get("maxResults") ?? 100);
      const pageToken = parsed.searchParams.get("pageToken");
      const start = pageToken ? Number(pageToken) : 0;
      const page = matching.slice(start, start + maxResults);
      const body = {
        messages: page.map((message) => ({ id: message.id, threadId: message.threadId })),
        resultSizeEstimate: matching.length,
      };
      if (start + maxResults < matching.length) body.nextPageToken = String(start + maxResults);
      return jsonResponse(body);
    }

    return jsonResponse({ error: { code: 404 } }, 404);
  };

  return { fetchImpl, calls };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
