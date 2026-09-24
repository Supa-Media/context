import { describe, expect, test } from "vitest";
import {
  type AnalyzedModule,
  type Classification,
  analyze,
  BARRIER_FORBIDDEN_FIELDS,
  classify,
  CREDENTIAL_BARRIERS,
  CREDENTIAL_HTTP_ROUTES,
  DECRYPT_CALL,
  DECRYPT_IMPORTERS,
  DELIBERATE_KEY_DISCLOSURES,
  DELIBERATE_TOKEN_MINTS,
  DISCLOSED_KEY_FIELD,
  encryptedColumnsIn,
  exportBlocks,
  findViolations,
  importsDecrypt,
  LIVE_MODULES,
  MINTED_TOKEN_FIELD,
  PUBLIC_FORBIDDEN_FIELDS,
  RAW_SOURCES,
  realModules,
  referencePath,
  SCHEMA_ENCRYPTED_FIELDS,
} from "./fixtures.helpers";

/**
 * Split out of the original `structure.test.ts`. See `fixtures.helpers.ts` for the
 * analyzer this describe block drives and for the full header comment
 * explaining what the whole suite defends.
 *
 * The reachability graph itself: every way a public function or HTTP route
 * can transitively reach the storage-secret decrypt path, pinned by name.
 * `scheduling.test.ts`, `barriers.test.ts` and `httpRoutes.test.ts` hold the
 * three narrower exemptions this graph allows.
 */

