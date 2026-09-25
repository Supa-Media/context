/**
 * `route` — every HTTP request to the gateway, in one function whose ORDER of
 * checks is the security boundary (origin, well-known, OAuth, the transport
 * and its session, then each surface). Moved verbatim out of `index.js`; it
 * is one statement, so a pure move cannot make this file shorter.
 */

import { actorFor, contextsFor } from "../context/identity.js";
import { attachGatewayJobQueue, attachLinkCalls, matchWellKnown } from "./routing.js";
import {
  authorizationServerMetadata,
  forbiddenResponse,
  handleAuthorize,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
  publicOrigin,
  unauthorizedResponse,
} from "../oauth.js";
import {
  bearerToken,
  decodePathSegment,
  hasScope,
  resolveSession,
  SCOPE_CAPTURE,
  SCOPE_READ,
  sessionForContext,
  SessionRefusal,
  splitWorkspacePath,
  StorageUnavailable,
  storeForSession,
} from "../session.js";
import { corsResponse, json } from "./responses.js";
import { createControlPlane } from "../controlPlane.js";
import { deferredWork } from "../mcp/usage.js";
import { enforceOrigin, isTransportPath } from "../origin.js";
import { handleAgent } from "../agent/route.js";
import { handleAgentActivity, handlePresence } from "../live/presenceRoute.js";
import { handleCollaboration } from "../live/collaborationRoute.js";
import { handleGranolaWebhook } from "../ingestion/granolaWebhook.js";
import { handleInbox } from "../ingestion/inboxRoute.js";
import { handleMcp } from "../mcp/handlers.js";
import {
  handleMeetings,
  isMeetingPath,
  matchMeetingRoute,
  meetingScopeRefusal,
  scopeForMeetingRequest,
} from "../meetings/ingest.js";
import { localIngestionStore } from "../ingestion/inbox.js";
import { publishMeetingNote, resolveMeetingNotePath } from "../meetings/notes.js";
import { searchBudgetFor } from "../search/budget.js";
import { transcriptionForwarder } from "../ingestion/transcription.js";

