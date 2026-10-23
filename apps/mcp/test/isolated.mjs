/**
 * The gateway suites that need nothing from the shared fixture: each stands up
 * its own control plane, bucket or fake server, or is pure functions over
 * fixtures of its own. They used to run one after another at the end of
 * test/test.mjs, which made that file the slowest test process by a minute
 * (2026-10-20). Now `node test/isolated.mjs <shard> <count>` runs every
 * count-th one starting at shard, in the order below, and test/run.mjs runs the
 * shards side by side, beside test.mjs. Within a shard they still run one at a
 * time, so a suite that swaps globalThis.fetch and restores it still owns that
 * global alone; across shards each is its own process.
 *
 * A suite that touches the shared fixture (call, contextStore, controlPlane)
 * belongs in test.mjs, not here: this process builds that fixture too, but
 * nothing has seeded it.
 */
import { check, suite, getFailures } from "./harness.mjs";
import { runCommunicationsChecks } from "./communications.test.mjs";
import { runContactsChecks } from "./contacts.test.mjs";
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
import { runSearchPacingControlPlaneChecks } from "./searchPacingControlPlane.test.mjs";
import { runSearchV2IntegrationChecks } from "./searchV2Integration.test.mjs";
import { runSearchV2IntegrationShardChecks } from "./searchV2IntegrationShards.test.mjs";
import { runStoreFactoryChecks } from "./storeFactory.test.mjs";
import { runTenancyChecks } from "./tenancy.test.mjs";
import { runPluginChecks } from "./plugins.test.mjs";
import { runContextPluginChecks } from "./contextPlugins.test.mjs";
import { runPrivacyGroupChecks } from "./privacyGroups.test.mjs";
import { runFormChecks } from "./forms.test.mjs";
import { runListChecks } from "./lists.test.mjs";
import { runProjectListChecks } from "./listProjects.test.mjs";
import { runSetPropertyChecks } from "./listSetProperty.test.mjs";
import { runStatusAdviceChecks, runStatusChecks } from "./listStatuses.test.mjs";
import { runLinkToolChecks } from "./linkTools.test.mjs";
import { runSiteActionChecks } from "./siteActions.test.mjs";
import { runPathInjectionChecks } from "./pathInjection.test.mjs";
import { runCrossContextChecks } from "./crossContext.test.mjs";
import { runToolArgumentChecks } from "./toolArguments.test.mjs";
import { runLinkChecks } from "./links.test.mjs";
import { runActivityChecks } from "./activity.test.mjs";
import { runTreeHintChecks } from "./treeHints.test.mjs";
import { runForwardingChecks } from "./forwarding.test.mjs";
import { runPresenceChecks } from "./presence.test.mjs";
import { runAgentActivityChecks } from "./agentActivity.test.mjs";
import { runAgentMapChecks } from "./agentMap.test.mjs";
import { runStoredReadsChecks } from "./storedReads.test.mjs";
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
import { runHarnessExitChecks } from "./harnessExit.test.mjs";
import { runSearchD1Checks } from "./searchD1.test.mjs";
import { runSearchProjectionChecks } from "./searchProjection.test.mjs";
import { runAuditPartialMoveChecks } from "./auditPartialMove.test.mjs";
import { runReferenceRewriteAuditChecks } from "./auditReferenceRewrite.test.mjs";
import { runCredentialShapeChecks } from "./credentialShape.test.mjs";
import { runAgentChecks } from "./agent.test.mjs";
import { runAgentBuiltinChecks } from "./agentBuiltin.test.mjs";
import { runMeetingSummaryChecks } from "./meetingSummary.test.mjs";
import { runAgentGatewayChecks } from "./agentGateway.test.mjs";
import { runAgentComputerChecks } from "./agentComputer.test.mjs";
import { runAgentBrowseChecks } from "./agentBrowse.test.mjs";
import { runAgentRoutineChecks } from "./agentRoutine.test.mjs";
import { runAgentRoutineTexChecks } from "./agentRoutineTex.test.mjs";
import { runAgentDelegateRouteChecks } from "./agentDelegateRoute.test.mjs";
import { runAgentBackgroundRouteChecks } from "./agentBackgroundRoute.test.mjs";
import { runAgentTranscriptChecks } from "./agentTranscriptRoute.test.mjs";
import { runAgentDreamChecks } from "./agentDream.test.mjs";
import { runAgentHeartbeatChecks } from "./agentHeartbeat.test.mjs";
import { runAgentMailHealthChecks } from "./agentMailHealth.test.mjs";
import { runAgentHousekeepingChecks } from "./agentHousekeeping.test.mjs";
import { runAgentEgressChecks } from "./agentEgress.test.mjs";
import { runAgentEgressTextingChecks } from "./agentEgressTexting.test.mjs";
import { runEmailGateChecks } from "./emailGate.test.mjs";
import { runEmailGateOneThumbChecks } from "./emailGateOneThumb.test.mjs";
import { runEmailDraftChecks } from "./emailDraft.test.mjs";
import { runEmailReadChecks } from "./emailRead.test.mjs";
import { runCalendarGateChecks } from "./calendarGate.test.mjs";
import { runGoogleChatGateChecks } from "./googleChatGate.test.mjs";
import { runForwardRuleChecks } from "./forwardRule.test.mjs";
import { runReportGateChecks } from "./reportGate.test.mjs";
import { runAgentEgressJudgeChecks } from "./agentEgressJudge.test.mjs";
import { runAgentSearchChecks } from "./agentSearch.test.mjs";
import { runEncryptionChecks } from "./encryption.test.mjs";
import { runEncryptionGatewayChecks } from "./encryptionGateway.test.mjs";
import { runEncryptionPassphraseChecks } from "./encryptionPassphrase.test.mjs";
import { runEncryptionRotationChecks } from "./encryptionRotation.test.mjs";
import { runRotationCursorAdversarialChecks } from "./encryptionRotationCursor.test.mjs";
import { runStorageLayoutChecks, runStorageLayoutReadChecks } from "./storageLayout.test.mjs";

