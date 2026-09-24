/**
 * `search_notes`, then the tools that move notes: `archive_note`, `move_note`, `move_notes`, `move_folder`, `materialize_move`.
 *
 * Part of `baseToolDefinitions` (`../schemas.js`), which concatenates these
 * families in the order the list has always had; moved verbatim.
 */

import { MOVE_MATERIALIZE_BATCH } from "../../moves/limits.js";

export function searchAndMoveToolDefinitions() {
  return [
    {
      name: "search_notes",
      description:
        "Search the user's own notes. Reach for this whenever they mention a project, a person, a " +
        "client, a decision, a preference, or something they have written before — it is usually " +
        "already recorded here, and asking them to repeat it is the failure mode. Case-insensitive " +
        "and ranked, so the best matches come first; returns matching paths with line snippets. " +
        "Pass a folder prefix when you already know where to look, and reuse the result for the " +
        "session rather than repeating the same search before every write.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          prefix: {
            type: "string",
            description: "Optional folder prefix that narrows results to one subtree",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "archive_note",
      description:
        "Retract a note from its canonical location into this context's own archive folder, date-stamped and recoverable — there is no delete, and this is the safe way to pull something out of circulation. Links to it are rewritten to point into the archive, so nothing that referenced it breaks. Only on contexts whose layout has an archive folder (`4-archive`, `5-archive`, `archive`); elsewhere it refuses and move_note follows the owner's conventions instead. Team archives remain team-visible; personal archives safely tighten to private. Pass expected_etag for team cleanup.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          expected_etag: { type: "string", description: "Required for team connections" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_note",
      description:
        "Move or rename one note without recreating it. Links to it are rewritten across every note this connection can see, so references follow the note rather than breaking — you do not need to find and fix them yourself. Private overrides are preserved and privacy is never implicitly reduced. A team note moved by personal access into a private-default folder safely becomes private.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Existing markdown note path" },
          destination: { type: "string", description: "New markdown note path" },
          source_context: {
            type: "string",
            description:
              'Optional source context, as "@name". Use with destination_context to move a note between workspaces.',
          },
          destination_context: {
            type: "string",
            description:
              'Optional destination context, as "@name". Cross-context moves require write access in both contexts.',
          },
          expected_source_etag: {
            type: "string",
            description: "Optional etag from read_note for conflict-safe moves",
          },
          confirm_team_publish: {
            type: "boolean",
            description:
              "Required when a cross-context move publishes a private source note into team-visible destination scope.",
          },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_notes",
      description:
        "Preflight or apply an all-or-rollback batch of up to 100 independent note moves. Links to every moved note are rewritten across the notes this connection can see. Set dry_run=true to validate every source, etag, destination, conflict, and scope without changing data. Cycles and destination/source overlap are rejected.",
      inputSchema: {
        type: "object",
        properties: {
          moves: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                destination: { type: "string" },
                expected_source_etag: { type: "string" },
              },
              required: ["source", "destination"],
              additionalProperties: false,
            },
          },
          dry_run: { type: "boolean", description: "When true, return the validated plan only" },
        },
        required: ["moves"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_folder",
      description:
        "Move or rename a folder tree after preflighting every destination. Links into the folder are rewritten to follow it, and relative links inside it are recomputed for its new depth. Folders above 500 visible objects are moved logically immediately and physically synced by a resumable materialization job. Private overrides are preserved and privacy is never implicitly reduced.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Existing folder prefix" },
          destination: { type: "string", description: "New folder prefix" },
          dry_run: { type: "boolean", description: "When true, validate and return the move plan only" },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "materialize_move",
      description:
        "Owner-only maintenance command for a logical folder move created by move_folder. Copies and verifies a bounded batch of objects, then deletes sources only after every destination is present. Safe to retry until it reports complete.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Logical move id returned by move_folder" },
          batch_size: {
            type: "integer",
            minimum: 1,
            maximum: MOVE_MATERIALIZE_BATCH,
            description: `Maximum objects to copy or delete this pass; default ${MOVE_MATERIALIZE_BATCH}`,
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
