# Context directory connector

The public directory connector connects ChatGPT, Codex, Claude and Claude Code
to your Context Markdown notes and existing workspaces.

Server URL: **https://mcp.context.lc/mcp/chatgpt**. The path names its original
client, but the same documented contract is available to every compatible MCP
client and every user. It uses Streamable HTTP and OAuth with automatic client
registration. No API key or local process is required.

## Connect

1. Sign in at https://context.lc and finish creating a workspace with storage.
2. Add the server URL in your client's remote MCP connector settings.
3. Sign in to Context, choose the default workspace, and approve the access you
   want to grant. Read access permits the six read tools; editing adds four note
   tools. Private notes require an explicit private-note grant.
4. Ask to list your workspaces or find a note. Your account's workspace roles and
   note privacy rules apply to every call.

In Claude Code, add the remote server with:

```sh
claude mcp add --transport http context https://mcp.context.lc/mcp/chatgpt
```

Then use `/mcp` to complete sign-in. ChatGPT and Claude directory listings become
available after their respective reviews; before then, clients with custom MCP
support can use the same URL.

## Tools

| Tool | Operation |
| --- | --- |
| `get_profile` | Identify the connected account by a stable ID and label. |
| `list_workspaces` | List accessible workspaces and your roles. |
| `get_workspace_overview` | Read the front page and visible note references. |
| `list_notes` | Browse visible note paths in a folder, with pagination. |
| `search` | Search accessible notes and return source URLs. |
| `fetch` | Read a note by its qualified ID, with source URL and current etag. |
| `create_note` | Create one new Markdown note; existing paths are refused. |
| `update_note` | Replace one existing note using its current etag. |
| `move_note` | Move or rename a note within its workspace using its current etag. |
| `archive_note` | Move a note into the archive using its current etag. |

Fetch a note again before editing, moving or archiving if its revision changed.
Moves refuse destination collisions and never widen note access. Archiving is
reversible: the note remains in the workspace's archive and can be moved back.
This endpoint has no permanent deletion operation.

Examples: “Find my launch plan,” “Summarize my current project,” “Create a note
with this decision,” or “Move this note into my projects folder.” Saving happens
at your request. This connector has no automatic conversation capture, messaging,
website publication, form creation, payment, or arbitrary action-dispatch tool.
It does not install lifecycle hooks or change a client's global instructions.

The existing https://mcp.context.lc/mcp endpoint retains the separate six-tool
gateway contract for clients that use its broader capabilities.

## Data and support

Only the content and arguments needed for the requested note operation are sent
through Context. Notes remain in their workspace's configured storage; writes
appear in workspace activity. Revoke an app's grant from Context's Connections
settings to stop its access.

- [Privacy policy](https://context.lc/privacy)
- [Terms](https://context.lc/terms)
- Support: context@supa.media

