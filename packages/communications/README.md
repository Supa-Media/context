# `@context/communications`

The core of the communications inbox: everything that decides **where a day of
somebody's mail lands**, and **what Markdown it becomes** in the customer's own
bucket.

A mail archive that held your mail would be a competitor to us as much as to
anyone else. So a day of mail lands as one plain Markdown file in storage the
customer owns, readable through the MCP endpoint by every AI client they have
connected — and readable in Obsidian, in a text editor, or after they revoke our
credential. That is the product, and this package is where the file format is
decided.

The argument behind every constant in here is
[`docs/decisions/communications.md`](../../docs/decisions/communications.md).
The on-bucket layout is a stable format, not an internal detail
([`CLAUDE.md`](../../CLAUDE.md), non-negotiable 3): change the decision before
changing a path.

## Where it runs

The gateway (`apps/mcp`) and the control plane import this, so it is plain ESM
with JSDoc types, **zero npm dependencies**, and no Node built-ins. `Date`,
`TextEncoder`, `URL` and the standard library are available on every host it
runs on; nothing else is.

Nothing in here does I/O, and nothing in here knows what Gmail is. A
`CommunicationEvent` is a plain object somebody else fetched — which is what
lets the whole format be exercised against fixtures while the OAuth flow waits
on Google's verification of a restricted scope.

## What is in here

| Module | What it decides |
| --- | --- |
| `protocol.js` | **The contract.** The event shape, the channels, the folders, the frontmatter keys, the split threshold. |
| `paths.js` | Where a channel-day note and a contact page land, and what a key has to look like to be one. |
| `anchors.js` | The stable link target for one message, and the key a thread is grouped by. |
| `note.js` | Rendering and parsing the Markdown a day becomes, and splitting an oversized one. |
| `contacts.js` | The contact page, what may merge automatically, and what may only be suggested. |
| `calendar/` | A day of the calendar: its own folder, its own frontmatter, its own sync cache — see below. |
| `index.js` | The public surface, calendar included. |

## The layout

```text
0-inbox/
├── email/
│   ├── 9f2c1d7a4b6e8035ac91d2f4.md          forwarded captures, unchanged
│   └── name-at-example-com/2026-09-07.md    one connected mailbox, one day
├── google-chat/2026-09-07.md
├── imessage/2026-09-07.md
├── calendar/2026-09-07.md                   every connected account, merged
└── contacts/adam-okonkwo.md
```

No date folders, and no second inbox root. A mailbox is a *folder* because a
folder is the unit `privacy.md` can name — flat, per-mailbox visibility would be
one exact override per day, forever. Calendar is the one exception to "a
channel is a folder": every connected account merges into one
`0-inbox/calendar/`, because a person has one calendar the way they have
several mailboxes — see `docs/decisions/communications.md`, "A calendar day
lands at `0-inbox/calendar/YYYY-MM-DD.md`, with no account level".

## Calendar

`src/calendar/` is the same shape one level down: `protocol.js`,
`anchors.js` (`evt-` anchors, reusing `fnv1a64`), `paths.js`, `timezone.js`
(`Intl.DateTimeFormat` only — no hand-rolled DST table), `render.js`,
`sync.js` (the pure cache-and-project logic an incremental sync needs — see
the decision doc for why a calendar sync needs a local cache at all, which a
channel day never did), `meetingLink.js` (matching a captured meeting to an
event, and the text patch that attaches the link) and `contacts.js`
(attendees, drafted into the same shape `mergeContacts` above already
consumes). The provider-shaped adapter — turning a raw
`calendar.events.list` response into what this package renders — lives in
`apps/mcp/src/communications/calendar-google.js`, one level up, for the same
reason nothing in here knows what Gmail is.

```
node test/calendar.test.mjs
```

runs the calendar suite alone; `node test/test.mjs` runs it as part of the
whole package.

Google Chat has one folder regardless of how many Google accounts sync into
it — `channelFolder` refuses an account segment for any channel but
`email` — and inside it a day is grouped one level deeper than email's:
space (or direct message), then thread, then message. `groupIntoSpaces` in
`note.js` is that grouping; `spaceKey` in `anchors.js` is the hash it is keyed
by, built the same NUL-joined, hash-not-write way `threadKey` and
`messageAnchor` are. A space whose history Chat has turned off, or whose
membership this connection has lost, is named honestly in the note rather
than silently missing — see
[`docs/decisions/communications.md`](../../docs/decisions/communications.md),
*Google Chat groups spaces, then threads, then messages*.

## Tests

```
node test/test.mjs
```

No framework, no install. Each test module carries a **sabotage record**: what
was deliberately broken, and how many checks noticed. Two of the checks in
`paths.test.mjs`, two in `note.test.mjs` and one in `contacts.test.mjs` exist
because the first run of that table said zero.

## The two defangs, and why there are two

A sender's words leave their quotation in two ways, so they are closed
separately and both are in `note.js`:

- **`defangFence`** stops a body from ending the untrusted region it is quoted
  in. The fence carries a per-note nonce, so a marker cannot be pre-written;
  this handles the near-miss.
- **`defangOutsideFence`** is for every string this package writes *outside* a
  fence — a message heading, a thread heading, an attachment filename, and
  every field of a contact page, which has no fence at all because it is
  presented as the owner's own derived index. A subject of
  `x]] and [[.audit/anything` written into `[[<path>#<anchor>|<subject>]]`
  closes the link the renderer opened and opens one the sender chose, which
  `links.js` then resolves and rewrites like a link the owner made.

Bodies go through the first and deliberately **not** the second: inside a
fence, a stranger's brackets are their words, and quoting them verbatim is what
the fence is for.
