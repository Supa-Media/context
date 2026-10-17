/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as functions_builtInFolders from "../functions/builtInFolders.js";
import type * as functions_stagingPersonas from "../functions/stagingPersonas.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as functions_admin from "../functions/admin.js";
import type * as functions_account from "../functions/account.js";
import type * as functions_accountDeletion from "../functions/accountDeletion.js";
import type * as functions_accountSetup from "../functions/accountSetup.js";
import type * as functions_audit from "../functions/audit.js";
import type * as functions_billing from "../functions/billing.js";
import type * as functions_jev from "../functions/jev.js";
import type * as functions_billingStripe from "../functions/billingStripe.js";
import type * as functions_authorizations from "../functions/authorizations.js";
import type * as functions_cardAssets from "../functions/cardAssets.js";
import type * as functions_cardRender from "../functions/cardRender.js";
import type * as functions_chaosScore from "../functions/chaosScore.js";
import type * as functions_chatProduct from "../functions/chatProduct.js";
import type * as functions_cloudflare from "../functions/cloudflare.js";
import type * as functions_collect from "../functions/collect.js";
import type * as functions_contentReports from "../functions/contentReports.js";
import type * as functions_contextMoves from "../functions/contextMoves.js";
import type * as functions_contextPlugins from "../functions/contextPlugins.js";
import type * as functions_controlPlane from "../functions/controlPlane.js";
import type * as functions_customDomains from "../functions/customDomains.js";
import type * as functions_customDomainsProvision from "../functions/customDomainsProvision.js";
import type * as functions_devlog from "../functions/devlog.js";
import type * as functions_dropboxRemoval from "../functions/dropboxRemoval.js";
import type * as functions_emoji from "../functions/emoji.js";
import type * as functions_emojiMeaning from "../functions/emojiMeaning.js";
import type * as functions_emailProof from "../functions/emailProof.js";
import type * as functions_signInAlerts from "../functions/signInAlerts.js";
import type * as functions_emailRecovery from "../functions/emailRecovery.js";
import type * as functions_faces from "../functions/faces.js";
import type * as functions_encryptionKeys from "../functions/encryptionKeys.js";
import type * as functions_fastSearch from "../functions/fastSearch.js";
import type * as functions_fastSearchProvision from "../functions/fastSearchProvision.js";
import type * as functions_files from "../functions/files.js";
import type * as functions_folderIcons from "../functions/folderIcons.js";
import type * as functions_folderNotes from "../functions/folderNotes.js";
import type * as functions_folders from "../functions/folders.js";
import type * as functions_forms from "../functions/forms.js";
import type * as functions_formNotify from "../functions/formNotify.js";
import type * as functions_foundingPremium from "../functions/foundingPremium.js";
import type * as functions_gatewayWorkspaces from "../functions/gatewayWorkspaces.js";
import type * as functions_grants from "../functions/grants.js";
import type * as functions_groups from "../functions/groups.js";
import type * as functions_ingestion from "../functions/ingestion.js";
import type * as functions_ingestionGateway from "../functions/ingestionGateway.js";
import type * as functions_invitationEmail from "../functions/invitationEmail.js";
import type * as functions_invitations from "../functions/invitations.js";
import type * as functions_managedHandoff from "../functions/managedHandoff.js";
import type * as functions_handoffEmail from "../functions/handoffEmail.js";
import type * as functions_moveCatchUp from "../functions/moveCatchUp.js";
import type * as functions_managedEncryption from "../functions/managedEncryption.js";
import type * as functions_managedErasure from "../functions/managedErasure.js";
import type * as functions_managedProvisioning from "../functions/managedProvisioning.js";
import type * as functions_meaningAdmin from "../functions/meaningAdmin.js";
import type * as functions_meaningProvision from "../functions/meaningProvision.js";
import type * as functions_meaningSearch from "../functions/meaningSearch.js";
import type * as functions_lib_admin from "../functions/lib/admin.js";
import type * as functions_lib_appSecrets from "../functions/lib/appSecrets.js";
import type * as functions_lib_audit from "../functions/lib/audit.js";
import type * as functions_lib_cardArt from "../functions/lib/cardArt.js";
import type * as functions_lib_cardCoverage from "../functions/lib/cardCoverage.js";
import type * as functions_lib_cardFont_onest from "../functions/lib/cardFont/onest.js";
import type * as functions_lib_cardKey from "../functions/lib/cardKey.js";
import type * as functions_lib_cloudflare from "../functions/lib/cloudflare.js";
import type * as functions_lib_consentScopes from "../functions/lib/consentScopes.js";
import type * as functions_lib_crypto from "../functions/lib/crypto.js";
import type * as functions_lib_d1 from "../functions/lib/d1.js";
import type * as functions_lib_pkce from "../functions/lib/pkce.js";
import type * as functions_lib_fastSearch from "../functions/lib/fastSearch.js";
import type * as functions_lib_fileOps from "../functions/lib/fileOps.js";
import type * as functions_lib_gatewayAuth from "../functions/lib/gatewayAuth.js";
import type * as functions_lib_googleOAuth from "../functions/lib/googleOAuth.js";
import type * as functions_lib_identities from "../functions/lib/identities.js";
import type * as functions_lib_ingestLog from "../functions/lib/ingestLog.js";
import type * as functions_lib_ingestion from "../functions/lib/ingestion.js";
import type * as functions_lib_ingestionStore from "../functions/lib/ingestionStore.js";
import type * as functions_lib_invitationEmail from "../functions/lib/invitationEmail.js";
import type * as functions_lib_invitees from "../functions/lib/invitees.js";
import type * as functions_lib_nameClaims from "../functions/lib/nameClaims.js";
import type * as functions_lib_names from "../functions/lib/names.js";
import type * as functions_lib_noteCount from "../functions/lib/noteCount.js";
import type * as functions_lib_noteLinks from "../functions/lib/noteLinks.js";
import type * as functions_lib_googleSchedule from "../functions/lib/googleSchedule.js";
import type * as functions_lib_privacy from "../functions/lib/privacy.js";
import type * as functions_lib_rateLimit from "../functions/lib/rateLimit.js";
import type * as functions_lib_scaffold from "../functions/lib/scaffold.js";
import type * as functions_lib_shareTitle from "../functions/lib/shareTitle.js";
import type * as functions_lib_usage from "../functions/lib/usage.js";
import type * as functions_lib_verification from "../functions/lib/verification.js";
import type * as functions_lib_workspaceAuth from "../functions/lib/workspaceAuth.js";
import type * as functions_calendarConnect from "../functions/calendarConnect.js";
import type * as functions_googleConnect from "../functions/googleConnect.js";
import type * as functions_googlePush from "../functions/googlePush.js";
import type * as functions_googleSync from "../functions/googleSync.js";
import type * as functions_meetings_demoTranscribe from "../functions/meetings/demoTranscribe.js";
import type * as functions_meetings_transcribe from "../functions/meetings/transcribe.js";
import type * as functions_names from "../functions/names.js";
import type * as functions_nodes from "../functions/nodes.js";
import type * as functions_nodesGateway from "../functions/nodesGateway.js";
import type * as functions_nodesListing from "../functions/nodesListing.js";
import type * as functions_nodesMigration from "../functions/nodesMigration.js";
import type * as functions_noteIds from "../functions/noteIds.js";
import type * as functions_noteIdsCleanup from "../functions/noteIdsCleanup.js";
import type * as functions_noteIdsCleanupRun from "../functions/noteIdsCleanupRun.js";
import type * as functions_noteIdsCopy from "../functions/noteIdsCopy.js";
import type * as functions_noteIdsKeyed from "../functions/noteIdsKeyed.js";
import type * as functions_nodesFeed from "../functions/nodesFeed.js";
import type * as functions_nodeChaos from "../functions/nodeChaos.js";
import type * as functions_nodeFacts from "../functions/nodeFacts.js";
import type * as functions_nodeMoves from "../functions/nodeMoves.js";
import type * as functions_nodeMovesAdmin from "../functions/nodeMovesAdmin.js";
import type * as functions_nodeRowMoves from "../functions/nodeRowMoves.js";
import type * as functions_nodesPrivacy from "../functions/nodesPrivacy.js";
import type * as functions_nodesAccess from "../functions/nodesAccess.js";
import type * as functions_privacyRows from "../functions/privacyRows.js";
import type * as functions_nodesPurge from "../functions/nodesPurge.js";
import type * as functions_owners from "../functions/owners.js";
import type * as functions_obsidianPlugins from "../functions/obsidianPlugins.js";
import type * as functions_agentGrant from "../functions/agentGrant.js";
import type * as functions_providers from "../functions/providers.js";
import type * as functions_provisioning from "../functions/provisioning.js";
import type * as functions_shareCard from "../functions/shareCard.js";
import type * as functions_sharedInbox from "../functions/sharedInbox.js";
import type * as functions_shares from "../functions/shares.js";
import type * as functions_storage from "../functions/storage.js";
import type * as functions_smallData from "../functions/smallData.js";
import type * as functions_storageLag from "../functions/storageLag.js";
import type * as functions_storageMover from "../functions/storageMover.js";
import type * as functions_feedback from "../functions/feedback.js";
import type * as functions_blocks from "../functions/blocks.js";
import type * as functions_reports from "../functions/reports.js";
import type * as functions_messages from "../functions/messages.js";
import type * as functions_places from "../functions/places.js";
import type * as functions_phoneCheck from "../functions/phoneCheck.js";
import type * as functions_signInEmails from "../functions/signInEmails.js";
import type * as functions_otherEmail from "../functions/otherEmail.js";
import type * as functions_workspaceDomains from "../functions/workspaceDomains.js";
import type * as functions_telemetry from "../functions/telemetry.js";
import type * as functions_appearance from "../functions/appearance.js";
import type * as functions_textLinks from "../functions/textLinks.js";
import type * as functions_textSetup from "../functions/textSetup.js";
import type * as functions_routines from "../functions/routines.js";
import type * as functions_retiredTables from "../functions/retiredTables.js";
import type * as functions_dreams from "../functions/dreams.js";
import type * as functions_heartbeats from "../functions/heartbeats.js";
import type * as functions_housekeeping from "../functions/housekeeping.js";
import type * as functions_builtinModel from "../functions/builtinModel.js";
import type * as functions_meetingSummary from "../functions/meetingSummary.js";
import type * as functions_agentTurns from "../functions/agentTurns.js";
import type * as functions_searchTimings from "../functions/searchTimings.js";
import type * as functions_trash from "../functions/trash.js";
import type * as functions_trashEmptying from "../functions/trashEmptying.js";
import type * as functions_trashedNotes from "../functions/trashedNotes.js";
import type * as functions_treeChanges from "../functions/treeChanges.js";
import type * as functions_treeSignals from "../functions/treeSignals.js";
import type * as functions_vault from "../functions/vault.js";
import type * as functions_vaultSettings from "../functions/vaultSettings.js";
import type * as functions_featureSwitches from "../functions/featureSwitches.js";
import type * as functions_waitlist from "../functions/waitlist.js";
import type * as functions_waitlistText from "../functions/waitlistText.js";
import type * as functions_waitlistTex from "../functions/waitlistTex.js";
import type * as functions_signupAlerts from "../functions/signupAlerts.js";
import type * as functions_xConversions from "../functions/xConversions.js";
import type * as functions_metaConversions from "../functions/metaConversions.js";
import type * as functions_referrals from "../functions/referrals.js";
import type * as functions_usage from "../functions/usage.js";
import type * as functions_websites from "../functions/websites.js";
import type * as functions_workspaces from "../functions/workspaces.js";
import type * as functions_workspaceMoves from "../functions/workspaceMoves.js";
import type * as http from "../http.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "functions/builtInFolders": typeof functions_builtInFolders;
  "functions/stagingPersonas": typeof functions_stagingPersonas;
  auth: typeof auth;
  crons: typeof crons;
  "functions/admin": typeof functions_admin;
  "functions/account": typeof functions_account;
  "functions/accountDeletion": typeof functions_accountDeletion;
  "functions/accountSetup": typeof functions_accountSetup;
  "functions/audit": typeof functions_audit;
  "functions/billing": typeof functions_billing;
  "functions/jev": typeof functions_jev;
  "functions/billingStripe": typeof functions_billingStripe;
  "functions/managedHandoff": typeof functions_managedHandoff;
  "functions/handoffEmail": typeof functions_handoffEmail;
  "functions/moveCatchUp": typeof functions_moveCatchUp;
  "functions/managedEncryption": typeof functions_managedEncryption;
  "functions/managedErasure": typeof functions_managedErasure;
  "functions/managedProvisioning": typeof functions_managedProvisioning;
  "functions/meaningAdmin": typeof functions_meaningAdmin;
  "functions/meaningProvision": typeof functions_meaningProvision;
  "functions/meaningSearch": typeof functions_meaningSearch;
  "functions/authorizations": typeof functions_authorizations;
  "functions/cardAssets": typeof functions_cardAssets;
  "functions/cardRender": typeof functions_cardRender;
  "functions/chaosScore": typeof functions_chaosScore;
  "functions/chatProduct": typeof functions_chatProduct;
  "functions/collect": typeof functions_collect;
  "functions/cloudflare": typeof functions_cloudflare;
  "functions/contentReports": typeof functions_contentReports;
  "functions/contextMoves": typeof functions_contextMoves;
  "functions/contextPlugins": typeof functions_contextPlugins;
  "functions/controlPlane": typeof functions_controlPlane;
  "functions/customDomains": typeof functions_customDomains;
  "functions/customDomainsProvision": typeof functions_customDomainsProvision;
  "functions/devlog": typeof functions_devlog;
  "functions/dropboxRemoval": typeof functions_dropboxRemoval;
  "functions/emoji": typeof functions_emoji;
  "functions/emojiMeaning": typeof functions_emojiMeaning;
  "functions/emailProof": typeof functions_emailProof;
  "functions/signInAlerts": typeof functions_signInAlerts;
  "functions/emailRecovery": typeof functions_emailRecovery;
  "functions/faces": typeof functions_faces;
  "functions/encryptionKeys": typeof functions_encryptionKeys;
  "functions/fastSearch": typeof functions_fastSearch;
  "functions/fastSearchProvision": typeof functions_fastSearchProvision;
  "functions/files": typeof functions_files;
  "functions/folderIcons": typeof functions_folderIcons;
  "functions/folderNotes": typeof functions_folderNotes;
  "functions/folders": typeof functions_folders;
  "functions/forms": typeof functions_forms;
  "functions/formNotify": typeof functions_formNotify;
  "functions/foundingPremium": typeof functions_foundingPremium;
  "functions/gatewayWorkspaces": typeof functions_gatewayWorkspaces;
  "functions/grants": typeof functions_grants;
  "functions/groups": typeof functions_groups;
  "functions/ingestion": typeof functions_ingestion;
  "functions/ingestionGateway": typeof functions_ingestionGateway;
  "functions/invitationEmail": typeof functions_invitationEmail;
  "functions/invitations": typeof functions_invitations;
  "functions/lib/admin": typeof functions_lib_admin;
  "functions/lib/appSecrets": typeof functions_lib_appSecrets;
  "functions/lib/audit": typeof functions_lib_audit;
  "functions/lib/cardArt": typeof functions_lib_cardArt;
  "functions/lib/cardCoverage": typeof functions_lib_cardCoverage;
  "functions/lib/cardFont/onest": typeof functions_lib_cardFont_onest;
  "functions/lib/cardKey": typeof functions_lib_cardKey;
  "functions/lib/cloudflare": typeof functions_lib_cloudflare;
  "functions/lib/consentScopes": typeof functions_lib_consentScopes;
  "functions/lib/crypto": typeof functions_lib_crypto;
  "functions/lib/d1": typeof functions_lib_d1;
  "functions/lib/pkce": typeof functions_lib_pkce;
  "functions/lib/fastSearch": typeof functions_lib_fastSearch;
  "functions/lib/fileOps": typeof functions_lib_fileOps;
  "functions/lib/gatewayAuth": typeof functions_lib_gatewayAuth;
  "functions/lib/googleOAuth": typeof functions_lib_googleOAuth;
  "functions/lib/identities": typeof functions_lib_identities;
  "functions/lib/ingestLog": typeof functions_lib_ingestLog;
  "functions/lib/ingestion": typeof functions_lib_ingestion;
  "functions/lib/ingestionStore": typeof functions_lib_ingestionStore;
  "functions/lib/invitationEmail": typeof functions_lib_invitationEmail;
  "functions/lib/invitees": typeof functions_lib_invitees;
  "functions/lib/nameClaims": typeof functions_lib_nameClaims;
  "functions/lib/names": typeof functions_lib_names;
  "functions/lib/noteCount": typeof functions_lib_noteCount;
  "functions/lib/noteLinks": typeof functions_lib_noteLinks;
  "functions/lib/googleSchedule": typeof functions_lib_googleSchedule;
  "functions/lib/privacy": typeof functions_lib_privacy;
  "functions/lib/rateLimit": typeof functions_lib_rateLimit;
  "functions/lib/scaffold": typeof functions_lib_scaffold;
  "functions/lib/shareTitle": typeof functions_lib_shareTitle;
  "functions/lib/usage": typeof functions_lib_usage;
  "functions/lib/verification": typeof functions_lib_verification;
  "functions/lib/workspaceAuth": typeof functions_lib_workspaceAuth;
  "functions/calendarConnect": typeof functions_calendarConnect;
  "functions/googleConnect": typeof functions_googleConnect;
  "functions/googlePush": typeof functions_googlePush;
  "functions/googleSync": typeof functions_googleSync;
  "functions/meetings/demoTranscribe": typeof functions_meetings_demoTranscribe;
  "functions/meetings/transcribe": typeof functions_meetings_transcribe;
  "functions/names": typeof functions_names;
  "functions/nodes": typeof functions_nodes;
  "functions/nodesGateway": typeof functions_nodesGateway;
  "functions/nodesListing": typeof functions_nodesListing;
  "functions/nodesMigration": typeof functions_nodesMigration;
  "functions/noteIds": typeof functions_noteIds;
  "functions/noteIdsCleanup": typeof functions_noteIdsCleanup;
  "functions/noteIdsCleanupRun": typeof functions_noteIdsCleanupRun;
  "functions/noteIdsCopy": typeof functions_noteIdsCopy;
  "functions/noteIdsKeyed": typeof functions_noteIdsKeyed;
  "functions/nodesFeed": typeof functions_nodesFeed;
  "functions/nodeChaos": typeof functions_nodeChaos;
  "functions/nodeFacts": typeof functions_nodeFacts;
  "functions/nodeMoves": typeof functions_nodeMoves;
  "functions/nodeMovesAdmin": typeof functions_nodeMovesAdmin;
  "functions/nodeRowMoves": typeof functions_nodeRowMoves;
  "functions/nodesPrivacy": typeof functions_nodesPrivacy;
  "functions/nodesAccess": typeof functions_nodesAccess;
  "functions/privacyRows": typeof functions_privacyRows;
  "functions/nodesPurge": typeof functions_nodesPurge;
  "functions/owners": typeof functions_owners;
  "functions/obsidianPlugins": typeof functions_obsidianPlugins;
  "functions/agentGrant": typeof functions_agentGrant;
  "functions/providers": typeof functions_providers;
  "functions/provisioning": typeof functions_provisioning;
  "functions/shareCard": typeof functions_shareCard;
  "functions/sharedInbox": typeof functions_sharedInbox;
  "functions/shares": typeof functions_shares;
  "functions/storage": typeof functions_storage;
  "functions/smallData": typeof functions_smallData;
  "functions/storageLag": typeof functions_storageLag;
  "functions/storageMover": typeof functions_storageMover;
  "functions/feedback": typeof functions_feedback;
  "functions/blocks": typeof functions_blocks;
  "functions/reports": typeof functions_reports;
  "functions/messages": typeof functions_messages;
  "functions/places": typeof functions_places;
  "functions/phoneCheck": typeof functions_phoneCheck;
  "functions/signInEmails": typeof functions_signInEmails;
  "functions/otherEmail": typeof functions_otherEmail;
  "functions/workspaceDomains": typeof functions_workspaceDomains;
  "functions/telemetry": typeof functions_telemetry;
  "functions/appearance": typeof functions_appearance;
  "functions/textLinks": typeof functions_textLinks;
  "functions/textSetup": typeof functions_textSetup;
  "functions/routines": typeof functions_routines;
  "functions/retiredTables": typeof functions_retiredTables;
  "functions/dreams": typeof functions_dreams;
  "functions/heartbeats": typeof functions_heartbeats;
  "functions/housekeeping": typeof functions_housekeeping;
  "functions/builtinModel": typeof functions_builtinModel;
  "functions/meetingSummary": typeof functions_meetingSummary;
  "functions/agentTurns": typeof functions_agentTurns;
  "functions/searchTimings": typeof functions_searchTimings;
  "functions/trash": typeof functions_trash;
  "functions/trashEmptying": typeof functions_trashEmptying;
  "functions/trashedNotes": typeof functions_trashedNotes;
  "functions/treeChanges": typeof functions_treeChanges;
  "functions/treeSignals": typeof functions_treeSignals;
  "functions/usage": typeof functions_usage;
  "functions/vault": typeof functions_vault;
  "functions/vaultSettings": typeof functions_vaultSettings;
  "functions/featureSwitches": typeof functions_featureSwitches;
  "functions/waitlist": typeof functions_waitlist;
  "functions/waitlistText": typeof functions_waitlistText;
  "functions/waitlistTex": typeof functions_waitlistTex;
  "functions/signupAlerts": typeof functions_signupAlerts;
  "functions/xConversions": typeof functions_xConversions;
  "functions/metaConversions": typeof functions_metaConversions;
  "functions/referrals": typeof functions_referrals;
  "functions/websites": typeof functions_websites;
  "functions/workspaces": typeof functions_workspaces;
  "functions/workspaceMoves": typeof functions_workspaceMoves;
  http: typeof http;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
