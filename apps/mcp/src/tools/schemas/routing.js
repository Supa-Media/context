/** Destination routing dry-run. */

export function routingToolDefinitions() {
  return [
    {
      name: "suggest_destination",
      title: "Check a destination suggestion",
      description:
        "Dry-run a ranked set of workspace candidates after orienting in each relevant context. " +
        "The backend applies fixed confidence thresholds and checks write authorization separately. " +
        "It never accepts note text, paths, or rationale, and it never writes note content. A unique " +
        "authorized result is recorded as a content-free audit event in the suggested destination.",
      inputSchema: {
        type: "object",
        properties: {
          candidates: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            description:
              "Ranked workspace candidates derived after orienting. Scores are whole percentages.",
            items: {
              type: "object",
              properties: {
                context: { type: "string", description: 'Workspace name, such as "@supa".' },
                confidence: {
                  type: "integer",
                  minimum: 0,
                  maximum: 100,
                  description: "Semantic fit, independent of whether the connection may write there.",
                },
              },
              required: ["context", "confidence"],
              additionalProperties: false,
            },
          },
          content_classification: {
            type: "string",
            enum: ["personal", "shared", "unknown"],
            default: "unknown",
            description:
              "Whether the information is safe for a shared workspace. Unknown is treated like personal.",
          },
          expected_decision_id: {
            type: "string",
            description:
              "Decision id from an earlier dry-run. A changed candidate, score, reach, role, or source returns routing.destination_changed.",
          },
        },
        required: ["candidates"],
        additionalProperties: false,
      },
      // The call writes only a content-free audit event after it has one
      // authorized destination. It is therefore not advertised on a grant
      // that cannot write anywhere, even though it never writes a note.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
