/**
 * The two pins the graph itself consults: the barrier set, where taint stops,
 * and the HTTP routes allowed to reach a credential. Moved out of
 * `fixtures.helpers.ts` unchanged, beside the analyzer that reads them, so that
 * `graph.helpers.ts` does not import the fixture module that re-exports it.
 */

/**
 * THE CREDENTIAL BARRIER SET.
 *
 * Every function here is decrypt-capable **and** may be called by a public
 * function. Taint stops at a barrier: its callers do not inherit it.
 *
 * That is a real relaxation of the property this file used to enforce — that
 * no public function could reach a credential *at all* — and it was added
 * deliberately, because the alternative is that a person can never read or
 * write their own bucket from the console. A read path has to obtain a
 * credential somewhere, and no static rule can prove that a function which
 * holds one does not leak it: a `returns: v.string()` handler could return
 * `credential.secretAccessKey` and satisfy any validator-based check.
 *
 * So the barrier is not a *proof*, it is a **pin**. What it buys:
 *
 *  - The set is enumerated here, by name. Adding a second one is a diff to
 *    this file that a reviewer sees, exactly like adding to the
 *    decrypt-capable list below.
 *  - Everything else is unchanged. A public function that calls
 *    `getBindingForGateway` directly — the reviewer's original attack — still
 *    fails, because that function is not a barrier. So does one that calls
 *    `verifyStorageBinding`, or any *new* internal function that opens a
 *    credential without being listed here.
 *  - The barrier's own return validator is checked for credential fields (see
 *    the test below), and `__tests__/fileContent.test.ts` asserts
 *    behaviourally that no credential and no note content reaches a caller,
 *    an audit row, or an error.
 *
 * A barrier earns its place by being small enough to read in one sitting and
 * by doing exactly one thing with the credential. `runFileOperation` builds one
 * `S3Store` and hands it to `lib/fileOps.ts`, which has no access to the
 * credential at all. **Do not add one without that property.**
 */
/**
 * The second member. Read the paragraph above before adding a third.
 *
 * `functions.encryptionKeys.exportWorkspaceDataKeys` decrypts every generation
 * of a workspace's data key and returns the plaintext material — the console's
 * `exportEncryptionKeys` and the gateway's `export_encryption_keys` are both
 * `docs/decisions/encryption.md`'s "Revocation and export": the customer must
 * be able to get the key itself, not only decrypt with it through us, or the
 * first non-negotiable is false the moment they leave — by revoking our
 * credential on their own bucket, or by exporting off managed storage. That is
 * a *deliberate* disclosure this codebase has never needed before — every
 * other barrier and every other decrypt-capable function returns something
 * *derived* from a credential (file content, a signed request); this is the
 * first that hands back the credential itself, on purpose, to its owner.
 *
 * What makes it small enough to be a barrier and not a hole: it performs no
 * authorization of its own. `authorizeEncryptionExport` — a *different*,
 * non-barrier internal mutation — checks the owner role, spends the rate
 * limit, and writes the audit row, all three in one transaction, before the
 * console's public `exportEncryptionKeys` action ever calls this one. A
 * barrier that also decided who may call it would be two things to get right
 * instead of one; this one does exactly the thing `runFileOperation` does —
 * open a credential and hand back the single value its caller asked for.
 */
export const CREDENTIAL_BARRIERS = new Set([
  "functions.files.runFileOperation",
  "functions.encryptionKeys.exportWorkspaceDataKeys",
]);

/**
 * THE HTTP ROUTES THAT MAY REACH A CREDENTIAL.
 *
 * There are two, and there is a reason it cannot be zero: the whole product is
 * a worker in another datacentre signing S3 requests with the customer's own
 * key, and the only way it gets that key is over HTTPS from here.
 * `/gateway/binding`'s *purpose* is to return a decrypted secret, and so is
 * `/gateway/ingest/binding`'s.
 *
 * ── The second entry, and what it costs ─────────────────────────────────────
 *
 * `/gateway/ingest/binding` was added with the Email Worker, and it is exactly
 * what the paragraph below warns about: a second internet-facing path to other
 * people's bucket keys. It is here rather than folded into the first because it
 * cannot present the same proofs. `/gateway/binding` requires an end user's
 * access token and derives the workspace from that grant; an inbound email has
 * no user token, because nobody is present and nothing was authorized just now.
 *
 * What it keeps, and what is checked below: the caller still cannot name a
 * context. It presents a ticket the control plane minted, bound at mint time to
 * whatever `resolvePersonalContextForIngestion` answered for a name a *sender*
 * typed. What it gives up is "a real person authorized this just now", and the
 * bound is that a stolen `EMAIL_WORKER_SECRET` reaches one ingestion-enabled
 * personal context's credential per single-use, five-minute ticket, rate-limited
 * per name, and no shared context ever.
 *
 * Any additional entry would need the same argument made again, in this comment.
 *
 * So this is not a barrier and must not be read as one. A barrier stops taint
 * propagating — everything that calls through it comes out clean, which is why
 * `CREDENTIAL_BARRIERS` has one member and a long warning attached. This is a
 * **pin**: the route is still decrypt-capable, it still appears in the
 * enumerated `decryptCapable` set below, and every *other* http route in the
 * codebase still fails if it can reach a credential. Adding an entry here is a
 * diff a reviewer sees, and it means another internet-facing path
 * to other people's bucket keys.
 *
 * What keeps the exemption honest, all enforced below:
 *
 *  - the route must actually be an `httpAction` and must actually be
 *    decrypt-capable, or the pin is stale;
 *  - **every** route in `http.ts` — this one included — must be built by the
 *    `gatewayRoute` factory, and that factory must require the gateway secret,
 *    so no route can be added that skips proof #1;
 *  - `expectedWorkspaceId` must never be used as a lookup key anywhere, which
 *    is what keeps proof #2 meaningful: the workspace comes from the grant the
 *    user's token resolved to, and the caller cannot name the workspace it
 *    gets.
 *
 * None of that proves the route does not leak. Nothing static can. It bounds
 * the blast radius to one reviewed, two-factor-authenticated path, and
 * `__tests__/controlPlane.test.ts` carries the behavioural half.
 */
export const CREDENTIAL_HTTP_ROUTES = new Set([
  "http.gatewayBinding",
  "http.gatewayJobsOpen",
  "http.gatewayIngestBinding",
  // THE FOURTH, AND THE ONLY ONE ADDED RATHER THAN AVOIDED.
  //
  // `searchIndex`, `encryptionKey` and `rotation` all became *siblings* on
  // `/gateway/binding` specifically so this set would stay at three, and that
  // remains the default answer for a new gateway-facing credential. The model
  // key is the exception, for a reason that is about #661 rather than about
  // convenience: `openStorageBinding`'s returns validator already carries
  // `secretAccessKey`, and `v.object` is exact, so any drift in that shape
  // serializes everything in it into a log. Folding a customer's provider key
  // in would make one accident spill two credentials.
  //
  // What makes the door cost little: it is built by the same `gatewayRoute`
  // factory, spends the same two proofs, applies the same
  // compared-never-looked-up rule to `expectedWorkspaceId`, and answers `null`
  // for everything that is not a hit — all of which the tests below enforce on
  // it exactly as they do on the other three. What it does not share is the
  // validator, which is the entire point: two flat fields, nothing nested.
  "http.gatewayProvider",
]);
