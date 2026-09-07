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
 *   an unroutable `@name` dropped rather than refusing the entry              6
 *   `postEntry` not reading `notePath` off a finalize's ack                   2
 *   the grant's tier not checked before a meeting is sent                     5
 *   `grantCoversMeetings` answering `true` for everything                     7
 *   ...answering `write || tier` rather than needing both                     5
 *
 * The last three rows are the same failure as the fourth, one field over: a
 * meeting sent on a grant that cannot file it privately is published
 * team-visible — to everybody its owner shares that folder with — with no error
 * anywhere. Asking for `context:private` is not getting it; the person
 * approving decides, and this client has to read the answer.
 *
 * The fourth row is the one worth reading. Dropping an unroutable slug is the
 * *tidy* thing to do — the request still goes out, on the bare route — and what
 * it does is file somebody's meeting in whatever context this machine's grant
 * defaults to, with no error anywhere. That is the failure
 * `apps/mobile/features/meetings/gateway.ts` argues at length about, and the
 * only answer that is not it is to refuse to send.
 */

import { ERRORS, ROUTES } from "@context/meetings/protocol";
import { contextRouteFor, postEntry, routeFor } from "../src/core/sync/client.ts";
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

/**
 * `scope` is what the **grant came back with**, and it is the desktop's whole
 * one: `context:write context:private`. A config that named a narrower one is a
 * machine that must not send a meeting at all, which is the block at the bottom
 * of this file.
 */
const GRANT = "context:write context:private";

const config = (fetchImpl, token = TOKEN, scope = GRANT) => ({
  baseUrl: "https://gateway.example.test",
  token: async () => token,
  scope: () => scope,
  fetch: fetchImpl,
});

