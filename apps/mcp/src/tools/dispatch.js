/**
 * `callTool` — the dispatch switch from a tool name to its handler. Its
 * `case` labels are read off THIS FILE by toolArguments.test.mjs as the census
 * of every tool the gateway dispatches, so keep each one a string literal.
 */

import { loadPrivacyState } from "../privacy/state.js";
import { toolArchiveNote } from "./moves/archive.js";
import {
  toolCreateForm,
  toolRetractSubmission,
  toolSubmitForm,
  toolUpdateSubmission,
  toolVoteForm,
} from "./forms/tools.js";
import { toolCreateLink, toolListLinks, toolRevokeLink } from "./links.js";
import { toolReportProblem } from "./reportProblem.js";
import { toolSaveEmailDraft, toolSendEmail } from "./email.js";
import { toolReadEmail, toolSearchEmail } from "./emailRead.js";
import { toolCalendarEvent } from "./calendarWrite.js";
import { toolGoogleChat } from "./googleChat.js";
import { toolForwardRule } from "./forwardRule.js";
import { toolApplyLayout, toolConnectGoogle, toolCreateWorkspace, toolInviteMember } from "./workspaces.js";
import { toolDreamNow } from "./dreamNow.js";
import { toolNotifyMe } from "./attention.js";
import { toolVaultAddLink, toolVaultList, toolVaultShareLink, toolVaultViewLink } from "./vault.js";
import { toolError, toolText } from "./results.js";
import { toolExistenceMasked } from "./registry.js";
import { toolSetEncryption } from "./encryption/setEncryption.js";
import { toolListChanges } from "../activity/changes.js";
import {
  toolListChannelDays,
  toolListContacts,
  toolReadChannelDay,
  toolReadContact,
} from "./communications.js";
import { toolListMeetings, toolReadMeeting } from "./meetings.js";
import { toolReadCalendar } from "./calendarRead.js";
import { toolListNotes, toolReadNote } from "./notes/read.js";
import { toolListPlugins } from "../plugins/listPluginsTool.js";
import { toolListProposals, toolReadProposal } from "./proposals.js";
import { toolMigrateStorageLayout } from "../notes/storage.js";
import { toolMoveFolder } from "./moves/folder.js";
import { toolMoveNote } from "./moves/note.js";
import { toolMoveNotes } from "./moves/notes.js";
import { toolOpenAiFetch, toolOpenAiSearch, toolSearchNotes } from "./search.js";
import { toolRelatedNotes } from "./related.js";
import { toolOrient, toolScopeInfo } from "../orient/tool.js";
import { toolProposeNote, toolReviewProposal } from "./proposalActions.js";
import { toolReadActivity } from "../activity/readActivity.js";
import { toolReadImage } from "./readImage.js";
import { toolReadFile } from "./readFile.js";
import { toolRotateEncryptionKeys } from "./encryption/rotate.js";
import { toolSaveContext } from "./saveContext.js";
import { toolSetFolderVisibility, toolSetVisibility } from "./visibility.js";
import { toolWriteNote } from "./notes/write.js";
import { toolImageUploadLinks } from "../notes/imageUploads.js";
import { toolRemember } from "./notes/remember.js";
import { toolCommentNote } from "./notes/comment.js";
import { toolMailNote, toolReadMail } from "./notes/mail.js";
import { toolSiteAction } from "./notes/site.js";
import { toolEvaluateLists } from "./evaluateLists.js";
import { toolConnectApp, toolSlackApi } from "./connectors.js";
import { toolAppChange, toolAppRead } from "./apps.js";
import { servedListingStore, TreeUnavailable } from "../tree/served.js";

/**
 * The tools that only list and read: their walks are answered from the Convex
 * tree (`tree/served.js`) and never from the bucket. Where the tree cannot
 * answer, the call says so ("could not be read just now") rather than listing
 * storage. A tool that writes is not in this set: the names it needs come from
 * the tree too, one at a time (`tree/names.js`, `tree/twins.js`, `moves/folder.js`).
 */
export const TREE_LISTING_TOOLS = new Set([
  "orient",
  "list_notes",
  "evaluate_lists",
  "list_meetings",
  "read_calendar",
  "list_channel_days",
  "list_contacts",
]);

export async function callTool(name, args, store, scope) {
  if (!TREE_LISTING_TOOLS.has(name)) return await runTool(name, args, store, scope);
  try {
    return await runTool(name, args, servedListingStore(store), scope);
  } catch (error) {
    if (error instanceof TreeUnavailable) return toolError(error.message);
    throw error;
  }
}

