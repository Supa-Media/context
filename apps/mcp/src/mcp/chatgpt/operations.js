/** Reviewed, individually callable operations. No client-name or reviewer branches. */
import { ACTIONS } from "../../tools/v2/actions.js";

const entries = [];
function add(name, target, source, options = {}) {
  entries.push({ name, target, source, ...options });
}

for (const name of ["orient", "scope_info", "list_notes", "read_note", "read_notes", "evaluate_lists", "list_meetings", "read_calendar", "read_meeting", "list_channel_days", "read_channel_day", "list_contacts", "read_contact", "read_image", "read_file", "list_plugins", "related_notes", "read_activity", "list_changes", "list_links", "search_email", "read_email", "search_texts", "list_texts", "read_texts", "read_google_chat"]) add(name, name, `read.${name}`);
entries[0].description = "Read the selected Context workspace's front page, recent updates, folder map, access and saved conventions for a user-requested task about their Context data. Use about for the available tools or a specific guide, and since for changes after an earlier orientation.";
add("get_profile", null, "read.profile", { custom: "profile" });
add("list_workspaces", null, "read.workspaces", { custom: "workspaces" });
add("search", "search_notes", "read.search", { custom: "search" });
add("fetch", "read_note", "read.fetch", { custom: "fetch", description: "Read a Context note or supported read-only resource by its id, optionally prefixed with @workspace/. Return its content, source URL and note revision when available. Use update_note with that revision to replace a note. Dynamic connected-app execution is excluded; use separately exposed service tools for service operations." });
add("list_saved_credentials", "vault_list", "read.vault", { fields: [], readOnly: true, openWorld: false, description: "List the user's saved credential entries by metadata. Secret values are not returned and no external API is executed." });
add("list_connected_apps", "app_read", "read.apps", { fields: [], readOnly: true, description: "List the apps connected to the user's Context account and their connection status. This operation does not invoke an app tool." });

add("create_note", "write_note", "write.save", { fields: ["path", "content", "summary", "images"], required: ["path", "content"], custom: "create", destructive: false, description: "Create a new Markdown note, including supported page and form content and optional images. Refuse an existing path. Existing workspace access rules apply; this does not mint a share link or publish a website." });
add("update_note", "write_note", "write.save", { fields: ["path", "content", "expected_etag", "summary", "images"], required: ["path", "content", "expected_etag"], custom: "update", destructive: true, description: "Replace an existing Markdown note, including supported page and form content and optional images. Require the current revision and preserve its access settings. This does not mint a share link or publish a website." });
add("save_notes", "write_note", "write.save_many", { custom: "save_many", destructive: true, openWorld: false, description: "Save up to 100 explicitly supplied notes. Each save uses its own path, content and optional revision; results report each success or refusal. This does not change visibility or publish links." });
for (const [action, name] of Object.entries({ add: "add_comment", reply: "reply_to_comment", resolve: "resolve_comment", reopen: "reopen_comment", delete: "delete_comment" })) {
  const fields = action === "add" ? ["quote", "occurrence", "text"] : action === "reply" ? ["thread", "text"] : ["thread"];
  add(name, "write_note", "write.comment", { nested: "comment", fixed: { action }, fields, required: ["path", ...(action === "add" ? ["quote", "text"] : action === "reply" ? ["thread", "text"] : ["thread"])], destructive: !["add", "reply"].includes(action), openWorld: false, description: `${action[0].toUpperCase() + action.slice(1)} a comment thread on the specified Context note. The comment and its author are recorded on that note.` });
}
add("join_note_mail", "write_note", "write.mail", { nested: "mail", fields: ["join", "device"], required: ["path", "join"], destructive: false, openWorld: false, description: "Join the specified note's agent mailbox under a name, optionally binding the already paired device. Return the mailbox ID for subsequent note-mail calls." });
add("send_note_mail", "write_note", "write.mail", { nested: "mail", fields: ["text", "to", "kind", "wait"], required: ["path", "text"], destructive: true, openWorld: false, description: "Send the supplied message to agents participating in the specified note's mailbox. It is recorded on the note and may notify or interrupt its recipient according to existing permissions." });
add("prepare_image_upload", "write_note", "write.upload", { custom: "upload", destructive: false, openWorld: false, description: "Create short-lived upload tickets for the specified image names, hashes and sizes in this workspace. Return upload commands; attach the uploaded images in a subsequent note write." });
add("remember", "remember", "write.remember", { destructive: true, description: "Save a durable fact the user asked Context to retain, or replace the specified prior fact. Use the stated or inferred label accurately. Existing note access and revision protections apply." });
for (const [source, name] of Object.entries({ answer: "submit_form", update_answer: "update_submission", retract_answer: "retract_submission", vote: "vote_form" })) add(name, name, `write.${source}`, { destructive: source !== "answer" });
add("create_form", "create_form", "write.save", { destructive: false });
add("save_context", "save_context", "write.save_session", { fields: ["platform", "content", "visibility", "confirm_team_publish", "title", "session_id"], required: ["platform", "content"], fixed: { completeness: "summary" }, destructive: false, description: "Save a concise, task-specific summary the user asked to retain in Context. Include relevant decisions and outcomes only. Do not provide raw transcripts, conversation history or unrelated context. Follow the workspace's save destination and access rules." });
add("report_problem", "report_problem", "write.report_problem", { fields: ["message"], required: ["message"], readOnly: false, destructive: false, openWorld: true, description: "Send a concise problem report about Context itself to its developers when the user requests it. Supply only the failed operation, expected behavior, actual behavior and sanitized error text. Exclude workspace note contents, paths, names, contact details, credentials and conversation history. This tool sends the supplied message only; no recent texts are attached. The existing ten-reports-per-day limit applies." });

