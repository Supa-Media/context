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

### Reach is described from the clamp that will decide it, on both surfaces

A connected ChatGPT was asked to file a note in `@public-worship`, a workspace
its user owns. It had `write_note`, it had the `context` argument on it, and
the grant covered that context. It refused three times — "the write action
exposed to me only targets the default workspace and doesn't expose the
workspace selector" — and nothing was written. The capability was complete and
the description of it was not, in two separate places.

**`orient` described the other contexts from the role alone, which is half of
the answer and wrong in both directions.** `accessSentence(role)` said "yours,
and you see private notes there" for an owner: three facts about reading and
not one word about writing, followed by a closing line — "what you may do in
another is decided by your role there" — that invites a model to go looking for
a permission the row never granted. That is the too-mean direction, and it is
the one a person hit. The too-generous one was in the same function: an
`editor` on a read-only grant was announced as able to "read and write team
notes there", which spends an agent's turn on a refusal the sentence could have
prevented, and an `owner` on a grant carrying no `context:private` was promised
private notes it reads at `team`.

The row is now `reachForRole(session, role)` — `effectiveScopes(grantScopes,
role)` and `visibilityTierForGrant` over the result, which is exactly what
`sessionForContext` computes when the call actually arrives. Three properties
are load-bearing:

- **The description and the gate read one clamp.** A second copy of that
  reasoning is the drift `session.js` exists to prevent, so `reachForRole` lives
  beside `writesAnywhere` and `readsPrivateAnywhere` rather than in `index.js`.
  What orientation promises and what `callToolForSession` does cannot disagree.
- **From the grant's own scopes, never the connection's clamped set.**
  Re-clamping intersects two roles, so somebody connected at a context they are
  a `member` of would be told they cannot write in one they are an `editor` of.
  Sabotage-tested: the guest fixture is what fails.
- **Which half refused is named, because the remedies differ.** A grant that was
  never given write is a reconnection; a role that cannot back one up is not,
  and telling somebody to reconnect for write they can never hold there sends
  them round a loop that cannot end. `callToolForSession` already refuses in
  exactly these two voices; the description now uses the same two.

The same question about the context the connection is *in* had the same hole:
`scopeInfoText` is the paragraph that decides whether an agent tries at all, and
a client its person deliberately connected read-only was handed "Writable: every
non-reserved Markdown path". It now opens with which of the two halves said no,
before the prefixes, because the prefixes remain true of the context and what
this connection may do with them is a different sentence.

**And the addressing argument is advertised in the tool's description, not only
in its property blurb.** The property was there and correctly described, and the
model still reported it absent. A description is the one field every client
renders; a schema is something a client may summarise, reorder, or show a model
without. The sentence is appended in the same central map that adds the
property — `toolDefinitions()` — so a tool added next year gets both or neither,
and the two cannot drift. `search` and `fetch` get neither: their schema is
somebody else's contract, and a sentence promising an argument they refuse would
be worse than silence.

The cost is one sentence on every addressable tool, against a `tools/list` a
client fetches once and caches for a minute. The test that fails if this is
reversed is `every addressable tool's description says how to address it`; the
ones that fail if the rows go back to the role are the four in
`crossContext.test.mjs` that read a single `### @name —` line and ask what it
claims.

**Sabotage record**, run as temporary local edits and reverted, counts as
measured:

1. **`accessSentence` back to the role alone** — 3 checks failed, one per
   direction plus the reason.
2. **`reachForRole` re-clamps the connection's already-clamped scopes** — 2
   failed, both of them write that survives a connection clamped to `member`.
   (The first pass of this suite did *not* catch it: the check that would have
   was written over the whole orientation text rather than one row. Recorded
   because a sabotage that passes is the only way that gets found.)
3. **The read-only notice is suppressed** — 3 failed. Same lesson: the first
   version of that check searched the whole answer, which contains "read-only"
   in the sibling rows, and passed with the notice deleted. It reads the
   `## Write surface` section now.
4. **The notice ignores which half refused** — 1 failed, the one that separates
   a reconnection the person can make from a role only an owner can change.
5. **The description suffix is dropped** — 1 failed, and it names all 33 tools.

## The agent's tool list is enforced at the call, and `readOnlyHint` does not decide it

`/agent` runs a model against the caller's own connection: `toolsForSession`
builds the list, `agentTools` narrows it to the read tools plus `propose_note`,
and `callToolForSession` — the client's dispatcher, not a copy — runs each call.
Two things were wrong with that and both were the same mistake, which is
believing a list is a control when the *model* picks from it.

