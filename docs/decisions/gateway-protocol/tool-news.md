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

## Orient carries the live tool list, in full only when it is needed

Decided with the owner, 2026-10-15. News says what *changed*; an agent whose
copy is old also needs what *is*, argument by argument, and a hand-kept copy
of that would drift the first week.

- **Generated, never written.** `apps/mcp/src/tools/liveList.js` renders the
  list at request time from `toolsForSession`, the same call `tools/list`
  answers with, through `store.offeredTools` (set beside `store.actor` in
  `mcp/handlers.js`, handed along by `openContext`). Each tool is its name,
  the opening of its description, and every argument with its type, `*` for
  required, and an object's keys one level down. The `context` argument every
  tool takes is said once.
- **Only what this connection may call.** Read-only grants see no write
  tools, `PRIVATE_TIER_ONLY_TOOLS` stay out below the private tier,
  `rotate_encryption_keys` included, and unlisted or switched-off tools are
  absent, because the list *is* the listing. Addressed to another workspace,
  orient still lists this connection's tools, as `tools/list` does.
- **It tells the agent to trust it.** The section says to prefer it over the
  app's copy, to pass arguments exactly as listed even where that copy does
  not show them, and that a tool the app does not offer needs a reconnect.
- **Default: full list only when the copy is stale.** The full list is about
  10 KB. It is shown when the news section is (a news entry dated on or after
  the grant's `toolsListedAt`), or when the agent passes `orient { tools: true }`.
  Otherwise orient carries a two-line "Context's tools" section saying the
  copy is current and how to ask. An unknown listing time gets the pointer
  without claiming the copy is current. The texting assistant, handed today's
  tools on every turn, sets no `offeredTools` and gets neither.

Reversing any of these fails `apps/mcp/test/liveToolList.test.mjs`; listing
the registry instead of the connection's tools was sabotage-checked there and
reddens five cases.

## An argument a stale client sends as text is read as its advertised type

Decided 2026-10-15, found on production the day the live list shipped: Claude
Code, holding an `orient` with no `tools` property, sent `tools: true` as the
string `"true"` and was refused. A client sends a property its copy does not
type as text, so every non-string argument added after it connected failed.

`coercedArguments` (`apps/mcp/src/tools/advertised.js`) reads a top-level
string as the schema's type before validation, and only where that type has
no `string` in it: `true`/`false`, a whole number, a finite number, or JSON
that parses to an object or array. Anything else is left as sent and refused
as before, and the result is still validated in full. Reversing it fails
`apps/mcp/test/staleClientArguments.test.mjs` and the text case in
`liveToolList.test.mjs`.

## Apps that drop unknown arguments are told to reconnect

Decided 2026-10-16. Codex sends only the arguments in its own copy of a tool
and drops the rest before the call leaves it, so a stale Codex never reaches
the gateway with an argument added since it loaded our tools (found when it
stripped `mail` from `write_note`). "Pass it even where your copy does not
show it" was false advice there.

- `appDropsUnknownArguments` (`apps/mcp/src/tools/liveList.js`) matches the
  client's registered name (`/codex/i`, as the control plane's
  `CLIENT_FAMILIES` does). For those apps both the news section and the live
  list say the argument will not reach Context and to ask the person to
  reconnect; the list is still shown, as the reason to.
- Every other app is told to pass arguments as listed, and to have Context
  reconnected if its app refuses or ignores one.
- Both sections end with the app's own way to load today's tools
  (`refreshStep`: ChatGPT's Settings › Connectors › Refresh, a new Claude
  Code session, removing and re-adding the Claude connector, restarting
  Cursor, reconnecting Codex), from the project's 2026-10-16 staleness
  survey, with a general "reconnect" for any other app.
- Add a client here when it is seen dropping arguments; the name is the
  client's own claim and only chooses which advice is read.

Reversing it fails the Codex cases in `apps/mcp/test/liveToolList.test.mjs`.
