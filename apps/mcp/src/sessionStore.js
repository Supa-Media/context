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

import { StorageUnavailable, managedEncryptionForStore, storeForBinding } from "./store/factory.js";
import { ControlPlaneError } from "./controlPlane.js";
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
  let opened;
  try {
    opened = await controlPlane.getStorageBinding(
      session.accessToken,
      session.workspaceId
    );
  } catch (error) {
    if (error instanceof ControlPlaneError) throw new StorageUnavailable("control plane");
    throw error;
  }
  const { binding, searchIndex, meaningIndex, encryptionKey, rotation, noteCap } = opened;

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

  const store = storeForBinding(binding, env, { noteCap, managedEncryption: managedEncryptionForStore(opened, binding) });
  // The backend's name, for the search trace and nothing else. Latency is a
  // property of which backend this is — a native R2 binding and an S3 endpoint
  // reached over HTTP are not the same round trip — so a timing that does not
  // say which one it measured explains nothing. It is a provider name, never a
  // credential and never an endpoint, and no code branches on it: the whole
  // point of `storeForBinding` is that one `provider` check builds the store
  // and nothing above it asks again.
  store.provider = typeof binding.provider === "string" ? binding.provider : null;

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
  attachSearchIndexes(store, { searchIndex, meaningIndex }, env?.AI);

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
  return store;
}

export function storeForOpenedBinding(opened, expectedWorkspaceId, env) {
  const binding = opened?.binding;
  if (binding === null) throw new StorageUnavailable("not bound");
  if (!binding || typeof binding !== "object") throw new StorageUnavailable("malformed binding");
  if (binding.status !== "active") throw new StorageUnavailable("not active");
  if (typeof binding.workspaceId !== "string" || binding.workspaceId !== expectedWorkspaceId) {
    throw new StorageUnavailable("workspace mismatch");
  }

  const store = storeForBinding(binding, env, { managedEncryption: managedEncryptionForStore(opened, binding) });
  store.provider = typeof binding.provider === "string" ? binding.provider : null;
  attachSearchIndexes(store, { searchIndex: opened?.searchIndex, meaningIndex: opened?.meaningIndex }, env?.AI);
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
