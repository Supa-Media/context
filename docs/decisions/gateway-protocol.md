# The MCP gateway: protocol, transport, orientation

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### Two MCP eras, two lists, and they must never be merged

`2026-07-28` is not an increment on `2025-11-25`. It deletes the `initialize`
handshake, protocol-level sessions, `Mcp-Session-Id`, the GET stream, SSE
resumability and `ping`, and replaces the version counter-offer with an error.
The spec calls the two shapes **modern** and **legacy**; this gateway serves
both, which it can only do because it never had a session to remove.

`src/protocol.js` therefore keeps `MODERN_PROTOCOLS` and `LEGACY_PROTOCOLS`
apart. Sorting them into one array is the obvious-looking tidy-up and is wrong
in both directions:

- **Legacy negotiation may only offer legacy revisions.** A client that sent
  `initialize` has declared it speaks the handshake era; answering it with
  `2026-07-28` names a revision that has no `initialize` in it.
- **Modern negotiation may only offer modern revisions.** `server/discover` and
  the `-32022` error both carry a list the client is expected to *retry with* on
  the path it is already on. A legacy revision there sends it looking for a
  handshake it just declared it is not using.

Negotiation itself is inverted between the two, and implementing it backwards is
the single most common way real MCP servers fail to connect: legacy **must**
counter-offer inside a normal `InitializeResult` and **must not** error; modern
**must** error with `-32022` and `data.supported` and has no result to
counter-offer in.

A revision goes in a list only once its semantics are implemented. Claiming one
we do not speak is worse than lagging, and it is self-detecting: a conformant
client probes, gets an answer that is not modern, and correctly concludes the
server lied.

### Authority is decided once, never per protocol era

`toolsForSession` and `callToolForSession` are the only two places that decide
what a connection may see and do. Both eras call them. A scope check
implemented separately for a new protocol revision is a scope check that will
drift, and the drift would be a privilege escalation reachable by adding one
header to a request. There is a test asserting the read-only filter and the
write gate hold identically on both paths.

### An absent `Origin` is allowed; `null` is not

The transport paths (`/mcp`, `/inbox`) refuse any browser origin not on the
allowlist. Two halves of that are counter-intuitive enough to be "fixed" by
someone tidying up, and each fix is a different disaster:

- **No `Origin` header at all must pass.** Claude Desktop, Codex CLI and the
  SDKs are not browsers and send none. Refusing absence would take down every
  real client while stopping nothing, because the header a browser cannot forge
  is precisely the one an attacker's page always sends.
- **`Origin: null` must not pass.** A sandboxed iframe serializes to the opaque
  origin `null`, so folding it in with "no header" is a one-line bypass an
  attacker can trigger with an `<iframe sandbox>` attribute.

Matching is exact — scheme, host, port, no wildcards — for the same reason
`redirectUriMatches` is. Unset `ALLOWED_ORIGINS` means non-browser clients only,
which is fail-closed and breaks nothing already deployed. See `src/origin.js`.

### Orientation is the front door, and `index.md` is the part we do not generate

A context nobody's agent reads is worth nothing, and the first version of this
gateway lost that fight quietly: clients connected, never called `orient`, never
wrote anything back, and the owner concluded the product did not work. The fix
is not one lever. There are three surfaces and they act at three different
moments, and only the first two decide whether a tool is *reached for at all*:

- **Connect** — the `instructions` payload (legacy `initialize`, modern
  `server/discover`). Read once, sits in the system prompt for every
  conversation, and reaches the model before it has decided anything.