export async function runGatewayChecks(check) {
  // -- routes come from the contract ----------------------------------------
  check("a session posts to the contract's collection route", routeFor(entry("session")) === ROUTES.sessions);
  check("segments post to the contract's segments route", routeFor(entry("segments")) === ROUTES.segments(sessionId));
  check("notes post to the contract's notes route", routeFor(entry("notes")) === ROUTES.notes(sessionId));
  check("finalize posts to the contract's finalize route", routeFor(entry("finalize")) === ROUTES.finalize(sessionId));

  // -- and a meeting addressed to a named context carries the name -----------
  //
  // The gateway routes on an optional `@name` at the front of the path, and the
  // desktop is the client that can be asked to write somewhere other than the
  // context its own grant defaults to — the console's destination sheet. What
  // matters is the direction of the refusal: a slug the gateway's selector
  // would not read falls off the front and the request is served by the
  // default, so a value that fails the pattern must stop the request rather
  // than being quietly dropped from it.

  check(
    "nothing addressed is the machine's own context, which is what the tray records",
    contextRouteFor(entry("finalize")) === ROUTES.finalize(sessionId),
  );
  check(
    "a named context is written on the front of the path, as a name",
    contextRouteFor({ ...entry("session"), context: "acme" }) === `/@acme${ROUTES.sessions}`,
  );
  check(
    "AN UNROUTABLE NAME REFUSES THE ADDRESS RATHER THAN FALLING BACK TO THE DEFAULT",
    contextRouteFor({ ...entry("session"), context: "Acme Corp" }) === null,
  );
  check(
    "...including one that would climb out of the route",
    contextRouteFor({ ...entry("session"), context: "../../admin" }) === null,
  );
  check(
    "...and one too short for the gateway's own pattern",
    contextRouteFor({ ...entry("session"), context: "a" }) === null,
  );
  check(
    "...and an empty one, which is a name nobody can route to rather than no name",
    contextRouteFor({ ...entry("session"), context: "" }) === null,
  );
  check(
    "...and a queue file corrupted into something that is not a name at all",
    contextRouteFor({ ...entry("session"), context: { slug: "acme" } }) === null,
  );
  check(
    "an entry from a build that predates addressing is this machine's own context",
    contextRouteFor(entry("notes")) === ROUTES.notes(sessionId),
  );
  {
    /*
      And the addressed meeting really is posted there.

      `contextRouteFor` above is the decision; this is the URL, because the two
      being one line apart is not the same as the one calling the other. A
      meeting somebody sent to a shared context from the console lands in that
      bucket, with this machine's own grant on the request — which is the whole
      shape of the feature in one check.
    */
    const impl = fakeFetch([{ status: 200, body: { sessionId, state: "recording" } }]);
    const result = await postEntry(config(impl), { ...entry("session", { id: sessionId }), context: "acme" });
    check(
      "A MEETING ADDRESSED TO A SHARED CONTEXT IS POSTED TO IT, WITH THIS MACHINE'S GRANT",
      result.ok === true && impl.calls[0]?.url === `https://gateway.example.test/@acme${ROUTES.sessions}`,
    );
    check(
      "...and the name is in the path rather than in the credential",
      !String(impl.calls[0]?.url ?? "").includes(TOKEN),
    );
  }
  {
    const impl = fakeFetch([{ status: 200, body: {} }]);
    const result = await postEntry(config(impl), { ...entry("finalize"), context: "Acme Corp" });
    check("...and nothing is sent for it at all", impl.calls.length === 0);
    check(
      "...and it parks rather than retrying forever against somebody's gateway",
      result.ok === false && result.retryable === false && result.code === ERRORS.invalid,
    );
    check(
      "...with a sentence that does not echo the name back",
      result.ok === false && !result.message.includes("Acme"),
    );
  }

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

  // -- where the note landed comes back with the finalize --------------------
  //
  // The one fact in a successful ingest that the client did not already know,
  // and the console is what is waiting for it: its page must not draw a meeting
  // as saved on "the queue accepted it". Read off the ack rather than composed
  // here, because the gateway decides where a note goes — including the folder
  // fallback it applies to a folder it will not file into.

  {
    const impl = fakeFetch([
      { status: 200, body: { sessionId, state: "complete", notePath: "5-meetings/standup.md" } },
    ]);
    const result = await postEntry(config(impl), entry("finalize"));
    check("a finalize's ack carries the note's path", result.ok === true && result.notePath === "5-meetings/standup.md");
  }
  {
    const impl = fakeFetch([{ status: 200, body: { sessionId, state: "finalizing", notePath: null } }]);
    const result = await postEntry(config(impl), entry("finalize"));
    check(
      "a finalize the gateway accepted without a path answers `null`, not a guess",
      result.ok === true && result.notePath === null,
    );
  }
  {
    const impl = fakeFetch([
      { status: 200, body: { ok: true } },
      { status: 200, body: { sessionId, notePath: "5-meetings/standup.md" } },
    ]);
    let outbox = emptyOutbox();
    outbox = queueWrite(outbox, { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    outbox = queueWrite(outbox, { sessionId, kind: "finalize", body: { sessionId }, now: 1 });
    const report = await drainOnce(outbox, config(impl), () => 1_000);
    check(
      "a drain reports which meetings reached the bucket, and where",
      report.written.length === 1 && report.written[0].notePath === "5-meetings/standup.md",
    );
    check("...keyed by the meeting, so a caller knows whose note it is", report.written[0].sessionId === sessionId);
  }
  {
    const impl = fakeFetch([{ status: 200, body: { sessionId, notePath: "5-meetings/x.md" } }]);
    let outbox = emptyOutbox();
    outbox = queueWrite(outbox, { sessionId, kind: "session", body: { id: sessionId }, now: 0 });
    const report = await drainOnce(outbox, config(impl), () => 1_000);
    check(
      "a session upsert is not a written note, whatever the reply said",
      report.sent === 1 && report.written.length === 0,
    );
  }

  // -- the grant is read, not only spent -------------------------------------
  //
  // `DESKTOP_SCOPE` asks for `context:private` because the tier decides what a
  // meeting is **filed as**: `visibilityTierForGrant` reads a grant without it
  // as `team`, and `publishMeetingNote` then writes the note team-visible and
  // records that visibility in the customer's own `privacy.md`. The person
  // approving may hand over less than was asked, so asking is not getting — and
  // a machine that sends anyway publishes its owner's meetings to everybody
  // they share a folder with, having been told nothing.

  {
    const impl = fakeFetch([{ status: 200, body: { sessionId } }]);
    const result = await postEntry(config(impl, TOKEN, "context:write"), entry("finalize"));
    check(
      "A MEETING IS NOT SENT ON A GRANT THAT CANNOT FILE IT PRIVATELY",
      result.ok === false && /team-visible/.test(result.message),
    );
    check(
      "...and nothing reached the gateway, so nothing was filed at the wider tier",
      impl.calls.length === 0,
    );
    check(
      "...and the meeting is held rather than dropped: this app un-parks nothing",
      result.retryable === true,
    );
  }
  {
    const impl = fakeFetch([{ status: 200, body: { sessionId } }]);
    // RFC 6749 lets a token endpoint omit `scope` to mean "as requested". Read
    // that way, this check would answer with the client's own request instead
    // of the server's answer — which is the whole thing it exists to stop.
    check(
      "A GRANT THAT SAYS NOTHING IS NOT A GRANT THAT SAID PRIVATE",
      (await postEntry(config(impl, TOKEN, ""), entry("finalize"))).ok === false &&
        (await postEntry(config(impl, TOKEN, null), entry("finalize"))).ok === false,
    );
  }
  {
    const impl = fakeFetch([{ status: 200, body: { sessionId } }]);
    check(
      "...nor is the tier alone, without the write it also needs",
      (await postEntry(config(impl, TOKEN, "context:private"), entry("finalize"))).ok === false,
    );
  }
  {
    const impl = fakeFetch([
      { status: 200, body: { sessionId } },
      { status: 200, body: { sessionId } },
    ]);
    check(
      "...and a wildcard grant is wider than this one, so it sends",
      (await postEntry(config(impl, TOKEN, "*"), entry("finalize"))).ok === true &&
        (await postEntry(config(impl, TOKEN, "context.write context.private"), entry("finalize")))
          .ok === true,
    );
  }
  {
    // Order matters: "not connected yet" is not the same answer as "connected
    // at the wrong tier", and a machine with no grant must get the first.
    const impl = fakeFetch([{ status: 200, body: { sessionId } }]);
    const result = await postEntry(config(impl, null, ""), entry("finalize"));
    check(
      "a machine with no grant at all is still told it is not connected yet",
      result.ok === false && /not connected/.test(result.message),
    );
  }

  // -- the token never comes back out ---------------------------------------
  {
    const store = memoryTokenStore("secret-token-value");
    await store.clear();
    check("clearing the token store leaves nothing behind", (await store.read()) === null);
  }
}