describe("no public function can reach a storage secret", () => {
  /**
   * Pin the exact set of functions that can reach a decrypted credential.
   *
   * The scheduling exemption above is correct but load-bearing: a public
   * function may now *trigger* a decrypt, and no static rule can prove the
   * scheduled job never stores that plaintext somewhere a public query reads.
   * What remains checkable is the size of the blast radius — so the set is
   * enumerated here rather than merely bounded.
   *
   * If this test fails you have added a new way to reach a storage credential.
   * That may well be correct. It is not something to fix by editing the list
   * and moving on: whatever you added now holds other people's bucket keys, and
   * needs the same scrutiny `getBindingForGateway` got. Add it deliberately,
   * and say why in the commit.
   */
  /**
   * The other half of the same closure, one level below the graph.
   *
   * The test below enumerates which *functions* can reach a decrypt. This one
   * enumerates which *modules* may import it at all, and it is what stops a
   * plain helper — no Convex exports, therefore no graph node — from calling
   * `decryptSecret` on behalf of a public function whose own source never
   * mentions it.
   *
   * If this fails, do not add the module and move on. Ask why a third place
   * needs to open a customer's credential, and whether it could instead call
   * one of the two that already does.
   */
  test("only these modules may import the decrypt", () => {
    const importers = Object.entries(RAW_SOURCES)
      .filter(([, source]) => importsDecrypt(source as string))
      .map(([path]) => path.replace(/^(\.\.?\/)+/, ""))
      .sort();

    expect(importers).toEqual([...DECRYPT_IMPORTERS].sort());
  });

  /**
   * NOBODY RESTATES THE CAPABILITY OBJECT.
   *
   * Four modules had their own copy of `{ conditionalWrite, conditionalCreate,
   * conditionalDelete }` — two return validators in `controlPlane.ts`, two in
   * `ingestionGateway.ts` — and `storage.ts` owned a fifth that was the real
   * one. Adding `serverSideCopy` to the schema and to the probe therefore made
   * both credential routes refuse the answer they had just built:
   * `v.object` is exact, `openStorageBinding` and `openIngestionBinding` threw
   * `ReturnsValidationError`, and every AI client and every inbound message was
   * told `storage_unavailable` — advised to reconnect storage that was never
   * unreachable.
   *
   * The lesson is not "remember the other four next time". It is that a
   * credential route's return validator is the last hop before a customer, and
   * a field list restated there is one nobody is watching. So: exactly one
   * declaration of the shape, and this test is what keeps it at one.
   *
   * If this fails, import `capabilitiesValidator` from `functions/storage`
   * rather than writing the fields out again.
   */
  test("only the schema spells the capability object out", () => {
    // A `capabilities:` field whose validator is written inline, which is what
    // each of the four copies looked like. `capabilitiesValidator` itself is
    // `v.object({ … })` too, but it is not under a `capabilities:` key — it is
    // the thing a `capabilities:` key is supposed to point at.
    const inlineShape = /capabilities:\s*v\.object\(/;
    const declarers = Object.entries(RAW_SOURCES)
      .filter(([, source]) => inlineShape.test(source as string))
      .map(([path]) => path.replace(/^(\.\.?\/)+/, ""))
      .sort();

    // The schema, and nowhere else. It is where the field list is defined (in
    // the storage table module `schema.ts` spreads in), and
    // `functions/storage.ts` builds the one validator from it.
    expect(declarers).toEqual(["functions/lib/schema/storage.ts"]);
  });

  test("only these functions can reach a decrypted credential", () => {
    const { decryptCapable } = analyze(realModules());

    expect([...decryptCapable].sort()).toEqual(
      [
        // The decrypt itself. internalAction, so Convex refuses to route it
        // from a client.
        "functions.storage.getBindingForGateway",
        // Re-encrypts every binding during a key rotation. Reads plaintext by
        // definition; internal, batched, never client-reachable.
        "functions.storage.rekeyStorageBindings",
        // Builds a real S3Store to probe the bucket a user just connected.
        // Reached only by a schedule edge from bindStorage.
        "functions.provisioning.verifyStorageBinding",
        // The owner-triggered storage-layout runner first refreshes observed
        // capabilities, then delegates the bounded copy to runFileOperation.
        // Internal and reached only through the scheduler, so neither the
        // verification result nor a credential can flow back to the client.
        "functions.files.runStorageLayoutMigration",
        // THE SECOND KIND OF CREDENTIAL, AND THE ONLY FUNCTION THAT OPENS ONE.
        //
        // Everything else in this list decrypts a *storage* key — a credential
        // scoped to one bucket. This one decrypts the customer's **Cloudflare
        // account** credential, which is strictly more powerful: it can create
        // buckets and mint further credentials. It is here because there is no
        // way to create a bucket in somebody's account without briefly holding
        // something that may act on that account, and the alternative is that
        // the product only works for people who already know R2.
        //
        // What bounds it: the envelope exists for one attempt and one attempt
        // only. `beginProvisioning` writes it, this opens it, and the row
        // carrying it is deleted on success and stripped of it on failure — so
        // unlike a storage binding there is no steady state in which the
        // control plane holds an account-level Cloudflare credential at all.
        // internalAction, reached only by a schedule edge from
        // `beginProvisioning`, and `__tests__/cloudflare.test.ts` asserts
        // behaviourally that the token appears in no table and in no public
        // return value.
        "functions.cloudflare.provisionCloudflareStorage",
        // THE SAME KIND, POINTED AT OUR OWN ACCOUNT.
        //
        // Managed storage: the bucket a Premium customer paid for, created in an
        // account we run rather than one they named. It opens
        // `MANAGED_R2_API_TOKEN` from `appSecrets` — an operator credential,
        // never a customer's storage key — long enough to create a bucket and
        // mint a key scoped to that one bucket.
        //
        // What bounds it: the token is ours, so nothing here can reach a
        // customer's own account, and the only thing it *writes* is an encrypted
        // per-bucket key that is indistinguishable from a pasted one. It is an
        // internalAction reached by two schedule edges — the webhook that turns a
        // plan active, and an owner's retry — and it stores neither the operator
        // token nor the minted token, only the SHA-256 the S3 API expects as a
        // secret access key. `__tests__/managedProvisioning.test.ts` asserts
        // behaviourally that neither value appears in any table.
        //
        // The reason this exists at all is non-negotiable #1: a person who does
        // not have and does not want a Cloudflare account still has to be able
        // to own their notes, and somebody has to create the bucket.
        "functions.managedProvisioning.provisionManagedStorage",
        // THE TEST ACCOUNT'S RESOURCE FUNERAL. Opens our managed-account token
        // only after `deleteAccount` has proved the exact verified CUJ email,
        // and refuses any bucket except the deterministic name for that
        // workspace. It empties/deletes that one managed bucket and revokes
        // its scoped token; ordinary customer-account deletion never reaches
        // this edge and continues to leave customer storage untouched.
        "functions.managedProvisioning.deleteManagedTestResources",
        // Opens the parked per-bucket destination credential for one bounded,
        // resumable copy page. Internal-only; the source binding remains live
        // until a quiet verification pass and atomic source-id-checked cutover.
        "functions.managedProvisioning.runManagedStorageMigration",
        // The readiness gate in front of that copy, and the narrowest use of
        // the same parked credential: it opens the destination secret to ask
        // the new bucket one question — does it answer, and will it take a
        // write — and moves nothing either way. Internal-only, reached by the
        // same two schedule edges, and it cannot widen what the copy it
        // precedes could already do with the identical secret.
        "functions.managedProvisioning.awaitManagedTargetReady",
        // THE THIRD KIND, AND THE WEAKEST ONE.
        //
        // Opens the parked PKCE verifier so the authorization code can be
        // exchanged for a Dropbox grant. What it holds is not a key to anybody's
        // storage — a verifier is useless without the matching code, it is
        // ten minutes old at most, and the row carrying it is deleted *before*
        // this runs, so a replay finds nothing.
        //
        // It is here rather than inside `completeDropboxConnect` precisely
        // because that one is public: reached only by a schedule edge, which is
        // the same shape as `verifyStorageBinding`.
        "functions.dropboxConnect.exchangeAndBind",
        // THE CREDENTIAL'S FUNERAL. Opens a Dropbox refresh token one last
        // time to disable the grant at Dropbox after `disconnectStorage`
        // deleted the row — without it, "Disconnect" forgets our copy while
        // the authorization lives on in the person's account, and their next
        // connect silently auto-approves. The envelope arrives in the args
        // (the row is already gone), it is spent on one refresh + one revoke,
        // and every failure is swallowed: after this runs, successfully or
        // not, the control plane holds nothing. internalAction, reached only
        // by schedule edges — three of them now: `disconnectStorage`,
        // `applyBinding` rebinding away from Dropbox, and
        // `applyDropboxBinding` landing on a different account. A count in
        // this list is the sort of thing that goes stale silently, so it is
        // here to be checked rather than trusted.
        "functions.dropboxConnect.revokeDropboxGrant",
        // THE FILE EDITOR'S CREDENTIAL BARRIER. Builds one S3Store for one
        // file operation and hands it to lib/fileOps.ts, which never sees the
        // credential. internalAction, and the only member of
        // CREDENTIAL_BARRIERS — read that comment before adding a second.
        "functions.files.runFileOperation",
        // Resolves the end user's access token to a live grant, derives the
        // workspace from THAT grant, and opens that workspace's credential for
        // the gateway. internalAction; the only thing that reaches it is the
        // route below.
        "functions.controlPlane.openStorageBinding",
        // THE QUEUE RUNNER'S CREDENTIAL DOOR. A user-authorized request mints an
        // opaque job ticket first; this internal action spends that ticket for
        // one bounded Worker queue attempt and reads the workspace off the job
        // row, never off the request body.
        "functions.controlPlane.openGatewayJob",
        // THE KEY TO NOTE CONTENT, rather than a credential for reaching it.
        //
        // Opens one workspace's data key so the gateway can decrypt that
        // context's encrypted notes for the length of one request. It is here
        // because there is no other place decryption can happen: every consumer
        // that exists — MCP clients, the console, link rewriting — reads through
        // the gateway, and `docs/decisions/encryption.md` says out loud that this
        // is encryption at rest against the storage provider and a leaked bucket
        // credential, and not against us.
        //
        // internalAction, reached only by `openStorageBinding` above, which has
        // already spent both proofs and passes the workspace id it read off the
        // resolved row. It is *not* a barrier: taint propagates through it
        // exactly as it does through `getBindingForGateway`, which is why
        // `http.gatewayBinding` is still in this list and why nothing new was
        // added to `CREDENTIAL_HTTP_ROUTES` — the route that reaches it was
        // already enumerated as an internet-facing path to a credential, and this
        // does not add a second one.
        "functions.encryptionKeys.openWorkspaceDataKey",
        // THE SAME KEY, DELIBERATELY DISCLOSED. Decrypts every generation of a
        // workspace's data key and hands the plaintext material back — the
        // second and, for now, only other member of `CREDENTIAL_BARRIERS`. Read
        // that comment before touching this one; it is here, and not merely a
        // barrier, because "decrypt-capable" is exactly what it is.
        "functions.encryptionKeys.exportWorkspaceDataKeys",
        // The ingest analogue. Spends a single-use ticket the control plane
        // minted, reads the workspace off THAT ticket's row, and opens its
        // credential for the Email Worker. internalAction; the only thing that
        // reaches it is `/gateway/ingest/binding`.
        "functions.ingestionGateway.openIngestionBinding",
        // AN INTERNET-FACING PATH TO A CREDENTIAL. `/gateway/binding`.
        // Requires the gateway secret AND the user's access token, and the
        // workspace comes from the grant, never from the caller.
        "http.gatewayBinding",
        // THE QUEUE ANALOGUE. `/gateway/jobs/open` requires the gateway secret
        // and an opaque job ticket that was minted under a live owner/private
        // grant; there is no workspace id in the request shape.
        "http.gatewayJobsOpen",
        // THE SECOND ONE. `/gateway/ingest/binding`. Requires the email worker's
        // own secret and a ticket we minted; there is no user token, because an
        // inbound email has nobody behind it. Read the CREDENTIAL_HTTP_ROUTES
        // comment before adding another.
        "http.gatewayIngestBinding",
        // THE PLATFORM'S OWN CREDENTIALS, AND THE ONE FUNCTION THAT OPENS ONE.
        //
        // Not a customer's anything — see the `functions/admin.ts` entry in
        // DECRYPT_IMPORTERS. internalAction, no schedule edge and no HTTP route;
        // the callers are the server-side integrations that need a token to make
        // an outbound request with it.
        //
        // The thing to check if this list ever grows a sibling: the admin
        // console writes these rows and must never read one. It calls
        // `setSecret` (which encrypts and never decrypts) and `listSecrets`
        // (which returns a fingerprint). A `getSecret` would land in this list
        // as a *public* function and be caught by the next test rather than
        // this one.
        "functions.admin.readIntegrationSecret",
        // THE PROVISIONER, AND ITS UNDERTAKER.
        //
        // Both open `SEARCH_D1_API_TOKEN` — a credential of *ours*, not a
        // customer's — to create and delete one context's search database.
        // internalActions, reached only by a schedule edge from
        // `fastSearch.enable` / `.disable`, which is the same shape
        // `verifyStorageBinding` has and rests on the same decision: scheduling
        // is not calling, so the public mutations that start them are not
        // themselves paths to the token.
        //
        // They are in this list at all because of a hole this branch found and
        // closed: their credential read sits in a module-level helper written
        // *after* a non-function export, which the analyzer used to attribute to
        // that constant's block and then drop for not being a node. Both were
        // invisible here and are not any more. See `unattributed` in `analyze`.
        "functions.fastSearchProvision.provisionIndex",
        "functions.fastSearchProvision.releaseIndex",
        // THE PAYMENT KEY, WHICH IS ALSO OURS AND NOT A CUSTOMER'S.
        //
        // Both open `STRIPE_SECRET_KEY` to mint a hosted Checkout or customer
        // portal URL. internalActions, reached only by a schedule edge from
        // `billing.startCheckout` / `.startPortal` — the same shape as the two
        // above and resting on the same decision, and the reason those two
        // mutations return a row id rather than a URL.
        //
        // What bounds them: the key never leaves this file. What is written back
        // to the row is a URL Stripe minted, and the failure path records our own
        // error code rather than Stripe's text, which can name an account or a
        // customer.
        //
        // The webhook is deliberately NOT here. It verifies an HMAC against an
        // environment variable, so it opens no envelope and stays off
        // `CREDENTIAL_HTTP_ROUTES` — see `STRIPE_WEBHOOK_SECRET_ENV_VAR` in
        // `functions/lib/premium.ts` for why that placement is load-bearing.
        "functions.billingStripe.createCheckoutSession",
        "functions.billingStripe.createPortalSession",
        // THE THIRD, AND THE ONLY ONE NOBODY PRESSED A BUTTON FOR.
        //
        // Opens the same payment key to cancel a subscription whose context is
        // being deleted. Reached by a schedule edge from `deleteWorkspaceCascade`
        // — a *public* mutation, which is exactly why it is a schedule and not a
        // call: `account.deleteAccount` must not be a path to the payment key.
        //
        // It is here rather than folded into the portal because the portal is the
        // customer choosing to cancel and this is the product noticing it must.
        // Without it, deleting a context leaves the card being charged with no
        // route in the product to stop it.
        "functions.billingStripe.cancelSubscription",
        // THE CUSTOM-HOSTNAME TOKEN, OURS AGAIN.
        //
        // All three open `CUSTOM_DOMAINS_API_TOKEN` — a token of ours,
        // zone-scoped to the one zone customer domains are registered in — to
        // register, read and delete a hostname there. internalActions, reached
        // only by schedule edges from `customDomains.connect` / `.checkNow` /
        // `.remove`, the sweep, and the workspace-deletion cascade, which is
        // the shape the D1 and Stripe entries above have and rests on the same
        // decision. Nothing they write back is Cloudflare's text or the token:
        // a provider id, three booleans and one of our own problem codes, and
        // `__tests__/customDomains/lifecycle.test.ts` asserts the token is in
        // no row and no response.
        "functions.customDomainsProvision.provision",
        "functions.customDomainsProvision.check",
        "functions.customDomainsProvision.deprovision",
        // THE GOOGLE CONNECT FLOW'S FOUR, THE SAME SHAPE AS DROPBOX'S TWO PLUS
        // product-specific and combined binders. See the `functions/googleConnect.ts`
        // entry in `DECRYPT_IMPORTERS` for why OAuth-connect modules exist rather
        // than folding into each other, and why minting an access token for the
        // sync job has no Dropbox analogue at all: a Dropbox binding hands the
        // gateway a cached access token straight off the row (`storage.ts`'s own
        // `S3`/`Dropbox` credential path), while a Google connection is read-only
        // *from the gateway's side* and refreshes through the control plane instead,
        // so it needs a function of its own — reused for every product on the grant.
        "functions.googleConnect.exchangeAndBind",
        "functions.googleConnect.exchangeAndBindGoogle",
        "functions.googleConnect.mintGoogleAccessToken",
        "functions.googleConnect.revokeGoogleGrant",
        // CHAT'S OWN CONNECT ROUND TRIP — the same PKCE-verifier decrypt
        // `googleConnect.ts`'s `exchangeAndBind` needs, on its own sibling
        // file. Disconnect and access-token minting are reused verbatim from
        // `googleConnect.ts` (they are already product-agnostic), so Chat adds
        // exactly one barrier function, not three.
        "functions.chatProduct.exchangeAndBindChat",
        // CALENDAR'S OWN VERIFIER-OPENING STEP — see the
        // `functions/calendarConnect.ts` entry in `DECRYPT_IMPORTERS` for why
        // this exists rather than reusing `googleConnect.exchangeAndBind`.
        // Minting an access token and revoking the grant are NOT duplicated
        // here: `googleConnect.mintGoogleAccessToken` and `.revokeGoogleGrant`
        // above already serve every product on the one connection row.
        "functions.calendarConnect.exchangeAndBindCalendar",
        // THE AGENT'S MODEL ACCOUNT, AND THE ONLY CREDENTIAL HERE WE CANNOT
        // ROTATE AFTER A LEAK.
        //
        // Opens the customer's own Anthropic or OpenAI key so the gateway can
        // spend it on one request. An internalAction, and `/gateway/provider`
        // is its only caller — the two public exports in that module do not
        // reach the decrypt at all: `connectProvider` encrypts, and
        // `listProviders` builds its answer field by field and never reads
        // `encryptedApiKey`.
        //
        // It spends the same two proofs `openStorageBinding` spends, in the
        // same order and with the same rule: the token's hash resolves to a
        // live grant, `expectedWorkspaceId` selects *within* that grant's own
        // set, and what goes to the decrypt is the id read off the resolved
        // row. The `expectedWorkspaceId is never used as a lookup key` test
        // below covers this module too, because it reads every module.
        //
        // What bounds it further: the returns validator is two flat fields with
        // nothing nested to drift, which is deliberate. #661 broke on a
        // *nested* validator — `capabilities` gained a key, `v.object` refused
        // the object `openStorageBinding` had just built, and the error named
        // what it rejected, so a live R2 secret went into the production logs
        // beside it. A key issued by somebody else's console cannot be rotated
        // by us at all, so the shape here is kept too small to drift.
        "functions.providers.openProviderForGateway",
        // THE FOURTH INTERNET-FACING PATH TO A CREDENTIAL. `/gateway/provider`.
        //
        // Requires the gateway secret AND the user's access token, and the
        // workspace comes from the grant, never from the caller — the same two
        // proofs `http.gatewayBinding` spends. Read the `CREDENTIAL_HTTP_ROUTES`
        // comment for why it is a door rather than a fifth sibling on the
        // binding route: folding a model key into `openStorageBinding`'s return
        // would put it inside the same validator as `secretAccessKey`, so one
        // drift could spill both.
        "http.gatewayProvider",
      ].sort(),
    );
  });

  test("every decrypt-capable Convex function is internal", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    // Belt to the violations check's braces: that test reports public
    // reachers, this one asserts the positive property directly, so a bug in
    // the reporting loop cannot make both pass.
    //
    // HTTP routes are excluded here and covered by their own rule below —
    // excluded because they carry no `isPublic`/`isInternal` at all, not
    // because they are trusted.
    for (const node of decryptCapable) {
      const classification = classifications.get(node);
      if (classification?.kind === "http") continue;
      expect(classification?.isPublic, `${node} must not be public`).toBe(
        false,
      );
    }
  });

  test("every decrypt-capable HTTP route is one of the enumerated ones", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    const reachers = [...decryptCapable].filter(
      (node) => classifications.get(node)?.kind === "http",
    );
    expect(reachers.sort()).toEqual([...CREDENTIAL_HTTP_ROUTES].sort());
  });

  test("the analyzer actually sees the whole control plane", () => {
    const modules = realModules();
    const paths = modules.map((m) => m.path);

    // If a module stops being globbed, every assertion below silently passes
    // over it. Pin the ones that must be in scope.
    expect(paths).toContain("functions/storage.ts");
    expect(paths).toContain("functions/provisioning.ts");
    expect(paths).toContain("functions/grants.ts");
    expect(paths).toContain("functions/audit.ts");
    expect(paths).toContain("functions/workspaces.ts");
    expect(paths).toContain("functions/names.ts");

    const total = modules.reduce(
      (sum, module) => sum + Object.keys(module.exports).length,
      0,
    );
    expect(total).toBeGreaterThan(15);
  });

  test("every Convex function is either public or internal, never neither", () => {
    for (const module of realModules()) {
      for (const [name, classification] of Object.entries(module.exports)) {
        // An `httpAction` is genuinely neither: Convex routes it by path, not
        // through the `api`/`internal` object. It is not exempt from scrutiny
        // — it is held to the stricter HTTP rules above and below — but the
        // public/internal dichotomy does not apply to it.
        if (classification.kind === "http") continue;
        expect(
          classification.isPublic !== classification.isInternal,
          `${module.path}#${name} is classified as neither public nor internal (or as both)`,
        ).toBe(true);
      }
    }
  });

  test("the decrypt path exists and is reachable only from internal functions", () => {
    const violations = findViolations(realModules());
    expect(
      violations.map((v) => `${v.node} ${v.reason}`),
      "a public Convex function can reach the credential decrypt path",
    ).toEqual([]);
  });

  /**
   * The graph must actually find the decrypt path, or the test above passes
   * because it found nothing at all.
   */
  test("the analysis is not vacuous — it locates the real decrypting function", () => {
    const modules = realModules();
    const storage = modules.find((m) => m.path === "functions/storage.ts");
    expect(storage).toBeDefined();

    // The body is in `lib/storage/credentialOpening.ts`; the registration
    // here hands it over by name, and the decrypt is in that body.
    const { blocks } = exportBlocks(storage!.source);
    expect(blocks.get("getBindingForGateway")).toContain(
      "handler: credentialOpening.getBindingForGatewayHandler",
    );
    const opening = modules.find(
      (m) => m.path === "functions/lib/storage/credentialOpening.ts",
    );
    expect(opening).toBeDefined();
    expect(
      DECRYPT_CALL.test(
        exportBlocks(opening!.source).blocks.get("getBindingForGatewayHandler") ??
          "",
      ),
    ).toBe(true);
    expect(storage!.exports.getBindingForGateway).toEqual({
      kind: "action",
      isPublic: false,
      isInternal: true,
    });
  });

  /**
   * No public function's declared return type may carry a credential field.
   *
   * A second, independent net: reachability catches a public function that
   * *calls* the decrypt path, this catches one that returns a credential it
   * obtained some other way (a raw envelope read straight off the row, say).
   * It reads the validator Convex will actually enforce, not the source.
   */
  /**
   * The derivation itself, checked — because a regex that quietly stops
   * matching disables both guards below and leaves them green.
   *
   * This is the shape the file already warns about: "a guard nobody has checked
   * is not a guard". A derived list makes the guard cover fields nobody
   * remembered, and makes an empty list a silent all-clear. So: prove it finds
   * a column it was not told about, and prove it is not empty on the real
   * schema.
   */
  test("the credential-field list is derived from the schema, and the derivation works", () => {
    // A column that does not exist in this repo today. A hand-maintained list
    // could not know about it; the derivation must.
    expect(
      encryptedColumnsIn(
        [
          "  storageBindings: defineTable({",
          "    provider: v.string(),",
          "    encryptedRefreshToken: v.optional(v.string()),",
          "    encryptedAccessToken: v.optional(v.string()),",
          "    dropboxAccountId: v.optional(v.string()),",
          "  })",
        ].join("\n"),
      ),
    ).toEqual(["encryptedrefreshtoken", "encryptedaccesstoken"]);

    // Lowercased, deduplicated, and nothing that merely mentions the word.
    expect(encryptedColumnsIn("    encrypted: v.string(),")).toEqual([
      "encrypted",
    ]);
    expect(encryptedColumnsIn("// encryptedThing: not a column")).toEqual([]);

    // And on the real schema it is non-empty and covers what is there now. An
    // empty list would make both guards below pass unconditionally.
    expect(SCHEMA_ENCRYPTED_FIELDS.length).toBeGreaterThan(0);
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedsecretaccesskey");
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedsetupcredential");
    expect(BARRIER_FORBIDDEN_FIELDS).toContain("encryptedsetupcredential");
    // The Dropbox columns, which the hand-written list never knew about.
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedrefreshtoken");
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedaccesstoken");
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedverifier");
    // And the decrypted tokens, which no schema column will ever name.
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("accesstoken");
    expect(BARRIER_FORBIDDEN_FIELDS).toContain("accesstoken");
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("apitoken");
    expect(BARRIER_FORBIDDEN_FIELDS).toContain("apitoken");
    // The workspace data key, both halves: the envelope the schema declares,
    // found by the derivation, and the opened key that only ever exists in
    // flight and therefore has to be named.
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encrypteddatakey");
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("datakey");
    expect(BARRIER_FORBIDDEN_FIELDS).toContain("datakey");
    // And the name the same key travels under since rotation made it a set.
    // Without this entry the guard says nothing at all about a workspace data
    // key in flight, because nothing is called `dataKey` any more.
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("material");
    expect(BARRIER_FORBIDDEN_FIELDS).toContain("material");
  });

  /**
   * The exemption is an allowlist, so it needs its own guard: an entry that
   * names a function which does not exist exempts nothing and looks like it
   * exempts something, and a typo would be indistinguishable from a decision.
   */
  test("every deliberate key disclosure names a function that exists, and there are exactly two", () => {
    const live = new Set<string>();
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const name of Object.keys(module ?? {})) {
        live.add(`${referencePath(globKey)}.${name}`);
      }
    }
    expect(DELIBERATE_KEY_DISCLOSURES.size).toBe(2);
    for (const node of DELIBERATE_KEY_DISCLOSURES) {
      expect(live.has(node), `${node} is exempted but does not exist`).toBe(
        true,
      );
    }
    // The barrier among them is a barrier, and the other is not.
    expect(
      CREDENTIAL_BARRIERS.has(
        "functions.encryptionKeys.exportWorkspaceDataKeys",
      ),
    ).toBe(true);
    expect(
      CREDENTIAL_BARRIERS.has("functions.encryptionKeys.exportEncryptionKeys"),
    ).toBe(false);
  });

  /**
   * The minted-token exemption, held to the same three things the key one is:
   * it names something that exists, it is one entry rather than a category, and
   * it buys exactly one field.
   */
  test("the minted-token exemption is one real function and one field", () => {
    const live = new Set<string>();
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const name of Object.keys(module ?? {})) {
        live.add(`${referencePath(globKey)}.${name}`);
      }
    }
    expect(DELIBERATE_TOKEN_MINTS.size).toBe(1);
    for (const node of DELIBERATE_TOKEN_MINTS) {
      expect(live.has(node), `${node} is exempted but does not exist`).toBe(true);
    }

    // One field, and it is not the key one: the two exemptions must not start
    // covering for each other.
    expect(MINTED_TOKEN_FIELD).not.toBe(DISCLOSED_KEY_FIELD);
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain(MINTED_TOKEN_FIELD);

    /*
      And the exempted function is still held to every other forbidden field.
      A `mintConsoleGrant` that grew a `secretaccesskey` would be caught by the
      guard above; this asserts the source has none of them, so the exemption
      cannot be read as "this function is out of scope".
    */
    for (const node of DELIBERATE_TOKEN_MINTS) {
      const [, moduleName, exportName] = node.split(".");
      const module = LIVE_MODULES[`../../functions/${moduleName}.ts`] as
        | Record<string, { exportReturns?: () => string }>
        | undefined;
      const returns = module?.[exportName!]?.exportReturns?.().toLowerCase() ?? "";
      expect(returns.length).toBeGreaterThan(0);
      for (const field of PUBLIC_FORBIDDEN_FIELDS) {
        if (field === MINTED_TOKEN_FIELD) continue;
        expect(returns.includes(`"${field}"`), `${node} also returns ${field}`).toBe(
          false,
        );
      }
    }
  });

  /**
   * THE GUARD'S OWN SELF-TEST, because a check that only ever runs against
   * source that passes it has not been shown to catch anything. A synthetic
   * public function declaring the disclosed field under a name that is NOT
   * exempted must be caught.
   */
  test("a third function returning key material would be caught", () => {
    const returns = JSON.stringify({
      type: "object",
      value: {
        keys: { type: "array", value: { material: { type: "string" } } },
      },
    }).toLowerCase();
    const node = "functions.somethingNew.helpfulExport";
    expect(DELIBERATE_KEY_DISCLOSURES.has(node)).toBe(false);
    expect(returns.includes(`"${DISCLOSED_KEY_FIELD}"`)).toBe(true);
  });

  test("no public function declares a credential field in its return validator", () => {
    // Derived from the schema, so a new credential column is covered the moment
    // it is declared. `encryptedsetupcredential` — the Cloudflare provisioning
    // envelope — arrives that way rather than by being remembered: it seals a
    // credential that can create buckets and mint further credentials in a
    // customer's cloud account, so it belongs here for the same reason the
    // storage envelope does. An opaque value is still the credential.
    const forbidden = PUBLIC_FORBIDDEN_FIELDS;
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const [name, value] of Object.entries(module ?? {})) {
        const classification = classify(value);
        if (classification === null || !classification.isPublic) continue;

        const exportReturns = (value as { exportReturns?: () => string })
          .exportReturns;
        if (typeof exportReturns !== "function") continue;

        const node = `${referencePath(globKey)}.${name}`;
        const returns = exportReturns.call(value).toLowerCase();
        for (const field of forbidden) {
          if (
            field === DISCLOSED_KEY_FIELD &&
            DELIBERATE_KEY_DISCLOSURES.has(node)
          )
            continue;
          if (field === MINTED_TOKEN_FIELD && DELIBERATE_TOKEN_MINTS.has(node)) {
            continue;
          }
          expect(
            returns.includes(`"${field}"`),
            `${globKey}#${name} is public and returns a "${field}" field`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * A public function with no `returns:` is inspected by the guard above and
   * cannot fail it, which is not the same as being skipped.
   *
   * The mechanism is worth stating exactly, because the obvious reading is
   * wrong. `exportReturns` is present on every registered query, mutation and
   * action whether or not a validator was declared, so the
   * `if (typeof exportReturns !== "function") continue;` line above does not
   * fire for them — it fires only for `httpAction`s, which have no `returns:`
   * in their API at all and are excluded here for that reason. What happens
   * instead is quieter: an undeclared return serializes to the string
   * `"null"`, the guard searches it for credential field names, finds none,
   * and passes. Every time. For any return shape whatsoever.
   *
   * So the guard runs and can never fail, which is the failure mode this
   * codebase keeps finding: green while the thing it protects is unexamined.
   * `schema.ts` states the promise it breaks, beside `appSecrets.encryptedValue`
   * — that naming a column `encrypted*` means the guard forbids it "with
   * nobody needing to remember". A function whose return schema is `"null"`
   * is one nobody is remembering for.
   *
   * **An allowlist rather than a count**, for the reason `audit.ts` gives about
   * its own: a threshold that has to be kept in step is a threshold somebody
   * lowers, and deny-by-default makes the next omission a decision somebody
   * writes down rather than a silence.
   */
  const PUBLIC_WITHOUT_RETURNS: ReadonlySet<string> = new Set([
    // Generated by `@convex-dev/auth`, not written here: `convexAuth()` returns
    // these three already registered, so there is no call site at which a
    // `returns:` could be added. They are listed rather than pattern-matched so
    // that a fourth export appearing from a library upgrade is a failure
    // somebody looks at, not a silent widening of the exemption.
    "../../auth.ts#signIn",
    "../../auth.ts#signOut",
    "../../auth.ts#isAuthenticated",
  ]);

  test("every public function declares a returns validator, so the credential guard has something to read", () => {
    const unreadable: string[] = [];
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const [name, value] of Object.entries(module ?? {})) {
        const classification = classify(value);
        if (classification === null || !classification.isPublic) continue;
        // `httpAction` has no `returns:` to declare. It is covered instead by
        // CREDENTIAL_HTTP_ROUTES and the body checks around it.
        if (classification.kind === "http") continue;

        const exportReturns = (value as { exportReturns?: () => string })
          .exportReturns;
        const declared =
          typeof exportReturns === "function"
            ? exportReturns.call(value)
            : null;
        if (typeof declared === "string" && declared !== "null") continue;

        const id = `${globKey}#${name}`;
        if (PUBLIC_WITHOUT_RETURNS.has(id)) continue;
        unreadable.push(id);
      }
    }
    expect(
      unreadable,
      "these public functions return a schema the credential guard cannot read, so it passes them vacuously",
    ).toEqual([]);
  });

  /**
   * The reviewer's attack, run through the same analyzer.
   *
   * This is the test that says what the guard is worth. `functions/gateway.ts`
   * below is the file that defeated the old name-based check verbatim: a
   * public action, innocuously named, that launders the internal decrypting
   * action for an unauthenticated caller.
   */
  test("catches a new public module that launders the internal decrypting action", () => {
    const attack: AnalyzedModule = {
      reference: "functions.gateway",
      path: "functions/gateway.ts",
      source: `
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const fetchBucketConfig = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
});
`,
      exports: {
        fetchBucketConfig: {
          kind: "action",
          isPublic: true,
          isInternal: false,
        },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain(
      "functions.gateway.fetchBucketConfig",
    );
    expect(violations[0].reason).toMatch(/decrypt path/);
  });

  /** The other way through: hide the call target behind a computed reference. */
  test("refuses a ctx.run… call whose target cannot be resolved statically", () => {
    const attack: AnalyzedModule = {
      reference: "functions.dynamic",
      path: "functions/dynamic.ts",
      source: `
export const passthrough = action({
  args: { name: v.string() },
  handler: async (ctx, args) =>
    await ctx.runAction((internal as any).functions.storage[args.name], {}),
});
`,
      exports: {
        passthrough: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.reason).join(" ")).toMatch(
      /cannot be resolved statically/,
    );
  });

  /** The fourth: launder it through an indirect export the splitter can't see. */
  test("catches a decrypt reached from a function that is not a plain `export const`", () => {
    const attack: AnalyzedModule = {
      reference: "functions.indirect",
      path: "functions/indirect.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

const passthrough = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
});

export { passthrough };
`,
      exports: {
        passthrough: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain(
      "functions.indirect.passthrough",
    );
  });

  /**
   * And the sixth, which the five above all miss: the decrypt in a plain
   * TypeScript helper that declares no Convex functions.
   *
   * Every rule so far reasons over the *graph*, and the graph's nodes are
   * Convex functions. A module exporting an ordinary arrow function
   * contributes no nodes, so it is not a node anything can be tainted
   * through — while the public function that imports it contains no
   * `decryptSecret(` of its own and passes every textual check.
   *
   * This is the fourth time a guard here has been weaker than it looked
   * (CLAUDE.md keeps the tally: a check that grepped export names, an isolation
   * claim that inverted silently, an import guard that read prose as code), and
   * it is the same shape each time — a rule that describes the code it expects
   * rather than the code an attacker would write.
   *
   * The closure is the one this file already uses twice, for
   * `CREDENTIAL_BARRIERS` and for the pinned `decryptCapable` set: enumerate.
   * `decryptSecret` may be imported only by modules on `DECRYPT_IMPORTERS`, so
   * a laundering helper fails loudly and has to be argued for rather than
   * merged. The test below is the enumeration; this one proves it bites.
   */
  test("catches a decrypt laundered through a helper that declares no Convex functions", () => {
    const launder = `
import { decryptSecret, requireKeyset } from "./crypto";
export const open = (envelope: string, workspaceId: string) =>
  decryptSecret(envelope, requireKeyset(), { workspaceId });
`;
    expect(importsDecrypt(launder)).toBe(true);
    // …and a module that merely mentions it in prose does not, so the rule is
    // about code rather than about the word.
    expect(
      importsDecrypt(
        "// this module never calls decryptSecret, it just says so\nexport const x = 1;",
      ),
    ).toBe(false);
  });

  /** And the fifth: a public function in the same file as the decrypt. */
  test("catches a public function that decrypts inline, whatever it is called", () => {
    const attack: AnalyzedModule = {
      reference: "functions.innocuous",
      path: "functions/innocuous.ts",
      source: `
import { decryptSecret, requireKeyset } from "./lib/crypto";

export const health = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("storageBindings").first();
    return await decryptSecret(row.encryptedSecretAccessKey, requireKeyset(), {
      workspaceId: args.workspaceId,
    });
  },
});
`,
      exports: { health: { kind: "query", isPublic: true, isInternal: false } },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain(
      "functions.innocuous.health",
    );
  });
});
