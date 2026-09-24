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
import { toolError } from "./results.js";
import { toolExistenceMasked } from "./registry.js";
import { toolExportEncryptionKeys, toolSetEncryption } from "./encryption/setEncryption.js";
import { toolListChanges } from "../activity/changes.js";
import {
  toolListChannelDays,
  toolListContacts,
  toolReadChannelDay,
  toolReadContact,
} from "./communications.js";
import { toolListMeetings, toolReadMeeting } from "./meetings.js";
import { toolListNotes, toolReadNote } from "./notes/read.js";
import { toolListPlugins } from "../plugins/listPluginsTool.js";
import { toolListProposals, toolReadProposal } from "./proposals.js";
import { toolMaterializeMove } from "./moves/materialize.js";
import { toolMigrateStorageLayout } from "../notes/storage.js";
import { toolMoveFolder } from "./moves/folder.js";
import { toolMoveNote } from "./moves/note.js";
import { toolMoveNotes } from "./moves/notes.js";
import { toolOpenAiFetch, toolOpenAiSearch, toolSearchNotes } from "./search.js";
import { toolOrient, toolScopeInfo } from "../orient/tool.js";
import { toolProposeNote, toolReviewProposal } from "./proposalActions.js";
import { toolReadActivity } from "../activity/readActivity.js";
import { toolReadImage } from "./readImage.js";
import { toolRotateEncryptionKeys } from "./encryption/rotate.js";
import { toolSaveContext } from "./saveContext.js";
import { toolSetFolderVisibility, toolSetVisibility } from "./visibility.js";
import { toolWriteNote } from "./notes/write.js";

export async function callTool(name, args, store, scope) {
  const privacy = await loadPrivacyState(store);
  if (privacy.error) {
    return toolError(
      `privacy manifest invalid; access failed closed without exposing content: ${privacy.error}`
    );
  }
  const { rules, overrides } = privacy;
  switch (name) {
    case "orient":
      return toolOrient(store, scope, rules, overrides);
    case "scope_info":
      return toolScopeInfo(store, scope, rules, overrides, args.path, args.workspaces === true);
    case "list_notes":
      return toolListNotes(store, scope, rules, overrides, args.prefix);
    case "read_note":
      return toolReadNote(store, scope, rules, overrides, args.path);
    case "list_meetings":
      return toolListMeetings(store, scope, rules, overrides, args.limit);
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
    case "read_image":
      return toolReadImage(store, scope, rules, overrides, args);
    case "write_note":
      return toolWriteNote(store, scope, rules, overrides, args);
    case "set_visibility":
      return toolSetVisibility(store, scope, rules, overrides, args);
    case "set_encryption":
      return toolSetEncryption(store, scope, rules, overrides, args);
    // Owner-only, and masked exactly like an invented tool name for every
    // other caller — the same idiom `docs/decisions/encryption.md` already
    // uses for a team-tier read of a private encrypted note ("byte-identical
    // to a path that never existed"), applied here to a *tool* rather than a
    // path. `set_encryption` and `list_plugins` answer a team-tier caller with
    // a distinct "permission denied" message, which is fine for a capability
    // whose existence is not itself sensitive; a workspace's key material is
    // a narrower thing to advertise, so this refuses as though the tool were
    // never registered at all.
    case "export_encryption_keys":
      if (toolExistenceMasked(name, scope)) return toolError(`unknown tool: ${name}`);
      return toolExportEncryptionKeys(store, scope);
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
    case "materialize_move":
      if (toolExistenceMasked(name, scope)) return toolError(`unknown tool: ${name}`);
      if (scope !== "private") return toolError("permission denied: move materialization requires owner access.");
      return toolMaterializeMove(store, scope, args.id, args.batch_size);
    // `archive_chat` is the name this tool shipped under, and a client holding
    // a cached tool list is still calling it. It is no longer *listed* — the
    // rename is the point — but refusing it would drop sessions on the floor
    // for every connection made before this deploy.
    case "archive_chat":
    case "save_context":
      return toolSaveContext(store, scope, rules, overrides, args);
    case "list_changes":
      return toolListChanges(store, scope, rules, overrides, args.limit);
    case "read_activity":
      return toolReadActivity(store, scope, rules, overrides, args);
    case "migrate_storage_layout":
      if (toolExistenceMasked(name, scope)) return toolError(`unknown tool: ${name}`);
      return toolMigrateStorageLayout(store, scope, args);
    case "create_link":
      return toolCreateLink(store, scope, args);
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
