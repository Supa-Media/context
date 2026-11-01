/**
 * Opening the *other* contexts one request reaches, at most once each.
 *
 * Moved out of `route.js` (which sat at its size ceiling) with two changes,
 * both about wasted control-plane round trips and neither about who may reach
 * what:
 *
 *  - **One open per workspace per request.** A Tex turn is one request that
 *    makes many tool calls, and a search everywhere and an orient each open
 *    every workspace the person reaches. Each open is a `/gateway/binding`
 *    round trip; before this, the same workspace was opened again for every
 *    call that named it. The memo lives in this request's frame, holds only
 *    stores built from this request's own session, and dies with it, so a
 *    reused isolate carries nothing across requests or tenants. A failed open
 *    is forgotten, so the next call asks again.
 *  - **A named workspace opens beside the default, not after it.** A tool
 *    call that says `context: "@band"` used to wait for the connection's own
 *    workspace to open and only then open `@band`. `prefetchNamedContexts`
 *    reads the names off a copy of the request body and starts those opens at
 *    once. It goes through `sessionForContext`, the same clamp `openContext`
 *    uses, so a name the person does not reach opens nothing (and costs no
 *    round trip, exactly as before), and a store opened this way is only ever
 *    handed to a call that names it.
 */

import { actorFor, contextsFor } from "../context/identity.js";
import { attachLinkCalls } from "./routing.js";
import { sessionForContext } from "../session.js";
import { attachChangeReporters } from "../controlPlane/changeReporters.js";
import { searchBudgetFor } from "../search/budget.js";
import { toolSuggestDestination } from "../routing/suggestDestination.js";
import { attachImageUploads } from "../notes/imageUploads.js";

/** The tool-call arguments that name a workspace (`tools/session.js`). */
const NAMING_ARGUMENTS = ["context", "source_context", "destination_context"];
/** A request body larger than this is not peeked at; its call opens its context as before. */
const PEEK_BYTE_LIMIT = 256 * 1024;

/**
 * `openStore(target)` at most once per workspace for this request: the promise
 * is held, so opens started side by side share one round trip, and dropped if
 * it fails, so a later call asks again rather than inheriting the failure.
 */
export function onceEach(openStore) {
  const opened = new Map();
  return (target) => {
    const key = target?.workspaceId;
    if (typeof key !== "string" || key === "") return openStore(target);
    if (!opened.has(key)) {
      const opening = openStore(target);
      opened.set(key, opening);
      // Also marks a prefetch nobody awaits as handled.
      opening.catch(() => {
        if (opened.get(key) === opening) opened.delete(key);
      });
    }
    return opened.get(key);
  };
}

/**
 * The workspace names one MCP request's tool calls address, read off a copy of
 * its body; `[]` for anything else. Never throws, and never reads a body the
 * transport would not.
 */
