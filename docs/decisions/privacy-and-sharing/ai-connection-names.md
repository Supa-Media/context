# Privacy and sharing — An AI connection holds its person's names

_See `docs/decisions/README.md` for the index._

### An AI connection reads what was shared with its person, as the app does (decided by the owner, 2026-11-03)

**What changed.** A session carries `grantedNames`: the person's groups in a
workspace, their handle, and the row tokens (`#<noteId>`, `#<noteId>!edit`) of
every grant on a row naming them. `canSee` opens a note pointed at a group or a
person, and a Tex group chat's sealed home (`texting-assistant/chat-homes.md`),
only through those names. Until now only the app's own client
(`context_console`) was handed them; every OAuth client (Claude, ChatGPT, any
other) read `team` with no names at all. So a member's AI connection saw each
chat home they were in as empty, history file included, and every note shared
to them by name or through a group as missing. The owner asked "i'm a member
though, so shouldn't you have access?" and chose, of two options, that AI
connections also see notes shared by name, not only the chat homes.

**The rule.** A connection holds the person's names when it is the app's own
client or any client registered through OAuth. Context's own background
clients (`context_*`: Tex's texts and group turns, routines, heartbeats,
dreams, housekeeping, cards, settings) hold none, as before; a group chat's
grant keeps its own rows (`liveGrants.ts`). One predicate on each side:
`holdsGrantedNames` in `apps/convex/functions/lib/controlPlane/liveGrants.ts`
(the control plane's session) and in `apps/mcp/src/workspaceStore/personRows.js`
(the person object's session). The names stay live: re-read on every request,
so leaving a group or losing a grant closes it on the next call.

**The tree routes judge by the same names.** The control plane's gateway tree
routes (`/gateway/tree/manifest`, the facts and note-id lookups) take their
clearance from `gatewayReadClearance` (`lib/nodes/gatewayManifest.ts`), which
passed a guest's names on and dropped everyone else's. After the change above,
a member's AI connection held a chat home's names in its session and still got
an empty listing there. It now passes every name the session carries.

**The note tools judge by the same names.** Even with both halves above
live, every note tool (`list_notes`, `read_note`, `fetch`, search and the
rest) called `canSee` with the rules alone, so the names the session held
reached no tool and the homes still read as empty. The store a session opens
now carries the session's names on the rules it serves (`READER_NAMES` in
`apps/mcp/src/privacy/engine.js`, set by `store/privacyAuthority.js`), and
`canSee` uses them only when its caller leaves the names out. A caller that
judges somebody else (a live room's recipient) or the members at large (who may
see a moved note's new name, the team score in a tidiness check, a guest
chat's own reads) passes its own names or `null`, never the reader's.

**Why this is not a widening of tier.** The names open only what the person
could already open in the app; a connection's scopes and visibility tier are
clamped exactly as before (`effectiveScopes`, `visibilityTierForGrant`), so a
connection without `context:private` still never reads a private note, and an
edit token writes only where its row grants edit and the grant has
`context:write`. The earlier rule ("its consent is narrower") was never written
down as a decision, and it contradicted `encryption/threat-model-and-scope.md`,
which names "a named grantee's AI client" as an intended reader. It also caused
the Members-folder outage described in `all-context-users.md`.

**What a "simplification" would cost.** Gating names back to the console
hides every by-name share and every chat home from the person's own AI
connections again. Handing names to `context_*` clients would let Tex's own
jobs (a routine, a dream, a 1:1 text turn) read a group chat's sealed memory
and carry it into another conversation; that is a separate decision.

Tests: `apps/convex/__tests__/textGroupHome.test.ts` ("a member's AI
connection holds a home's names"), `apps/convex/__tests__/controlPlane/session.test.ts`
("a console session carries live group names"), `apps/convex/__tests__/pinnedReaders.test.ts`
("a real member's MCP connection holds the members grant's names"),
`apps/mcp/test/personObject.test.mjs` ("the app's own client and every AI
connection hold the names its grants on rows give it"),
`apps/convex/__tests__/pinnedReaders.test.ts` ("the gateway's tree manifest
lists a member's AI connection what its names open"), and
`apps/convex/__tests__/nodes/gatewayManifest.test.ts` ("a member's names are
passed on"), and `apps/mcp/test/readerNames.test.mjs` (the note tools).
