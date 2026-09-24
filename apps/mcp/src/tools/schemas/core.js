/**
 * `orient`, ChatGPT's `search` and `fetch`, `scope_info`, `list_notes` and `read_note`.
 *
 * Part of `baseToolDefinitions` (`../schemas.js`), which concatenates these
 * families in the order the list has always had; moved verbatim.
 */

export function coreToolDefinitions() {
  return [
    {
      name: "orient",
      description:
        "CALL THIS FIRST, once per session, before answering anything about the user's own work. " +
        "One cheap call returns their front page, what they touched most recently, and a map of " +
        "every folder with note counts — so you know what already exists instead of guessing. " +
        "Everything else here is easier to use well afterwards.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    // ChatGPT's ordinary chats can invoke exactly two tools on a custom
    // connector: ones named `search` and `fetch`, in OpenAI's deep-research
    // shape. These are `search_notes` and `read_note` wearing that contract —
    // see the doc block on `toolOpenAiSearch`. Their descriptions are written
    // for the model deciding whether to reach for this connector at all.
    {
      name: "search",
      description:
        "Search the user's own memory: their notes about their projects, people, decisions, " +
        "preferences and past work. The first place to look for any question about the user — " +
        "the answer is usually already written down here. Returns results whose id can be " +
        "passed to fetch for the full note.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "fetch",
      description:
        "Fetch one note from the user's memory in full, by the id a search result returned.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "A result id from search" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "scope_info",
      description:
        "Show team-writable folder defaults and the access model. Optionally inspect a proposed path. Personal connections receive its effective visibility; team connections receive only the folder default so private note existence is never disclosed.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional note or destination path to inspect" },
          workspaces: {
            type: "boolean",
            description:
              "Set true to also list, as a JSON block, the workspaces this connection reaches: slug, role, personal or shared, and which one it is connected to.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_notes",
      description:
        "List note paths under a folder prefix (e.g. '1-projects'), or everywhere when omitted. " +
        "Use it to open up an area that orient only summarized — a project folder's contents, " +
        "what is sitting unfiled in 0-inbox — before deciding something has not been written down.",
      inputSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Folder prefix to list under; omit for everything." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "read_note",
      description:
        "Read one of the user's notes in full — the paths come from orient, list_notes, or " +
        "search_notes. Returns its content and an etag; pass that etag back to write_note so a " +
        "concurrent edit is detected instead of silently overwritten.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "e.g. '1-projects/togather/status.md'" } },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}
