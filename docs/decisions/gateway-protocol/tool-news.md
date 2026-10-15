# Gateway protocol: telling stale clients what changed in the tools

## Orient names the tool changes since a client last loaded our tools

Decided with the owner, 2026-10-15. Clients cache `tools/list` and many
re-fetch it only when a person reconnects, so a connection can keep reading
our tools as they were the day it connected, arguments and all. Nothing a
server or a model says makes a client reload: MCP's
`notifications/tools/list_changed` needs a held stream this stateless
gateway does not keep, and only some clients act on it.

- **The control plane records when each grant last fetched `tools/list`**
  (`oauthGrants.toolsListedAt`, through `/gateway/grants/tools-listed`,
  deferred and best-effort). A grant that has not listed since the field
  existed counts from its creation.
- **`orient` names the entries of `apps/mcp/src/tools/news.js` dated on or
  after that day**, ahead of the front page, newest eight at most. Arguments
  are validated against today's schema whatever the client cached, so a new
  argument works as soon as the agent reads about it. A new *tool* cannot be
  called until the client reloads, and its line says so.
- **A tool change nobody wrote down fails a test.** `toolNews.test.mjs`
  fingerprints every advertised tool's name and argument names; descriptions
  are not news.

Reversing the stamp, the orient section or the fingerprint fails
`apps/mcp/test/toolNews.test.mjs` and the `tools-listed` cases in
`apps/convex/__tests__/controlPlane/session.test.ts`.
