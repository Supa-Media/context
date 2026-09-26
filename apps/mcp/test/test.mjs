import { check, call, contextStore, lacks, env, accessTokenFor, suite, getFailures } from "./harness.mjs";
import { runStoreChecks } from "./store.test.mjs";
import { runCommunicationsChecks } from "./communications.test.mjs";
import { runContactsChecks } from "./contacts.test.mjs";
import { messageAnchor } from "../../../packages/communications/src/anchors.js";
import { renderChannelDayNote } from "../../../packages/communications/src/note.js";
import { runCommsSearchIndexChecks } from "./commsSearchIndex.test.mjs";
import { runCalendarGoogleChecks } from "./calendarGoogle.test.mjs";
import { runCalendarSyncChecks } from "./calendarSync.test.mjs";
import { runOrientationChecks } from "./orientation.test.mjs";
import { runSearchFilterChecks } from "./searchFilter.test.mjs";
import { runSearchIndexerChecks } from "./searchIndexer.test.mjs";
import { runSearchIntegrationChecks } from "./searchIntegration.test.mjs";
import { runSearchQueryChecks } from "./searchQuery.test.mjs";
import { runSearchShardQueryChecks } from "./searchShardQuery.test.mjs";
import { runSearchShardsChecks } from "./searchShards.test.mjs";
import { runSearchDocmapPathsChecks } from "./searchDocmapPaths.test.mjs";
import { runSearchPacingChecks } from "./searchPacing.test.mjs";
import { runSearchV2IntegrationChecks } from "./searchV2Integration.test.mjs";
import { runStoreFactoryChecks } from "./storeFactory.test.mjs";
import { runTenancyChecks } from "./tenancy.test.mjs";
import { runDropboxFolderChecks } from "./dropboxFolders.test.mjs";
import { runPluginChecks } from "./plugins.test.mjs";
import { runContextPluginChecks } from "./contextPlugins.test.mjs";
import { runPrivacyGroupChecks } from "./privacyGroups.test.mjs";
import { runFormChecks } from "./forms.test.mjs";
import { runListChecks } from "./lists.test.mjs";
import { runProjectListChecks } from "./listProjects.test.mjs";
import { runSetPropertyChecks } from "./listSetProperty.test.mjs";
import { runStatusChecks } from "./listStatuses.test.mjs";
import { runLinkToolChecks } from "./linkTools.test.mjs";
import { runPathInjectionChecks } from "./pathInjection.test.mjs";
import { runCrossContextChecks } from "./crossContext.test.mjs";
import { runMoveWithoutConditionalDeleteChecks } from "./moveWithoutConditionalDelete.test.mjs";
import { runBulkFolderMoveVisibilityChecks } from "./bulkFolderMoveVisibility.test.mjs";
import { runToolArgumentChecks } from "./toolArguments.test.mjs";
import { runLinkChecks } from "./links.test.mjs";
import { runActivityChecks } from "./activity.test.mjs";
import { runTreeHintChecks } from "./treeHints.test.mjs";
import { runForwardingChecks } from "./forwarding.test.mjs";
import { runPresenceChecks } from "./presence.test.mjs";
import { runAgentActivityChecks } from "./agentActivity.test.mjs";
import { runNoteCapGatewayChecks } from "./noteCapGateway.test.mjs";
import { runCollaborationChecks } from "./collaboration.test.mjs";
import { runDrawingChecks } from "./drawings.test.mjs";
import { runUsageReportingChecks } from "./usageReporting.test.mjs";
import { runMeetingChecks } from "./meetings.test.mjs";
import { runGmailSyncChecks } from "./gmailSync.test.mjs";
import { runDayPlacementChecks } from "./dayPlacement.test.mjs";
import { runGoogleChatChecks } from "./googleChat.test.mjs";
import { runChatContributionStoreChecks } from "./chatContributionStore.test.mjs";
import { runCalendarContributionStoreChecks } from "./calendarContributionStore.test.mjs";
import { runSearchD1Checks } from "./searchD1.test.mjs";
import { runSearchProjectionChecks } from "./searchProjection.test.mjs";
import { runAuditPartialMoveChecks } from "./auditPartialMove.test.mjs";
import { runCredentialShapeChecks } from "./credentialShape.test.mjs";
import { runProviderCredentialChecks } from "./providerCredential.test.mjs";
import { runAgentChecks } from "./agent.test.mjs";
import { runEncryptionChecks } from "./encryption.test.mjs";
import { runEncryptionGatewayChecks } from "./encryptionGateway.test.mjs";
import { runEncryptionPassphraseChecks } from "./encryptionPassphrase.test.mjs";
import { runEncryptionRotationChecks } from "./encryptionRotation.test.mjs";
import { runRotationCursorAdversarialChecks } from "./encryptionRotationCursor.test.mjs";
import {
  runStorageLayoutChecks,
  runStorageLayoutReadChecks,
} from "./storageLayout.test.mjs";
import { runProtocolBasicsChecks } from "./protocolBasics.test.mjs";
import { runTransportSecurityChecks } from "./transportSecurity.test.mjs";
import { runProtocolVersioningChecks } from "./protocolVersioning.test.mjs";
import { runOrientVisibilityChecks } from "./orientVisibility.test.mjs";
import { runPrivacyAclChecks } from "./privacyAcl.test.mjs";
import { runProposalsAndArchiveChecks } from "./proposalsAndArchive.test.mjs";
import { runMovesAndBatchChecks } from "./movesAndBatch.test.mjs";
import { runWebhooksAndCalendarChecks } from "./webhooksAndCalendar.test.mjs";
import { runAttachmentsCoreChecks } from "./attachmentsCore.test.mjs";
import { runAttachmentsEdgeChecks } from "./attachmentsEdge.test.mjs";
import { runUploadedImageChecks } from "./uploadedImages.test.mjs";

