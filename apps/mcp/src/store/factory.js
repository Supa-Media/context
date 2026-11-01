/**
 * The one place a control-plane binding becomes a `ContextStore`.
 *
 * There are two backends now — a native R2 binding for self-hosters, and any
 * S3-compatible endpoint signed with the customer's own key — and there will
 * be more. A binding for a store that has since been retired is refused by name
 * now (`StorageUnsupported`), see below. The obvious shape is a
 * `provider` check wherever a store gets built: once in `session.js` for a live
 * request, once in the control plane's provisioning path, once in its file
 * path. Three switches over one union is three places to forget the fourth
 * backend, and the direction that forgetting fails is "fell through to the S3
 * branch and tried to sign a request with credentials that are not there".
 *
 * So the mapping lives here, once, as a table.
 *
 * ## The table is exhaustive, and there is no default branch
 *
 * `storeForSession` used to read `provider === "r2-binding" ? native :
 * credentialed`, which made **S3 the fallback for everything else** — including
 * a provider this deployment has never heard of, and including a binding with
 * no `provider` at all. That was harmless while S3 was the only other backend
 * and is not any more: a retired binding down that path is missing every field
 * S3 needs, and a *future* provider down that path is a store built out of
 * whatever happened to be present.
 *
 * An unrecognised provider is therefore a refusal. A gateway that has not been
 * deployed since a provider was added does not get to guess what it is; it says
 * so, and the customer sees "reconnect your storage" rather than a bucket error
 * about a bucket that was never involved.
 *
 * ## A binding carries what its provider needs, and nothing else
 *
 * Two rules, both applying to every provider rather than living inside one
 * adapter, and both fail closed:
 *
 * 1. **Every field the provider needs must be present**, or the binding is
 *    refused before a store exists. Never half-built: an `S3Store` with an
 *    empty `accessKeyId` signs a request that 403s on somebody else's bucket,
 *    and a store built with no token is a 401 loop that reads like an
 *    outage.
 *
 *    Both adapters already refuse that in their own constructors, so what this
 *    file adds is the **conversion**: an adapter throws a plain `Error` whose
 *    message can quote configuration, and `index.js` catches only
 *    `StorageUnavailable`. Without the conversion a binding with no credential
 *    is an unhandled exception — a 500 carrying a message about somebody's
 *    bucket, where a 503 saying "reconnect your storage" belongs. *That* is the
 *    guard here, and it is the one worth sabotaging. A duplicate field check
 *    lived on this line briefly and was removed: it could not be
 *    made to fail on its own, because the adapter always refused first, and a
 *    guard nobody can break is a guard nobody has checked.
 * 2. **No credential the provider does not use may ride along.** An S3 binding
 *    carrying another provider's credential (or the reverse) means the control plane
 *    handed this Worker a credential it has no use for — extra blast radius for
 *    free — and it is also the signature of a binding row being spread into a
 *    payload wholesale after a rebind, instead of being assembled per provider.
 *    Whoever builds `getBindingForGateway` should select the fields for the
 *    provider rather than spreading the row; this is what says so out loud.
 *
 * ## A refresh token must never arrive here
 *
 * A long-lived refresh token mints access tokens for as long as the customer
 * leaves a connection in place. The control plane must never hand one to the
 * gateway. That is a property of the control plane, so this file cannot enforce
 * it. What it can do is refuse to be the place the mistake goes unnoticed: any
 * field whose name mentions a refresh token fails the whole binding, loudly,
 * rather than being quietly ignored on the way to a store that works.
 *
 * ## A retired binding is refused by name
 *
 * A retired store is no longer served (notes-by-id, 2026-10-15). A workspace still
 * bound to one is not a bucket error and not an unknown provider: it gets
 * `StorageUnsupported`, code `STORAGE_UNSUPPORTED`, whatever fields it carries.
 * That check runs before the table, so no field of a retired binding is looked at.
 */

