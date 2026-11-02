# Each chat with Tex has one ledger, and every view is rebuilt from it (2026-11-02)

_Part of [the texting assistant](../texting-assistant.md). Decided by the owner, 2026-11-02: "I want one JSON file for the structured data, a manifest for the way we're structuring the data, like a v1, v2 … I want everything logged, including tool calls and the responses … just one source of all of this", for every one-to-one chat and every group chat, kept in a Durable Object, with what Tex reads, the daily pages and the rest rebuilt from it "on the fly"._

## What holds

- **One ledger per chat.** A person's one-to-one chat with Tex (chat `texts`, whichever line they text on) is kept in their Tex object, `person:<workspaceId>`; a group chat's in its own, `chat:<groupKey>` (`texStore/ledger.js`). One row per entry, appended and never edited, so adding a line never rewrites the file; read back, a chat's rows are one JSON document with its manifest first: `{manifest: {schema: "tex-ledger", version: 1, chat, created, updated, count, bytes}, entries}`.
- **Versioned.** Every entry carries `v`; the manifest names the schema and version. A reader that meets a version newer than it knows reads none of it rather than misreading it. A change of shape is a new version, never a silent change of v1.
- **Everything is kept** (`agent/ledger.js`): what they sent and what Tex sent (`text`), its thinking in words (`thinking`), what it said between tools (`said`), each tool call with its arguments, outcome, time and result (`tool`), the answer (`reply`), the advisor's asks (`advisor`), the Mail checker's verdicts (`mail_check`), jobs (`job`) and anything else worth keeping (`note`). A later fact about an earlier entry (a held email settled) is a new entry naming it in `ref`, never a rewrite.
- **One exception, by the owner's rule.** A call that read from another workspace (a `context` other than the one the chat's turns run in) keeps what it asked for, its arguments and how it went, never what came back (`withheld: "other_workspace"`). A person keeps what they learned from work they lose access to; they do not keep a copy of the other workspace's notes.
- **Never a secret.** An argument named like a secret is kept `[hidden]`; saved logins never reach a turn at all ([vault](./vault.md)). A very long result or text is kept cut with its full length in `cut`.
- **Idempotent.** An entry's id is kept once per chat; a retried write adds nothing. A chat event keeps the event's own id.
- **Views, not copies.** What a turn is shown, the daily transcript page, the Tex page's thinking, advisor and mail-check lists, dreaming and export are rendered from the ledger, choosing which kinds to include. Leaving thinking or tools out of what the model reads is a change to a view, never to what is kept.

## This reverses

- "Never a tool's result" in the history and transcripts ([history](./history.md), 2026-10-09; [transcripts](./transcripts.md), 2026-10-15). The grant reason for it now applies only to results from another workspace, which stay out.
- Several copies of one chat (the event log in the bucket and the texting Worker's day of it, the history record, the transcripts, the Tex page's own records). They are folded into the ledger and then retired, one at a time, each after its readers read the ledger.

## What a simplification would cost

- Keeping a second store "for the page" or "for speed": two records that disagree, the regression the owner rejected repeatedly ([one-to-one-history](./one-to-one-history.md)).
- Keeping another workspace's results: a chat holding notes its people may no longer reach.
- Rewriting the whole file on each append: every text would grow slower with the chat's age.

## Tests

`apps/mcp/test/chatLedger.test.mjs`: one document, manifest first, in order; a retried append keeps one copy; two chats never read each other; paging with `after`, `before` and `kinds`; refused envelopes keep nothing; wipe removes every ledger; a person's and a group's ledgers live in their own objects; an open page is told what changed; a call that read another workspace keeps no result; secrets hidden; long results cut; the writer keeps order and never throws.