/**
 * This file used to hold the ~4,100 lines of sequential checks below inline.
 * They are now ten subject files, split by topic and run here in their
 * original order against the one shared fixture `harness.mjs` builds (the
 * same in-memory bucket, control plane and `rpc`/`call`/`check` helpers every
 * check below was written against). None of these calls is wrapped in
 * `suite()` — a throw during this shared-fixture portion of the file always
 * killed the whole process before the split, and still does; `suite()`'s own
 * comment below explains why that is deliberate for the checks that come
 * after it, not for these.
 */
await runProtocolBasicsChecks();
await runTransportSecurityChecks();
await runProtocolVersioningChecks();
await runOrientVisibilityChecks();
await runPrivacyAclChecks();
await runProposalsAndArchiveChecks();
await runMovesAndBatchChecks();
await runWebhooksAndCalendarChecks();
await runAttachmentsCoreChecks();
await runAttachmentsEdgeChecks();
await runUploadedImageChecks();

await suite("runStoreChecks", () => runStoreChecks(check, {
  // The hostile-backend checks need a real way in; there is only one.
  env,
  ownerToken: accessTokenFor("priv-token"),
}));

// -- the binding → store table, and every way it refuses
// Synchronous and network-free: it builds adapters and inspects them, so it
// neither needs nor touches the control plane the checks above installed.
await suite("runStoreFactoryChecks", () => runStoreFactoryChecks(check));

// -- multi-tenancy, OAuth, and the ways both are supposed to fail
//
// Last, and with its own control plane and object store: it swaps
// globalThis.fetch and restores it, so it must not run while the calendar cron
// checks above still own that global.
// Orientation's budgeted walk and fail-soft handshake, against a bucket that
// paginates and delimits honestly. Its own control plane, so it runs beside the
// tenancy suite rather than against the shared fixture.
await suite("runOrientationChecks", () => runOrientationChecks(check));

// The model account the agent spends, across the control-plane wire. Its own
// control plane, for the same reason the tenancy suite has one: it swaps
// globalThis.fetch and restores it.
await suite("runProviderCredentialChecks", () => runProviderCredentialChecks(check));