import { R2Store } from "./r2.js";
import { S3Store } from "./s3.js";
import { withLogicalDelete } from "./logicalDelete.js";
import { withIdLayout } from "./idLayout.js";
import { withTexRouting } from "./texRouting.js";
import { withWorkspaceRouting } from "./workspaceRouting.js";
import { withNoteCap } from "./noteCap.js";
import { managedEncryptionFor, withManagedEncryption } from "./managedEncryption.js";

/**
 * The gateway could not reach a usable bucket for an otherwise valid session.
 *
 * Distinct from an auth failure because it is a different fact about a
 * different subject: the *caller* is fine, the *workspace* has no working
 * storage. Telling them apart is not an oracle — a caller learns only about
 * their own grant and their own workspace, never about anyone else's.
 *
 * `reason` is for this gateway's own structured logs. It never reaches a
 * caller: `index.js` answers every one of these with the same 503.
 */
export class StorageUnavailable extends Error {
  constructor(reason) {
    super(`storage unavailable: ${reason}`);
    this.name = "StorageUnavailable";
    this.reason = reason;
  }
}

/**
 * A binding for a store this gateway no longer serves, removed
 * 2026-10-16. Distinct from `StorageUnavailable` in its code and message, so the
 * customer is told what to do rather than to reconnect. It is still a
 * `StorageUnavailable`, so every caller that already catches that catches this.
 */
export class StorageUnsupported extends StorageUnavailable {
  constructor(reason) {
    super(reason);
    this.name = "StorageUnsupported";
    this.code = "STORAGE_UNSUPPORTED";
    this.message =
      "This workspace's storage is no longer supported by Context. Move it to a bucket of your own or Context storage.";
  }
}

/**
 * Credential fields, by the provider that consumes them.
 *
 * A native R2 binding is deliberately empty: it names a bucket the operator
 * already allowlisted on this Worker, so any credential on it is one nobody
 * asked for.
 */
const CREDENTIAL_FIELDS = {
  "r2-binding": [],
  credentialed: ["accessKeyId", "secretAccessKey", "sessionToken"],
};

/**
 * Every credential field any provider uses, so a foreign one is recognisable.
 * `accessToken` is a credential no provider uses any more. It stays on this
 * list so a binding still carrying one is refused as a foreign credential, not
 * built: `legacy: stored rows only; no store takes it (notes-by-id)`.
 */
const ALL_CREDENTIAL_FIELDS = new Set([...Object.values(CREDENTIAL_FIELDS).flat(), "accessToken"]);

/**
 * A `Map` rather than an object literal, so `provider: "constructor"` resolves
 * to nothing instead of to `Object.prototype.constructor`.
 */
const BUILDERS = new Map([
  ["r2-binding", { kind: "r2-binding", build: nativeStore }],
  ["s3", { kind: "credentialed", build: credentialedStore }],
  ["r2", { kind: "credentialed", build: credentialedStore }],
  ["b2", { kind: "credentialed", build: credentialedStore }],
  ["s3-compatible", { kind: "credentialed", build: credentialedStore }],
]);

/**
 * Turn one control-plane binding into the store that serves one request.
 *
 * @param {object} binding the binding exactly as the control plane returned it
 * @param {object} [env] the Worker environment, for a native R2 binding only
 * @param {{texStore?: ((owner: string) => unknown)|null, texWorkspaceId?: string, texChats?: string[], fetchImpl?: typeof fetch, probeCapabilities?: boolean, rawObjects?: boolean, sealedObjects?: boolean, noteCap?: number|null, noteCount?: (() => Promise<number|null>)|null, idLayout?: object|null, managedEncryption?: {workspaceId: string, mode: "migrating"|"encrypted"|"decrypting", current: string, keys: Record<string,string>}|null}} [options] forwarded to the adapter. The
 *   control plane builds stores from this same table — for the connect probe
 *   and the console file browser — and needs a `fetch` with a timeout on it.
 *   A second switch there would be the third place to forget a new backend,
 *   which is the thing this file exists to prevent.
 * @returns {import("./index.js").ContextStore}
 * @throws {StorageUnavailable} for anything this gateway will not build
 */
