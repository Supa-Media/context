// A fake `calendar.events.list` server: an in-process function with the same
// signature as `fetch`, backed by an append-only change log, returning
// Google's documented response shapes exactly as the real API would —
// `{items, nextPageToken, nextSyncToken}`, a `410` when a syncToken no
// longer resolves, and pagination via `pageToken`.
//
// This is deliberately not a mock that records "was called with X" — it is a
// small server with real incremental-sync semantics, so `calendar-sync.js`'s
// paging loop, 410 handling and syncToken bookkeeping are exercised against
// behaviour a real Calendar API would actually produce, not against a stub
// that already knows what the test expects.
//
// ## The model
//
// Every `addEvent`/`cancelEvent` call appends one entry to a linear change
// log with a monotonic sequence number. A syncToken *is* a sequence number
// (opaque to the caller, spelled `"tok-<n>"`). A full request (no syncToken)
// returns the latest non-cancelled state of every event whose window
// overlaps `[timeMin, timeMax)`, plus `nextSyncToken` for "everything up to
// now". An incremental request (`syncToken: "tok-n"`) returns the latest
// state — cancelled or not — of every event with at least one change after
// sequence `n`, deduplicated to one entry per event id, exactly as Google's
// own incremental sync deduplicates multiple changes to the same event
// between two syncs.

function windowOverlaps(event, timeMin, timeMax) {
  if (!timeMin && !timeMax) return true;
  const start = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00.000Z` : null);
  const end = event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00.000Z` : start);
  if (!start) return true;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end ?? start);
  const minMs = timeMin ? Date.parse(timeMin) : -Infinity;
  const maxMs = timeMax ? Date.parse(timeMax) : Infinity;
  return endMs > minMs && startMs < maxMs;
}

export function createFakeCalendarServer({ pageSize = 250 } = {}) {
  /** @type {Array<{seq: number, event: object}>} */
  const changeLog = [];
  let seq = 0;
  const expiredTokens = new Set();
  const requests = [];

  function upsert(event) {
    seq += 1;
    changeLog.push({ seq, event: { ...event, status: event.status ?? "confirmed" } });
    return seq;
  }

  return {
    /** Every request this server has answered, for a test to inspect (never includes the access token — see the check below). */
    requests,

    addEvent(event) {
      return upsert(event);
    },

    /**
     * Cancel an event. `bare: true` mimics Google's documented behaviour for
     * a deleted *standalone* (non-recurring) event: the resource carries only
     * `id` and `status`, with no `start`/`end`/`originalStartTime` at all —
     * the case a bookkeeping cache has to resolve from its own memory.
     */
    cancelEvent(eventId, { originalStartTime, bare = false } = {}) {
      const event = bare
        ? { id: eventId, status: "cancelled" }
        : { id: eventId, status: "cancelled", ...(originalStartTime ? { originalStartTime } : {}) };
      return upsert(event);
    },

    /** Force the next use of this token to answer `410 Gone`, simulating an expired sync token. */
    expireToken(token) {
      expiredTokens.add(token);
    },

    currentToken() {
      return `tok-${seq}`;
    },

    /** The `fetch`-compatible entry point. */
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      const auth = init.headers?.Authorization ?? init.headers?.authorization;
      requests.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), hadAuthHeader: Boolean(auth) });

      const syncToken = parsed.searchParams.get("syncToken");
      const timeMin = parsed.searchParams.get("timeMin");
      const timeMax = parsed.searchParams.get("timeMax");
      const pageToken = parsed.searchParams.get("pageToken");

      if (syncToken && expiredTokens.has(syncToken)) {
        return jsonResponse(410, { error: { code: 410, message: "Sync token is no longer valid, a full sync is required." } });
      }

      /** @type {object[]} */
      let items;
      if (syncToken) {
        const match = /^tok-(\d+)$/.exec(syncToken);
        if (!match) return jsonResponse(410, { error: { code: 410, message: "Invalid sync token value." } });
        const since = Number(match[1]);
        if (since > seq) return jsonResponse(410, { error: { code: 410, message: "Sync token is from the future." } });
        const latestById = new Map();
        for (const { seq: entrySeq, event } of changeLog) {
          if (entrySeq > since) latestById.set(event.id, event);
        }
        items = [...latestById.values()];
      } else {
        const latestById = new Map();
        for (const { event } of changeLog) latestById.set(event.id, event);
        items = [...latestById.values()].filter((event) => event.status !== "cancelled" && windowOverlaps(event, timeMin, timeMax));
      }

      const offset = pageToken ? Number(pageToken) : 0;
      const page = items.slice(offset, offset + pageSize);
      const hasMore = offset + pageSize < items.length;

      const body = { kind: "calendar#events", items: page };
      if (hasMore) body.nextPageToken = String(offset + pageSize);
      else body.nextSyncToken = `tok-${seq}`;
      return jsonResponse(200, body);
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