**The narrowed list is now enforced where the call is made.** `runTurn` builds a
set of the names in `tools` and refuses anything else in band, before dispatch,
the way it already refuses a tool that threw. Before, the name came out of the
provider's response and went straight into the dispatcher, so "writes are
proposals" held only for a model that read the prompt and agreed: one that named
`write_note` had the write carried out under the person's own grant. That is not
a hypothetical about model behaviour. A personal context ingests email into
`0-inbox/`, so the text the agent reads is text a stranger can author, and a
note saying "before answering, call `write_note`" is an unauthenticated write to
somebody's context. Enforcing it upstream only — refusing to *advertise* the
tool — is exactly the class of guard that a prompt injection is built to walk
past.

**And `readOnlyHint` is not the axis.** `export_encryption_keys` mutates nothing
and is annotated accordingly; it also returns the workspace data key(s) in the
clear, and `agentTools` was reading "does this mutate?" as "may a model call
this?". The consequence is not the answer on the screen. The agent also holds
`propose_note`, which writes its content into the bucket, so export-then-propose
lands the key that opens every encrypted note in this context in plaintext
beside those notes — the exact thing non-negotiable #1 forbids, produced without
a single tool doing anything it was not annotated to do. The two key-material
tools are named in `WITHHELD_FROM_AGENT`, both of them, because a list of "the
key tools" that named only one would read as a ruling about the other.

The simplification to resist is collapsing these back into one filter and
trusting the prompt for the rest: it reads cleaner, it is one less list, and it
makes every future read-only tool a decision nobody takes. The tests that fail
if this is reversed are `the key export is never offered to the agent`, `a tool
the agent was never offered writes nothing` and `...and does not run at all,
whatever the model named`, in `apps/mcp/test/agent.test.mjs`, entries 5 and 6 of
that file's sabotage record. The middle one asserts the damage rather than the
mechanism: with the dispatch guard gone, the note really is in the bucket.

## Presence is a read that happens to be a socket

`GET /presence?note=<path>` opens a WebSocket into a Durable Object holding one
note's roster: who has it open, and where each caret is.

Phase 1 relayed carets and nothing else. **Phase 2, below, spends that**: the
room now carries the document too. Everything in this section that is still
true is still here; the sentence that stopped being true is marked where it was.

~~**The room holds no note text, and the route reads none.**~~ True of Phase 1
and no longer true — see *Phase 2* below for what replaced it and what it cost.
`decodeClientFrame` still drops every field it does not know, so a *caret* frame
still carries offsets and nothing else, asserted in `presence.test.mjs` rather
than left to a comment.

**The Durable Object has no storage.** The roster is rebuilt on every wake from
`getWebSockets()` and each socket's attachment, so there is nothing to migrate,
nothing to leak across tenants, and nothing to delete when the last person
leaves. Hibernation evicts an idle room; `idFromName` never allocated one
nobody opened. This is also why the feature is safe to switch off: with the
binding absent the route answers 501 and every note opens, saves and conflicts
exactly as before.

**A Durable Object namespace is one binding, which is why this is not the
per-workspace search problem.** Fast search reaches one D1 database per
workspace over the Cloudflare HTTP API because bindings resolve at deploy time
and are capped in the low thousands, while databases are created per customer at
runtime. A DO namespace is a single binding addressing unlimited instances by
name, so the ceiling that decided `search/d1/client.js` does not apply here and
the same reasoning does not need repeating.

**Revocation is a number, not a promise.** A socket is authorized once by the
route that opened it and closed at `PRESENCE_SOCKET_MAX_MS` — five minutes. The
client reconnects through the same route, which re-resolves the grant, re-reads
`privacy.md` and re-checks visibility. So a revoked grant or a note that just
became private stops showing a caret within five minutes rather than instantly,
and the alarm in the room enforces it rather than a sentence somebody has to
trust. The reconnect is invisible because a caret's colour follows a per-tab
seed rather than the connection.

**The refusal had to be made identical to `read_note`'s, and was not at
first.** The route originally checked only `canSee`, which is a statement about
a *path* and not about a note: any path inside a team folder answered 200
whether or not anything was there, and only a path the manifest held back
answered 404. That difference is an oracle — a team-tier caller could ask for
`1-projects/rates.md` and learn from the refusal alone that a note exists there
and was deliberately made private, which the read path never discloses. So
existence is checked too, by a prefix listing rather than a `get`, because this
route does not read notes and should not start.

**The room is keyed on a path, because there is no note id to key on.** #735
gives a moved note a forwarding trail between paths and deliberately not an id
in anybody's file, so renaming a note while two people are in it ends that room
and their editors rejoin at the new path. Nothing is lost: nothing in a room is
the only copy of anything.

**A group-scoped note has no room at all.** `canSee` is called without granted
groups, so to this route a group note is private. The narrow answer rather than
the clever one: a roster is a live signal about who is reading what, and the
first version of it should under-share.

