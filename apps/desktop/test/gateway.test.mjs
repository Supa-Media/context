/**
 * What leaves the machine, and what must never be in it.
 *
 * The gateway client is thin, so this suite is mostly two questions: does it
 * post to the route the contract names, and can the credential end up anywhere
 * a person could later read it. The second one is the reason the checks about
 * error strings exist — a `fetch` failure's own message carries the request
 * URL, and the log file is the last place anybody looks for a token.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   the token appended as `?token=` instead of a header                       4
 *   a non-JSON 200 treated as a successful ingest                             2
 *   `String(error)` used for the network failure message                      2
 */

import { ERRORS, ROUTES } from "@context/meetings/protocol";
import { postEntry, routeFor } from "../src/core/sync/client.ts";
import { drainOnce } from "../src/core/sync/drain.ts";
import { emptyOutbox, queueWrite } from "../src/core/sync/outbox.ts";
import { memoryTokenStore } from "../src/core/sync/tokenStore.ts";
import { fakeFetch } from "./fakes.mjs";

const sessionId = "mtg_abcdefghjkmnpqrstvwx";
const TOKEN = "fake-grant-token-not-a-real-one";

const entry = (kind, body = {}) => ({
  id: `${sessionId}:${kind}`,
  sessionId,
  kind,
  body,
  queuedAt: 0,
  updatedAt: 0,
  attempts: 0,
  state: "pending",
  nextAttemptAt: 0,
});

const config = (fetchImpl, token = TOKEN) => ({
  baseUrl: "https://gateway.example.test",
  token: async () => token,
  fetch: fetchImpl,
});

