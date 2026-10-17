/**
 * The binding → store mapping, and every way it is supposed to refuse.
 *
  * `storeForBinding` is the single table `sessionStore.js` and the control plane's own
 * store-building paths go through, so it is the one place a new backend can be
 * forgotten. These checks are about what happens when a binding and its
 * `provider` do not agree — which is the shape of both a control-plane bug and
 * a rebind that left a stale field behind.
 *
 * Offline and dependency-free: nothing here reaches a network. Building a store
 * is synchronous and constructs no connection, so the assertions are about the
 * adapter that came back and the refusals that did not.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/store/factory.js` and reverted; no flag
 * ships to reproduce them, because a switch that disables a credential check is
 * not something that belongs in a deployable artifact.
 *
 * 1. **A builder's explicit `accessToken` check deleted.** *Zero* checks
 *    failed — which is why that check is not in the file any more. The store
 *    refuses a missing token in its own constructor, so the factory's copy of
 *    the rule could never be the thing that caught anything, and a guard nobody
 *    can break is a guard nobody has checked. What the factory genuinely adds is
 *    turning that raw `Error` into a typed `StorageUnavailable`, so the sabotage
 *    that *does* bite is removing the `try/catch`: **5 checks fail**, four here
 *    and one in the tenancy suite where a 503 becomes an unhandled throw.
 * 2. **The unknown-provider branch falls back to S3**, the way the code read
 *    before this file existed. **5 checks fail**: an unknown provider, an absent
 *    provider, the reason it gives, the prototype-member sweep, and "no provider
 *    is ever silently treated as S3".
 * 3. **`assertNoRefreshToken` deleted.** **9 checks fail**, across all three
 *    providers and including the end-to-end one in the tenancy suite, because a
 *    binding carrying a refresh token then builds a perfectly working store —
 *    exactly the outcome that lets the control-plane bug ship unnoticed.
 * 4. **`assertNoForeignCredential` deleted.** **4 checks fail**, including a
 *    token-only binding that happily carries somebody's S3 secret.
 * 5. **`BUILDERS` as an object literal instead of a `Map`.** **3 checks fail**.
 *    This one is why the prototype checks assert the *reason* rather than that
 *    something was refused: with a literal, `provider: "constructor"` resolves
 *    to `Object.prototype.constructor`, which is truthy, so the binding is
 *    refused a step later for the wrong reason — and a binding carrying no
 *    credential at all reaches `entry.build(…)` with `build` undefined and
 *    crashes. "Refused somehow" was true in both versions.
 * 6. **The factory drops `rootPrefix` on the way to the store.** 6 checks
 *    fail, four of them in the tenancy suite — the customer's folder is not a
 *    detail the store can lose.
 */

import { readFileSync } from "node:fs";
import { storeForBinding, StorageUnavailable, StorageUnsupported } from "../src/store/factory.js";
import { S3Store } from "../src/store/s3.js";
import { R2Store } from "../src/store/r2.js";

/** The copy a customer sees for a retired binding. Pinned here so it cannot drift silently. */
const RETIRED_MESSAGE =
  "This workspace's storage is no longer supported by Context. Move it to a bucket of your own or Context storage.";

/** Obviously fake. This repository is public. */
const S3_BINDING = {
  workspaceId: "ws_example",
  provider: "s3",
  endpoint: "https://s3.example-object-storage.test",
  region: "auto",
  bucket: "example-bucket",
  rootPrefix: "context/",
  accessKeyId: "AKIAEXAMPLEEXAMPLE00",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  forcePathStyle: true,
  capabilities: {
    conditionalWrite: true,
    conditionalCreate: true,
    conditionalDelete: true,
    serverSideCopy: "same-store",
  },
  status: "active",
};

const RETIRED_BINDING = {
  workspaceId: "ws_example",
  provider: "dropbox",
  accessToken: "sl.FAKE-not-a-real-token",
  rootPrefix: "context/",
  capabilities: { conditionalWrite: true, conditionalCreate: true },
  status: "active",
};

