/**
 * The store for one resolved session: the bridge from a live grant and its
 * workspace's storage binding to the one `ContextStore` every tool reads and
 * writes through.
 *
 * Split out of `session.js`, which decides who is calling. This module decides
 * which bucket that caller's request may reach, and it is the only place in the
 * gateway a storage credential is opened into an adapter. It holds no session
 * state of its own: each call builds a fresh store for one request, which is
 * what keeps a Worker isolate reused across tenants from carrying one tenant's
 * credential into another's request.
 */

import { gatewayTexStore } from "./texStore/wire.js";
import { workspaceClient } from "./workspaceStore/api.js";
import { objectFirstFacts, objectFirstHooks, objectFirstNames, objectFirstSurvey } from "./store/objectLookup.js";
import { objectFirstMail } from "./store/objectMail.js";
import { openedFromObject } from "./store/objectBinding.js";
import { StorageUnavailable, managedEncryptionForStore, storeForBinding } from "./store/factory.js";
import { treeNoteCount } from "./tree/names.js";
import { ControlPlaneError } from "./controlPlane.js";
import { SCOPE_WRITE, TEX_SETUP_CLIENTS, hasScope } from "./session.js";
import { withPrivacyAuthority } from "./store/privacyAuthority.js";
import { objectFirstAddGrantees, objectFirstSetAccess } from "./store/objectAccess.js";
import { attachSearchIndexes } from "./search/storeIndexes.js";

/**
 * Build the storage adapter for one session.
 *
 * This is the only place in the worker that turns a workspace into a bucket,
 * and the only place a storage credential exists. Everything above it works
 * against the `ContextStore` interface and never learns which provider, which
 * bucket, or which prefix it is talking to.
 *
 * What this function owns is the *tenancy* half: a live grant, a workspace both
 * sides agree on, and an active binding. Which backend that binding names, and
 * whether it carries what that backend needs, is `storeForBinding`'s — one
 * table in `store/factory.js` rather than a `provider` check here and another
 * one in every other place a store gets built.
 *
 * Keys are never namespaced. A note is at `1-projects/foo.md` in the customer's
 * own bucket, exactly as their Obsidian sync expects. `rootPrefix` is a
 * customer-chosen convenience applied inside the adapter and invisible above
 * it; it is not tenancy and is never derived from a workspace id.
 */
export async function storeForSession(session, env, controlPlane) {
  try {
    return await openSessionStore(session, env, controlPlane);
  } catch (error) {
    // Every caller answers this with the same reasonless 503, so the reason is said here or nowhere
    // (group Tex on 2026-10-29: every reply in one chat failed and nothing said why). A code, never a key.
    if (error instanceof StorageUnavailable) {
      console.error(JSON.stringify({ event: "storage_unavailable", reason: String(error.reason).replace(/[^A-Za-z0-9:]+/g, "_"), workspace: session?.workspaceId ?? null }));
    }
    throw error;
  }
}

/**
 * The binding and its siblings: from the workspace's object in one call where it may answer (`store/objectBinding.js`),
 * else from the control plane, whose answer is then kept there for the next request. One log line says which.
 */
async function openBinding(session, env, controlPlane, later = () => {}) {
  const started = Date.now();
  let fromObject = { opened: null, reason: "object_failed" };
  try {
    fromObject = await openedFromObject(session, env, controlPlane);
  } catch {
    // Anything unexpected asks the control plane, as before.
  }
  const logged = (source, extra = {}) =>
    console.log(JSON.stringify({ event: "workspace_binding_opened", workspaceId: session.workspaceId, source, reason: fromObject.reason, ms: Date.now() - started, ...(fromObject.wake ? { cold: fromObject.wake.cold, waitedMs: fromObject.wake.waitedMs } : {}), ...extra }));
  // Where it came from, for the entry point's timings (`http/mcpRoute.js`): a source and a short code, never a key.
  const from = { source: fromObject.opened !== null ? "object" : "control_plane", reason: typeof fromObject.reason === "string" && /^[a-z_]{1,32}$/.test(fromObject.reason) ? fromObject.reason : null };
  if (fromObject.opened !== null) {
    logged("object");
    sources.set(fromObject.opened, from);
    // A kept copy past fresh was served; the control plane is asked behind the response, for the next request.
    if (typeof fromObject.refresh === "function") later(refreshBehind(session, controlPlane, fromObject.refresh));
    return fromObject.opened;
  }
  let opened;
  try {
    opened = await controlPlane.getStorageBinding(
      session.accessToken,
      session.workspaceId,
      // Tex's own read of its setup in the pin (`session.js` `sessionForSetup`): asked as that, never as the person.
      ...(session.setupRead === true ? [undefined, { setupRead: true }] : [])
    );
  } catch (error) {
    if (error instanceof ControlPlaneError) throw new StorageUnavailable(`control plane ${error.status ?? error.reason}`);
    throw error;
  }
  const kept = typeof fromObject.keep === "function" ? await fromObject.keep(opened) : null;
  logged("control_plane", kept === null ? {} : { kept: kept.kept, keptReason: kept.reason });
  if (opened && typeof opened === "object") sources.set(opened, from);
  return opened;
}

