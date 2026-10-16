/**
 * The three v2 tools that are new names: `write`, `manage` and `send`.
 *
 * With `orient`, `search` and `fetch` (in `../schemas/core.js`) they are the
 * whole advertised surface (decided 2026-10-16,
 * docs/decisions/gateway-protocol/six-tools.md). Each takes an `action` and an
 * open `args` object, so a capability added next year is a new action the
 * gateway validates, not a new argument a client's frozen copy of this schema
 * would strip. `orient` carries the live manual of every action.
 *
 * The split is by risk, so a client can ask a person before the riskier ones:
 * `write` adds or changes content, `manage` changes something Context can
 * undo (where a note lives, who sees it), `send` does something Context
 * cannot take back (an email sent, an outside API called).
 */

/** The open object every action's own arguments travel in. */
const ARGS = {
  type: "object",
  description:
    "The action's own arguments. orient lists every action and what it takes, and that list is newer " +
    "than this description.",
};

export function v2ToolDefinitions() {
  return [
    {
      name: "write",
      title: "Write",
      description:
        "Add to or change the person's notes. With no action, saves path with content (pass the etag you " +
        "read as expected_etag). Other actions: comment, mail, remember, propose, answer, update_answer, " +
        "retract_answer, vote, upload, save_session, report_problem. orient lists every action and its args.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Omit to save a note. Otherwise one of the actions orient lists." },
          path: { type: "string", description: "The note, e.g. '1-projects/togather/status.md'." },
          content: { type: "string", description: "The whole note as Markdown, when saving." },
          expected_etag: { type: "string", description: "The etag you read, so a concurrent edit is caught." },
          args: ARGS,
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "manage",
      title: "Manage",
      description:
        "Change where something lives or who sees it, in ways Context can undo: move, move_many, " +
        "move_folder, archive, visibility, folder_visibility, encrypt, review_proposal, suggest_destination, " +
        "website, share_link, revoke_link, vault_add, vault_share, vault_view. Ask the person before anything " +
        "that lets more people see something. orient lists every action and its args.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "One of the actions orient lists." },
          args: ARGS,
        },
        required: ["action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: "send",
      title: "Send",
      description:
        "Do something outside Context that cannot be taken back: api calls a site with a key saved in the " +
        "vault, which you never see. Ask the person first. orient lists every action and its args.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "One of the actions orient lists, e.g. api." },
          args: ARGS,
        },
        required: ["action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