- **Decision** — the tool descriptions in `tools/list`, present every turn, for
  every client. A description that explains mechanics ("List note paths,
  optionally under a folder prefix") tells a model how a tool works and gives it
  no reason to believe the user's question is answered inside. They are written
  in the language of the user's intent for that reason.
- **Result** — text appended to tool output. Only ever reaches an agent that
  already called something.

**There is deliberately no "you have not oriented yet" banner**, though it is
the obvious next idea and the only mechanically enforceable one. It would live
at *result* time, which is the moment least related to the failure, and it needs
per-grant state to avoid becoming noise — and a grant is a **connection, not a
conversation**. One desktop client holds one grant for weeks, so "already
oriented" would need an invented TTL and would stay silent for exactly the fresh
chat worth catching. It buys a Convex schema change and a write on the hot path
to solve the least of the three problems.

`orient` itself leads with the person's context and ends with the rules. It used
to open with twenty-five lines of visibility governance handed to an agent that
had not yet been given one reason to care, which is a document to comply with
rather than a context to explore.

**`index.md` is the one part of orientation we never generate.** Everything else
— folder map, counts, recency — is derived and rebuilt per call. The front page
is an ordinary root note the customer writes, edits in Obsidian, and owns; it is
in the stable on-bucket layout above. Absent, `orient` says so and says what it
is for. Generating a plausible one instead would be the product inventing the
one thing only its owner can say.

**Who may write the front page is settled, and it is not "whoever asks".** The
onboarding seed prompt tells a connected client outright not to touch
`index.md`, because `write_note` only checks an etag when one is supplied and a
client told to write "who I am" would replace the scaffolded manifest with a
biography on its first call. The orientation contract does ask agents to keep it
current, and the two are reconciled rather than left to collide: read it, pass
its etag, add to what is there, say what is changing first, never replace it
wholesale. Loosening that to "keep index.md up to date" is one sentence shorter
and hands every connected client a wholesale overwrite of the one file the whole
orientation is built on.

Three properties of the survey are load-bearing:

- **Every count counts only what this connection can see.** Counting hidden
  notes would let a colleague subtract and derive an exact private-note total
  for the person who withheld them — what the console's census is owner-only to
  prevent.
- **Two listings per folder, answering different questions.** Delimited names
  every subfolder; a bounded flat walk counts and dates them. Deriving the map
  from the walk alone is simpler and drops the siblings of one huge folder off
  the map entirely — for precisely the people with the most in here. Anything
  the walk could not reach is a floor (`5000+`), never a total, and a recency
  list built from a partial walk says that it is.
- **The connect-time sketch fails soft, always.** A slow bucket, a revoked key,
  a `privacy.md` somebody broke in Obsidian: none of them may take down a
  handshake. A client that gets the static instructions is fully working and
  merely less curious. Note that a thrown handler is answered with a JSON-RPC
  error over HTTP 200, so "the handshake returned 200" does not test this.

### `search` and `fetch` exist because ChatGPT's chats can call nothing else

Outside developer mode, ChatGPT invokes exactly two tools on a custom
connector: ones literally named `search` and `fetch`, speaking OpenAI's
deep-research shape (`search(query)` → one text block of JSON
`{"results":[{id,title,text,url}]}`; `fetch(id)` → `{id,title,text,url,
metadata}`). Every other tool on the connector — `orient` included — is
invisible to those chats. Verified live before the pair existed: asked "who is
my sister?", ChatGPT ranked Gmail and Contacts as the plausible sources and
never considered this connector until the user named it, and no connect-time
instruction could have changed that, because an instruction is only read after
the connector's tools are reachable.

So the pair is `search_notes` and `read_note` wearing that contract, and three
things about them are load-bearing:

- **One scan.** `search` and `search_notes` share `scanVisibleNotes`, so the
  two dialects cannot disagree about what a query matches. A second scan is a
  second place for a visibility bug.
- **The dialect discloses nothing the ordinary tools would not.** `fetch` of a
  private note is byte-identical to `fetch` of a path that never existed, and
  a team search cannot surface a private note. Sabotage-tested.
- **`url` is a `context://note/...` URI that resolves nowhere, on purpose.**
  The contract wants a URL per result; a note has no public URL because there
  is no public tier, and inventing an https one would imply otherwise.

Renaming either tool, or "simplifying" the pair away because they duplicate
`search_notes`/`read_note`, disconnects every ordinary ChatGPT chat.