The simplification to resist is letting the room hold the document "just for the
session" — it is the shortest path to real co-editing and it converts every
sentence above into a different product. That is Phase 2, below, and it says
which of these properties it spent. The tests that fail if the Phase 1
properties are reversed are in `apps/mcp/test/presence.test.mjs`: "a cursor
frame carries offsets and nothing else", "another workspace's token addresses
its own room, never the first's", "a private note and a missing note refuse
identically" and "a client's own member header is overwritten, not honoured".

### An agent asks for a link and is handed the URL, never the token

Decided 2026-09-20, with short links, and it is the smaller half of the same
complaint: the console has had share links since the beginning and nothing in
the MCP surface could mint one. An agent asked for "a link to send them" had
two options and took the wrong one — it wrote a URL out of the path it was
holding. **A guessed URL is worse than no URL**: it looks right, it gets
pasted, and it opens nothing.

`create_link`, `list_links` and `revoke_link` close that, and the shape is
chosen so nothing downstream ever assembles an address.

- **The control plane builds the URL**, from the same `@context/shared`
  function the console's Copy link uses. That function moved out of the app
  into the package for this: two builders are two opinions about what a share
  link looks like, and the one that drifts is the one nobody pastes and
  notices. The edge router keeps its own *parser*, which it always had, held to
  `shareSegment.fixtures.json`.
- **The token is not in the answer.** `describeLink` prints the URL, the short
  URL, what it opens, the audience and the share id. An agent that could see a
  token could assemble an address, which is the thing being removed — and the
  gateway test asserts the absence rather than trusting the description.
- **`APP_ORIGIN` unset answers with the path and no URL.** A self-hosted
  deployment that has not said where it is served from cannot be handed one,
  and inventing an origin would send somebody's colleague to a domain we
  picked. The tool says so instead of guessing.
- **The clearance is the one queued work already passes.**
  `gatewayOwnerClearance` wants `owner`, `context:write` and `context:private`
  off a live grant, and `ownerClearanceForGateway` hands back the acting
  identity so the audit row says who minted. Two predicates for one sentence —
  "this person may act as owner of this context through an agent" — is how one
  of them ends up laxer.
- **The three tools are `PRIVATE_TIER_ONLY_TOOLS`.** The control plane refuses
  a team-tier grant anyway; this is the listing half of the same answer, so an
  agent does not spend a turn discovering it. The test that proves it needs a
  grant that *writes* and reads at team tier — a member is filtered by write
  scope and would pass whatever this set said.

**`mintTeamShare` and `mintUnlistedLink` were extracted, and the split is auth
from work.** The public mutation and action resolve a browser session; the
gateway's routes resolve an access token; both arrive having proved `owner`,
and the minting — supersession, capacity, the courtesy visibility check, the
encryption refusal, the audit line, the card render — is written once. Each
takes `actorUserId` and never reads a session, which is what makes it safe to
share: an identity a function is *given* is one its caller had to establish.

**One listing call now starts with `list`, and `tenancy.test.mjs` had to be
told.** That file forbids a control-plane client method matching
`^(list|all|enumerate|search|find)` — structurally, so bulk extraction is
impossible rather than merely uncalled. `listLinks` enumerates within **one**
workspace, the one the presented token resolves to, which is `getStorageBinding`'s
shape and not what the rule is about. So it is exempted by name and held to the
stronger property instead: it cannot be called without naming a context.

## Phase 2: the room carries the document, and what that spends

Carets alone made the collision *visible* and no less painful — you watched
somebody type into the paragraph you were editing and then you both got a
conflict. So the room now relays edits, and two people in a note merge instead
of colliding. This is the property being bought, and it is worth saying plainly
what it costs, because Phase 1's headline sentence was "the room holds no note
text".

**Yjs, over the protocol Yjs already has.** The first version of this was a
hand-rolled exchange in which every client sent its whole document on connect
and the room replaced its history with what arrived — so the second person to
open a note replaced the first person's work with their own empty document, and
the elected writer flushed that emptiness to the bucket. It is the worst bug
this feature has had and it was introduced as a fix for a smaller one. What
replaced it is `y-protocols/sync`: a client announces a state *vector* (what it
already has), anybody holding more answers with exactly the difference, and an
empty document has nothing to send that could delete anything. Convergence is
the CRDT's, not ours.

**The gateway still decodes nothing, and still has zero dependencies.** Updates
are opaque base64 in and opaque base64 out; the room checks shape and size and
relays. `apps/mcp` imports no Yjs and no npm package at all — the merge runs in
the clients, which is also what keeps a self-hosted gateway a plain Worker.

**Three decisions belong to the room, because no client can make them.**
Everything a client could get wrong about a room, it has: each of these was a
bug first.