export function storeForBinding(binding, env, options = {}) {
  if (!binding || typeof binding !== "object") throw new StorageUnavailable("malformed binding");

  // Before anything else: a retired binding is refused whatever it carries.
  if (binding.provider === "dropbox") throw new StorageUnsupported("retired provider");

  assertNoRefreshToken(binding);

  const entry = BUILDERS.get(binding.provider);
  // No default branch, on purpose — see the header.
  if (!entry) throw new StorageUnavailable("unknown provider");

  assertNoForeignCredential(binding, entry.kind);
  const store = entry.build(binding, env, options);
  // Verification must observe what the provider actually enforces. Applying
  // yesterday's persisted result first would make a false capability
  // impossible to discover as true on reconnect.
  // Encryption first, because a caller that skips the probed capabilities may
  // still be writing note surface: the scaffolder builds its store this way,
  // and a plain object it wrote into a sealed bucket is refused on every read
  // that follows. Absent for every bucket a customer owns, and absent on the
  // probe itself, which writes and removes its own object with this store.
  // The scaffolder writes a new workspace's first notes through this branch,
  // so it crosses the id layer too when its builder passes one.
  if (options.probeCapabilities === true) return withNoteLayout(withEncryption(store, options.managedEncryption), options.idLayout);
  // The managed-encryption walk's view: probed capabilities, and bytes exactly
  // as stored, sealed or not. Only the walk asks for this; it must see which
  // objects are still plain (`managedEncryptionWalk.js`).
  if (options.sealedObjects === true) return withProbedCapabilities(store, binding);
  // Managed-storage encryption sits directly on the adapter, so every caller
  // above — the logical-delete view, the note cap, a hand-off copy reading
  // `rawObjects` — sees plain bytes and nothing above can write around it.
  // `managedEncryption.js`; absent for every bucket a customer owns.
  const probed = withEncryption(withProbedCapabilities(store, binding), options.managedEncryption);
  // Managed storage-layout migration explicitly needs the hidden marker
  // objects themselves. Ordinary gateway callers always receive the logical
  // view, so this escape hatch is intentionally opt-in.
  if (options.rawObjects === true) return probed;
  // The free managed tier's note cap, outermost so every write a caller makes
  // crosses it — `noteCap.js`. Absent for every other context. The two
  // escape hatches above never see it: a connect probe writes no notes, and a
  // storage-layout migration only moves what is already there.
  // Counted from the Convex tree by whoever built the store (`noteCount`).
  // The id layer (`idLayout.js`) sits inside the cap, so the cap still sees
  // the path a person wrote and counts it, and the keys the layer writes
  // underneath are never mistaken for notes of their own.
  // Tex's notes (`texRouting.js`): a row's key of the Tex form goes to its
  // Durable Object, under the id layer so every holder of a row's key reaches
  // it, and refused when `options.texStore` cannot open one.
  const texRouted = withTexRouting(withLogicalDelete(probed), { workspaceId: options.texWorkspaceId ?? binding.workspaceId, chats: options.texChats ?? [], texStore: options.texStore ?? null });
  // Note texts and shared-editing history, to the workspace's object by its home (`workspaceRouting.js`). Only when
  // the caller passed `workspaceStore`: a caller that must see the bucket alone (the copy and compare) leaves it out.
  const routed = typeof options.workspaceStore === "function"
    ? withWorkspaceRouting(texRouted, {
        workspaceId: binding.workspaceId,
        client: options.workspaceStore(binding.workspaceId),
        known: { home: binding.notesHome, backfilledAt: binding.notesBackfilledAt ?? null },
        defer: options.defer ?? null,
        log: options.log ?? (() => {}),
      })
    : texRouted;
  return withNoteCap(withNoteLayout(routed, options.idLayout), options.noteCap, options.noteCount ?? null);
}

