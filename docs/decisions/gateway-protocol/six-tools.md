# Gateway protocol: six tools that never change, and new capabilities are actions

## The gateway advertises six tools, and the names are fixed

Decided with the owner, 2026-10-16. Context offers an MCP client exactly six
tools: `orient`, `search`, `fetch`, `write`, `manage` and `send`. Every
capability Context has is reached through one of them. The 49 names that were
advertised before (`write_note`, `read_note`, `search_notes`, `save_context`,
`set_visibility` and the rest) still answer when called by name, as aliases,
until call logs show nobody uses them. They are no longer in `tools/list`.

- **`orient`** is the front door, and it documents the rest. `orient about:
  "tools"` lists every action with its arguments as they are today.
- **`search` and `fetch`** read. They are the ChatGPT pair (see
  [`search` and `fetch` exist because ChatGPT's chats can call nothing else](../gateway-protocol.md))
  and the ids `fetch` accepts are the one vocabulary for reading anything.
- **`write`** adds or changes content: a note, a comment, mail, a remembered
  fact, a proposal, a form answer, a saved session, a problem report.
- **`manage`** changes what Context can undo: where something lives, who sees
  it, whether it is encrypted, a share link, a vault link.
- **`send`** does what Context cannot take back: a call to an outside API with
  a key the person saved, which the model never sees.

A new capability is a new **action** in `args` of one of these tools. The
gateway validates the action and its arguments against the table in
`apps/mcp/src/tools/v2/actions.js`, which says which existing tool carries it
out. The table is the only place an action is named; `orient` renders it.

## Why six, and why the names do not change

Clients freeze the tool list at connect, and most do not refresh it until a
person reconnects (see [Orient names the tool changes](./tool-news.md) and the
staleness survey it cites). Codex and Claude Desktop drop an argument their
copy does not list; Cursor reads only the first forty tools; ChatGPT's ordinary
chats call only `search` and `fetch`. A server that adds a tool or an argument
every few weeks therefore ships half of each change to clients that cannot see
it, and the failures look like the product being broken.

Six tools with fixed names, and an open `args` object that the gateway checks
itself, move the change out of the part a stale client freezes:

- **Nothing a client holds goes stale.** The names, and the one `action` and
  `args` shape, are the same next year. A new action is a row the gateway
  already routes; a client that holds last month's copy can still call it,
  because the copy says `args` is an object, not what is in it.
- **`orient` is the live manual.** Its copy of the actions is newer than any
  client's, and it is checked against the table on every call, so the answer
  to "what can I do" is never a frozen description.
- **Fewer than ten tools is the point.** Cursor's forty-tool cut and a model's
  choice among near-identical names both get worse with every tool added.

## Split by risk, so a client can ask first

The three write-shaped tools are split by what a mistake costs, not by the
noun:

- `write` is content. It can be corrected by writing again, and its history is
  the customer's own.
- `manage` is what Context can undo: a note moved back, a visibility put back.
  Its descriptions say to ask the person before anything that lets more people
  see something.
- `send` is what cannot be taken back: an outside call has happened. It is the
  one tool marked `openWorldHint`, and an app that asks before sending asks
  here.

A client that wants to confirm with the person before anything irreversible
can therefore gate `manage` and `send` and leave `write` alone, with three
names instead of forty-nine. The split is advice to the client and to the
model; authority does not depend on it. The gateway's write gate, egress gate
and visibility rules decide every translated call exactly as they decided the
old tool it became.

## Authority is still decided once, after translation

`translateV2Params` (`apps/mcp/src/tools/v2/translate.js`) turns a v2 call into
one call of an existing tool before routing. Everything that decides authority
runs on that translated call: the context it reaches, the write gate, the
egress gate, argument validation against the existing tool's schema, and the
audit record. A v2 call is therefore decided exactly as the old call it stands
for, and a reversal of this rule is a privilege question, not a tidy-up.

The translation reads an action's `args` only as far as the table says, and
refuses an unknown action with the list of the ones that exist, rather than
passing an unknown name through to the dispatcher.

## What a "simplification" would cost

- **Adding a tool for a new capability.** A stale client cannot call a new
  name until it reconnects, and some never do. That is the whole reason for
  the six names; a seventh is the change this decision exists to stop.
- **Folding the six into one dispatcher with `execute`.** Models read
  `execute` as "run code" and misuse it; the name `send` was chosen for the
  outside-call meaning, and the split by risk is lost with it.
- **Putting authority in the tool names or the schema.** A client's copy of a
  schema is the thing that goes stale. Authority in the names would be decided
  twice, once in the table and once in the copy, and drift.
- **Removing the old names.** Every connection made before this change still
  holds the 49. Their aliases are kept until call logs show nobody calls them.
  Removing them early breaks those chats; keeping them costs one alias table.
- **Adding staff upkeep to the actions.** `rotate_encryption_keys`,
  `materialize_move` and `migrate_storage_layout` are not agent actions. They
  move to the console later, and an action table that lists them would hand a
  connected agent the keys to the bucket.

## Tests

- `apps/mcp/test/v2Actions.test.mjs` — every action in the table translates to
  the tool it names, refuses an unknown action with the list, and an action's
  arguments are validated against the translated tool's schema. A translated
  call reaches the same gate as the old call (sabotage: route a v2 call around
  `translateV2Params` and the write-gate and visibility cases fail).
- `apps/mcp/test/v2SearchFetch.test.mjs` — `search` and `fetch` translate to the
  same scan and the same visibility as the tools they replace, and a private
  note is not distinguishable from one that does not exist.
- `apps/mcp/test/orientV2.test.mjs` — `orient about: "tools"` lists exactly the
  actions a connection may call, and a read-only grant sees no `write` action
  it cannot use.
- `apps/mcp/test/toolNews.test.mjs` — the advertised names and argument names
  are fingerprinted, so a change to the six (or to an alias) needs a news entry.
- `apps/mcp/test/protocolBasics.test.mjs` — the connect-time instructions name
  the v2 spellings the agent must use.