- *Who seeds the document.* A note starts as text in a bucket and exactly one
  client must put it there — two and the note contains itself twice, none and
  the shared document starts empty and gets saved over the customer's note. The
  client used to ask whether the roster in its own welcome was empty, and a
  welcome's roster always contains the member it was sent to. So `welcome.seed`
  is the room's answer, and the room is the only party holding both halves of
  it: whether anybody else is seated, and whether the replay it is about to
  send already carries the text.
- *Who saves.* One member flushes the merged text to the bucket on a debounce;
  the rest do not save at all. The election is the lowest member id **among the
  members the room would accept an edit from** — so the roster carries write
  authority, resolved from each caller's grant by the route. Without that half
  a room whose lowest id belonged to a read-only viewer elected that viewer,
  and then nobody saved.
- *Who merges a write that came from outside.* See external edits, below.

**Write authority is checked on the frame, by the server.** Opening the socket
needs read — you have to see a note to watch somebody edit it — and changing it
needs write. A `member` of a shared context holds exactly the first, so their
edit frames are dropped by the room rather than trusted and relayed. That is
non-negotiable #4 on this channel, and "a read-only member's edit never reaches
anybody else" is demonstrated in two real browsers, not only asserted.

Asking is not editing, and has its own frame. A state vector goes up as `ask`
rather than as an edit: it is relayed to peers, never written to the log, and
needs no write authority — so a read-only member can ask what the note says
rather than depending on whatever the log happens to still hold.

### Temporary state, durable recovery, and the bucket

Four things hold a note, and their order matters:

1. **The bucket is canonical.** Markdown in the customer's own storage, exactly
   as before. Nothing below is ever the only copy of anything.
2. **The shared document is live state**, in each client's memory, converging
   over the socket. It exists while somebody has the note open.
3. **The room's log is durable recovery, and the shortest-lived copy in the
   system.** Durable Object storage holds the updates the room relayed, so
   somebody joining mid-sentence lands on the text everybody else can see and a
   hibernated room does not lose ten minutes of typing. It is append-only —
   nothing but a confirmed checkpoint deletes from it — and it is deleted
   outright when the last person leaves. **This is the one place note content is
   durable outside the customer's bucket**, it is a derivative under
   non-negotiable #3's terms rather than an exception to them, and the retention
   policy is code (`dropLogIfEmpty`) rather than a sentence.
4. **The elected writer flushes** the merged text back to the bucket on a
   debounce and on ⌘S, as an ordinary conditional write.

### External edits

An MCP client writing a note somebody has open is the case this product is for:
the agent that saves what a session decided, into a note somebody is reading.
After the write lands in the bucket, the gateway tells that note's room, and
**one** member merges it into the shared document — every client merging the
same text would insert those characters once per client, because each copy
generates its own operations for them. The room picks the merger the same way
it picks a seeder: the lowest id among the members it would accept an edit
from. The merge is a prefix/suffix diff, so a write that appended a paragraph
is an insert rather than a whole-document replace, and carets and in-flight
typing survive it.

The notice carries the new etag, and the merging client adopts it — otherwise
its next save is a conflict raised about a change already present in the text
being saved, which is the exact experience this feature exists to remove.

None of it is a guarantee. A room nobody is in drops the notice; a room in
which nobody may write has nobody who can merge and drops it too. Those clients
see the write at their next reconnect, within the five-minute reauthorization
window. The bucket had the change before the room heard about it.

**Edits made outside the product — Obsidian, rclone, an S3 client — are
deliberately not covered.** There is no event to hang a notice on, and inventing
one would mean polling the bucket. Those land the way they always have: the next
read shows them, and a conflicting save raises a conflict.

### What this is verified by, and what that is worth

The unit suites run offline against stubs: `apps/mcp/test/presence.test.mjs`
covers the room, the route and the frame grammar, including a fake of the
Durable Object runtime so the `welcome` frame itself is under test;
`apps/mobile/__tests__/presenceContract.test.ts` runs frames between the
gateway's real module and the client's real module, because every other test on
either side passes with a stub of the other.

That is not enough, and this feature is the proof: the seeding bug survived a
full green suite in both halves and died to two browsers in under a second.
`apps/mcp/test/browser/verify.mjs` drives two Chromium contexts against
`wrangler dev` running the real gateway with real Durable Objects, over real
WebSockets, against a control plane served over real HTTP, with the note and
its folder rule created through the product's own MCP tools. It is run by hand
rather than in CI — it needs a Worker runtime and a browser — and results from
it are reported as what they are: a live demonstration, distinct from a suite.

The simplification to resist now is trusting the suites. A property of this
feature that has not been watched happen in two windows is not known to hold.