/**
 * `read_note` for the gateway's own use, with the caller's privacy, outside
 * the argument-checked dispatch above: the mail footer (`mail/footer.js`)
 * reads the note a mailbox belongs to. The path comes from the control plane,
 * never from the caller.
 */
export async function readNoteForGateway(store, scope, path) {
  const privacy = await loadPrivacyState(store);
  if (privacy.error) return toolError("privacy manifest invalid");
  return toolReadNote(store, scope, privacy.rules, privacy.overrides, path);
}

async function runTool(name, args, store, scope) {
  const privacy = await loadPrivacyState(store);
  if (privacy.error) {
    return toolError(
      `privacy manifest invalid; access failed closed without exposing content: ${privacy.error}`
    );
  }
  const { rules, overrides } = privacy;
  switch (name) {
    case "orient":
      return toolOrient(store, scope, rules, overrides, { about: args.about, tools: args.tools === true });
    case "scope_info":
      return toolScopeInfo(store, scope, rules, overrides, args.path, args.workspaces === true);
    case "list_notes":
      return toolListNotes(store, scope, rules, overrides, args.prefix);
    case "read_note":
      if (args.mail !== undefined) return toolReadMail(store, scope, rules, overrides, args);
      return toolReadNote(store, scope, rules, overrides, args.path);
    case "evaluate_lists":
      return toolEvaluateLists(store, scope, rules, overrides, args.path);
    case "suggest_destination":
      if (typeof store.suggestDestination !== "function") {
        return toolError("routing suggestions are unavailable on this deployment");
      }
      return store.suggestDestination(args);
    case "list_meetings":
      return toolListMeetings(store, scope, rules, overrides, args.limit);
    case "read_calendar":
      return toolReadCalendar(store, scope, rules, overrides, args);
    case "read_meeting":
      return toolReadMeeting(store, scope, rules, overrides, args);
    case "list_channel_days":
      return toolListChannelDays(store, scope, rules, overrides, args);
    case "read_channel_day":
      return toolReadChannelDay(store, scope, rules, overrides, args);
    case "list_contacts":
      return toolListContacts(store, scope, rules, overrides, args);
    case "read_contact":
      return toolReadContact(store, scope, rules, overrides, args);
    case "read_file":
      return toolReadFile(store, scope, rules, overrides, args.path, args.from, args.summary ?? null);
    case "read_image":
      return toolReadImage(store, scope, rules, overrides, args);
    case "write_note":
      if (args.site !== undefined) return toolSiteAction(store, args);
      if (args.upload !== undefined) return toolImageUploadLinks(store, args);
      if (args.comment !== undefined) return toolCommentNote(store, scope, rules, overrides, args);
      if (args.mail !== undefined) return toolMailNote(store, scope, rules, overrides, args);
      return toolWriteNote(store, scope, rules, overrides, args);
    case "remember":
      return toolRemember(store, scope, rules, overrides, args);
    case "set_visibility":
      return toolSetVisibility(store, scope, rules, overrides, args);
    case "set_encryption":
      return toolSetEncryption(store, scope, rules, overrides, args);
    // Owner-only, and masked exactly like an invented tool name for every
    // other caller — the same idiom `docs/decisions/encryption.md` already
    // uses for a team-tier read of a private encrypted note ("byte-identical
    // to a path that never existed"), applied here to a *tool* rather than a
    // path. There is no key export here: the owner removed it on 2026-10-08,
    // and its name now gets the default's `unknown tool` like any other.
    case "rotate_encryption_keys":
      if (toolExistenceMasked(name, scope)) return toolError(`unknown tool: ${name}`);
      return toolRotateEncryptionKeys(store, scope);
    case "set_folder_visibility":
      return toolSetFolderVisibility(store, scope, args);
    case "propose_note":
      return toolProposeNote(store, scope, args.path, args.content, args.reason, args.agent);
    case "list_proposals":
      return toolListProposals(store, scope);
    case "read_proposal":
      return toolReadProposal(store, scope, args.id);
    case "review_proposal":
      return toolReviewProposal(
        store,
        scope,
        args.id,
        args.action,
        args.destination,
        args.review_note
      );
    case "search":
      return toolOpenAiSearch(store, scope, rules, overrides, args.query);
    case "fetch":
      return toolOpenAiFetch(store, scope, rules, overrides, args.id);
    case "search_notes":
      return toolSearchNotes(store, scope, rules, overrides, args.query, args.prefix);
    case "related_notes":
      return toolRelatedNotes(store, scope, rules, overrides, args);
    case "archive_note":
      return toolArchiveNote(store, scope, rules, overrides, args.path, args.expected_etag);
    case "move_note":
      return toolMoveNote(
        store,
        scope,
        rules,
        overrides,
        args.source,
        args.destination,
        args.expected_source_etag
      );
    case "move_notes":
      return toolMoveNotes(store, scope, rules, overrides, args.moves, args.dry_run === true);
    case "move_folder":
      return toolMoveFolder(store, scope, rules, overrides, args.source, args.destination, args.dry_run === true);
    // `archive_chat` is the name this tool shipped under, and a client holding
    // a cached tool list is still calling it. It is no longer *listed* — the
    // rename is the point — but refusing it would drop sessions on the floor
    // for every connection made before this deploy.
    case "archive_chat":
    case "save_context":
      return toolSaveContext(store, scope, rules, overrides, args);
    case "list_changes":
      return toolListChanges(store, scope, rules, overrides, args.limit, { reads: args.reads === true });
    case "read_activity":
      return toolReadActivity(store, scope, rules, overrides, args);
    case "migrate_storage_layout":
      if (toolExistenceMasked(name, scope)) return toolError(`unknown tool: ${name}`);
      return toolMigrateStorageLayout(store, scope, args);
    case "create_link":
      return toolCreateLink(store, scope, args);
    case "vault_list":
      return toolVaultList(store, args);
    case "vault_add_link":
      return toolVaultAddLink(store, args);
    case "vault_share_link":
      return toolVaultShareLink(store, args);
    case "vault_view_link":
      return toolVaultViewLink(store, args);
    case "report_problem":
      return toolReportProblem(store, args);
    case "send_email":
      return toolSendEmail(store, args);
    case "save_email_draft":
      return toolSaveEmailDraft(store, args);
    case "search_email":
      return toolSearchEmail(store, scope, rules, overrides, args);
    case "read_email":
      return toolReadEmail(store, args);
    case "calendar_event":
      return toolCalendarEvent(store, args);
    case "google_chat":
      return toolGoogleChat(store, args);
    case "forward_rule":
      return toolForwardRule(store, args);
    case "create_workspace":
      return toolCreateWorkspace(store, args);
    case "apply_layout":
      return toolApplyLayout(store, args);
    case "connect_google":
      return toolConnectGoogle(store, args);
    case "connect_app":
      return toolConnectApp(store, args);
    case "slack_api":
      return toolSlackApi(store, args);
    case "app_read":
      return toolAppRead(store, args);
    case "app_change":
      return toolAppChange(store, args);
    case "invite_member":
      return toolInviteMember(store, args);
    case "dream_now":
      return toolDreamNow(store, scope);
    case "notify_me":
      return toolNotifyMe(store, scope, rules, overrides, args);
    case "list_links":
      return toolListLinks(store, scope);
    case "revoke_link":
      return toolRevokeLink(store, scope, args);
    case "create_form":
      return toolCreateForm(store, scope, rules, overrides, args);
    case "submit_form":
      return toolSubmitForm(store, scope, rules, overrides, args);
    case "update_submission":
      return toolUpdateSubmission(store, scope, rules, overrides, args);
    case "retract_submission":
      return toolRetractSubmission(store, scope, rules, overrides, args);
    case "vote_form":
      return toolVoteForm(store, scope, rules, overrides, args);
    case "list_plugins":
      // **The owner's, like the note census.** `.obsidian/` sits outside the
      // privacy manifest's reach, and `isPlumbing` hides every dot-segment from
      // `read_note`, `list_notes` and search for every role — so this is the
      // only read path into that prefix, and it was open at the lowest read
      // tier because this line passed the store and not the scope.
      //
      // What that handed a plain `member` of somebody else's context: every
      // plugin's id, name, version and author, which blocked internals each
      // bundle names, and up to twelve hostnames pulled out of the bundle text.
      // A count over what they cannot see, and then the list. That is the
      // reasoning `getStorageBinding` already applies to the note census, and
      // #201 widened who can ask by making one connection reach every context
      // its person belongs to.
      if (scope !== "private") {
        return toolError(
          "reading this context's Obsidian plugins is the context owner's.",
        );
      }
      return toolListPlugins(store);
    default:
      return toolError(`unknown tool: ${name}`);
  }
}