// The agent turn, end to end: a question in, tool calls through the same
// dispatcher a client's go through, an answer out. Its own control plane, S3
// backend and fake model, so — like the tenancy suite — it swaps globalThis.fetch
// and restores it.
await suite("runAgentChecks", () => runAgentChecks(check));

// A privacy rule that names a group: what the tools do when they meet one.
// Its own control plane and bucket, like orientation, because the fixture is a
// team folder with a group-scoped note inside it — the arrangement where a
// guard that tests `=== "private"` instead of `!== "team"` actually leaks.
await suite("runPrivacyGroupChecks", () => runPrivacyGroupChecks(check));
await suite("runFormChecks", () => runFormChecks(check));
await suite("runListChecks", () => runListChecks(check));
await suite("runProjectListChecks", () => runProjectListChecks(check));
await suite("runSetPropertyChecks", () => runSetPropertyChecks(check));
await suite("runStatusChecks", () => runStatusChecks(check));
await suite("runLinkToolChecks", () => runLinkToolChecks(check));

// A path is not a place to write privacy rules. Its own bucket, because the
// fixture is one named private note and one forged path that tries to publish
// it without ever naming it.
await suite("runPathInjectionChecks", () => runPathInjectionChecks(check));

// The two communications reads, against their own bucket for the same reason:
// the fixture here is two mailboxes with different visibilities, which is the
// arrangement the "a mailbox is a folder" decision exists for.
await suite("runCommunicationsChecks", () => runCommunicationsChecks(check));
// The two contact reads, in their own bucket for the same reason: the fixture
// is one contact published, one held back, and a note of the user's own at a
// key a sender could have picked — the arrangement that tells a lenient parse
// apart from a positive identity marker.
await suite("runContactsChecks", () => runContactsChecks(check));
await suite("runCommsSearchIndexChecks", () => runCommsSearchIndexChecks(check));

// The calendar sync: the Google-shaped adapter (calendarGoogle.test.mjs) and
// the orchestrator against a fake, stateful Calendar API server
// (calendarSync.test.mjs, fakeCalendarServer.mjs) — syncToken paging, the 410
// fallback, the bounded horizon, per-day regeneration, disconnect as a real
// no-op, and two workspaces' connections never touching each other's store.
// Neither file shares state with anything else in this suite: each stands up
// its own fake server and store per check block.
await suite("runCalendarGoogleChecks", () => runCalendarGoogleChecks(check));
await suite("runCalendarSyncChecks", () => runCalendarSyncChecks(check));

// The search index. The two format halves are pure functions over their own
// fixtures and touch no store or control plane, so they run anywhere; the
// integration checks stand up their own instrumented bucket, like orientation,
// because the properties that matter there are store-call counts.
await suite("runSearchIndexerChecks", () => runSearchIndexerChecks(check));
await suite("runSearchQueryChecks", () => runSearchQueryChecks(check));
await suite("runSearchIntegrationChecks", () => runSearchIntegrationChecks(check));
// The sharded index (v2), in the same three layers: the storage half against
// its own instrumented bucket, the query half as pure functions over fixtures,
// and the gateway wired to both through the worker.
await suite("runSearchShardsChecks", () => runSearchShardsChecks(check));
await suite("runSearchDocmapPathsChecks", () => runSearchDocmapPathsChecks(check));
await suite("runSearchShardQueryChecks", () => runSearchShardQueryChecks(check));
await suite("runSearchFilterChecks", () => runSearchFilterChecks(check));
await suite("runSearchV2IntegrationChecks", () => runSearchV2IntegrationChecks(check));
// What a search *costs*: the ops it reserves for its own answer, the share of
// the backfill it does while somebody waits, and the round trips it no longer
// serializes.
await suite("runSearchPacingChecks", () => runSearchPacingChecks(check));

