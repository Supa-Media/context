/**
 * `save_context`, and the share-link tools: `create_link`, `list_links`, `revoke_link`.
 *
 * Part of `baseToolDefinitions` (`../schemas.js`), which concatenates these
 * families in the order the list has always had; moved verbatim.
 */

export function saveAndLinkToolDefinitions() {
  return [
    {
      name: "save_context",
      description:
        "Save what mattered from this session back into the user's context, before it ends. " +
        "Call it when the work is done or the conversation is wrapping up — the decisions, the " +
        "transcript, or both, whatever their own procedure asks for. That procedure and the " +
        "destination are theirs: orient reports them from their index.md, and this tool tells you " +
        "what it assumed when they have not said. Personal connections save privately; team " +
        "connections save at team visibility. Exclude hidden prompts, reasoning, credentials, and " +
        "raw tool logs.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            description:
              "Short lower-case name of the client saving this, e.g. chatgpt, claude, codex, cursor",
          },
          content: {
            type: "string",
            description:
              "Markdown: the decisions, the user-visible transcript, or whatever this session's procedure asks to keep. Never hidden prompts, reasoning, credentials, or raw tool logs.",
          },
          history: {
            type: "string",
            description: "Deprecated alias for content.",
          },
          completeness: {
            type: "string",
            enum: ["full-visible-transcript", "available-context", "summary"],
            description:
              "Use full-visible-transcript only when every user-visible turn is available; defaults to available-context",
          },
          visibility: {
            type: "string",
            enum: ["private", "team"],
            description:
              "Optional explicit override. Omit to inherit connection access. Team-to-private requests require personal approval.",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required when a personal connection explicitly archives at team visibility",
          },
          title: { type: "string", description: "Optional human-readable conversation title" },
          session_id: { type: "string", description: "Optional source-platform conversation id" },
        },
        required: ["platform"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "create_link",
      description:
        "Mint a link to one note or folder and get the URL back. Use it whenever they ask for " +
        "a link to send, publish, or put in a signature — never assemble a URL yourself, and " +
        "never hand out a path and hope. audience=anyone opens without an account; " +
        "audience=members needs a live membership. Pass short to also claim a memorable address " +
        "under their handle, context.lc/@name/<short> — say first that a short name is guessable " +
        "by anyone who types it, which is the point of having one and is not true of the long " +
        "link. Pass mode=collect to make it a link that TAKES ANSWERS to a form on the note, from " +
        "people with no account — that is how a published intake form gets filled in, and it is " +
        "the only write in this product with no account behind it. Owner-only, revocable, and it " +
        "publishes nothing a link did not already publish.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The note, or the folder, this link opens." },
          audience: {
            type: "string",
            enum: ["anyone", "members"],
            description:
              "anyone opens with no account and is the one to use for a form or a page you are publishing. members still needs a live membership, so a link that leaks opens nothing. Defaults to anyone.",
          },
          kind: {
            type: "string",
            enum: ["note", "folder"],
            description:
              "What path is. Say folder to link a folder and the subtree beneath it; the subtree is still filtered to what the workspace can read. Defaults to note.",
          },
          short: {
            type: "string",
            description:
              "A memorable name under their handle: lowercase letters, digits and hyphens. Refused for a name Context writes into every workspace, or one already taken here — the link still works, and you are told why the name did not.",
          },
          mode: {
            type: "string",
            enum: ["read", "collect"],
            description:
              "read shows what the link points at. collect ALSO takes answers to a form on that note from people with no account, which is what makes a published intake form work — it needs audience=anyone and one note, never a folder. Tell them plainly: strangers can send answers, nobody can read the answers through the link, and an answer sent that way is final. Defaults to read.",
          },
          collect_cap: {
            type: "integer",
            minimum: 1,
            description:
              "With mode=collect, the most answers this link will take before it stops — 1 to 10000, and 500 if you leave it. It is what stands between a published URL and their whole storage quota, so raise it because they asked for a bigger form, never to be helpful. A number outside the range leaves the default standing rather than failing the mint.",
          },
          title_in_preview: {
            type: "boolean",
            description:
              "Whether the link's card names the note when it unfurls in a chat. Defaults to true; turning it off also takes the name out of the URL.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_links",
      description:
        "Every live link in this context: what it opens, who it is for, whether it is taking " +
        "answers, and its URL. Answers \"what have I published\" without opening the console.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "revoke_link",
      description:
        "Take a link back, by the id list_links gives. Immediate and final for that link — the " +
        "note and everything in it stay exactly as they are. A card that already unfurled in a " +
        "chat cannot be recalled, so say so if they are revoking something that was pasted.",
      inputSchema: {
        type: "object",
        properties: {
          share_id: { type: "string", description: "The link's id, as list_links reports it." },
        },
        required: ["share_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}