/** Where each opened binding came from (`openBinding`), read once by the store built from it. */
const sources = new WeakMap();

/** Ask the control plane for the binding and keep it in the object. Never throws: a failed refresh is tried next time. */
async function refreshBehind(session, controlPlane, keep) {
  try {
    // Asked as the store was opened: Tex's setup read as that (`session.js` `sessionForSetup`), never as the person.
    const opened = await controlPlane.getStorageBinding(session.accessToken, session.workspaceId, ...(session.setupRead === true ? [undefined, { setupRead: true }] : []));
    const kept = await keep(opened);
    console.log(JSON.stringify({ event: "workspace_binding_refreshed", workspaceId: session.workspaceId, kept: kept?.kept === true, keptReason: kept?.reason ?? null }));
  } catch {
    console.log(JSON.stringify({ event: "workspace_binding_refreshed", workspaceId: session.workspaceId, kept: false, keptReason: "refresh_failed" }));
  }
}

/**
 * The door to the request's `ctx.waitUntil`, which `http/requestStore.js` fills only after the store opens. Work handed
 * to it before then is held and handed across the moment the door is filled; a host that never fills it leaves the
 * work running unawaited, which is all a refresh behind the response needs.
 */
export function deferDoor() {
  let defer = null;
  const held = [];
  return {
    get defer() {
      return defer;
    },
    set defer(value) {
      defer = typeof value === "function" ? value : null;
      if (defer !== null) for (const work of held.splice(0)) defer(work);
    },
    later(work) {
      if (defer !== null) defer(work);
      else held.push(work);
    },
  };
}

/**
 * The group chat whose Tex notes this session's store may reach: its own chat's key and no other (`store/texRouting.js`).
 * The key is the control plane's, read from the grant under the group client (`session.js` `normalizeSession`), so a
 * person's turn, or another chat's, is built with none.
 */
function texChatsOf(session) {
  return typeof session?.texChatId === "string" && /^[0-9a-f]{64}$/.test(session.texChatId) ? [session.texChatId] : [];
}

/**
 * For a person's own session (an AI client, the app's live typing; never Tex, never a chat's turn): whether a group
 * chat's home is in this workspace, so a note whose row they reached under it opens from that chat's object. Which
 * of those notes they see is each row's access, sealed to the chat's people; this says only where the text is kept.
 */
function texHomeChatOf(session, controlPlane) {
  if (texChatsOf(session).length > 0 || TEX_SETUP_CLIENTS.has(session?.actorClientId)) return null;
  if (typeof controlPlane?.texChatHome !== "function") return null;
  return async (chat) => await controlPlane.texChatHome(session.accessToken, session.workspaceId, chat);
}

