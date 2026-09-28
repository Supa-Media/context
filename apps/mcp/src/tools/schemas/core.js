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
      title: "Orient in your context",
      description:
        "Use this when the request concerns information in the user's Context notes or shared " +
        "workspaces, or asks to save or organize that information. When Context is relevant, call " +
        "this first: one cheap call returns their front page, recent activity, and a folder map. " +
        "Do not use Context for weather, image generation, travel search, or booking unless the " +
        "user explicitly asks to use information from their Context notes or workspaces.",
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
      title: "Search memory",
      description:
        "Use this when the user asks to find information already saved in their Context notes " +
        "about projects, people, decisions, preferences, or past work. Do not use it for weather, " +
        "image generation, travel search, or booking unless the user explicitly asks to search " +
        "their Context notes. Returns results whose id can be passed to fetch for the full note.",
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
      title: "Fetch note",
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
      title: "Show write access",
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
      title: "List notes",
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
      title: "Read note",
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
    {
      name: "evaluate_lists",
      title: "Evaluate folder lists",
      description:
        "Evaluate every Folder list block in one note against the notes this connection can currently open. " +
        "Returns selected rows without hidden-note counts; use read_note when you need the source block itself.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "A visible Markdown note containing Folder list blocks." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}
