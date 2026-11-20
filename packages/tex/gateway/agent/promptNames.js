/**
 * NAMES A PROMPT MAY NOT TEACH TEX (Dev2, 2026-11-06, the context review).
 *
 * Since 2026-10-16 Tex is offered six tools (`sixTools.js`: orient, search,
 * fetch, write, manage, send), each listing its actions. The tool shelf before
 * them (`find_tools` and about thirty single tools: `read_note`, `send_email`,
 * `calendar_event`, ...) stayed in the production prompt and in lines written
 * by code, so Haiku was told to call tools it was never given. The older names
 * still work when a model calls them, but nothing tells the model they exist,
 * and `find_tools` is gone for good.
 *
 * `staleToolNames(text)` lists the retired names a prompt names. The gateway
 * logs them when the production setup is read (`production.js`), and
 * `test/texPromptNames.test.mjs` renders every prompt Tex is given and fails on
 * any. Name an action the way the model calls it: `send action calendar`,
 * `write`, `fetch id "texts:"`, `manage action move_many`.
 */

/** Each retired name, with how a prompt says it now. */
export const RETIRED_TOOL_NAMES = Object.freeze({
  find_tools: "(gone: every action is listed in the six tools)",
  search_notes: "search",
  read_note: "fetch",
  read_notes: "fetch",
  list_notes: "fetch (a folder's path)",
  write_note: "write",
  write_notes: "write action save_many",
  read_skill: 'fetch id "skill:<name>"',
  read_learned_skill: 'fetch id "learned:<name>"',
  earlier_texts: 'fetch id "texts:"',
  earlier_chat: 'fetch id "chat:"',
  scope_info: 'orient about: "<folder>"',
  move_note: "manage action move",
  move_notes: "manage action move_many",
  archive_note: "manage action archive",
  set_visibility: "manage action visibility",
  create_link: "manage action share_link",
  vault_list: "send action api",
  vault_add_link: "manage action vault_add",
  vault_view_link: "manage action vault_view",
  vault_share_link: "manage action vault_share",
  send_email: "send action email",
  save_email_draft: "send action email_draft",
  calendar_event: "send action calendar",
  slack_api: "send action slack",
  app_read: 'fetch id "apps:"',
  app_change: "send action app",
  connect_app: "manage action connect",
  text_progress: "send action progress",
  ask_advisor: "send action advisor",
  start_background_job: "send action background",
  steer_background_job: "send action steer_job",
  notify_me: "send action notify",
  "about-me.md": "about.md",
  "privacy.md": "(gone: access lives on folders and notes)",
});

const NAMES = Object.keys(RETIRED_TOOL_NAMES).sort((a, b) => b.length - a.length);
const PATTERN = new RegExp(`(?<![A-Za-z0-9_-])(?:${NAMES.map((name) => name.replace(/[.]/g, "\\.")).join("|")})(?![A-Za-z0-9_])`, "g");

/** The retired names `text` mentions, each once, in the order first seen. */
export function staleToolNames(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return [...new Set(text.match(PATTERN) ?? [])];
}
