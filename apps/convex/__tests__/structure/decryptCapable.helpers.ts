/**
 * Every Convex function allowed to reach a decrypted credential, each with the
 * reason it may. `reachability.test.ts` holds the analyzer to this list
 * exactly, so a new path to a plaintext secret fails a test until it is
 * argued for here.
 */
export const DECRYPT_CAPABLE_FUNCTIONS: readonly string[] = [
      // The decrypt itself. internalAction, so Convex refuses to route it
      // from a client.
      "functions.storage.getBindingForGateway",
      // Re-encrypts every binding during a key rotation. Reads plaintext by
      // definition; internal, batched, never client-reachable.
      "functions.storage.rekeyStorageBindings",
      // The vault's barrier: seals or opens one login's name, sites and
      // people for the signed-in save and share pages. Never a secret part.
      "functions.vault.runVaultOperation",
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
      // A DELETED ACCOUNT'S MANAGED STORAGE, ERASED. Opens our managed-account
      // token for one bounded run of a queued erasure (`managedErasures`),
      // written by the workspace cascade only for the deterministic bucket of
      // a workspace being deleted. Re-derives and compares that bucket name,
      // and checks the token's name, before deleting anything; a customer's
      // own bucket is never queued and never reached.
      "functions.managedErasure.runManagedErasure",
      // THE CUSTOMER HANDOFF'S RESOURCE FUNERAL. Opens the same operator
      // token only after the verified raw-object copy has atomically moved
      // the live binding to the customer's bucket. The scheduled arguments
      // are the deterministic managed bucket and its scoped token id; the
      // action re-derives and compares that bucket name before deleting it.
      "functions.managedProvisioning.deleteManagedStorageAfterHandoff",
      // Opens the parked per-bucket destination credential for one bounded,
      // resumable copy page. Internal-only; the source binding remains live
      // until a quiet verification pass and atomic source-id-checked cutover.
      "functions.managedProvisioning.runManagedStorageMigration",
      // The same page, handed to the gateway's mover so the files go bucket
      // to bucket and never through this deployment. Spends a single-use
      // ticket minted by the action above, reads the workspace off it, and
      // refuses a page the move has already passed. internalAction; the only
      // thing that reaches it is `/gateway/mover/open`.
      "functions.managedProvisioning.openMoverPage",
      // The readiness gate in front of that copy, and the narrowest use of
      // the same parked credential: it opens the destination secret to ask
      // the new bucket one question — does it answer, and will it take a
      // write — and moves nothing either way. Internal-only, reached by the
      // same two schedule edges, and it cannot widen what the copy it
      // precedes could already do with the identical secret.
      "functions.managedProvisioning.awaitManagedTargetReady",
      // A new managed bucket's promotion off its temporary credential.
      // Opens the bucket's own key only to probe whether it answers yet,
      // then clears the temporary one or schedules itself again. Internal-
      // only, reached by schedule edges from `completeManagedProvisioning`
      // and itself; it returns nothing and logs no credential.
      "functions.managedProvisioning.promoteManagedKey",
      // Managed-storage encryption's walk. Opens the managed bucket's
      // credential (our own, per workspace) and the workspace's data key to
      // seal each object in place, one bounded page per run. internalAction,
      // reached only by schedule edges from the staff rollout's `tick` and
      // `retryWorkspace` and from itself; it returns nothing, and the page
      // it records carries a cursor and counts, never a key or a byte.
      "functions.managedEncryption.runWalk",
      // The passes after a move's switch-over. Opens the *old* bucket's key,
      // carried sealed in its own scheduled arguments, to read files that
      // landed there after the last check; it writes only to the current
      // binding, create-only, and stops when that binding is not the one
      // the move switched to. Internal-only, reached by one schedule edge
      // from the switch-over and by its own reschedules.
      "functions.moveCatchUp.runMoveCatchUp",
      // The id copy's two passes (`functions/noteIdsCopy.ts`, `lib/noteIds/`).
      // Each internalAction copies or checks one page of a workspace's files,
      // by the gateway's mover when one is set, or here through the bucket's
      // own credential when it is not. Reached only by schedule edges from the
      // staff surface, the cron and themselves; nothing returns a credential,
      // and each page records ids, etags and counts, never a path or a byte.
      "functions.noteIdsCopy.run",
      "functions.noteIdsCopy.runCheck",
      // The old-copy cleanup's two passes (`functions/noteIdsCleanupRun.ts`, `lib/cleanup/pass.ts`).
      // Each internalAction lists one page of a workspace's bucket (a count) or lists and deletes one
      // page of old path copies (a delete), through the gateway's mover when one is set, or here through
      // the bucket's own credential when it is not. Reached only by schedule edges from the two staff
      // mutations and from themselves; the pages record counts, times and fixed labels, never a key.
      "functions.noteIdsCleanupRun.runCount",
      "functions.noteIdsCleanupRun.runDelete",
      // Two cron-scheduled bucket passes that return no credential and record ids, counts and fixed labels only:
      // emptying the trash (`trashEmptying.ts`, from `trash.emptyDue`, for erasures `trash.claimErasure` made) and
      // filing editing history by note id (`collaborationFiling.ts`, from `fileDue` and itself).
      "functions.trashEmptying.eraseWorkspace",
      "functions.collaborationFiling.fileWorkspace",
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
      // THE MOVER'S DOOR. `/gateway/mover/open`: the gateway secret and a
      // single-use ticket minted for one page of one running whole-bucket
      // move. See its CREDENTIAL_HTTP_ROUTES entry.
      "http.gatewayMoverOpen",
      // THE SECOND ONE. `/gateway/ingest/binding`. Requires the email worker's
      // own secret and a ticket we minted; there is no user token, because an
      // inbound email has nobody behind it. Read the CREDENTIAL_HTTP_ROUTES
      // comment before adding another.
      "http.gatewayIngestBinding",
      // THE PERSON'S OWN GMAIL. `/gateway/email/send` mints a Google access
      // token for one send and spends it on one request to Gmail; the token
      // is never returned. See its CREDENTIAL_HTTP_ROUTES entry.
      "http.gatewayPersonEmail",
      // A CONNECTED APP. `/gateway/connect/call` opens the workspace's own
      // token for one allow-listed call; see its CREDENTIAL_HTTP_ROUTES entry.
      "http.gatewayConnectCall",
      // The same, saving a draft: `/gateway/email/draft`.
      "http.gatewayPersonEmailDraft",
      // THE PERSON'S OWN CALENDAR. `/gateway/calendar/event`, the same
      // shape as the Gmail route; see its CREDENTIAL_HTTP_ROUTES entry.
      "http.gatewayCalendarWrite",
      // THE PERSON'S OWN GOOGLE CHAT. `/gateway/chat/send` and
      // `/gateway/chat/spaces`; see their CREDENTIAL_HTTP_ROUTES entry.
      "http.gatewayChatSend",
      "http.gatewayChatSpaces",
      // `/gateway/chat/recent`, the same account read for check-ins.
      "http.gatewayChatRecent",
      // THE PERSON'S OWN GMAIL, READ. `/gateway/email/search` and
      // `/gateway/email/read`; see their CREDENTIAL_HTTP_ROUTES entry.
      "http.gatewayPersonMailSearch",
      "http.gatewayPersonMailRead",
      // THE PERSON'S OWN CALENDAR, READ. `/gateway/calendar/days`; see its
      // CREDENTIAL_HTTP_ROUTES entry.
      "http.gatewayPersonCalendarDays",
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
      // The meaning index's two, same credential and shape (schedule edges from `meaningSearch.enable` / `.disable`),
      // and Delete the backup's eraser, which empties the texts rows through it, scheduled only by owner-only `deleteBackup`.
      "functions.meaningProvision.provisionMeaningIndex",
      "functions.meaningProvision.releaseMeaningIndex",
      "functions.messagesExport.eraseBackupPage",
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
      // WINDING BILLING DOWN (owner, 2026-10-20: Context is free, stop
      // charging). Both are internalActions run only by hand through
      // `convex run` from the billing wind-down workflow; no public function
      // schedules or calls either. One counts, one cancels.
      "functions.billingStripe.cancelEveryChargeableSubscription",
      "functions.billingStripe.countChargeableSubscriptions",
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
      // THE DOMAIN CONNECT SIGNING KEY, OURS TOO. Reached only by the
      // schedule edge from `customDomains.connect`; it signs one apply link
      // and writes back the link and the provider's name, never the key.
      // `__tests__/customDomains/domainConnect.test.ts` verifies the link
      // against the public half and that no failure writes anything else.
      "functions.customDomainsProvision.detectProvider",
      // THE GOOGLE CONNECT FLOW'S. See the `functions/googleConnect.ts`
      // entry in `DECRYPT_IMPORTERS` for why OAuth-connect modules exist rather
      // than folding into each other. Minting an access token for the sync job
      // needs a function of its own: a Google connection is read-only from the
      // gateway's side and refreshes through the control plane instead, and the
      // function is reused for every product on the grant.
      // A CONNECTED APP'S TOKEN, opened for one API call or to revoke it after a disconnect,
      // a reconnect or a workspace's deletion. See `functions/connections.ts` in `DECRYPT_IMPORTERS`.
      "functions.connections.callProvider",
      "functions.connections.revokeToken",
      // An MCP tool call or one of our API tools, and the scheduled finish
      // of a standard consent. See the `functions/connectionApps.ts` entry.
      "functions.connectionApps.callApp",
      "functions.connectionConsent.finishStandardConsent",
      "functions.googleConnect.exchangeAndBind",
      "functions.googleConnect.exchangeAndBindGoogle",
      "functions.googleConnect.mintGoogleAccessToken",
      // The same mint saying why there is no token, so a pass can tell Google not answering from Google
      // refusing the grant; the daily re-check that forces one refresh per revoked grant through it
      // (`googleReconnect.ts`), and the calendar scope re-check (`googleScopeCheck.ts`, answers only
      // booleans and addresses). None returns a credential outside the barrier but the sync pass's own action.
      "functions.googleConnect.mintGoogleAccessTokenOutcome",
      "functions.googleReconnect.recheckRevokedGrants",
      "functions.googleScopeCheck.recheckCalendarWrite",
      "functions.meetingCalendar.readMeetingCalendars", // Join and take notes' calendar barrier; see CREDENTIAL_BARRIERS.
      "functions.googleConnect.revokeGoogleGrant",
      "functions.googleClients.exchangeAndBindAgent", // agent grant (googleClients.ts), on the schedule edge
      "functions.googleClients.revokeAgentGrant",
      // CHAT'S OWN CONNECT ROUND TRIP — the same PKCE-verifier decrypt `googleConnect.ts`'s `exchangeAndBind`
      // needs, on its own sibling file. Disconnect and access-token minting are reused verbatim from
      // `googleConnect.ts` (they are already product-agnostic), so Chat adds exactly one barrier function, not three.
      "functions.chatProduct.exchangeAndBindChat",
      // CALENDAR'S OWN VERIFIER-OPENING STEP — see the
      // `functions/calendarConnect.ts` entry in `DECRYPT_IMPORTERS` for why
      // this exists rather than reusing `googleConnect.exchangeAndBind`.
      // Minting an access token and revoking the grant are NOT duplicated
      // here: `googleConnect.mintGoogleAccessToken` and `.revokeGoogleGrant`
      // above already serve every product on the one connection row.
      "functions.calendarConnect.exchangeAndBindCalendar",
];