// The Obsidian plugin compatibility check: the scan as pure functions, the
// inventory against its own bucket stubs, and the phrasing of the report. No
// control plane and no shared fixture, so it runs anywhere in this file.
await suite("runPluginChecks", () => runPluginChecks(check));
await suite("runContextPluginChecks", () => runContextPluginChecks(check));

// Links between notes, and the rewrite that keeps them pointing at what they
// name after a move. Pure rules first, then the four move tools against a
// worker of its own — see the file header for why it does not share this
// fixture.
await suite("runLinkChecks", () => runLinkChecks(check));
await suite("runForwardingChecks", () => runForwardingChecks(check));

// `activity.md`: the feed as a file in the customer's bucket. Pure format and
// substance rules first, then a worker of its own — it writes to the root of
// the bucket on every call, so it cannot share this fixture either.
await suite("runActivityChecks", () => runActivityChecks(check));
await suite("runTreeHintChecks", () => runTreeHintChecks(check));
await suite("runDrawingChecks", () => runDrawingChecks(check));

/*
  A MESSAGE DEEP LINK IS A KEY THE READ TOOLS ACCEPT.

  `search_notes` prints a channel-day hit as `<notePath>#<anchor>` and an
  agent's next move is `read_note` on exactly that string; the ChatGPT
  dialect's entire contract is `search` then `fetch(id)`. Reviewed as a round
  trip rather than as two features: the shape the answer hands out is asserted
  in `commsSearchIndex.test.mjs`, and what the tools do with that shape is
  asserted here, against the real worker.

  Seeded here, at the end of this file's shared-fixture assertions, so one
  extra object in the bucket cannot move a count somebody above is asserting.
*/
{
  const dayPath = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const event = {
    channel: "email",
    account: "name-at-example-com",
    messageId: "<deep-link@mail.example.net>",
    threadId: "thread-1",
    sentAt: "2026-09-07T09:14:00.000Z",
    subject: "Quarterly numbers",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    to: [{ address: "name@example.com" }],
    body: "DEEPLINKWORD in the body of one message",
    attachments: [],
  };
  await contextStore.put(
    dayPath,
    renderChannelDayNote({
      channel: "email",
      account: "name-at-example-com",
      address: "name@example.com",
      date: "2026-09-07",
      nonce: "0123456789abcdef",
      now: "2026-09-07T18:04:11.221Z",
      events: [event],
    })
  );
  const anchor = messageAnchor(event);
  const deepLink = `${dayPath}#${anchor}`;

  const read = await call("priv-token", "read_note", { path: deepLink });
  check(
    "read_note opens the containing note when handed a search hit's message deep link",
    (read?.content?.[0]?.text || "").includes("DEEPLINKWORD")
  );
  check(
    "...and reports the note's own path, never the key with the anchor still on it",
    (read?.content?.[0]?.text || "").includes(`path: ${dayPath}`) &&
      lacks(read?.content?.[0]?.text, `path: ${deepLink}`)
  );
  const fetched = await call("priv-token", "fetch", { id: deepLink });
  check(
    "the ChatGPT dialect's fetch takes the id its own search would have handed out",
    (fetched?.content?.[0]?.text || "").includes("DEEPLINKWORD")
  );
  check(
    "...answering under the note's id, so a second fetch of it is the same call",
    (fetched?.content?.[0]?.text || "").includes(`"id":"${dayPath}"`)
  );
  // Only a well-formed trailing anchor is one: a `#` in a path stays a
  // character in a path, and nothing here invents a note that does not exist.
  const notAnAnchor = await call("priv-token", "read_note", { path: `${dayPath}#msg-nothex` });
  check(
    "a trailing # that is not a message anchor is still part of the path, and still not found",
    (notAnAnchor?.content?.[0]?.text || "").includes("not found")
  );
  const teamRead = await call("team-token", "read_note", { path: deepLink });
  check(
    "and the deep link is no way around canSee: a team connection cannot read a private day through one",
    (teamRead?.content?.[0]?.text || "").includes("not found")
  );
}