export async function runGatewayChecks(check) {
  // -- routes come from the contract ----------------------------------------
  check("a session posts to the contract's collection route", routeFor(entry("session")) === ROUTES.sessions);
  check("segments post to the contract's segments route", routeFor(entry("segments")) === ROUTES.segments(sessionId));
  check("notes post to the contract's notes route", routeFor(entry("notes")) === ROUTES.notes(sessionId));
  check("finalize posts to the contract's finalize route", routeFor(entry("finalize")) === ROUTES.finalize(sessionId));

  // -- the credential --------------------------------------------------------
  {
    const impl = fakeFetch([{ status: 200, body: { sessionId, state: "recording", segmentCount: 0, notePath: null } }]);
    const result = await postEntry(config(impl), entry("session", { id: sessionId }));
    check("a 2xx is an ingest", result.ok === true);
    const call = impl.calls[0] ?? { url: "", init: { headers: {}, body: "{}" } };
    check("the URL is base plus the contract's path", call.url === `https://gateway.example.test${ROUTES.sessions}`);
    check("the credential is NOT in the URL", !call.url.includes(TOKEN));
    check("the credential is in the Authorization header", call.init.headers.authorization === `Bearer ${TOKEN}`);
    check("the body is the entry's body", JSON.parse(call.init.body).id === sessionId);
  }

  // -- an unconnected machine queues rather than failing ---------------------
  {
    const impl = fakeFetch([{ status: 200 }]);
    const result = await postEntry(config(impl, null), entry("session"));
    check("an unconnected machine does not post at all", impl.calls.length === 0);
    check("an unconnected machine keeps the meeting queued", result.ok === false && result.retryable === true);
  }

  // -- refusals --------------------------------------------------------------
  {
    const impl = fakeFetch([{ status: 403, body: { error: ERRORS.forbidden, message: "this grant cannot write" } }]);
    const result = await postEntry(config(impl), entry("segments"));
    check("a forbidden grant is not retried", result.ok === false && result.retryable === false);
    check("the gateway's own message is kept", result.message === "this grant cannot write");
  }
  {
    const impl = fakeFetch([{ status: 503, body: { error: ERRORS.unavailable, message: "storage is down" } }]);
    const result = await postEntry(config(impl), entry("finalize"));
    check("storage being down is retried", result.ok === false && result.retryable === true);
  }
  {
    const impl = fakeFetch([{ status: 409, body: {} }]);
    const result = await postEntry(config(impl), entry("finalize"));
    check("a 409 with no code is read as a conflict", result.code === ERRORS.conflict && result.retryable === true);
  }
  {
    const impl = fakeFetch([{ status: 400, body: "not json" }]);
    // A 400 whose body is a JSON string, not an object: still a refusal, still not retried.
    const result = await postEntry(config(impl), entry("session"));
    check("a 400 is not retried", result.code === ERRORS.invalid && result.retryable === false);
  }

  // -- the captive portal ----------------------------------------------------
  {
    const impl = fakeFetch([() => new Response("<html>sign in to wifi</html>", { status: 200, headers: { "content-type": "text/html" } })]);
    const result = await postEntry(config(impl), entry("finalize"));
    check("a 200 that is not JSON is not an ingest", result.ok === false);
    check("a captive portal is retried, not parked", result.retryable === true);
    check("the captive portal's HTML is not in the message", !(result.message ?? "").includes("<html>"));
  }

  // -- nothing leaks into an error ------------------------------------------
  {
    const impl = fakeFetch([() => { throw new TypeError(`fetch failed for https://gateway.example.test/x?token=${TOKEN}`); }]);
    const result = await postEntry(config(impl), entry("session"));
    check("a network failure is retryable", result.ok === false && result.retryable === true);
    check("the credential is not in the error message", !JSON.stringify(result).includes(TOKEN));
    check("the request URL is not in the error message", !JSON.stringify(result).includes("gateway.example.test"));
  }

  // -- the timeout -----------------------------------------------------------
  {
    const impl = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const result = await postEntry({ ...config(impl), timeoutMs: 5 }, entry("session"));
    check("a hung request times out rather than wedging the drain", result.ok === false && result.message === "the request timed out");
  }

  // -- the replay ------------------------------------------------------------
  //
  // The meeting was recorded offline. Everything is queued; the connection
  // comes back; one drain sends it all, in order, once.
  {
    const impl = fakeFetch([{ status: 200, body: { ok: true } }]);
    let outbox = emptyOutbox();
    outbox = queueWrite(outbox, { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    outbox = queueWrite(outbox, {
      sessionId,
      kind: "segments",
      body: { sessionId, segments: [{ id: "s1", startMs: 0, endMs: 1, text: "a", speaker: null, channel: "mic", confidence: null }] },
      now: 1,
    });
    outbox = queueWrite(outbox, { sessionId, kind: "notes", body: { sessionId, notes: "mine" }, now: 2 });
    outbox = queueWrite(outbox, { sessionId, kind: "finalize", body: { sessionId, segmentCount: 1 }, now: 3 });

    const report = await drainOnce(outbox, config(impl), () => 1_000);
    check("a reconnect sends everything that was queued", report.sent === 4);
    check("the queue is empty afterwards", report.outbox.entries.length === 0);
    check(
      "the order on the wire is the contract's",
      impl.calls.map((call) => call.url.replace("https://gateway.example.test", "")).join(" ") ===
        `${ROUTES.sessions} ${ROUTES.segments(sessionId)} ${ROUTES.notes(sessionId)} ${ROUTES.finalize(sessionId)}`,
    );
  }

  // -- a drain that meets a wall ---------------------------------------------
  {
    const impl = fakeFetch([{ status: 503, body: { error: ERRORS.unavailable, message: "down" } }]);
    let outbox = emptyOutbox();
    outbox = queueWrite(outbox, { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    outbox = queueWrite(outbox, { sessionId, kind: "finalize", body: { sessionId }, now: 1 });
    const report = await drainOnce(outbox, config(impl), () => 0);
    check("a session that cannot send its head does not send its tail", impl.calls.length === 1);
    check("nothing is lost when the gateway is down", report.outbox.entries.length === 2);
  }

  // -- the token never comes back out ---------------------------------------
  {
    const store = memoryTokenStore("secret-token-value");
    await store.clear();
    check("clearing the token store leaves nothing behind", (await store.read()) === null);
  }
}
