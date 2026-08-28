/**
 * The binding → store mapping, and every way it is supposed to refuse.
 *
 * `storeForBinding` is the single table `session.js` and the control plane's own
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
 * 1. **`dropboxStore`'s explicit `accessToken` check deleted.** *Zero* checks
 *    failed — which is why that check is not in the file any more. `DropboxStore`
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
 *    Dropbox binding that happily carries somebody's S3 secret.
 * 5. **`BUILDERS` as an object literal instead of a `Map`.** **3 checks fail**.
 *    This one is why the prototype checks assert the *reason* rather than that
 *    something was refused: with a literal, `provider: "constructor"` resolves
 *    to `Object.prototype.constructor`, which is truthy, so the binding is
 *    refused a step later for the wrong reason — and a binding carrying no
 *    credential at all reaches `entry.build(…)` with `build` undefined and
 *    crashes. "Refused somehow" was true in both versions.
 * 6. **The factory drops `rootPrefix` on the way to `DropboxStore`.** 6 checks
 *    fail, four of them in the tenancy suite — the customer's folder is not a
 *    detail the store can lose.
 */

import { readFileSync } from "node:fs";
import { storeForBinding, StorageUnavailable } from "../src/store/factory.js";
import { S3Store } from "../src/store/s3.js";
import { R2Store } from "../src/store/r2.js";
import { DropboxStore } from "../src/store/dropbox.js";

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
  capabilities: { conditionalWrite: true },
  status: "active",
};

const DROPBOX_BINDING = {
  workspaceId: "ws_example",
  provider: "dropbox",
  accessToken: "sl.FAKE-not-a-real-token",
  rootPrefix: "context/",
  capabilities: { conditionalWrite: true },
  status: "active",
};

const NATIVE_ENV = { NATIVE_BINDINGS: "CONTEXT_BUCKET", CONTEXT_BUCKET: fakeBucket() };

const NATIVE_BINDING = {
  workspaceId: "ws_example",
  provider: "r2-binding",
  bindingName: "CONTEXT_BUCKET",
  capabilities: { conditionalWrite: true },
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

function refused(binding, env) {
  const { store, error } = attempt(binding, env);
  return store === null && error instanceof StorageUnavailable;
}

export function runStoreFactoryChecks(check) {
  /* ---------------------------- the happy paths ---------------------------- */

  {
    const { store } = attempt(DROPBOX_BINDING);
    check("a dropbox binding builds a DropboxStore", store instanceof DropboxStore);
    check(
      "the customer's folder becomes the rootPrefix, normalised",
      store?.rootPrefix === "context/"
    );
    check(
      "and the short-lived access token is the only credential it holds",
      store?.accessToken === DROPBOX_BINDING.accessToken
    );
    check(
      "a dropbox store still claims conditional writes, so the probe can test them",
      store?.capabilities?.conditionalWrite === true
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

  /* ------------------- a provider that does not match its fields ------------ */

  // Every one of these is refused by the *adapter*; what is asserted is that it
  // arrives as a typed `StorageUnavailable`, because `index.js` catches nothing
  // else and a raw throw is a 500 quoting somebody's configuration.
  for (const [label, accessToken] of [
    ["no access token", undefined],
    ["an empty access token", ""],
    ["an access token that is not a string", 12345],
  ]) {
    check(
      `a dropbox binding with ${label} is refused, as StorageUnavailable`,
      refused({ ...DROPBOX_BINDING, accessToken })
    );
  }
  check(
    "a dropbox binding whose folder traverses is refused, not normalised",
    refused({ ...DROPBOX_BINDING, rootPrefix: "../somebody-elses-folder" })
  );

  // The exact failure this factory exists to prevent: an S3-shaped binding
  // wearing a dropbox provider used to fall through to the S3 branch, where
  // every field it needs happens to be present, and a Dropbox-bound workspace
  // would have been served out of an S3 bucket.
  check(
    "an s3-shaped binding labelled dropbox is refused, not built as S3",
    refused({ ...S3_BINDING, provider: "dropbox" })
  );
  check(
    "a dropbox-shaped binding labelled s3 is refused",
    refused({ ...DROPBOX_BINDING, provider: "s3" })
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
    ["gcs", undefined, null, "", "dropbox ", "S3"].every((provider) =>
      refused({ ...S3_BINDING, provider })
    )
  );

  /* --------------------- a credential nobody meant to send ------------------ */

  check(
    "a dropbox binding carrying an S3 secret is refused",
    refused({ ...DROPBOX_BINDING, secretAccessKey: S3_BINDING.secretAccessKey })
  );
  check(
    "an s3 binding carrying a dropbox access token is refused",
    refused({ ...S3_BINDING, accessToken: DROPBOX_BINDING.accessToken })
  );
  check(
    "a native binding needs no credential and is refused for carrying one",
    refused({ ...NATIVE_BINDING, secretAccessKey: S3_BINDING.secretAccessKey }, NATIVE_ENV)
  );
  check(
    "a cross-provider credential says so, so the log names the real bug",
    attempt({ ...DROPBOX_BINDING, secretAccessKey: S3_BINDING.secretAccessKey }).error?.reason ===
      "cross-provider credential"
  );
  // A field explicitly absent is not a field carried. A control plane that
  // serializes its whole row with nulls is untidy, not compromised.
  check(
    "an explicitly null foreign credential is absence, not a refusal",
    attempt({ ...DROPBOX_BINDING, secretAccessKey: null, accessKeyId: null }).store instanceof
      DropboxStore
  );

  /* ---------------------- the refresh token never arrives ------------------- */

  // The gateway is handed a short-lived access token and nothing that can mint
  // another. A refresh token in this payload is a control-plane bug, and a
  // binding that quietly works while carrying one is how that bug ships.
  for (const field of [
    "refreshToken",
    "refresh_token",
    "encryptedRefreshToken",
    "dropboxRefreshToken",
  ]) {
    check(
      `a dropbox binding carrying ${field} is refused outright`,
      refused({ ...DROPBOX_BINDING, [field]: "rt.FAKE-long-lived" })
    );
  }
  check(
    "the refusal names the refresh token, so nobody has to guess which field",
    attempt({ ...DROPBOX_BINDING, refreshToken: "rt.FAKE-long-lived" }).error?.reason ===
      "refresh token in binding"
  );
  check(
    "an s3 binding carrying a refresh token is refused too",
    refused({ ...S3_BINDING, encryptedRefreshToken: "rt.FAKE-long-lived" })
  );
  check(
    "so is a native one, so the rule is not a dropbox special case",
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
    attempt({ ...DROPBOX_BINDING, accessToken: undefined }).error,
    attempt({ ...S3_BINDING, provider: "dropbox" }).error,
    attempt({ ...DROPBOX_BINDING, refreshToken: "rt.FAKE-long-lived" }).error,
    attempt({ ...S3_BINDING, accessToken: DROPBOX_BINDING.accessToken }).error,
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
    "session.js builds no store of its own; it delegates to the one table",
    (() => {
      const source = readFileSync(new URL("../src/session.js", import.meta.url), "utf8");
      return (
        /storeForBinding\(binding, env\)/.test(source) &&
        !/new (S3Store|R2Store|DropboxStore)\(/.test(source)
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
