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
| `index.js` | The public surface. |

## The layout

```text
0-inbox/
├── email/
│   ├── 9f2c1d7a4b6e8035ac91d2f4.md          forwarded captures, unchanged
│   └── name-at-example-com/2026-09-07.md    one connected mailbox, one day
├── google-chat/2026-09-07.md
├── imessage/2026-09-07.md
└── contacts/adam-okonkwo.md
```

No date folders, and no second inbox root. A mailbox is a *folder* because a
folder is the unit `privacy.md` can name — flat, per-mailbox visibility would be
one exact override per day, forever.

## Tests

```
node test/test.mjs
```

No framework, no install. Each test module carries a **sabotage record**: what
was deliberately broken, and how many checks noticed. Two of the checks in
`paths.test.mjs` and two in `note.test.mjs` exist because the first run of that
table said zero.
