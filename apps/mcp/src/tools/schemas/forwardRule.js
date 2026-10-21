/** The standing-forward tool. See `tools/forwardRule.js` and `tools/forwardRuleGate.js`. */
export function forwardRuleToolDefinitions() {
  return [
    {
      name: "forward_rule",
      title: "Keep forwarding mail",
      description:
        "Let one routine keep forwarding one kind of the person's mail (receipts, invoices) to one address, without asking each " +
        "time. start: write the routine note first, under tex/routines/<schedule>/, saying what to look for since its last run " +
        "and to forward each match with send_email forward to that address (body \"Forwarded automatically.\"), answering SKIP " +
        "when there is none; then call this with the routine's path, to and a few words on what is forwarded. The person is shown " +
        "the rule and their 👍 keeps it. stop: the routine's path; it stops at once. Only when the person asked for this.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "stop"] },
          routine: { type: "string", description: "The routine note's path, like tex/routines/hourly/forward-receipts.md." },
          to: { type: "string", description: "start only: the one address mail is forwarded to." },
          about: { type: "string", description: "start only: what is forwarded, in a few words, like \"receipts and invoices\"." },
        },
        required: ["routine"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}