export async function route(request, env, ctx) {
    const url = new URL(request.url);

    const origin = publicOrigin(request, env);

    // The workspace selector comes off the front first, so every route below
    // sees the same path whether or not the caller named a context. The slug
    // selects; it never authorizes. See splitWorkspacePath.
    //
    // Meeting ingestion used to be lifted out of this line — `isMeetingPath` on
    // the raw pathname, before the selector — because `meetings` was not one of
    // `session.js`'s RESERVED_FIRST_SEGMENTS, so `POST /meetings/sessions` read
    // as a workspace called "meetings" selecting the path `/sessions`. That was
    // one route defending itself against a list it was missing from, and it left
    // the actual hole open: the name was still claimable, in a namespace where a
    // name is also a mailbox on the apex. `meetings` is in that list now, and in
    // the control plane's RESERVED_NAMES beside it, so this needs no exception.
    const { slug, path: afterSlug } = splitWorkspacePath(url.pathname);

    // Token-in-path fallback: /t/<token>/mcp, or /@slug/t/<token>/mcp.
    //
    // Kept for clients that genuinely cannot set an Authorization header. It is
    // a TRANSPORT for an OAuth-issued access token and nothing else: the token
    // is resolved by exactly the same code as a header token, gets exactly the
    // same grant, and confers exactly the same authority. It is not, and has
    // never been, the security boundary. A token in a URL lands in browser
    // history, proxy logs, and referrer headers, so prefer the header.
    let path = afterSlug;
    let pathToken = null;
    const tokenInPath = path.match(/^\/t\/([^/]+)(\/.*)?$/);
    if (tokenInPath) {
      // A malformed escape decodes to nothing rather than throwing out of
      // `fetch`. An undecodable token is not a token; the route still resolves
      // and the request gets the ordinary 401 instead of a Worker exception.
      pathToken = decodePathSegment(tokenInPath[1]);
      path = tokenInPath[2] || "/";
    }

    // MCP says a server MUST validate `Origin` on the Streamable HTTP
    // transport, to stop a page in a victim's browser from reaching an
    // authenticated endpoint by DNS rebinding. See `src/origin.js` for what
    // counts as valid — in particular that *absence* is not an attack signal
    // and `null` is not absence.
    //
    // It runs here, above the method dispatch and above every auth path, for
    // two reasons: the preflight is refused on the same terms as the request it
    // precedes, and the refusal is produced before any token, slug, or control
    // plane answer exists to vary it.
    //
    // The meeting routes are guarded on the same terms. They are authenticated,
    // state-changing and reachable from a browser, which is the whole of
    // `isTransportPath`'s reasoning about `/inbox` — and the list itself lives
    // in `origin.js`, so this asks the question here rather than editing
    // another module's idea of what speaks the MCP transport.
    if (isTransportPath(path) || isMeetingPath(path)) {
      const refusal = enforceOrigin(request, env);
      if (refusal) return refusal;
    }

    if (request.method === "OPTIONS") return corsResponse();

    const wellKnown = matchWellKnown(path);
    if (wellKnown) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405 });
      }
      if (wellKnown.kind === "authorization-server") {
        return authorizationServerMetadata(origin);
      }
      // A client that was handed `https://host/@seyi/mcp` probes
      // `/.well-known/oauth-protected-resource/@seyi/mcp` before the root form,
      // so the slug can arrive in the prefix or in the suffix. Either way it
      // describes the same resource.
      return protectedResourceMetadata(origin, slug || wellKnown.slug);
    }

    if (path.startsWith("/oauth/")) {
      const controlPlane = createControlPlane(env);
      try {
        if (path === "/oauth/register" && request.method === "POST") {
          return await handleRegister(request, env, controlPlane);
        }
        if (path === "/oauth/authorize" && request.method === "GET") {
          return await handleAuthorize(request, env, controlPlane, { origin, slug });
        }
        if (path === "/oauth/token" && request.method === "POST") {
          return await handleToken(request, env, controlPlane, { origin, slug });
        }
        if (path === "/oauth/revoke" && request.method === "POST") {
          return await handleRevoke(request, env, controlPlane);
        }
      } catch {
        // Never relay a control-plane failure verbatim: its text is written for
        // operators and the caller is an AI client on the open internet.
        return json({ error: "server_error" }, 503);
      }
      return new Response(null, { status: 405 });
    }

    // Who else is in this note. Its own branch rather than a line in the block
    // below, because it is the one authenticated route that is a GET, answers
    // 101 rather than JSON, and needs no queue, no usage counter and no search
    // budget — it never reads a note and never writes one.
    if (path === "/presence") {
      return await handlePresence(request, env, { slug, pathToken, origin });
    }

    // Which notes agents touched lately, for the console's file tree. Its own
    // branch for the reasons `/presence` has one: a GET that reads no note,
    // writes nothing, and needs no queue, usage counter or search budget.
    if (path === "/agent-activity") {
      return await handleAgentActivity(request, env, { slug, pathToken, origin });
    }

    // A meeting route resolves a session exactly as `/mcp` does — same token,
    // same grant, same clamps — so it shares this block rather than growing a
    // second copy of it. What it does not share is the method: the contract
    // reads a session back over GET, so the POST-only gate below is asked of
    // the MCP transport paths only, and `handleMeetings` answers a wrong method
    // with a meeting error naming the route.
    const meetingRoute = matchMeetingRoute(path);
    if (
      path === "/mcp" ||
      path === "/inbox" ||
      path === "/agent" ||
      path === "/collaboration" ||
      meetingRoute
    ) {
      if (!meetingRoute && request.method !== "POST") return new Response(null, { status: 405 });
      const controlPlane = createControlPlane(env);
      let session;
      try {
        session = await resolveSession(pathToken || bearerToken(request), slug, controlPlane);
      } catch (error) {
        if (!(error instanceof SessionRefusal)) throw error;
        // A 403 from workspace selection deliberately drops the slug from its
        // challenge, so the refusal for "a real context you cannot reach" is
        // byte-identical to the one for a name nobody has ever registered.
        // Echoing it back would make the challenge header itself the oracle the
        // status code was careful not to be.
        return error.status === 403
          ? forbiddenResponse(origin, null, error)
          : unauthorizedResponse(origin, slug, error);
      }

      // A meeting write is a write, and it is checked here — before a store
      // exists and before any lookup — so the refusal is decided without
      // reading anything and therefore discloses nothing about what this
      // context holds. `hasScope` reads the already-clamped set, so a `member`
      // of somebody else's workspace is refused by their role and not only by the
      // grant.
      // `/agent` asks for read and nothing more. Every write it can make is a
      // *proposal*, which the connection's own clamp decides on per call in
      // `callToolForSession` — so a read-only grant gets an assistant that can
      // answer and cannot suggest, which is the honest shape of a read-only
      // grant rather than a special case.
      const needed = meetingRoute
        ? scopeForMeetingRequest(request.method)
        : path === "/inbox"
          ? SCOPE_CAPTURE
          : SCOPE_READ;
      if (!hasScope(session, needed)) {
        // A meeting client is owed one of the contract's error codes, not the
        // OAuth challenge the MCP transport answers with; it names the one
        // missing scope for the same incremental-consent reason.
        if (meetingRoute) return meetingScopeRefusal(needed);
        return forbiddenResponse(origin, null, {
          description: `This connection does not hold the ${needed} scope.`,
          // Incremental consent: name the one scope that was missing, so the
          // client can re-authorize for it rather than for everything.
          scope: [needed],
        });
      }

      let store;
      try {
        store = await storeForSession(session, env, controlPlane);
      } catch (error) {
        if (!(error instanceof StorageUnavailable)) throw error;
        // Authenticated, but this workspace has no bucket we can reach. A
        // refusal, never a fallback: there is no other store to serve from and
        // reaching for one would be the cross-tenant bug itself.
        return json(
          {
            error: "storage_unavailable",
            error_description:
              "This context has no reachable storage. Reconnect it from the dashboard.",
          },
          503
        );
      }

      // The deployment's search budget rides the per-request store the way
      // `store.actor` does: the tool layer never sees `env`, and the store dies
      // with the request, so a reused isolate carries nothing across tenants.
      store.searchSubrequestBudget = searchBudgetFor(env);
      attachGatewayJobQueue(store, session, controlPlane, env);
      attachLinkCalls(store, session, controlPlane);
      // The one way anything in this worker gets to keep working after the
      // response has gone out. Request-scoped like the budget above, and the
      // credential inside `store` never outlives the request either: an
      // extended request is still one request, which is the line "never cache
      // a decrypted credential across requests" draws.
      //
      // Absent on any host that gives no `ctx` — the suite's direct
      // `worker.fetch(request, env)` calls, a self-host shim — and every caller
      // therefore treats deferral as an optimisation it may not get, never as
      // where the work happens.
      store.defer =
        ctx && typeof ctx.waitUntil === "function"
          ? (work) => ctx.waitUntil(deferredWork(work))
          : null;

      /*
        **The room to tell when a tool writes a note somebody has open.**

        An MCP client writing `1-projects/foo.md` while two people are editing
        it in the console is the case this product is for — the agent that
        saves what a session decided, into a note somebody is reading. Without
        this the console learns about that write at the next reload, or worse,
        at the conflict its own save raises.

        The binding rather than a room: which room depends on the note, and is
        resolved at the moment of the write. Null on a deployment without
        presence, where every tool behaves exactly as it did before this
        existed.
      */
      store.presenceRooms = env.PRESENCE_ROOM ?? null;

      /**
       * Count a thing that happened, behind the response and never in front of
       * it.
       *
       * Request-scoped like `store.defer` above and for the same reason: the
       * tool layer never sees `env` or the control plane, so a reused isolate
       * carries nothing across tenants.
       *
       * Two properties, both of which are the whole point:
       *
       *  - **It cannot fail a request.** The report is deferred where the host
       *    can defer and dropped where it cannot — never awaited, never
       *    retried, and its rejection is swallowed here rather than at each
       *    call site, so there is one place this promise can throw from and it
       *    does not.
       *  - **It carries a name and a number.** The metric names are the
       *    control plane's closed vocabulary; the workspace is one this
       *    request already resolved a grant to. Nothing about *what* the call
       *    was — no path, no query, no title — is in the shape at all. Adding
       *    one would make this a record of what somebody wrote, which their
       *    own bucket already holds and we deliberately do not.
       */
      store.reportUsage = (events) => {
        if (!Array.isArray(events) || events.length === 0) return;
        // **The deferral is checked before the request is built, not after.**
        // A host with no `waitUntil` has nothing keeping the invocation alive
        // past the response, so a `fetch` started here is one the runtime may
        // cancel at any point — a request that costs a subrequest, may or may
        // not arrive, and cannot be observed either way. Not starting it is the
        // honest version of "this host does not report", and it is the one
        // place in this worker where "cannot defer" means "do not do the
        // work": an index nobody builds is a broken product, and a figure
        // nobody counts is a slightly emptier dashboard.
        if (typeof store.defer !== "function") return;
        try {
          store.defer(
            controlPlane.reportUsage(events).catch(() => {
              // A counter that could not be written changes nothing about the
              // answer that has already gone out.
            }),
          );
        } catch {
          // A host whose `waitUntil` refuses the work simply does not report.
        }
      };

      /**
       * How far this context's search projection has got.
       *
       * Request-scoped like `store.reportUsage`, and bound to the workspace
       * *this store reaches* rather than to the connection's default — a
       * cross-context call projects the context it was routed to, and a
       * progress figure filed against the wrong tenant is a census of somebody
       * else's notes on somebody's settings screen.
       *
       * Unlike `reportUsage` it is not gated on `store.defer`. The projection
       * pass is already behind the response wherever it can be, and on a host
       * that cannot defer it runs inline and awaited — so there is always a
       * live invocation around this call, and the case `reportUsage` declines
       * (a fetch nothing keeps alive) does not arise.
       */
      store.reportSearchIndexProgress = (progress) =>
        controlPlane.reportSearchIndexProgress({
          ...progress,
          workspaceId: session.workspaceId,
        });

      /**
       * That something landed in this context's `activity.md`, and at which
       * tier; and that its file tree changed, for which audiences. See
       * `attachChangeReporters`, which `openContext` below calls too.
       *
       * Bound to the workspace this store reaches, like the progress reporter
       * above and for the same reason: a cross-context write lights the dot on
       * the context it was written into, never on the one the client happened
       * to connect to.
       *
       * Deferred where the host can, and dropped where it cannot — the same
       * trade `reportUsage` makes, and the same reasoning: a dot that does not
       * light is a slightly quieter console, and a fetch nothing keeps alive
       * is a subrequest spent on nothing. The line is in the customer's bucket
       * either way, which is where it matters.
       */
      attachChangeReporters(store, session.workspaceId, controlPlane);

      /**
       * That a form on this context just took an answer.
       *
       * The gateway's half of "anytime there is a submission". The console and
       * a published collect link both write through `runFileOperation`, which
       * schedules the notification itself; a submission through `submit_form`
       * never touches the control plane, so without this line an AI client
       * filing a bug report would be the one way of answering a form that told
       * nobody.
       *
       * Bound to the workspace this store reaches, like the progress reporter
       * above and for the same reason: a cross-context submission notifies the
       * context it was written into, never the one the client connected to.
       *
       * Deferred where the host can and dropped where it cannot — the trade
       * `reportUsage` makes, with the same reasoning. The answer is in the
       * customer's bucket either way; what is lost on a host with no
       * `waitUntil` is a message, not a response. It never throws into the
       * tool call for the same reason it is deferred at all: a mail provider
       * having a bad afternoon must not turn a stored answer into an error.
       */
      store.reportFormSubmission = (submission) => {
        const send = controlPlane
          .notifyFormSubmission(session.workspaceId, submission)
          .catch(() => {});
        if (typeof store.defer !== "function") return;
        try {
          store.defer(send);
        } catch {
          // A host whose `waitUntil` refuses the work simply does not report.
        }
      };

      if (path === "/collaboration") {
        store.actor = actorFor(session);
        return handleCollaboration(request, store, session, origin);
      }

      // Capture is anchored to the context its grant was approved for, so the
      // inbox store is built without the opener at all rather than with one
      // nothing calls. That makes "a capture-only credential reaches exactly
      // one context" structural instead of a sentence someone has to keep true.
      if (path === "/inbox") return handleInbox(request, env, store, session);

      // Meetings are anchored to the context the request addressed, for the
      // reason capture is: the store is built without an opener, so a recorder
      // left running on a laptop reaches exactly one context and a meeting
      // cannot be filed into a workspace the URL did not name. The acting identity
      // rides on the store so the audit line for a written meeting says who,
      // and not merely at what tier.
      if (meetingRoute) {
        store.actor = actorFor(session);
        return handleMeetings(request, path, store, session, {
          publishNote: publishMeetingNote,
          // `null` on a deployment with no transcription configured, which is
          // the ordinary state of a self-hosted install and answers 501 rather
          // than pretending. See `meetings/transcribe.js`.
          transcribe: transcriptionForwarder(env),
          // M1: resolve a session's note by id when its stored path has moved.
          // See `resolveMeetingNotePath`'s own header for why this lives here
          // rather than in `meetings/ingest.js`.
          resolveNotePath: resolveMeetingNotePath,
        });
      }

      /**
       * Open one of the *other* contexts this connection covers.
       *
       * A grant covers every context its person is a live member of, so a tool
       * call may name one — and this is the only thing in the worker that acts
       * on that name. It rides on the per-request store for the same reason
       * `store.actor` and the search budget do: the tool layer never sees `env`
       * or the control plane, and everything it hands back dies with the
       * request, so a reused isolate carries no other tenant's credential.
       *
       * Two properties it must keep:
       *
       *  - **A second store, never a second grant.** `sessionForContext` clamps
       *    the grant's scopes and the visibility tier to the caller's role in
       *    the addressed context, and `storeForSession` spends the same
       *    two-factor proof — the same user token, for a context the control
       *    plane independently agrees they are a member of.
       *  - **No chaining.** The store it returns has no `openContext` of its
       *    own, so one tool call resolves one context and cannot walk.
       */
      store.openContext = async (name) => {
        const target = sessionForContext(session, name);
        if (target === session) return { session, store };
        const targetStore = await storeForSession(target, env, controlPlane);
        targetStore.searchSubrequestBudget = searchBudgetFor(env);
        attachGatewayJobQueue(targetStore, target, controlPlane, env);
        attachLinkCalls(targetStore, target, controlPlane);
        targetStore.defer = store.defer;
        // The same binding, keyed later by the *target's* workspace id: a
        // write routed into another context is announced in that context's
        // note room and recorded in its activity, never in the caller's.
        targetStore.presenceRooms = store.presenceRooms;
        // Its tree hint and activity dot go to the context written into: the
        // people watching `@theirs` are the ones whose console must move.
        attachChangeReporters(targetStore, target.workspaceId, controlPlane);
        targetStore.actor = actorFor(target);
        targetStore.contexts = contextsFor(target);
        // Against the context that was routed to, never the connection's own.
        // `targetStore.searchIndex` came from that context's own binding, so
        // the projection and the figure describing it name one workspace.
        targetStore.reportSearchIndexProgress = (progress) =>
          controlPlane.reportSearchIndexProgress({
            ...progress,
            workspaceId: target.workspaceId,
          });
        // Likewise against the context that was routed to. A form answered in
        // somebody else's context tells *their* owner, and a notification
        // filed against the caller's own workspace would resolve `notify:
        // owner` to the wrong person entirely.
        targetStore.reportFormSubmission = (submission) => {
          const send = controlPlane
            .notifyFormSubmission(target.workspaceId, submission)
            .catch(() => {});
          if (typeof targetStore.defer !== "function") return;
          try {
            targetStore.defer(send);
          } catch {
            // A host whose `waitUntil` refuses the work simply does not report.
          }
        };
        return { session: target, store: targetStore };
      };

      // After `store.openContext` is attached, deliberately: a turn may address
      // another context by name exactly as a client's tool call can, through
      // the same one place that decision is taken.
      if (path === "/agent") return await handleAgent(request, env, store, session, controlPlane);

      return handleMcp(request, store, session);
    }

    if (path === "/granola-webhook" && request.method === "POST") {
      const store = localIngestionStore(env);
      if (!store) return json({ error: "not_found" }, 404);
      return handleGranolaWebhook(request, env, store, ctx);
    }

    return json({ error: "not_found" }, 404);
}

/**
 * The two reporters every write's `recordChange` reaches for, bound to the
 * workspace `store` reaches — the connection's own for the session store, the
 * addressed one for a store `openContext` built. Bound per store rather than
 * per connection because a cross-context write lights the dot on, and re-lists
 * the tree of, the context it was written into; a store with neither is a
 * write nobody watching that context hears about until the next walk.
 *
 * `reportTreeChange` is called inside work that is already deferred (see
 * `announceTreeChange`); `reportActivity` defers its own send, and is dropped
 * on a host that cannot keep it alive — the line is in the customer's bucket
 * either way.
 */
function attachChangeReporters(store, workspaceId, controlPlane) {
  store.reportTreeChange = (audiences) =>
    controlPlane.reportTreeChange(workspaceId, audiences).catch(() => {});
  store.reportWebsiteChange = () =>
    controlPlane.reportWebsiteChange(workspaceId).catch(() => {});
  store.reportActivity = (teamVisible) => {
    const send = controlPlane.reportActivity(workspaceId, teamVisible === true).catch(() => {});
    if (typeof store.defer !== "function") return;
    try {
      store.defer(send);
    } catch {
      // A host whose `waitUntil` refuses the work simply does not report.
    }
  };
}
