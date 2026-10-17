/**
 * Every v2 action, and the existing tool that carries it out.
 *
 * A v2 call (`write`, `manage`, `send`, `search`, `fetch`) is translated into
 * one call of an existing tool before anything else happens (`translate.js`),
 * so routing, the write gate, the egress gate, argument validation and audit
 * all see exactly the call they saw before v2 and decide it the same way.
 * Nothing here decides authority: a table entry only says which tool an
 * action is, and how its arguments are spelled there.
 *
 * Adding a capability is adding a row. `orient` renders this table as the
 * live manual, and the tool's own description and schema (what the row's
 * `tool` advertises) are the reference for its arguments.
 *
 * Tools whose existence is masked from most callers (`EXISTENCE_MASKED_TOOLS`)
 * are deliberately absent: an action name is listed to everybody, so mapping
 * one would publish what the mask hides.
 */

/** Top-level `write` fields, merged under the action's own `args`. */
function withNote(call, extra = {}) {
  const out = { ...(call.args || {}), ...extra };
  if (call.path !== undefined) out.path = call.path;
  if (call.content !== undefined) out.content = call.content;
  if (call.expected_etag !== undefined) out.expected_etag = call.expected_etag;
  return out;
}

/** `{ path, <key>: args }`: the write_note sub-objects (comment, mail, site, upload). */
function nested(key) {
  return (call) => {
    const out = { [key]: call.args || {} };
    if (call.path !== undefined) out.path = call.path;
    return out;
  };
}

/**
 * `manage website`: write_note's `site`, whose path is required but names no
 * page (every site action is about the whole website). manage takes no path
 * of its own, so one given in `args` moves beside `site`, and none means the
 * website's home page.
 */
function website(call) {
  const { path, ...site } = call.args || {};
  return { path: path ?? "website/index.md", site };
}

/** The action's `args`, as the tool's own arguments. */
const plain = (call) => ({ ...(call.args || {}) });

export const ACTIONS = {
  write: {
    save: { tool: "write_note", summary: "Create or replace a note (the default).", take: (call) => withNote(call) },
    comment: { tool: "write_note", summary: "Comment on words in a note, reply, resolve or delete.", take: nested("comment") },
    mail: { tool: "write_note", summary: "Join a note's mail or send mail to agents working on it.", take: nested("mail") },
    upload: {
      tool: "write_note",
      summary: "Get upload commands for image files too big to send inline.",
      // write_note's `upload` is a list, so it travels as `args.files`.
      take: (call) => ({ ...(call.path !== undefined ? { path: call.path } : {}), upload: call.args?.files }),
    },
    remember: { tool: "remember", summary: "Save one durable fact about the person.", take: plain },
    propose: { tool: "propose_note", summary: "Queue a note for a folder you cannot write.", take: (call) => withNote(call) },
    answer: { tool: "submit_form", summary: "Answer a Markdown form.", take: (call) => withNote(call) },
    update_answer: { tool: "update_submission", summary: "Replace your answer to a form.", take: (call) => withNote(call) },
    retract_answer: { tool: "retract_submission", summary: "Delete your answer to a form.", take: (call) => withNote(call) },
    vote: { tool: "vote_form", summary: "Upvote, or take back a vote on, a form answer.", take: (call) => withNote(call) },
    save_session: { tool: "save_context", summary: "Save what mattered from this session before it ends.", take: (call) => withNote(call) },
    report_problem: { tool: "report_problem", summary: "Tell Context's builders something in Context is broken.", take: plain },
  },
  manage: {
    move: { tool: "move_note", summary: "Move or rename one note, also into another workspace.", take: plain },
    move_many: { tool: "move_notes", summary: "Move up to 100 notes at once, all or none.", take: plain },
    move_folder: { tool: "move_folder", summary: "Move or rename a folder and everything in it.", take: plain },
    archive: { tool: "archive_note", summary: "Move a note into the archive (there is no delete).", take: plain },
    visibility: { tool: "set_visibility", summary: "Make one note private or team, or name people who may open it.", take: plain },
    folder_visibility: { tool: "set_folder_visibility", summary: "Make a folder private, team or inherited.", take: plain },
    encrypt: { tool: "set_encryption", summary: "Encrypt or decrypt one note.", take: plain },
    review_proposal: { tool: "review_proposal", summary: "Approve or reject a proposed note.", take: plain },
    suggest_destination: { tool: "suggest_destination", summary: "Rank which workspace a note belongs in.", take: plain },
    website: { tool: "write_note", summary: "Check, publish, screenshot or roll back the website, or set its domain.", take: website },
    share_link: { tool: "create_link", summary: "Make a link to a note or folder (owners only).", take: plain },
    revoke_link: { tool: "revoke_link", summary: "Turn a link off.", take: plain },
    vault_add: { tool: "vault_add_link", summary: "Get a link where the person saves a login or secret.", take: plain },
    vault_share: { tool: "vault_share_link", summary: "Get a link to give a saved login to another member.", take: plain },
    vault_view: { tool: "vault_view_link", summary: "Get a link where the person sees a saved entry.", take: plain },
  },
  send: {
    api: {
      tool: "vault_list",
      summary: "Call an API with a key from the vault; the key is added for you and never shown.",
      take: (call) => ({ fetch: call.args || {} }),
    },
    email: {
      tool: "send_email",
      summary: "Send one email as the person through their Gmail, once they say yes to that exact email.",
      take: plain,
    },
  },
};

/** The v2 tools whose calls carry an `action`. */
export const ACTION_TOOLS = new Set(Object.keys(ACTIONS));

/** The action a call names, with `write`'s default. */
export function actionOf(tool, args) {
  if (tool === "write" && (args.action === undefined || args.action === null || args.action === "")) return "save";
  return args.action;
}
