# Context for ChatGPT and Codex

The expanded directory endpoint is **https://mcp.context.lc/mcp/chatgpt/v2**.
It uses the existing Context OAuth flow and individually exposes its operations.
The original `/mcp` keeps its six-tool interface. The earlier ten-tool
`/mcp/chatgpt` interface is unchanged, including for the existing Claude submission.

Start a user-requested Context task with `orient`. It runs the actual workspace
orientation: front pages, recent changes, folder maps, access and saved
conventions. `orient` with `about: "tools"` describes exactly the operations
available to this connection; it does not advertise hidden action dispatchers.
`run_context_reflection` starts the existing Tex reflection process on request;
the ordinary endpoint continues to call this action `dream_now`.

The connector supports note and file reads, search, meetings, contacts, message
records, user-requested context summaries, remembered facts, comments, note mail,
images, forms and responses, batch saves, moves, archiving, access controls,
sharing, workspace setup, website operations and the explicitly listed connected
service operations. Every call uses Context's existing permissions, workspace
routing, privacy, revision checks and outbound approval gates. Available tools
depend on the user's grant, workspace role and enabled Context features.

The [capability inventory](chatgpt-capabilities.json) maps every existing
`write`, `manage` and `send` action to its named tools or an explicit exclusion.
It also lists the reviewed tool names. A regression test fails if a new action
has neither a mapping nor an explicit exclusion.

## Explicit limits

- Arbitrary vault-backed API execution is excluded.
- Dynamically discovered connected-app reads and changes are excluded.
  `list_connected_apps` lists available connections but executes no app tool.
- Slack exposes only its individually listed methods, not arbitrary methods.
- `save_context` takes a concise, user-requested task summary. It has no raw
  conversation-history field and installs no automatic capture hook.
- Note writes do not implicitly publish a website or create a share link.
  Those operations have their own tools, with the existing access and approval
  checks. Existing form and page content remains supported.

These limits are visible in the tool manual as well as this guide. Moving
arbitrary commands into a note and executing them through a generic runner is
not an alternate operation on this endpoint.

The expanded connector must complete its own directory review. Its existence
does not mean the earlier submission has been amended or approved.

- [Privacy policy](https://context.lc/legal/privacy/)
- [Terms](https://context.lc/terms)
- Support: context@supa.media