await suite("runTenancyChecks", () => runTenancyChecks(check));
await suite("runDropboxFolderChecks", () => runDropboxFolderChecks(check));
await suite("runCrossContextChecks", () => runCrossContextChecks(check));
await suite("runMoveWithoutConditionalDeleteChecks", () => runMoveWithoutConditionalDeleteChecks(check));
// Its own control plane and S3 backend, so it swaps globalThis.fetch and
// restores it — same rule as the tenancy suite above.
await suite("runBulkFolderMoveVisibilityChecks", () => runBulkFolderMoveVisibilityChecks(check));
// The arguments of a tool call, against the schema `tools/list` advertised for
// it. Its own control plane and S3 backend, so — like the tenancy suite — it
// swaps globalThis.fetch and restores it, and must not run while anything
// above still owns that global.
await suite("runToolArgumentChecks", () => runToolArgumentChecks(check));
await suite("runUsageReportingChecks", () => runUsageReportingChecks(check));
await suite("runSearchD1Checks", () => runSearchD1Checks(check));
// The copy itself: notes reaching the database fast search provisions. Its own
// control plane, S3 backend and Cloudflare stub, so — like the tenancy suite —
// it swaps globalThis.fetch and restores it, and must not run while anything
// above still owns that global.
await suite("runSearchProjectionChecks", () => runSearchProjectionChecks(check));
await suite("runAuditPartialMoveChecks", () => runAuditPartialMoveChecks(check));
await suite("runCredentialShapeChecks", () => runCredentialShapeChecks(check));
await suite("runEncryptionChecks", () => runEncryptionChecks(check));
await suite("runEncryptionGatewayChecks", () => runEncryptionGatewayChecks(check));
await suite("runEncryptionPassphraseChecks", () => runEncryptionPassphraseChecks(check));
await suite("runEncryptionRotationChecks", () => runEncryptionRotationChecks(check));
await suite("runRotationCursorAdversarialChecks", () => runRotationCursorAdversarialChecks(check));
await suite("runStorageLayoutChecks", () => runStorageLayoutChecks());
await suite("runStorageLayoutReadChecks", () => runStorageLayoutReadChecks());

// Meeting ingestion: the routes a phone and a desktop app send a meeting to,
// the one note it becomes, and the neighbour who knows its session id. Its own
// control plane, its own S3 backend and its own fetch layer for failing a
// single write, so — like the tenancy suite — it swaps globalThis.fetch and
// restores it, and must not run while anything above still owns that global.
await suite("runMeetingChecks", () => runMeetingChecks(check));

// A connected Gmail mailbox's sync job: Gmail API response parsing, backfill
// and incremental sync against a fake Gmail server, idempotent upserts,
// gap detection and full reconcile, and the quota bound. No network and no
// dependency: `gmailSync.js` takes its socket and its store as parameters.
await suite("runGmailSyncChecks", () => runGmailSyncChecks(check));
await suite("runDayPlacementChecks", () => runDayPlacementChecks(check));

// Google Chat sync: no shared globals, no worker fetch — pure functions plus
// a fixture Chat API over an injected fetchImpl, so it runs anywhere in this
// order without the swap-and-restore discipline the block above needs.
await suite("runGoogleChatChecks", () => runGoogleChatChecks(check));
await suite("runChatContributionStoreChecks", () => runChatContributionStoreChecks(check));

// Presence: the pure roster module in full, then `GET /presence` up to the
// point it hands a socket to its Durable Object. Its own control-plane stub and
// its own buckets, and it installs and restores the fetch global itself, so it
// runs here rather than inside a block that owns that global.
await suite("runPresenceChecks", () => runPresenceChecks(check));
await suite("runCollaborationChecks", () => runCollaborationChecks(check));
await suite("runAgentActivityChecks", () => runAgentActivityChecks(check));
await suite("runNoteCapGatewayChecks", () => runNoteCapGatewayChecks(check));
await suite("runCalendarContributionStoreChecks", () => runCalendarContributionStoreChecks(check));

console.log(getFailures() ? `\n${getFailures()} FAILURES` : "\nALL PASS");