const SUITES = [
  // -- the binding → store table, and every way it refuses
  // Synchronous and network-free: it builds adapters and inspects them, so it
  // neither needs nor touches the shared fixture's control plane.
  ["runStoreFactoryChecks", () => runStoreFactoryChecks(check)],

  // -- multi-tenancy, OAuth, and the ways both are supposed to fail
  //
  // Last, and with its own control plane and object store: it swaps
  // globalThis.fetch and restores it, so it must not run beside a check that
  // still owns that global.
  // Orientation's budgeted walk and fail-soft handshake, against a bucket that
  // paginates and delimits honestly. Its own control plane, so it runs beside the
  // tenancy suite rather than against the shared fixture.
  ["runOrientationChecks", () => runOrientationChecks(check)],

  // The model account the agent spends, across the control-plane wire. Its own
  // control plane, for the same reason the tenancy suite has one: it swaps
  // globalThis.fetch and restores it.

  // The agent turn, end to end: a question in, tool calls through the same
  // dispatcher a client's go through, an answer out. Its own control plane, S3
  // backend and fake model, so — like the tenancy suite — it swaps globalThis.fetch
  // and restores it.
  ["runAgentChecks", () => runAgentChecks(check)],
  ["runAgentBuiltinChecks", () => runAgentBuiltinChecks(check)],
  ["runMeetingSummaryChecks", () => runMeetingSummaryChecks(check)],
  ["runAgentGatewayChecks", () => runAgentGatewayChecks(check)],
  ["runAgentComputerChecks", () => runAgentComputerChecks(check)],
  ["runAgentBrowseChecks", () => runAgentBrowseChecks(check)],
  ["runAgentRoutineChecks", () => runAgentRoutineChecks(check)],
  ["runAgentRoutineTexChecks", () => runAgentRoutineTexChecks(check)],
  // Tex hands a job to another agent, and its supervisor routine keeps it on track.
  ["runAgentDelegateRouteChecks", () => runAgentDelegateRouteChecks(check)],
  // Tex runs long asks as background jobs, several at once (`background.js`).
  ["runAgentBackgroundRouteChecks", () => runAgentBackgroundRouteChecks(check)],
  // Tex's daily transcript in tex/transcripts/, written as a text is answered.
  ["runAgentTranscriptChecks", () => runAgentTranscriptChecks(check)],
  ["runAgentDreamChecks", () => runAgentDreamChecks(check)],
  ["runAgentHeartbeatChecks", () => runAgentHeartbeatChecks(check)],
  // A broken mailbox bubbles up through check-ins, routines and orient.
  ["runAgentMailHealthChecks", () => runAgentMailHealthChecks(check)],
  ["runAgentHousekeepingChecks", () => runAgentHousekeepingChecks(check)],
  // The egress gate: a widening tool call waits for a person, outside the model.
  ["runAgentEgressChecks", () => runAgentEgressChecks(check)],
  // The texting-turn half of the egress gate, on its own fresh world (agentEgressFixtures.mjs).
  ["runAgentEgressTextingChecks", () => runAgentEgressTextingChecks(check)],
  // The send-review gate: every email waits for the person's yes to its exact copy.
  ["runEmailGateChecks", () => runEmailGateChecks(check)],
  ["runEmailGateOneThumbChecks", () => runEmailGateOneThumbChecks(check)],
  // A draft in the person's Gmail sends nothing, so it needs no yes.
  ["runEmailDraftChecks", () => runEmailDraftChecks(check)],
  ["runEmailReadChecks", () => runEmailReadChecks(check)],
  // The calendar gate: every change waits for the person's yes to it.
  ["runCalendarGateChecks", () => runCalendarGateChecks(check)],
  // A Google Chat message waits for the person's one yes or 👍 to it.
  ["runGoogleChatGateChecks", () => runGoogleChatGateChecks(check)],
  ["runForwardRuleChecks", () => runForwardRuleChecks(check)],
  // The bug-report gate: a report filed by text waits for the person's YES, and only then carries their texts.
  ["runReportGateChecks", () => runReportGateChecks(check)],
  // The gate with a judge: the person's words, read by a small model, decide (SHARING_JUDGE = "on").
  ["runAgentEgressJudgeChecks", () => runAgentEgressJudgeChecks(check)],
  ["runAgentSearchChecks", () => runAgentSearchChecks(check)],

  // A privacy rule that names a group: what the tools do when they meet one.
  // Its own control plane and bucket, like orientation, because the fixture is a
  // team folder with a group-scoped note inside it — the arrangement where a
  // guard that tests `=== "private"` instead of `!== "team"` actually leaks.
  ["runPrivacyGroupChecks", () => runPrivacyGroupChecks(check)],
  ["runFormChecks", () => runFormChecks(check)],
  ["runListChecks", () => runListChecks(check)],
  ["runProjectListChecks", () => runProjectListChecks(check)],
  ["runSetPropertyChecks", () => runSetPropertyChecks(check)],
  ["runStatusChecks", () => runStatusChecks(check)],
  ["runStatusAdviceChecks", () => runStatusAdviceChecks(check)],
  ["runLinkToolChecks", () => runLinkToolChecks(check)],
  ["runSiteActionChecks", () => runSiteActionChecks(check)],

  // A path is not a place to write privacy rules. Its own bucket, because the
  // fixture is one named private note and one forged path that tries to publish
  // it without ever naming it.
  ["runPathInjectionChecks", () => runPathInjectionChecks(check)],

  // The two communications reads, against their own bucket for the same reason:
  // the fixture here is two mailboxes with different visibilities, which is the
  // arrangement the "a mailbox is a folder" decision exists for.
  ["runCommunicationsChecks", () => runCommunicationsChecks(check)],
  // The two contact reads, in their own bucket for the same reason: the fixture
  // is one contact published, one held back, and a note of the user's own at a
  // key a sender could have picked — the arrangement that tells a lenient parse
  // apart from a positive identity marker.
  ["runContactsChecks", () => runContactsChecks(check)],
  ["runCommsSearchIndexChecks", () => runCommsSearchIndexChecks(check)],

  // The calendar sync: the Google-shaped adapter (calendarGoogle.test.mjs) and
  // the orchestrator against a fake, stateful Calendar API server
  // (calendarSync.test.mjs, fakeCalendarServer.mjs) — syncToken paging, the 410
  // fallback, the bounded horizon, per-day regeneration, disconnect as a real
  // no-op, and two workspaces' connections never touching each other's store.
  // Neither file shares state with anything else in this suite: each stands up
  // its own fake server and store per check block.
  ["runCalendarGoogleChecks", () => runCalendarGoogleChecks(check)],
  ["runCalendarSyncChecks", () => runCalendarSyncChecks(check)],

  // The search index. The two format halves are pure functions over their own
  // fixtures and touch no store or control plane, so they run anywhere; the
  // integration checks stand up their own instrumented bucket, like orientation,
  // because the properties that matter there are store-call counts.
  ["runSearchIndexerChecks", () => runSearchIndexerChecks(check)],
  ["runSearchQueryChecks", () => runSearchQueryChecks(check)],
  ["runSearchIntegrationChecks", () => runSearchIntegrationChecks(check)],
  // The sharded index (v2), in the same three layers: the storage half against
  // its own instrumented bucket, the query half as pure functions over fixtures,
  // and the gateway wired to both through the worker.
  ["runSearchShardsChecks", () => runSearchShardsChecks(check)],
  ["runSearchDocmapPathsChecks", () => runSearchDocmapPathsChecks(check)],
  ["runSearchShardQueryChecks", () => runSearchShardQueryChecks(check)],
  ["runSearchFilterChecks", () => runSearchFilterChecks(check)],
  ["runSearchV2IntegrationChecks", () => runSearchV2IntegrationChecks(check)],
  ["runSearchV2IntegrationShardChecks", () => runSearchV2IntegrationShardChecks(check)],
  // What a search *costs*: the ops it reserves for its own answer, the share of
  // the backfill it does while somebody waits, and the round trips it no longer
  // serializes.
  ["runSearchPacingChecks", () => runSearchPacingChecks(check)],
  ["runSearchPacingControlPlaneChecks", () => runSearchPacingControlPlaneChecks(check)],

  // The Obsidian plugin compatibility check: the scan as pure functions, the
  // inventory against its own bucket stubs, and the phrasing of the report. No
  // control plane and no shared fixture, so it runs anywhere in this file.
  ["runPluginChecks", () => runPluginChecks(check)],
  ["runContextPluginChecks", () => runContextPluginChecks(check)],

  // Links between notes, and the rewrite that keeps them pointing at what they
  // name after a move. Pure rules first, then the four move tools against a
  // worker of its own — see the file header for why it does not share this
  // fixture.
  ["runLinkChecks", () => runLinkChecks(check)],
  ["runForwardingChecks", () => runForwardingChecks(check)],

  // `activity.md`: the feed as a file in the customer's bucket. Pure format and
  // substance rules first, then a worker of its own — it writes to the root of
  // the bucket on every call, so it cannot share this fixture either.
  ["runActivityChecks", () => runActivityChecks(check)],
  ["runTreeHintChecks", () => runTreeHintChecks(check)],
  ["runDrawingChecks", () => runDrawingChecks(check)],
  ["runTenancyChecks", () => runTenancyChecks(check)],
  ["runCrossContextChecks", () => runCrossContextChecks(check)],
  // The two bulk-move suites (thousands of objects through the real S3 signing
  // path) run from test/bulkMoves.mjs, in their own process beside this one;
  // see test/run.mjs.
  // The arguments of a tool call, against the schema `tools/list` advertised for
  // it. Its own control plane and S3 backend, so — like the tenancy suite — it
  // swaps globalThis.fetch and restores it, and must not run while anything
  // above still owns that global.
  ["runToolArgumentChecks", () => runToolArgumentChecks(check)],
  ["runUsageReportingChecks", () => runUsageReportingChecks(check)],
  ["runSearchD1Checks", () => runSearchD1Checks(check)],
  // The copy itself: notes reaching the database fast search provisions. Its own
  // control plane, S3 backend and Cloudflare stub, so — like the tenancy suite —
  // it swaps globalThis.fetch and restores it, and must not run while anything
  // above still owns that global.
  ["runSearchProjectionChecks", () => runSearchProjectionChecks(check)],
  ["runAuditPartialMoveChecks", () => runAuditPartialMoveChecks(check)],
  ["runReferenceRewriteAuditChecks", () => runReferenceRewriteAuditChecks(check)],
  ["runCredentialShapeChecks", () => runCredentialShapeChecks(check)],
  ["runEncryptionChecks", () => runEncryptionChecks(check)],
  ["runEncryptionGatewayChecks", () => runEncryptionGatewayChecks(check)],
  ["runEncryptionPassphraseChecks", () => runEncryptionPassphraseChecks(check)],
  ["runEncryptionRotationChecks", () => runEncryptionRotationChecks(check)],
  ["runRotationCursorAdversarialChecks", () => runRotationCursorAdversarialChecks(check)],
  ["runStorageLayoutChecks", () => runStorageLayoutChecks()],
  ["runStorageLayoutReadChecks", () => runStorageLayoutReadChecks()],

  // Meeting ingestion: the routes a phone and a desktop app send a meeting to,
  // the one note it becomes, and the neighbour who knows its session id. Its own
  // control plane, its own S3 backend and its own fetch layer for failing a
  // single write, so — like the tenancy suite — it swaps globalThis.fetch and
  // restores it, and must not run while anything above still owns that global.
  ["runMeetingChecks", () => runMeetingChecks(check)],

  // A connected Gmail mailbox's sync job: Gmail API response parsing, backfill
  // and incremental sync against a fake Gmail server, idempotent upserts,
  // gap detection and full reconcile, and the quota bound. No network and no
  // dependency: `gmailSync.js` takes its socket and its store as parameters.
  ["runGmailSyncChecks", () => runGmailSyncChecks(check)],
  ["runDayPlacementChecks", () => runDayPlacementChecks(check)],

  // Google Chat sync: no shared globals, no worker fetch — pure functions plus
  // a fixture Chat API over an injected fetchImpl, so it runs anywhere in this
  // order without the swap-and-restore discipline the block above needs.
  ["runGoogleChatChecks", () => runGoogleChatChecks(check)],
  ["runChatContributionStoreChecks", () => runChatContributionStoreChecks(check)],

  // Presence: the pure roster module in full, then `GET /presence` up to the
  // point it hands a socket to its Durable Object. Its own control-plane stub and
  // its own buckets, and it installs and restores the fetch global itself, so it
  // runs here rather than inside a block that owns that global.
  ["runPresenceChecks", () => runPresenceChecks(check)],
  ["runCollaborationChecks", () => runCollaborationChecks(check)],
  ["runAgentActivityChecks", () => runAgentActivityChecks(check)],
  ["runAgentMapChecks", () => runAgentMapChecks(check)],
  ["runStoredReadsChecks", () => runStoredReadsChecks(check)],
  ["runNoteCapGatewayChecks", () => runNoteCapGatewayChecks(check)],
  ["runCalendarContributionStoreChecks", () => runCalendarContributionStoreChecks(check)],

  // Last, and about this file rather than the gateway: that a failure here
  // reaches the shell at all. Every check above is read by CI through an exit
  // status, so this one is the reason to believe the rest of them.
  ["runHarnessExitChecks", () => runHarnessExitChecks(check)],
];

const [shard, count] = process.argv.slice(2).map(Number);
if (!(count >= 1 && shard >= 0 && shard < count) || !Number.isInteger(shard) || !Number.isInteger(count)) {
  throw new Error("usage: node test/isolated.mjs <shard> <count>, with 0 <= shard < count");
}
const names = SUITES.map(([name]) => name);
if (new Set(names).size !== names.length) throw new Error("a suite is listed twice in test/isolated.mjs");

for (const [name, run] of SUITES.filter((_, index) => index % count === shard)) await suite(name, run);

console.log(getFailures() ? `\n${getFailures()} FAILURES` : "\nALL PASS");