for (const [source, target] of Object.entries({ move: "move_note", move_many: "move_notes", move_folder: "move_folder", archive: "archive_note", visibility: "set_visibility", folder_visibility: "set_folder_visibility", encrypt: "set_encryption", suggest_destination: "suggest_destination", share_link: "create_link", revoke_link: "revoke_link", vault_add: "vault_add_link", vault_share: "vault_share_link", vault_view: "vault_view_link", create_workspace: "create_workspace", invite: "invite_member", layout: "apply_layout", connect_google: "connect_google", connect: "connect_app", dream_now: "dream_now", fill_dates: "fill_dates", pair_device: "pair_device" })) add(source === "dream_now" ? "run_context_reflection" : target, target, `manage.${source}`, { destructive: !["suggest_destination", "vault_add", "vault_share", "vault_view", "create_workspace", "invite", "connect_google", "connect", "pair_device"].includes(source), ...(["visibility", "create_workspace"].includes(source) ? { openWorld: true } : {}) });
entries.find(op => op.name === "run_context_reflection").description = "At the user's request, start Context's Tex reflection process for their personal workspace. It reads their existing Tex conversations and, on its first run, their front page, then updates tex/about.md and records changes in tex/dreams/. It does not collect this client's conversation history or send a message. Owner, plan, concurrent-run and six-hour frequency limits apply.";
add("set_folder_job", "apply_layout", "manage.folder_job", { fields: ["job", "path", "remove"], destructive: true, description: "Assign an existing folder to a built-in workspace job, create its folder, or remove an optional job assignment. Existing owner permissions apply." });
const siteOperations = [
  ["get_website_status", "status", [], true],
  ["check_website", "check", ["inspect"], true],
  ["publish_website", "publish", ["draft"], false],
  ["screenshot_website", "screenshot", ["page", "sizes"], false],
  ["read_website_history", "history", ["revision", "inspect"], true],
  ["get_website_domain", "domain", [], true],
  ["connect_website_domain", "domain", ["hostname"], false],
];
for (const [name, action, fields, readOnly] of siteOperations) add(name, "write_note", "manage.website", { nested: "site", fields, fixed: { action }, readOnly, destructive: !readOnly, openWorld: true, required: name === "publish_website" ? ["draft"] : name === "connect_website_domain" ? ["hostname"] : [], description: ({ get_website_status: "Read the Context website's current draft and published status.", check_website: "Validate the Context website draft and optionally inspect a source page; return problems and the checked draft identifier.", publish_website: "Publish the explicitly selected, previously checked Context website draft to its public addresses. Refuse if the draft changed. This makes its pages publicly accessible.", screenshot_website: "Render the specified public Context website page at the selected sizes and return its screenshots and layout checks.", read_website_history: "List published Context website revisions, or read the specified revision's files for a possible rollback.", get_website_domain: "Read the Context website's custom domain, DNS requirements and verification status.", connect_website_domain: "Connect the supplied domain, which the user must own, to this workspace's public website. Existing owner and domain verification controls apply." })[name] });