const NATIVE_ENV = { NATIVE_BINDINGS: "CONTEXT_BUCKET", CONTEXT_BUCKET: fakeBucket() };

const NATIVE_BINDING = {
  workspaceId: "ws_example",
  provider: "r2-binding",
  bindingName: "CONTEXT_BUCKET",
  capabilities: { conditionalWrite: true, conditionalCreate: true },
  status: "active",
};

/** Build a store, or return the refusal it threw. Never both. */
function attempt(binding, env) {
  try {
    return { store: storeForBinding(binding, env), error: null };
  } catch (error) {
    return { store: null, error };
  }
}

// The production factory returns the logical view: physical stores that can
// CAS-write a content-free tombstone advertise effective conditional delete,
// while server-side copy is deliberately disabled.  Migration/probe callers
// use the rawObjects escape hatch and must still see the provider's probed
// capabilities.  Keep those two contracts explicit in these checks.
function rawAttempt(binding, env) {
  try {
    return { store: storeForBinding(binding, env, { rawObjects: true }), error: null };
  } catch (error) {
    return { store: null, error };
  }
}

function refused(binding, env) {
  const { store, error } = attempt(binding, env);
  return store === null && error instanceof StorageUnavailable;
}

export function runStoreFactoryChecks(check) {
  /* ---------------------------- the happy paths ---------------------------- */

  {
    // That store was removed (notes-by-id, 2026-10-16). A workspace still bound to
    // one is refused whatever it carries, with a typed error the customer can
    // act on, and nothing is built for it.
    const { store, error } = attempt(RETIRED_BINDING);
    check("a retired binding builds no store at all", store === null);
    check("it is refused as STORAGE_UNSUPPORTED", error?.code === "STORAGE_UNSUPPORTED");
    check("with the customer-facing message", error?.message === RETIRED_MESSAGE);
    check(
      "as a StorageUnsupported, which is also a StorageUnavailable for every caller that catches that",
      error instanceof StorageUnsupported && error instanceof StorageUnavailable
    );
  }

  {
    // Unchanged, and asserted rather than assumed: the whole point of a factory
    // is that adding a backend does not disturb the one already carrying
    // traffic.
    const { store } = attempt(S3_BINDING);
    check("an s3 binding still builds an S3Store", store instanceof S3Store);
    check("with the customer's bucket", store?.bucket === "example-bucket");
    check("and its rootPrefix", store?.rootPrefix === "context/");
  }

  {
    for (const provider of ["r2", "b2", "s3-compatible"]) {
      check(
        `the other credentialed providers (${provider}) build an S3Store too`,
        attempt({ ...S3_BINDING, provider }).store instanceof S3Store
      );
    }
  }

  {
    const { store } = attempt(NATIVE_BINDING, NATIVE_ENV);
    check("a native r2 binding still builds an R2Store", store instanceof R2Store);
    check(
      "the operator allowlist still gates it",
      refused({ ...NATIVE_BINDING, bindingName: "SOME_OTHER_BUCKET" }, NATIVE_ENV)
    );
  }

  /* -------------------- the capability the binding was probed for ----------- */

  /*
    Every adapter declares `conditionalWrite: true`, because every adapter sends
    `If-Match`. Whether the *backend* honours it is a different question, and it
    was answered at connect time by `probeStore` against that actual bucket:
    Backblaze B2 and Wasabi accept the header and write anyway. The answer is on
    the binding, and this factory used to drop it — so on those backends the
    gateway believed it had conflict detection it did not have, and said so in
    every meeting ack. "Never silently drop the guarantee", silently dropped.

    The direction matters: the binding may only ever *lower* the claim. A
    control plane that said `true` about an adapter which does not send the
    header could not talk it into pretending.
  */
  for (const [label, binding, env] of [
    ["s3", S3_BINDING, undefined],
    ["a native r2", NATIVE_BINDING, NATIVE_ENV],
  ]) {
    check(
      `a ${label} binding probed as conflict-safe builds a store that says so`,
      attempt(binding, env).store?.capabilities?.conditionalWrite === true
    );
    check(
      `a ${label} binding whose bucket cannot do a conditional write builds a store that says that`,
      attempt({ ...binding, capabilities: { conditionalWrite: false } }, env).store?.capabilities
        ?.conditionalWrite === false
    );
  }
  check(
    "an s3 binding preserves raw conditional-delete probing while the logical view enables CAS tombstones",
    rawAttempt(S3_BINDING).store?.capabilities?.conditionalDelete === true &&
      rawAttempt({ ...S3_BINDING, capabilities: { conditionalWrite: true, conditionalCreate: true } }).store?.capabilities
        ?.conditionalDelete === false &&
      attempt({ ...S3_BINDING, capabilities: { conditionalWrite: true, conditionalCreate: true } }).store?.capabilities
        ?.conditionalDelete === true
  );
  check(
    "an s3 binding only enables conditional create when the probe said create-only writes work",
    attempt(S3_BINDING).store?.capabilities?.conditionalCreate === true &&
      attempt({ ...S3_BINDING, capabilities: { conditionalWrite: true } }).store?.capabilities
        ?.conditionalCreate === false
  );
  check(
    // The logical view's `copy` is the bucket's own for a file that is not a
    // note (a HEAD rules out a deletion marker first) and a read and write
    // for a note, so it says what the raw view proved (move-engine plan, B).
    "an s3 binding's logical view copies server-side exactly where the raw view was proved to",
    rawAttempt(S3_BINDING).store?.capabilities?.serverSideCopy === "same-store" &&
      attempt(S3_BINDING).store?.capabilities?.serverSideCopy === "same-store" &&
      rawAttempt({
        ...S3_BINDING,
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      }).store?.capabilities?.serverSideCopy === false &&
      attempt({
        ...S3_BINDING,
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      }).store?.capabilities?.serverSideCopy === false
  );
  check(
    "an s3 binding reads the boolean server-side-copy probe, on the raw and the logical view",
    // `"same-store"` is the probe's vocabulary and the row holds a boolean
    // (`storageBindings.capabilities.serverSideCopy`). Reading only the string
    // is how the capability was lost: probed since #374, and until the schema
    // carried it every binding on every provider read back `undefined`.
    rawAttempt({
      ...S3_BINDING,
      capabilities: {
        conditionalWrite: true,
        conditionalCreate: true,
        conditionalDelete: true,
        serverSideCopy: true,
      },
    }).store?.capabilities?.serverSideCopy === "same-store" &&
      attempt({
        ...S3_BINDING,
        capabilities: {
          conditionalWrite: true,
          conditionalCreate: true,
          conditionalDelete: true,
          serverSideCopy: true,
        },
      }).store?.capabilities?.serverSideCopy === "same-store"
  );
  check(
    "a binding written before the capability fields existed moves nothing",
    // The production fault `sweepUnprobedCapabilities` repairs. A row from
    // before 2026-09-12 carries `conditionalWrite` and nothing else, and an
    // absent field is not a `false` this gateway may distinguish — so it fails
    // closed and `moveSafetyRefusal` refuses every move, against an R2 bucket
    // that has supported conditional delete the whole time.
    (() => {
      const legacy = attempt({ ...S3_BINDING, capabilities: { conditionalWrite: true } }).store;
      return (
        legacy?.capabilities?.conditionalDelete === false &&
        legacy?.capabilities?.conditionalCreate === false &&
        legacy?.capabilities?.serverSideCopy === false
      );
    })()
  );
  check(
    "a binding with no probed answer at all is treated as not conflict-safe",
    ["capabilitiesMissing", "capabilitiesEmpty", "capabilitiesNotAnObject"].every((shape) => {
      const binding =
        shape === "capabilitiesMissing"
          ? { ...S3_BINDING, capabilities: undefined }
          : shape === "capabilitiesEmpty"
            ? { ...S3_BINDING, capabilities: {} }
            : { ...S3_BINDING, capabilities: "yes" };
      return attempt(binding).store?.capabilities?.conditionalWrite === false;
    })
  );
  check(
    "and the store is otherwise the one it always was",
    attempt({ ...S3_BINDING, capabilities: { conditionalWrite: false } }).store instanceof S3Store
  );

  /* ------------------- a provider that does not match its fields ------------ */

  // Every one of these is refused by the *adapter*; what is asserted is that it
  // arrives as a typed `StorageUnavailable`, because `index.js` catches nothing
  // else and a raw throw is a 500 quoting somebody's configuration.
  // A retired binding is refused as unsupported before its fields are looked at,
  // so no shape of it gets a store, a 401 loop, or a credential check.
  for (const [label, binding] of [
    ["an access token", RETIRED_BINDING],
    ["no access token", { ...RETIRED_BINDING, accessToken: undefined }],
    ["an empty access token", { ...RETIRED_BINDING, accessToken: "" }],
    ["a traversing folder", { ...RETIRED_BINDING, rootPrefix: "../somebody-elses-folder" }],
  ]) {
    check(
      `a retired binding with ${label} is refused as STORAGE_UNSUPPORTED`,
      attempt(binding).error?.code === "STORAGE_UNSUPPORTED"
    );
  }

  // The exact failure this factory exists to prevent: an S3-shaped binding
  // wearing a retired provider used to fall through to the S3 branch, where
  // every field it needs happens to be present, and a retired-bound workspace
  // would have been served out of an S3 bucket.
  check(
    "an s3-shaped binding labelled as a retired provider is refused, not built as S3",
    refused({ ...S3_BINDING, provider: RETIRED_BINDING.provider })
  );
  check(
    "a retired binding labelled s3 is refused",
    refused({ ...RETIRED_BINDING, provider: "s3" })
  );

  // Unchanged behaviour, pinned: this is exactly how it failed before.
  for (const field of ["accessKeyId", "secretAccessKey", "endpoint", "bucket"]) {
    check(
      `an s3 binding missing ${field} is refused exactly as it always was`,
      attempt({ ...S3_BINDING, [field]: undefined }).error?.reason === "malformed binding"
    );
  }

  /* -------------------- no default branch, in either direction -------------- */

  check(
    "a provider this gateway has never heard of is refused",
    refused({ ...S3_BINDING, provider: "gcs" })
  );
  check(
    "a binding with no provider at all is refused",
    refused({ ...S3_BINDING, provider: undefined })
  );
  check(
    "an unknown provider says so, rather than blaming the fields",
    attempt({ ...S3_BINDING, provider: "gcs" }).error?.reason === "unknown provider"
  );
  // `provider` is control-plane data reaching a lookup. An object literal would
  // answer `Object.prototype.constructor` here — a truthy "builder" whose
  // `.build` is undefined, so the binding is refused for the wrong reason if a
  // later check happens to catch it and *crashes* if none does. The reason is
  // asserted rather than the refusal, because "refused somehow" is exactly what
  // the broken version also does.
  for (const provider of ["constructor", "toString", "hasOwnProperty"]) {
    check(
      `a provider naming Object.prototype's ${provider} resolves to no builder at all`,
      attempt({ ...S3_BINDING, provider }).error?.reason === "unknown provider" &&
        attempt({ ...NATIVE_BINDING, provider }, NATIVE_ENV).error?.reason === "unknown provider"
    );
  }
  check(
    "no provider is ever silently treated as S3",
    ["gcs", undefined, null, "", "s3 ", "S3"].every((provider) =>
      refused({ ...S3_BINDING, provider })
    )
  );

  /* --------------------- a credential nobody meant to send ------------------ */

  check(
    "an s3 binding carrying a foreign access token is refused",
    refused({ ...S3_BINDING, accessToken: RETIRED_BINDING.accessToken })
  );
  check(
    "a native binding needs no credential and is refused for carrying one",
    refused({ ...NATIVE_BINDING, secretAccessKey: S3_BINDING.secretAccessKey }, NATIVE_ENV)
  );
  check(
    "a cross-provider credential says so, so the log names the real bug",
    attempt({ ...S3_BINDING, accessToken: RETIRED_BINDING.accessToken }).error?.reason ===
      "cross-provider credential"
  );
  // A field explicitly absent is not a field carried. A control plane that
  // serializes its whole row with nulls is untidy, not compromised.
  check(
    "an explicitly null foreign credential is absence, not a refusal",
    attempt({ ...S3_BINDING, accessToken: null }).store instanceof S3Store
  );

  /* ---------------------- the refresh token never arrives ------------------- */

  // The gateway is handed a short-lived access token and nothing that can mint
  // another. A refresh token in this payload is a control-plane bug, and a
  // binding that quietly works while carrying one is how that bug ships.
  for (const field of [
    "refreshToken",
    "refresh_token",
    "encryptedRefreshToken",
    "providerRefreshToken",
  ]) {
    check(
      `an s3 binding carrying ${field} is refused outright`,
      refused({ ...S3_BINDING, [field]: "rt.FAKE-long-lived" })
    );
  }
  check(
    "the refusal names the refresh token, so nobody has to guess which field",
    attempt({ ...S3_BINDING, refreshToken: "rt.FAKE-long-lived" }).error?.reason ===
      "refresh token in binding"
  );
  check(
    "an s3 binding carrying a refresh token is refused too",
    refused({ ...S3_BINDING, encryptedRefreshToken: "rt.FAKE-long-lived" })
  );
  check(
    "so is a native one, so the rule is not special to one provider",
    refused({ ...NATIVE_BINDING, refreshToken: "rt.FAKE-long-lived" }, NATIVE_ENV)
  );
  // Checked before the provider is even resolved: a refresh token on a binding
  // this gateway would refuse anyway is still a control-plane bug worth naming.
  check(
    "a refresh token is refused ahead of an unknown provider",
    attempt({ ...S3_BINDING, provider: "gcs", refreshToken: "rt.FAKE" }).error?.reason ===
      "refresh token in binding"
  );

  /* ------------------------- refusals stay uninformative -------------------- */

  const refusals = [
    attempt({ ...RETIRED_BINDING, accessToken: undefined }).error,
    attempt({ ...S3_BINDING, provider: RETIRED_BINDING.provider }).error,
    attempt({ ...S3_BINDING, refreshToken: "rt.FAKE-long-lived" }).error,
    attempt({ ...S3_BINDING, accessToken: RETIRED_BINDING.accessToken }).error,
  ]
    .map((error) => `${error?.name}: ${error?.message} ${error?.reason}`)
    .join("\n");
  check(
    "no refusal quotes a credential, a bucket, or a workspace id",
    !refusals.includes("wJalrXUtnFEMI") &&
      !refusals.includes("sl.FAKE") &&
      !refusals.includes("rt.FAKE") &&
      !refusals.includes("example-bucket") &&
      !refusals.includes("ws_example")
  );

  /* ------------------ one table, not a switch per call site ----------------- */

  check(
    "sessionStore.js builds no store of its own; it delegates to the one table",
    (() => {
      const source = readFileSync(new URL("../src/sessionStore.js", import.meta.url), "utf8");
      return (
        // `env` and then, optionally, the per-request options (the note cap,
        // managed-storage encryption), never a hand-built adapter.
        /storeForBinding\(binding, env[,)]/.test(source) &&
        !/new (S3Store|R2Store)\(/.test(source)
      );
    })()
  );
}

/** The smallest thing `nativeStore` accepts as an R2 bucket. */
function fakeBucket() {
  return {
    async get() {
      return null;
    },
    async put() {
      return { etag: "e1" };
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
  };
}