export async function namedContextsOf(request) {
  try {
    if (request.method !== "POST") return [];
    const length = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(length) && length > PEEK_BYTE_LIMIT) return [];
    const text = await request.clone().text();
    if (text.length > PEEK_BYTE_LIMIT) return [];
    const body = JSON.parse(text);
    const names = new Set();
    for (const message of Array.isArray(body) ? body : [body]) {
      if (message?.method !== "tools/call") continue;
      const args = message?.params?.arguments;
      for (const key of NAMING_ARGUMENTS) {
        if (typeof args?.[key] === "string" && args[key].trim() !== "") names.add(args[key].trim());
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

/**
 * Start opening each named workspace the session reaches. A name it does not
 * reach, or that is its own, opens nothing here; the call itself refuses or
 * serves it exactly as it would have.
 */
export function prefetchNamedContexts(session, names, openOnce) {
  for (const name of names) {
    let target;
    try {
      target = sessionForContext(session, name);
    } catch {
      continue;
    }
    if (target === session || target.workspaceId === session.workspaceId) continue;
    openOnce(target);
  }
}

/**
 * `child[name]` reads `parent[name]` as it is now, until something sets it on
 * the child, which then keeps its own value (and may delete it again).
 */
function followParent(child, parent, name) {
  Object.defineProperty(child, name, {
    configurable: true,
    enumerable: true,
    get: () => parent[name],
    set: (value) => Object.defineProperty(child, name, { value, writable: true, configurable: true, enumerable: true }),
  });
}

/**
 * Attach `store.openContext` (and the pinned opener and destination
 * suggester that go through it) for this request.
 *
 * A grant covers every context its person is a live member of, so a tool
 * call may name one — and this is the only thing in the worker that acts on
 * that name. It rides on the per-request store for the same reason
 * `store.actor` and the search budget do: the tool layer never sees `env` or
 * the control plane, and everything it hands back dies with the request, so a
 * reused isolate carries no other tenant's credential.
 *
 * Two properties it must keep:
 *
 *  - **A second store, never a second grant.** `sessionForContext` clamps the
 *    grant's scopes and the visibility tier to the caller's role in the
 *    addressed context, and `openStore` (`storeForSession`) spends the same
 *    two-factor proof — the same user token, for a context the control plane
 *    independently agrees they are a member of.
 *  - **No general chaining.** The store it returns has no `openContext` of
 *    its own. The routing dry-run is the single narrow exception: it may
 *    re-clamp at most six caller-supplied candidate names and opens only the
 *    selected destination, solely to append its audit event.
 */
export function attachContextOpener(store, session, { env, controlPlane, origin, openOnce, pinnedName }) {
  const decorated = new Map();
  const decorate = (target, targetStore) => {
    targetStore.searchSubrequestBudget = searchBudgetFor(env);
    // Read through, never copied: the store is held for the rest of the request,
    // and a turn lays its setup's search settings (`agent/route.js`) and holds its
    // index passes (`search/heldPasses.js`) after it may already have opened one.
    followParent(targetStore, store, "searchSettings");
    followParent(targetStore, store, "holdSearchPass");
    attachLinkCalls(targetStore, target, controlPlane, env);
    attachImageUploads(targetStore, target, controlPlane, origin, env);
    targetStore.defer = store.defer;
    // The same binding, keyed later by the *target's* workspace id: a write
    // routed into another context is announced in that context's note room
    // and recorded in its activity, never in the caller's.
    targetStore.presenceRooms = store.presenceRooms;
    // Its tree hint and activity dot go to the context written into: the
    // people watching `@theirs` are the ones whose console must move.
    attachChangeReporters(targetStore, target.workspaceId, controlPlane);
    targetStore.actor = actorFor(target);
    targetStore.contexts = contextsFor(target);
    // The connection's own listing, wherever orient was addressed.
    targetStore.offeredTools = store.offeredTools;
    // Against the context that was routed to, never the connection's own.
    // `targetStore.searchIndex` came from that context's own binding, so the
    // projection and the figure describing it name one workspace.
    targetStore.reportSearchIndexProgress = (progress) =>
      controlPlane.reportSearchIndexProgress({ ...progress, workspaceId: target.workspaceId });
    // Likewise against the context that was routed to. A form answered in
    // somebody else's context tells *their* owner, and a notification filed
    // against the caller's own workspace would resolve `notify: owner` to the
    // wrong person entirely.
    targetStore.reportFormSubmission = (submission) => {
      const send = controlPlane.notifyFormSubmission(target.workspaceId, submission).catch(() => {});
      if (typeof targetStore.defer !== "function") return;
      try {
        targetStore.defer(send);
      } catch {
        // A host whose `waitUntil` refuses the work simply does not report.
      }
    };
    targetStore.suggestDestination = (args) =>
      toolSuggestDestination(target, args, (candidate) => store.openContext(candidate));
    // The one other name an addressed store may open, and only to read the
    // Context.LC-wide note orient shows first. See `orient/globalNote.js`.
    targetStore.openPinnedContext = store.openPinnedContext;
    return { session: target, store: targetStore };
  };

  store.openContext = async (name) => {
    const target = sessionForContext(session, name);
    if (target === session) return { session, store };
    const key = target.workspaceId;
    if (!decorated.has(key)) {
      const opening = openOnce(target).then((targetStore) => decorate(target, targetStore));
      decorated.set(key, opening);
      opening.catch(() => {
        if (decorated.get(key) === opening) decorated.delete(key);
      });
    }
    return await decorated.get(key);
  };
  store.openPinnedContext = () => store.openContext(pinnedName);
  store.suggestDestination = (args) =>
    toolSuggestDestination(session, args, (candidate) => store.openContext(candidate));
}
