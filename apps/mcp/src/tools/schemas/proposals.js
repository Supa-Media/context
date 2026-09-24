/**
 * `list_plugins`, then the proposal tools: `propose_note`, `list_proposals`, `read_proposal`, `review_proposal`.
 *
 * Part of `baseToolDefinitions` (`../schemas.js`), which concatenates these
 * families in the order the list has always had; moved verbatim.
 */

export function proposalToolDefinitions() {
  return [
    {
      name: "list_plugins",
      description:
        "Check the Obsidian plugins already in this context's bucket and report, for each one, "
        + "whether Context can run it, whether it needs the owner to approve a host it calls, "
        + "whether it stays in Obsidian while Context reads the files it writes, or whether it "
        + "cannot run here — with the specific call that decides it. Reads .obsidian/plugins/ and "
        + "writes nothing; the Obsidian setup is left exactly as it is.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "propose_note",
      description:
        "Queue a new markdown note for a correct destination that this connection cannot currently write. The proposal is hidden from team listings and must be approved by a personal connection; it never overwrites an existing note.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Intended destination ending in .md" },
          content: { type: "string" },
          reason: { type: "string", description: "Why this is the correct durable destination" },
          agent: { type: "string", description: "Submitting agent name, e.g. Claude Code" },
        },
        required: ["path", "content", "reason"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_proposals",
      description:
        "Private connection only. List pending note proposals with destination, submitter, reason, timestamp, and size; content is omitted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "read_proposal",
      description: "Private connection only. Read one pending note proposal by proposal id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "review_proposal",
      description:
        "Private connection only. Approve or reject a pending note proposal. Approval creates a new note only when the destination does not exist; destination may be corrected during review. Rejected and approved proposal records remain in hidden reviewed history.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["approve", "reject"] },
          destination: {
            type: "string",
            description: "Optional corrected destination for approval; must end in .md",
          },
          review_note: { type: "string", description: "Optional private review rationale" },
        },
        required: ["id", "action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
