/**
 * The per-request store's request-scoped parts, laid on it once it is open:
 * the search budget and settings, link and image calls, deferral, the
 * presence rooms, and the reporters that tell the control plane what
 * happened behind the response. Moved out of `route.js` so the MCP entry
 * point (`mcpRoute.js`) and every other transport route lay the same ones.
 */

import { attachLinkCalls } from "./routing.js";
import { attachChangeReporters } from "../controlPlane/changeReporters.js";
import { deferredWork } from "../mcp/usage.js";
import { textsCleared } from "../communications/messagesBackup.js";
import { searchBudgetFor } from "../search/budget.js";
import { searchSettingsFor } from "../search/settings.js";
import { attachImageUploads } from "../notes/imageUploads.js";

export function decorateRequestStore(store, { session, env, controlPlane, ctx, request, origin }) {
  // The deployment's search budget rides the per-request store the way
  // `store.actor` does: the tool layer never sees `env`, and the store dies
  // with the request, so a reused isolate carries nothing across tenants.
  store.searchSubrequestBudget = searchBudgetFor(env);
  // And the deployment's search settings (`search/settings.js`), on the
  // same terms; a texting setup may lay its own over them for one turn.
  store.searchSettings = searchSettingsFor(env);
  attachLinkCalls(store, session, controlPlane, env);
  attachImageUploads(store, session, controlPlane, origin, env);
  // The person's texts (`tools/texts.js`), for their own personal workspace's owner only.
  if (textsCleared(session)) Object.defineProperty(store, "texts", { value: Object.freeze({ cleared: true, reader: session.actorClientName ?? null }) });
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

  /*
    The model behind this connection, where the client says: the desktop
    app names the one it launched Claude Code with. A label for the usage
    breakdown and nothing else, normalized to a closed shape by the control
    plane; no MCP client is required to send it.
  */
  const declaredModel = request.headers.get("X-Context-Model");
  if (declaredModel) store.usageModel = declaredModel.slice(0, 128);

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
    // A function is a report to build later (`reportBoundaryUsage`): it
    // tokenizes, so it runs a macrotask after the response, never before.
    const lazy = typeof events === "function";
    if (!lazy && (!Array.isArray(events) || events.length === 0)) return;
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
      const sent = lazy
        ? new Promise((resolve) => setTimeout(resolve, 0))
            .then(events)
            .then(({ events: counted = [], hourly = [] } = {}) =>
              controlPlane.reportUsage(counted, hourly),
            )
        : controlPlane.reportUsage(events);
      store.defer(
        sent.catch(() => {
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

  // That this connection just fetched `tools/list`, against its own grant
  // (the token is the proof, as for the session). Deferred and dropped
  // where it cannot be, the trade `reportUsage` makes: a stamp that is
  // lost only means `orient` repeats some tool news next time.
  store.reportToolsListed = () => {
    if (typeof store.defer !== "function") return;
    try {
      store.defer(controlPlane.reportToolsListed(session.accessToken).catch(() => {}));
    } catch {
      // A host whose `waitUntil` refuses the work simply does not report.
    }
  };

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
  attachChangeReporters(store, session.workspaceId, controlPlane, { env });

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
}