/**
 * The id layer, when whoever built the store passed its hooks (`idLayout.js`):
 * a session's store and the console's, bound to that request's grant. Absent,
 * the store reads and writes paths, as every store did before ids.
 */
function withNoteLayout(store, hooks) {
  if (hooks === null || hooks === undefined) return store;
  return withIdLayout(store, hooks);
}

/**
 * The `managedEncryption` option for a store built from an opened binding:
 * absent for plain, and a refusal of the whole store (`StorageUnavailable`)
 * for a mode that arrived without a usable key.
 */
export function managedEncryptionForStore(opened, binding) {
  return managedEncryptionFor(opened, binding.workspaceId, (why) => new StorageUnavailable(why));
}

function withEncryption(store, config) {
  if (config === null || config === undefined) return store;
  return withManagedEncryption(store, config);
}

/**
 * The capability the *bucket* was probed for, applied to the store built for it.
 *
 * Every adapter declares `conditionalWrite: true`, because every adapter sends
 * `If-Match`. That is a statement about the adapter, not about the backend:
 * Backblaze B2 and Wasabi accept the header and write anyway, which is why the
 * capability is probed at connect time (`probeStore`) and recorded on the
 * binding (`summarizeProbe` takes it from what the probe *observed*, never from
 * what the adapter claimed).
 *
 * This file dropped that answer on the floor. Every store it built claimed
 * conflict safety, so on a B2 or Wasabi binding a conditional write was sent,
 * ignored, and reported as honoured — `writeSession` guarded a read that was
 * not guarded, and every meeting ack told a client `conflictSafe: true` about a
 * bucket that is last-writer-wins. CLAUDE.md's "probe capability at connect time
 * and degrade honestly — never silently drop it" was being silently dropped at
 * the one line where the two halves meet. The console's file browser already
 * applied it by hand after calling this function, which is the second copy of a
 * rule that belongs here once.
 *
 * **It only ever lowers.** A binding claiming `true` cannot talk an adapter that
 * does not send the header into pretending it does, and a binding carrying no
 * probed answer at all — an older control plane, a hand-built row — is treated
 * as "not proven", which is the direction that costs a retry rather than a
 * silently lost write.
 */
function withProbedCapabilities(store, binding) {
  const declaredWrite = store?.capabilities?.conditionalWrite === true;
  const probedWrite = binding.capabilities?.conditionalWrite === true;
  const declaredCreate = store?.capabilities?.conditionalCreate === true;
  const probedCreate = binding.capabilities?.conditionalCreate === true;
  const declaredDelete = store?.capabilities?.conditionalDelete === true;
  const probedDelete = binding.capabilities?.conditionalDelete === true;
  const declaredCopy = store?.capabilities?.serverSideCopy === "same-store";
  // `"same-store"` is the *probe's* vocabulary; the control plane stores a
  // boolean (`capabilities.serverSideCopy`), because nothing yet distinguishes
  // a second kind of copy. Accept both, or a row written by a control plane
  // that speaks either one silently loses the capability — which is how this
  // was found: the field was probed, never persisted, and read back as
  // `undefined` for every binding on every provider since #374.
  const probedCopy =
    binding.capabilities?.serverSideCopy === "same-store" ||
    binding.capabilities?.serverSideCopy === true;
  store.capabilities = {
    ...store.capabilities,
    conditionalWrite: declaredWrite && probedWrite,
    conditionalCreate: declaredCreate && probedCreate,
    conditionalDelete: declaredDelete && probedDelete,
    serverSideCopy: declaredCopy && probedCopy && probedCreate ? "same-store" : false,
  };
  return store;
}

