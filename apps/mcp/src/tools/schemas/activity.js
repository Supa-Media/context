/**
 * `migrate_storage_layout`, `read_activity` and `list_changes`.
 *
 * Part of `baseToolDefinitions` (`../schemas.js`), which concatenates these
 * families in the order the list has always had; moved verbatim.
 */

export function activityToolDefinitions() {
  return [
    {
      name: "migrate_storage_layout",
      description:
        "Owner-only maintenance: copy legacy Context-owned hidden objects into the consolidated .context tree in a resumable batch; after the copy is verified, cleanup=true removes the legacy copies.",
      inputSchema: {
        type: "object",
        properties: {
          batch_size: { type: "integer", minimum: 1, maximum: 8, description: "Objects to process in this call; default 8" },
          cleanup: { type: "boolean", description: "Remove verified legacy copies; allowed only after copying completes" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: "read_activity",
      description:
        "Read this context's activity: what people and AI clients have changed lately, newest " +
        "first, in sentences rather than log lines. Backed by activity.md at the root of the " +
        "bucket, filtered to what this connection may see. Use it to catch up before working, " +
        "and to avoid redoing something a colleague's client already did.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 30" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_changes",
      description:
        "List every recorded change, including ones activity.md judges too small to mention, as " +
        "immutable records filtered to paths visible to this connection. Records contain actions " +
        "and paths, never note content. Prefer read_activity for catching up; this is the trail.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}