async function openSessionStore(session, env, controlPlane) {
  if (!session || typeof session.workspaceId !== "string" || !session.workspaceId) {
    throw new StorageUnavailable("no workspace");
  }
  if (typeof session.accessToken !== "string" || !session.accessToken) {
    // A session that lost its token cannot prove anything to the control plane,
    // and must not be able to fall back to a gateway-secret-only request.
    throw new StorageUnavailable("no proof of authorization");
  }

  // Two things, not one. `/gateway/binding` answers `{binding, searchIndex}`
  // as siblings; reading only the first, and then hunting for the second
  // inside it, is what left fast search dead in production. See
  // `getStorageBinding`.
  // The request's `ctx.waitUntil` is laid on the store only after it opens (`http/requestStore.js`), so the routing
  // layer, and a binding refresh behind the response, are handed a door to it now.
  const behind = deferDoor();
  const opened = await openBinding(session, env, controlPlane, (work) => behind.later(work));
  const { binding, searchIndex, meaningIndex, meaningOn, encryptionKey, rotation, noteCap } = opened;

  if (binding === null) throw new StorageUnavailable("not bound");
  if (!binding || typeof binding !== "object") throw new StorageUnavailable("malformed binding");
  if (binding.status !== "active") throw new StorageUnavailable("not active");

  /**
   * The second half of the two-party check.
   *
   * The control plane resolved the user's token to a grant and derived the
   * workspace from that grant, independently of anything the gateway concluded.
   * If its answer is not the workspace this request resolved to, the two
   * resolutions disagree — and a disagreement about *which tenant this is* is
   * the one bug that must never be papered over. Refuse; do not serve whichever
   * one happens to be in hand.
   *
   * **A missing field is a disagreement too.** This was
   * `typeof binding.workspaceId === "string" && …`, so a control plane that
   * stopped sending it skipped the check rather than failing it. That was
   * defensible while a grant covered one context and the field merely confirmed
   * what the grant had already fixed. Now that one connection covers many, this
   * is the gateway's only local confirmation of *which of them* the store it
   * just built belongs to, and a check an upstream omission can switch off is
   * not a check. `/gateway/binding` sets it on both provider branches;
   * `gatewayIngestBinding` is the email worker's route and never reaches here.
   */
  if (typeof binding.workspaceId !== "string" || binding.workspaceId !== session.workspaceId) {
    throw new StorageUnavailable("workspace mismatch");
  }

  // `privacy.md` decided by the control plane's rules where they are the
  // authority, and every write of it reported there (`store/privacyAuthority.js`).
  const controlAuthority =
    typeof controlPlane.privacyAuthority === "function"
      ? controlPlane.privacyAuthority({ accessToken: session.accessToken }, session.workspaceId, opened.privacy ?? null)
      : null;
  // A tier change, or people added by name or address, in an object-home workspace is decided there first
  // (`store/objectAccess.js`); the control plane's `setAccess` / `addGrantees` is the fallback, and resolves a handle
  // the object has not been told. The actor is this request's own grant.
  const objectAccessOptions = {
    client: workspaceClient(env, session.workspaceId),
    home: binding.notesHome ?? null,
    role: session.role,
    userId: session.actorUserId ?? null,
    clientId: session.actorClientId ?? null,
    canWrite: (session.role === "owner" || session.role === "editor") && hasScope(session, SCOPE_WRITE),
    workspaceId: session.workspaceId,
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  };
  const authority =
    controlAuthority === null || typeof controlAuthority.setAccess !== "function"
      ? controlAuthority
      : {
          ...controlAuthority,
          setAccess: objectFirstSetAccess(controlAuthority.setAccess.bind(controlAuthority), objectAccessOptions),
          ...(typeof controlAuthority.addGrantees === "function"
            ? {
                addGrantees: objectFirstAddGrantees(
                  controlAuthority.addGrantees.bind(controlAuthority),
                  typeof controlAuthority.resolveHandles === "function" ? controlAuthority.resolveHandles.bind(controlAuthority) : null,
                  objectAccessOptions,
                ),
              }
            : {}),
        };
  // The free plan's cap counts the Convex tree's notes, never the bucket
  // (`store/noteCap.js`); asked only when a capped write would add a note.
  const noteCount =
    typeof controlPlane.readTreeFacts === "function"
      ? () => treeNoteCount((request) => controlPlane.readTreeFacts(session.accessToken, session.workspaceId, request))
      : null;
  // Where the workspace's notes are judged in its object, its row questions go there first (`store/objectLookup.js`).
  const controlHooks = idLayoutHooks(opened.idLayout, session, controlPlane);
  // Who reads, as the workspace's object judges them: its row questions and the agent tools' listing go there first.
  const objectReading = {
    client: workspaceClient(env, session.workspaceId),
    home: binding.notesHome ?? null,
    behind: binding.notesBehind === true,
    scope: session.scope,
    names: session.grantedGroups,
    chatNames: session.chatNames ?? null,
    workspaceId: session.workspaceId,
    userId: session.actorUserId ?? null,
    // Whether this request may write notes (the grant's `context:write`, clamped by role): the object's moves are asked
    // only for a caller the control plane would let move (`tools/moves/objectMove.js`).
    canWrite: hasScope(session, SCOPE_WRITE),
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  };
  const hooks = controlHooks === null ? null : objectFirstHooks(controlHooks, objectReading);
  // A keyed workspace's path objects are frozen copies (`notes-by-id.md`): a store
  // without the id layer would serve them as the note. Refused, never served paths.
  if (opened.keyed === true && hooks === null) throw new StorageUnavailable("keyed workspace needs the id layer");
  // Until the request fills the door, a backup write is awaited as before.
  const store = withPrivacyAuthority(
    storeForBinding(binding, env, {
      defer: (work) => {
        if (typeof behind.defer !== "function") return false;
        behind.defer(work);
        return true;
      },
      noteCap,
      noteCount,
      managedEncryption: managedEncryptionForStore(opened, binding),
      idLayout: hooks,
      texStore: gatewayTexStore(env),
      workspaceStore: (workspaceId) => workspaceClient(env, workspaceId),
      texChats: texChatsOf(session),
      texHomeChat: texHomeChatOf(session, controlPlane),
    }),
    authority,
    // Every tool judges a path as this session reads it: with the names the control plane gave it (`READER_NAMES`).
    { names: session.grantedGroups },
  );
  // The backend's name, for the search trace and nothing else. Latency is a
  // property of which backend this is — a native R2 binding and an S3 endpoint
  // reached over HTTP are not the same round trip — so a timing that does not
  // say which one it measured explains nothing. It is a provider name, never a
  // credential and never an endpoint, and no code branches on it: the whole
  // point of `storeForBinding` is that one `provider` check builds the store
  // and nothing above it asks again.
  // For the agent tools' listing (`http/routing.js` `treeManifest`, `store/objectManifest.js`). Non-enumerable: it holds
  // the object's client, which nothing that spreads or logs a store should carry.
  Object.defineProperty(store, "objectReading", { value: objectReading, enumerable: false, writable: false, configurable: true });
  // Where its binding came from (`openBinding`): `{source, reason}`, so a slow open can say why (`http/mcpRoute.js`).
  Object.defineProperty(store, "bindingFrom", { value: sources.get(opened) ?? null, enumerable: false, writable: false, configurable: true });
  store.provider = typeof binding.provider === "string" ? binding.provider : null;
  // Where the bucket's backup writes go behind the response, once the request names it (`http/requestStore.js`).
  Object.defineProperty(store, "backupBehind", { value: behind, enumerable: false, writable: false, configurable: true });
  // Notes' links and props from the object that holds their text, before the control plane (`http/routing.js` `treeFacts`).
  // Its word search from the same object (`search/objectSearch.js`), where the notes live there; `SEARCH_FROM_OBJECT=off`
  // asks the search database as before.
  Object.defineProperty(store, "objectSearch", {
    value: objectReading.home === "object" && env?.SEARCH_FROM_OBJECT !== "off" ? objectReading.client : null,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // And its search by meaning (`search/meaning/objectMeaning.js`); `MEANING_FROM_OBJECT=off` asks Vectorize as before.
  Object.defineProperty(store, "objectMeaning", {
    value: objectReading.home === "object" && env?.MEANING_FROM_OBJECT !== "off" ? objectReading.client : null,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // A writer's "is that name taken?" (`http/routing.js` `treeFacts`), unfiltered and so only where this grant may write.
  Object.defineProperty(store, "objectNames", {
    value: objectFirstNames({ ...objectReading, canWrite: (session.role === "owner" || session.role === "editor") && hasScope(session, SCOPE_WRITE) }),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(store, "objectFacts", {
    value: objectFirstFacts(objectReading),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // Orient's map of this workspace, drawn in its object (`workspaceStore/orientSurvey.js`) where its notes live there.
  Object.defineProperty(store, "objectSurvey", {
    value: objectFirstSurvey(objectReading),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  // A note's mail, read in its object: what is new for a mailbox, and an ask's held wait (`store/objectMail.js`).
  Object.defineProperty(store, "objectMail", {
    value: objectFirstMail(objectReading),
    enumerable: false,
    writable: false,
    configurable: true,
  });

  /**
   * The search projection's coordinates, where this workspace opted in.
   *
   * **Non-enumerable, because it carries a token.** `apiToken` is radioactive
   * on exactly the terms `secretAccessKey` is, and a store is an object other
   * code spreads, logs shapes of, and hands to helpers; enumerable would mean
   * one `{...store}` or one `JSON.stringify` away from a D1 write token in a
   * log line. The credential inside it dies with the request, like the bucket
   * credential in `store` itself.
   *
   * `null` where the descriptor is absent, partial or malformed — all three
   * are the same thing to this gateway, which is "fast search is off here,
   * serve from R2 and project nothing". That is the normal case.
   *
   * It comes off the **response**, beside the binding, and never out of the
   * binding. That is the control plane's shape (`http.ts`), and reading it
   * from the wrong place is not a null that behaves like "off" — it is a null
   * for every context in the product, which is what fast search was until
   * this line changed.
   */
  // And search by meaning's index beside it, on the same terms.
  attachSearchIndexes(store, { searchIndex, meaningIndex, meaningOn }, env?.AI);

  /**
   * The key that opens this context's encrypted notes, for this request only.
   *
   * **Non-enumerable, for exactly the reason `searchIndex` is.** `dataKey`
   * opens every encrypted note in one context; a store is an object other code
   * spreads, logs the shape of, and hands to helpers, and enumerable would mean
   * one `{...store}` or one `JSON.stringify` away from that key in a log line.
   * It dies with the request, like the bucket credential in `store` itself —
   * "never cache a decrypted credential across requests" applies here word for
   * word.
   *
   * `null` where the control plane sent nothing, sent something malformed, or
   * could not open the key it holds. All three are the same thing to this
   * gateway: **this request cannot decrypt.** That is a locked note rather than
   * a missing one, and it is the normal state for every context that has never
   * encrypted anything.
   *
   * It comes off the **response**, beside the binding, never out of it. Reading
   * a sibling from inside the binding is what left fast search dead in
   * production, and the same mistake here would mean no context in the product
   * could ever decrypt.
   */
  Object.defineProperty(store, "encryptionKey", {
    value: readEncryptionKey(encryptionKey),
    enumerable: false,
    writable: false,
    configurable: true,
  });

  /**
   * A workspace-key rotation in progress, or `null`.
   *
   * `null` is the ordinary case — no rotation ever started, or the last one
   * finished — and it is read exactly like `encryptionKey`: off the response,
   * beside the binding, defensively narrowed so a malformed or partial
   * descriptor reads as "no rotation" rather than throwing later. This is
   * enough for `rotate_encryption_keys` to know a walk is outstanding without
   * a second round trip, and enough for every other tool to simply ignore it.
   */
  Object.defineProperty(store, "encryptionRotation", {
    value: readRotation(rotation),
    enumerable: false,
    writable: false,
    configurable: true,
  });

  /**
   * Ask the control plane to start (or continue) a workspace-key rotation, or
   * to report a completed walk — the two optional flags `/gateway/binding`
   * accepts beside the ordinary request, spending the same two proofs this
   * store was already built from rather than a second credential.
   *
   * Bound to this request's own session and control plane so
   * `rotate_encryption_keys` need not be handed either: a tool function only
   * has the store, on purpose, and this is the one operation that needs to
   * reach the control plane a second time within one request.
   *
   * @param {{start?: true, complete?: string}} request exactly one of the two
   * @returns {Promise<{encryptionKey: {current: string, keys: Record<string,string>}|null, rotation: {fromGeneration: string, toGeneration: string}|null}>}
   */
  Object.defineProperty(store, "rotateEncryptionKeys", {
    value: async (request) => {
      const response = await controlPlane.getStorageBinding(
        session.accessToken,
        session.workspaceId,
        request
      );
      return {
        encryptionKey: readEncryptionKey(response.encryptionKey),
        rotation: readRotation(response.rotation),
      };
    },
    enumerable: false,
    writable: false,
    configurable: true,
  });

  /**
   * Move a folder or a note through the control plane as rows (`tools/moves/queuedFolder.js`): the
   * tree draws it at once, and the rows are the truth. Bound to this request's own session.
   */
  Object.defineProperty(store, "startQueuedMove", {
    value: async (from, to, expectedEtag) =>
      await controlPlane.startQueuedMove(session.accessToken, session.workspaceId, from, to, expectedEtag),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  /**
   * Ask the control plane to make several note moves in a keyed workspace,
   * whole or not at all (`tools/moves/queuedFolder.js`). Bound to this
   * request's own session, as `startQueuedMove` is.
   */
  Object.defineProperty(store, "startMoveBatch", {
    value: async (moves) => await controlPlane.startMoveBatch(session.accessToken, session.workspaceId, moves),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  /**
   * Move a note into another workspace through the control plane's engine
   * (`tools/moves/acrossKeyed.js`), from this request's workspace. Bound to
   * this request's own session, as `startQueuedMove` is.
   */
  Object.defineProperty(store, "moveAcross", {
    value: async (destinationWorkspaceId, from, to) =>
      await controlPlane.moveAcross(session.accessToken, session.workspaceId, destinationWorkspaceId, from, to),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(store, "keyedLayout", {
    value: opened.idLayout === "keys",
    enumerable: false,
    writable: false,
    configurable: true,
  });
  /*
    Requests through Context with a vault key added (`vault_list` `fetch`,
    `vault/proxy.js`). Behind a staff switch until 2026-11-08, when the owner
    launched it for everyone and the switch was removed.
  */
  Object.defineProperty(store, "vaultProxy", {
    value: { fetch: (url, init) => fetch(url, init) },
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return store;
}

/**
 * The id layer's hooks for one session (`store/idLayout.js`), bound to its own
 * access token: `null` when the control plane names no layout. The layer needs
 * all four, and a control plane that names "keys" without them is refused.
 */
function idLayoutHooks(layout, session, controlPlane) {
  if (layout !== "keys") return null;
  const methods = ["noteIdLookup", "noteIdWrote", "noteIdAdopt", "noteIdRemoved"];
  if (methods.some((name) => typeof controlPlane[name] !== "function")) {
    throw new StorageUnavailable("the keys layout needs a control plane that adopts notes");
  }
  return {
    lookup: (paths) => controlPlane.noteIdLookup(session.accessToken, session.workspaceId, paths),
    wrote: (record) => controlPlane.noteIdWrote(session.accessToken, session.workspaceId, record),
    adopt: (note) => controlPlane.noteIdAdopt(session.accessToken, session.workspaceId, note),
    removed: (note) => controlPlane.noteIdRemoved(session.accessToken, session.workspaceId, note),
    ...(typeof controlPlane.noteIdResolve === "function"
      ? { resolve: (noteIds) => controlPlane.noteIdResolve(session.accessToken, session.workspaceId, noteIds) }
      : {}),
  };
}

export function storeForOpenedBinding(opened, expectedWorkspaceId, env) {
  const binding = opened?.binding;
  if (binding === null) throw new StorageUnavailable("not bound");
  if (!binding || typeof binding !== "object") throw new StorageUnavailable("malformed binding");
  if (binding.status !== "active") throw new StorageUnavailable("not active");
  if (typeof binding.workspaceId !== "string" || binding.workspaceId !== expectedWorkspaceId) {
    throw new StorageUnavailable("workspace mismatch");
  }

  const store = storeForBinding(binding, env, { managedEncryption: managedEncryptionForStore(opened, binding), texStore: gatewayTexStore(env), workspaceStore: (workspaceId) => workspaceClient(env, workspaceId) });
  store.provider = typeof binding.provider === "string" ? binding.provider : null;
  attachSearchIndexes(store, { searchIndex: opened?.searchIndex, meaningIndex: opened?.meaningIndex, meaningOn: opened?.meaningOn }, env?.AI);
  Object.defineProperty(store, "encryptionKey", {
    value: readEncryptionKey(opened?.encryptionKey),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(store, "encryptionRotation", {
    value: readRotation(opened?.rotation),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return store;
}

/**
 * Narrow the control plane's encryption-key descriptor, or answer `null`.
 *
 * `current` and `keys` or neither, matching how every other partial
 * descriptor in this gateway is treated: half a key is not a degraded key, it
 * is no key, because there is one cure and it is the same one. A `current`
 * that is not a string, an empty one, a `keys` that is not an object, or a
 * `keys` with nothing under `current` are each the whole descriptor being
 * absent — never a shape a later `?.` or bracket lookup would read as present
 * and then fail on.
 */
function readEncryptionKey(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return null;
  const { current, keys } = descriptor;
  if (typeof current !== "string" || current === "") return null;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return null;
  if (typeof keys[current] !== "string" || keys[current] === "") return null;
  return { current, keys };
}

/**
 * Narrow the control plane's rotation descriptor, or answer `null`.
 *
 * Same discipline as `readEncryptionKey`: both fields or neither.
 */
function readRotation(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return null;
  const { fromGeneration, toGeneration } = descriptor;
  if (typeof fromGeneration !== "string" || fromGeneration === "") return null;
  if (typeof toGeneration !== "string" || toGeneration === "") return null;
  return { fromGeneration, toGeneration };
}