for (const [source, name] of Object.entries({ email: "send_email", email_draft: "save_email_draft", notify: "notify_me" })) add(name, name, `send.${source}`, { destructive: source !== "email_draft" });
for (const action of ["create", "edit", "move", "cancel", "rsvp"]) {
  const common = ["title", "start", "calendar", "as", "all_events"];
  const fields = action === "create" ? ["title", "start", "end", "location", "notes", "guests", "meet", "reminders", "recurrence", "calendar", "as"] : action === "edit" ? [...common, "new_title", "new_start", "new_end", "location", "notes", "add_guests", "remove_guests", "meet", "reminders", "recurrence"] : action === "move" ? [...common, "new_start", "new_end"] : action === "rsvp" ? [...common, "response"] : common;
  add(`${action}_calendar_event`, "calendar_event", "send.calendar", { fixed: { action }, fields, required: ["title", "start", ...(action === "create" ? ["end"] : action === "move" ? ["new_start", "new_end"] : action === "rsvp" ? ["response"] : [])], destructive: true, openWorld: true, description: `${action[0].toUpperCase() + action.slice(1)} one event in the user's connected Google Calendar, only for the change they requested. The existing Context approval gate applies; no change is completed until its required approval is received.` });
}
add("list_google_chat_spaces", "google_chat", "send.google_chat", { fixed: { action: "spaces" }, fields: [], readOnly: true, description: "List the Google Chat spaces in the user's connected account." });
add("send_google_chat_message", "google_chat", "send.google_chat", { fixed: { action: "send" }, fields: ["to", "space", "text"], required: ["text"], destructive: true, description: "Send the user's requested Google Chat message to the specified person or space after the existing approval of its exact content and destination." });
for (const action of ["start", "stop"]) add(`${action}_mail_forwarding`, "forward_rule", "send.forward_rule", { fixed: { action }, fields: action === "start" ? ["routine", "to", "about"] : ["routine"], required: action === "start" ? ["routine", "to", "about"] : ["routine"], destructive: true, description: action === "start" ? "Request approval for the supplied standing rule forwarding the specified kind of mail to one address. Once approved, its existing Context routine may keep forwarding without repeated approvals." : "Stop the specified Context routine's standing mail-forwarding permission." });
const slack = {
  "users.list": ["list_slack_users", true], "users.info": ["read_slack_user", true],
  "users.lookupByEmail": ["find_slack_user_by_email", true], "chat.getPermalink": ["get_slack_message_link", true],
  "conversations.list": ["list_slack_channels", true], "conversations.info": ["read_slack_channel", true],
  "conversations.history": ["read_slack_history", true], "conversations.replies": ["read_slack_thread", true],
  "search.messages": ["search_slack_messages", true], "chat.postMessage": ["post_slack_message", false],
  "chat.update": ["update_slack_message", false], "chat.delete": ["delete_slack_message", false],
  "chat.scheduleMessage": ["schedule_slack_message", false], "chat.meMessage": ["post_slack_action", false],
  "reactions.add": ["add_slack_reaction", false], "reactions.remove": ["remove_slack_reaction", false],
};
for (const [method, [name, readOnly]] of Object.entries(slack)) add(name, "slack_api", "send.slack", { custom: "slack", fixed: { method }, readOnly, destructive: !readOnly, openWorld: true, description: method === "chat.meMessage" ? "Post the supplied text as a Slack /me action message in the specified channel, using the user's connected Slack account. This invokes only chat.meMessage. Existing account permissions and approval for the exact message and destination apply." : `${readOnly ? "Read" : "Perform the user's requested change through"} Slack ${method} in the user's connected account. This tool invokes only that fixed operation. Existing account permissions and any required send approval apply.` });

/** Entire inventory, not just the connection's currently authorized subset. */
export const chatgptOperations = () => entries;

// These can replace a prior record or send an irreversible notification.
for (const op of entries) if (["save_context", "report_problem", "invite_member", "create_workspace"].includes(op.name)) op.destructive = true;

/** A missing capability is a failing census, not an implicit product decision. */
export function chatgptCoverage() {
  return Object.entries(ACTIONS).flatMap(([family, actions]) => Object.keys(actions).map(action => {
    const capability = `${family}.${action}`;
    const tools = entries.filter(entry => entry.source === capability).map(entry => entry.name);
    const exclusion = capability === "send.api" ? "Arbitrary vault-backed API execution is excluded: destinations and operations are not individually exposed for directory review." : capability === "send.app" ? "Dynamically discovered connected-app execution is excluded: future operations cannot be individually reviewed in this fixed contract." : capability === "manage.run_model" ? "The Architecture Lab's model runs are staff-only (people who edit @context-lc's AI setup) and are not part of this directory contract." : null;
    return { capability, tools, ...(exclusion ? { exclusion } : {}), ...(capability === "write.save_session" ? { limitation: "User-requested task summaries only; no raw-history field or automatic capture." } : {}) };
  }));
}
