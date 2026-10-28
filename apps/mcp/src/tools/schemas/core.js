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
        "CALL THIS FIRST, once per session, before answering anything about the user's own work. " +
        "One cheap call returns their front page, what they touched most recently, and a map of " +
        "every folder with note counts — so you know what already exists instead of guessing. " +
        "Everything else here is easier to use well afterwards.",
      inputSchema: {
        type: "object",
        properties: {
          tools: {
            type: "boolean",
            description:
              "true adds the live list of every tool you may call and its arguments, which can be newer " +
              "than your app's copy. Shown anyway when your copy is out of date.",
          },
          about: {
            type: "string",
            description:
              "Optional. One part of the manual instead of the overview: \"tools\" for every tool and action " +
              "with its arguments, an action's name (e.g. \"move\") for that action in full, \"access\" for " +
              "what you may write where, \"website\" for building the site, \"pages\" for the .page.md format, \"health\" for how tidy it is.",
          },
          since: {
            type: "string",
            description:
              "Optional. The orient_mark an earlier orient ended with: answers with only what changed since then, " +
              "much shorter and faster than the overview. Use it to orient again in the same session.",
          },
        },
        additionalProperties: false,
      },
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
        "Search the user's own memory: their notes about their projects, people, decisions, " +
        "preferences and past work. The first place to look for any question about the user — " +
        "the answer is usually already written down here. Returns results whose id can be " +
        "passed to fetch for the full note. For their email, pass args { email: true }: it searches " +
        "the mail synced into their notes first, then their Gmail for mail from before it was " +
        "connected or not synced yet, with Gmail search syntax in query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          args: {
            type: "object",
            description: "Optional. prefix: a folder to search within. email: true searches their email. orient lists the rest.",
          },
        },
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
        properties: {
          id: {
            type: "string",
            description:
              "A note path or search result id; a file path (a PDF, Word, Excel or picture file, such as an email attachment a note links) returns the words in it; " +
              "a folder path (ending in /) lists it; orient lists the other ids " +
              "(meetings:, messages:, contacts:, activity:, changes:, proposals:, links:, vault:, apps:, and email:<address>/<id> from an email search).",
          },
          args: {
            type: "object",
            description: "Optional. e.g. mail, transcript, image, lists, related (with limit: the notes linked to, from and like this one), limit. orient lists what each id takes.",
          },
        },
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
        "List note paths under a folder prefix (e.g. 'projects'), or everywhere when omitted. " +
        "Use it to open up an area that orient only summarized — a project folder's contents, " +
        "what is sitting unfiled in inbox — before deciding something has not been written down.",
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
        "concurrent edit is detected instead of silently overwritten. " +
        "Pass mail: true to read only the note's mail (what agents working on it sent each other) instead of the note: " +
        "with your mailbox, just what is new for you; mail: \"all\" for all of it.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "e.g. 'projects/togather/status.md'" },
          mail: {
            type: ["boolean", "string"],
            // "true" too: an app whose copy of this tool predates mail sends
            // the footer's `mail: true` as text.
            enum: [true, "true", "new", "all"],
            description:
              "Read the note's mail instead of its text. true: what is new for your mailbox (all of it without one); \"all\": every message.",
          },
        },
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
