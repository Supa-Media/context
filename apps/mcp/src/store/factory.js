/**
 * The one place a control-plane binding becomes a `ContextStore`.
 *
 * There are three backends now — a native R2 binding for self-hosters, any
 * S3-compatible endpoint signed with the customer's own key, and a folder in
 * somebody's Dropbox — and there will be more. The obvious shape is a
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
 * and is not any more: a Dropbox binding down that path is missing every field
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
 *    and a `DropboxStore` with no token is a 401 loop that reads like an
 *    outage.
 *
 *    Both adapters already refuse that in their own constructors, so what this
 *    file adds is the **conversion**: an adapter throws a plain `Error` whose
 *    message can quote configuration, and `index.js` catches only
 *    `StorageUnavailable`. Without the conversion a binding with no credential
 *    is an unhandled exception — a 500 carrying a message about somebody's
 *    bucket, where a 503 saying "reconnect your storage" belongs. *That* is the
 *    guard here, and it is the one worth sabotaging. A duplicate field check
 *    for Dropbox lived on this line briefly and was removed: it could not be
 *    made to fail on its own, because the adapter always refused first, and a
 *    guard nobody can break is a guard nobody has checked.
 * 2. **No credential the provider does not use may ride along.** A Dropbox
 *    binding carrying `secretAccessKey` means the control plane handed this
 *    Worker a customer's S3 secret it has no use for — extra blast radius for
 *    free — and it is also the signature of a binding row being spread into a
 *    payload wholesale after a rebind, instead of being assembled per provider.
 *    Whoever builds `getBindingForGateway` should select the fields for the
 *    provider rather than spreading the row; this is what says so out loud.
 *
 * ## The refresh token must never arrive here
 *
 * Dropbox's long-lived credential is the refresh token: it mints access tokens
 * for as long as the customer leaves the connection in place. The control plane
 * refreshes and hands the gateway a **short-lived access token only**, for the
 * same reason no decrypted credential is cached across requests — a gateway
 * compromise then yields minutes of one workspace's storage rather than the
 * ability to mint tokens for it forever.
 *
 * That is a property of the control plane, so this file cannot enforce it. What
 * it can do is refuse to be the place the mistake goes unnoticed: any field
 * whose name mentions a refresh token fails the whole binding, loudly, rather
 * than being quietly ignored on the way to a store that works. A binding that
 * works while carrying a credential nobody meant to send is how that bug
 * survives to production.
 */

import { R2Store } from "./r2.js";
import { S3Store } from "./s3.js";
import { DropboxStore } from "./dropbox.js";

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
 * Credential fields, by the provider that consumes them.
 *
 * A native R2 binding is deliberately empty: it names a bucket the operator
 * already allowlisted on this Worker, so any credential on it is one nobody
 * asked for.
 */
const CREDENTIAL_FIELDS = {
  "r2-binding": [],
  dropbox: ["accessToken"],
  credentialed: ["accessKeyId", "secretAccessKey"],
};

/** Every credential field any provider uses, so a foreign one is recognisable. */
const ALL_CREDENTIAL_FIELDS = new Set(Object.values(CREDENTIAL_FIELDS).flat());

/**
 * A `Map` rather than an object literal, so `provider: "constructor"` resolves
 * to nothing instead of to `Object.prototype.constructor`.
 */
const BUILDERS = new Map([
  ["r2-binding", { kind: "r2-binding", build: nativeStore }],
  ["dropbox", { kind: "dropbox", build: dropboxStore }],
  ["s3", { kind: "credentialed", build: credentialedStore }],
  ["r2", { kind: "credentialed", build: credentialedStore }],
  ["b2", { kind: "credentialed", build: credentialedStore }],
  ["s3-compatible", { kind: "credentialed", build: credentialedStore }],
]);

/**
 * Turn one control-plane binding into the store that serves one request.
 *
 * @param {object} binding the binding exactly as the control plane returned it
 * @param {object} env the Worker environment, for a native R2 binding only
 * @returns {import("./index.js").ContextStore}
 * @throws {StorageUnavailable} for anything this gateway will not build
 */
export function storeForBinding(binding, env) {
  if (!binding || typeof binding !== "object") throw new StorageUnavailable("malformed binding");

  assertNoRefreshToken(binding);

  const entry = BUILDERS.get(binding.provider);
  // No default branch, on purpose — see the header.
  if (!entry) throw new StorageUnavailable("unknown provider");

  assertNoForeignCredential(binding, entry.kind);
  return entry.build(binding, env);
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
function credentialedStore(binding) {
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
      endpoint,
      region: typeof region === "string" && region ? region : "auto",
      bucket,
      accessKeyId,
      secretAccessKey,
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

/**
 * A folder in the customer's Dropbox — the one-click tier.
 *
 * There is no endpoint, no region, no bucket and no key pair: a Dropbox binding
 * is an access token and the folder the customer chose, and that folder is the
 * `rootPrefix` every other backend already has rather than a second field
 * meaning the same thing.
 *
 * The token is short-lived by construction and arrives already refreshed. This
 * adapter has no way to renew one and deliberately does not get given the means
 * to — see the header.
 */
function dropboxStore(binding) {
  try {
    return new DropboxStore({
      accessToken: binding.accessToken,
      rootPrefix: binding.rootPrefix,
    });
  } catch {
    // The adapter refuses a missing or non-string token, and
    // `normalizeRootPrefix` refuses a traversing folder name. Both messages can
    // quote configuration, so both are dropped and become the one typed refusal
    // `index.js` answers with a 503 — never relayed, and never an unhandled
    // throw. Same treatment as the S3 path.
    throw new StorageUnavailable("malformed binding");
  }
}
