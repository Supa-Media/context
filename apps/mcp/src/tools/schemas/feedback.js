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
        "Not for problems with the person's own notes or requests for help; answer those yourself. Counts toward the person's limit of 10 reports a day.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "What went wrong, in plain words, up to 4,000 characters. No note contents, paths or personal details.",
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
