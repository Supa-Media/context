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

### Recency ranks attention, and automated capture is collapsed, not excluded

"Recently updated" exists to answer one question — where has this person's
attention actually been — and a connected mailbox or a run of daily meetings
threatens that answer by writing a note on its own schedule rather than the
person's, forever. `surveyContext` removes every note `src/communications/paths.js`
recognises as automated capture (a channel-day note, a meeting, a saved
session at its unrouted default) from the ranked list *before* `mostRecent`
runs, so it can never outrank or bump an authored note off the same
unchanged, unenlarged budget; each kind still present is reduced to one
collapsed line — a count and its newest note — appended after. Collapsing
rather than excluding is the deliberate half: an agent that asks "what came
in?" gets a pointer, not silence, and the recogniser is a path predicate only,
because nothing in this stack can tell an ingestion write from a person's own
hand-edit, so an edited channel-day note still collapses. The full argument,
and the three tests that pin it, are in
[communications](./communications.md), "A firehose is not attention". The
test that fails if this reverts to exclusion is `toolOrient answers "what came
in" with a pointer, never silence`; the one that fails if the collapse itself
is dropped is `a workspace with a year of channel-day notes still surfaces its own
recent notes in orient`.

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

### The advertised `inputSchema` is enforced, and it is enforced in one place

`tools/list` publishes an `inputSchema` for every tool and nothing
checked a call against one. `callTool` handed the whole arguments object to the
handler, which read the properties it knew about and ignored the rest. The gap
was found by an adversarial review of the key export asking whether
`export_encryption_keys` could be pointed at another workspace by supplying
that workspace's identifiers: the answer was no, and the only reason was that
`toolExportEncryptionKeys(store, scope)` and `toolRotateEncryptionKeys(store,
scope)` are the only two tool functions in `index.js` that do not declare an
`args` parameter at all. That is an accident of two signatures. Every other
tool had the same gap with nothing at all in front of it, and a refactor adding
`args` "for symmetry" would have closed the accident in one line.

It matters because of who calls these tools. They are AI clients driven by text
other people wrote — an email body, a meeting transcript, a shared note — and
an argument the schema does not describe reaching a handler is the shape a
prompt-injected client uses to turn a read into something else.

`src/toolArguments.js` is a hand-written validator over the subset the tool
definitions use, because the gateway takes no npm dependencies and runs on the
Workers runtime. Four things about it are load-bearing:

- **Unknown properties are refused, not dropped.** Dropping is the tempting
  half-measure and it is worse than either alternative: the call proceeds, so
  an injected instruction that failed still got a tool to run, and nothing in
  the transcript says a property was discarded. A call carrying an argument we
  never advertised is not a nearly-right call, it is a different call.
- **The order in `callToolForSession` is the security argument, not a
  formatting choice.** After routing, because `context` is that argument's own
  to interpret and is already refused on its own terms — a `context` of `123`
  is "no access to that context", not a type complaint. After the scope gate,
  so a read-only connection is told it holds a read-only grant rather than
  handed the argument shape of a tool its own `tools/list` does not show it.
  Before `callTool`, so no handler, no privacy-manifest read and no storage
  round trip happens for a call whose arguments we never said we would take —
  which is also what makes a call naming another workspace's identifiers
  refused identically whether that workspace exists or not. There is a check
  for each of those three, and they fail if the order is changed.
- **A tool whose existence is masked is not validated.** `callTool` answers a
  team-tier caller `unknown tool: …` for the two encryption tools, byte-identical
  to an invented name ([encryption](./encryption.md), "a team-tier caller does
  not even learn the tool exists"). Validating a masked tool's arguments undoes
  that in one sentence, because a complaint about a property is a statement
  that the tool is real. `EXISTENCE_MASKED_TOOLS` is read by the mask and by
  the validator so the two cannot drift.
- **The refusal is a function of the request and the schema, and of nothing
  else.** It never reads storage, never names a workspace, and never echoes a
  value — a client that volunteers a passphrase is told the property is not
  taken, never what it sent. Property names are escaped outside printable
  ASCII, so a name differing from a real one only by a Cyrillic letter comes back
  as `p\u0430th` rather than as something that looks like the correct spelling.

**The census is the part that has to survive the next tool.** A validator wired
into a dispatch table protects the tools somebody remembered to wire in, so
`toolArguments.test.mjs` reads `src/index.js` and asserts that every `case` in
`callTool`'s switch resolves to an advertised schema — through `TOOL_NAME_ALIASES`
for `archive_chat`, the one name still dispatched and no longer listed — that
every advertised schema is a closed object, that no schema uses a keyword the
validator would silently ignore, that there is exactly one place a tool is
dispatched from, and that the validator runs before it. The keyword check
earned itself immediately: `move_notes` advertised `minItems` and `maxItems`,
which nothing enforced, and they are implemented rather than deleted.

**Closedness is asserted at every object node, not only at the root, and every
`case` label has to be a literal.** Adversarial review of the census found the
same class of hole one level in from where it was looking. This validator
enforces exactly what a schema says and nothing more, so an object node *below*
the root that forgets `additionalProperties: false` accepts anything at that
position, and a property that says `type: "object"` without saying which
properties is never walked into at all — in both cases silently, with
`tools/list` still reading as though it were closed. `move_notes` already has
such a node one level down and a second array-of-objects tool is the obvious
next one, so the census walks the whole schema and names the offending node
(`move_notes.moves[]`) rather than checking only the outermost object. The
second half is the one hole the change that added the census named and left
open: the parser reads `case "some_name":` off the source, so a label that is a
variable dispatches a tool the census never sees while every other check passes.
Requiring every label in that switch to be a lowercase string literal costs one
check and closes it, rather than resting on nobody having done it yet.

**Both eras are asked the same question.** Every behavioural check above rides
the legacy transport, and "authority is decided once, never per protocol era"
in this file is the reason that is not enough: the two eras are different
functions with different framing, and a control proven on one path is a control
an attacker reaches by adding a header. The modern path gets the unknown
argument, the valid call and the existence mask, and pointing its `tools/call`
at `callTool` directly fails five checks rather than none.

Two deliberate consequences, neither of them a widening of a schema to make an
existing call pass:

- **`search` and `fetch` refuse `context`.** Their schema is ChatGPT's
  deep-research contract and deliberately does not carry the addressing
  argument; those chats send what the contract defines and nothing else, and a
  client that can see the ordinary tools can address a context with them.
- **A call refused for its arguments spends no rate-limit budget.** The export
  limit exists to bound how often key material can actually leave, and a call
  that was never going to produce any has nothing to bound.

The cost is 1 microsecond for a typical `write_note`, measured over 20,000
iterations in the suite, against a `fetch` to object storage on the other side
of the same function. The ceiling is the number worth watching rather than that
one: the largest call the tool list permits — a 100-move `move_notes` batch with
every optional property on every element, a little over 400 nodes — measures
around 50 microseconds, because the walk builds each node's address
(`moves[37].destination`) as it goes whether or not a message is ever produced.
Fifty microseconds is still nothing beside the storage round trip, and it is the
figure a future schema moves: an array with a larger `maxItems`, or an element
schema with more properties, changes the ceiling and leaves the typical-write
figure exactly where it was. Both are asserted in the suite. Neither is measured
under `workerd`.