/**
 * Anything refresh-token-shaped is a control-plane bug, not an unused field.
 *
 * Matched on the field *name* rather than an enumerated list, because the
 * enumeration is the thing that goes stale: `encryptedRefreshToken` today,
 * `refresh_token` from a different serializer tomorrow. No binding field this
 * gateway consumes has "refresh" in its name, so the match has nothing to
 * collide with.
 */
function assertNoRefreshToken(binding) {
  for (const field of Object.keys(binding)) {
    if (/refresh/i.test(field)) throw new StorageUnavailable("refresh token in binding");
  }
}

/** A credential the named provider cannot use is one nobody meant to send. */
function assertNoForeignCredential(binding, kind) {
  const mine = new Set(CREDENTIAL_FIELDS[kind]);
  for (const field of Object.keys(binding)) {
    if (!ALL_CREDENTIAL_FIELDS.has(field) || mine.has(field)) continue;
    if (binding[field] === null || binding[field] === undefined) continue;
    throw new StorageUnavailable("cross-provider credential");
  }
}

/**
 * A native Cloudflare R2 binding, for self-hosters.
 *
 * The product deployment does not use this: its tenants bring their own
 * buckets, reached over the S3 API with credentials the customer can revoke
 * without asking us. A self-hosted gateway serving its owner's single bucket
 * has no such credential to hand out, and binding R2 natively is both simpler
 * and safer for them.
 *
 * Two locks, because this is the one code path where a control-plane answer
 * names something inside *our* Worker rather than something inside the
 * customer's account:
 *
 * 1. The binding name must appear in `env.NATIVE_BINDINGS`, a comma-separated
 *    allowlist set by whoever deployed the Worker. A control plane that is
 *    compromised, confused, or simply pointed at the wrong row cannot name a
 *    binding the operator never listed.
 * 2. It must actually exist on `env` and look like a bucket.
 *
 * Without the allowlist, "return `{provider:'r2-binding', bindingName:'X'}`"
 * would be a way to reach any R2 bucket the Worker can see, from the control
 * plane, for any tenant.
 */
function nativeStore(binding, env) {
  const name = binding.bindingName;
  if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new StorageUnavailable("malformed binding");
  }
  const allowed = String(env?.NATIVE_BINDINGS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!allowed.includes(name)) throw new StorageUnavailable("binding not allowed");
  const bucket = env?.[name];
  if (!bucket || typeof bucket.get !== "function" || typeof bucket.put !== "function") {
    throw new StorageUnavailable("binding missing");
  }
  return new R2Store(bucket, { rootPrefix: binding.rootPrefix });
}

/**
 * Any S3-compatible endpoint, signed with the customer's own credential.
 *
 * Moved here verbatim, field checks included. They duplicate `S3Store`'s own
 * constructor validation and are kept because this is the shape a binding has
 * been refused in since the gateway grew tenants — but the load-bearing line is
 * the `catch`, for the reason in the header.
 */
function credentialedStore(binding, _env, options = {}) {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey } = binding;
  if (
    typeof endpoint !== "string" ||
    typeof bucket !== "string" ||
    typeof accessKeyId !== "string" ||
    typeof secretAccessKey !== "string" ||
    !endpoint ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey
  ) {
    throw new StorageUnavailable("malformed binding");
  }
  try {
    return new S3Store({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      endpoint,
      region: typeof region === "string" && region ? region : "auto",
      bucket,
      accessKeyId,
      secretAccessKey,
      // A temporary R2 credential's third part; see `S3Store`.
      ...(typeof binding.sessionToken === "string" && binding.sessionToken ? { sessionToken: binding.sessionToken } : {}),
      rootPrefix: binding.rootPrefix,
      forcePathStyle: binding.forcePathStyle,
    });
  } catch {
    // The adapter's own validation (ambiguous addressing style, unsafe root
    // prefix, bad bucket name) failed. Its message can quote configuration, so
    // it is dropped rather than relayed.
    throw new StorageUnavailable("malformed binding");
  }
}
