/** The date properties backfill. See `tools/fillDates.js`. */
export function fillDatesToolDefinitions() {
  return [
    {
      name: "fill_dates",
      title: "Fill date properties",
      description:
        "Fill every empty `date created` and `date modified` (and created, modified, updated, date_created, date_modified, created_at, updated_at) " +
        "in this context from each note's own history: when it was first saved and when its text last changed, in the format the note or workspace " +
        "already uses, in the owner's time zone. A value already there is kept, and a note without these keys is never touched. Context fills them on " +
        "every save already; this is the one pass for notes written before. Owner only. A long context answers in passes: call again with the `after` it names.",
      inputSchema: {
        type: "object",
        properties: {
          after: { type: "string", description: "Where the last pass stopped, exactly as its answer named it." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
