/** The problem-report tool. See `tools/reportProblem.js`. */
export function feedbackToolDefinitions() {
  return [
    {
      name: "report_problem",
      title: "Report a problem",
      description:
        "Report a problem with Context itself to the people who build it: a tool that failed or returned something wrong, an error message, behaviour that contradicts what a tool's description promises. " +
        "Send it when you hit such a problem; you do not need to ask first. Describe what you called, what you expected, what happened instead, and any error text, in plain words. " +
        "Never include note contents, note or folder paths, names, email addresses or anything else from the person's workspace: say 'a note in a team folder', not its path or text. " +
        "Not for problems with the person's own notes or requests for help; answer those yourself. Counts toward the person's limit of 10 reports a day. " +
        "By text, when the person wants to report a bug: write what went wrong in a few plain sentences as the message, and pass share_texts true so your recent texts with them go too. " +
        "They are shown the exact report and must give it a 👍 or say yes before anything is sent; nothing goes to the team without it.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "What went wrong, in plain words, up to 4,000 characters. No note contents, paths or personal details.",
          },
          share_texts: {
            type: "boolean",
            description:
              "By text with Tex only: also send the last few messages between you and the person, once they give the report a 👍 or say yes. Refused from any other AI.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
      // Changes nothing in any workspace, so every connection is offered it; it
      // does send text outside Context, which `openWorldHint` says.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
  ];
}
