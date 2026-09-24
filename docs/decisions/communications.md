# Communications

_See `docs/decisions/README.md` for the index._

Context records a person's communications the way it records their meetings:
not as a separate product with its own account and its own export button, but
as **plain Markdown in a bucket they own, readable through the endpoint every
AI client they have is already connected to**. A mail archive that held your
mail would be a competitor to us as much as to anyone else.

The scope this argues is `1-projects/context-lc-personal-communications-inbox`
in the company workspace, dictated by the owner on 2026-09-07: several personal
mailboxes, Google Chat and iMessage, one Inbox and one Contacts graph, **person
owned**. Workspace inboxes, support intake and team-owned communications are
explicitly a later product and nothing here should make them harder.

The on-bucket layout is a stable format, not an internal detail
([non-negotiable 3](../../CLAUDE.md)) — the same bucket is somebody's Obsidian
vault, and changing where a year of their mail lives is a migration they did
not ask for. So it is decided once, here, before anything writes a file.

The prototype of this layout is `packages/communications` — pure functions,
no dependencies, fixtures and tests, exactly like `packages/meetings`. That
package is the contract; this file is the argument behind it.

### A channel lands in `0-inbox`, and there is no second inbox root

Moved to [A channel lands in `0-inbox`, and there is no second inbox root](./communications/inbox-and-filing.md#a-channel-lands-in-0-inbox-and-there-is-no-second-inbox-root).

### ...and the default a connection is given is that folder, not a second string

Moved to [...and the default a connection is given is that folder, not a second string](./communications/inbox-and-filing.md#and-the-default-a-connection-is-given-is-that-folder-not-a-second-string).

### A day is filed under `YYYY/MM/`, and the date stays in the filename

Moved to [A day is filed under `YYYY/MM/`, and the date stays in the filename](./communications/inbox-and-filing.md#a-day-is-filed-under-yyyymm-and-the-date-stays-in-the-filename).

### The account level reaches Calendar and Chat

Moved to [The account level reaches Calendar and Chat](./communications/inbox-and-filing.md#the-account-level-reaches-calendar-and-chat).

### There are no `YYYY/MM/` folders, and the date is the filename

Moved to [There are no `YYYY/MM/` folders, and the date is the filename](./communications/inbox-and-filing.md#there-are-no-yyyymm-folders-and-the-date-is-the-filename).

### The mailbox is a folder because a folder is what `privacy.md` can name

Moved to [The mailbox is a folder because a folder is what `privacy.md` can name](./communications/inbox-and-filing.md#the-mailbox-is-a-folder-because-a-folder-is-what-privacymd-can-name).

### An address becomes a slug, and a slug is never a name anybody can claim

Moved to [An address becomes a slug, and a slug is never a name anybody can claim](./communications/inbox-and-filing.md#an-address-becomes-a-slug-and-a-slug-is-never-a-name-anybody-can-claim).

### A channel-day note is one file, with a fixed frontmatter, and its messages are fenced

Moved to [A channel-day note is one file, with a fixed frontmatter, and its messages are fenced](./communications/inbox-and-filing.md#a-channel-day-note-is-one-file-with-a-fixed-frontmatter-and-its-messages-are-fenced).

### A message anchor is a hash, and it is the only provider id in the bucket

Moved to [A message anchor is a hash, and it is the only provider id in the bucket](./communications/search-and-retention.md#a-message-anchor-is-a-hash-and-it-is-the-only-provider-id-in-the-bucket).

### An oversized day splits by rendered bytes, and the split is a pure function of the day

Moved to [An oversized day splits by rendered bytes, and the split is a pure function of the day](./communications/search-and-retention.md#an-oversized-day-splits-by-rendered-bytes-and-the-split-is-a-pure-function-of-the-day).

### A channel-day note is a note, and `privacy.md` decides it with no bypass

Moved to [A channel-day note is a note, and `privacy.md` decides it with no bypass](./communications/search-and-retention.md#a-channel-day-note-is-a-note-and-privacymd-decides-it-with-no-bypass).

### Search must index messages, and today's index cannot

Moved to [Search must index messages, and today's index cannot](./communications/search-and-retention.md#search-must-index-messages-and-todays-index-cannot).

### A firehose is not attention

Moved to [A firehose is not attention](./communications/search-and-retention.md#a-firehose-is-not-attention).

### Retention: raw MIME is off by default; attachments are fetched into the bucket, retained on a timer

Moved to [Retention: raw MIME is off by default; attachments are fetched into the bucket, retained on a timer](./communications/search-and-retention.md#retention-raw-mime-is-off-by-default-attachments-are-fetched-into-the-bucket-retained-on-a-timer).

### Contacts: one page per person, and a merge never rewrites history

Moved to [Contacts: one page per person, and a merge never rewrites history](./communications/contacts-and-chat.md#contacts-one-page-per-person-and-a-merge-never-rewrites-history).

### And they are read through two tools, because a page nobody can find is a file

Moved to [And they are read through two tools, because a page nobody can find is a file](./communications/contacts-and-chat.md#and-they-are-read-through-two-tools-because-a-page-nobody-can-find-is-a-file).

### The Gmail restricted scope is Google's decision, so v1 runs on fixtures

Moved to [The Gmail restricted scope is Google's decision, so v1 runs on fixtures](./communications/contacts-and-chat.md#the-gmail-restricted-scope-is-googles-decision-so-v1-runs-on-fixtures).

### Google Chat groups spaces, then threads, then messages

Moved to [Google Chat groups spaces, then threads, then messages](./communications/contacts-and-chat.md#google-chat-groups-spaces-then-threads-then-messages).

### An honest gap: history unavailable is written down, not smoothed over

Moved to [An honest gap: history unavailable is written down, not smoothed over](./communications/contacts-and-chat.md#an-honest-gap-history-unavailable-is-written-down-not-smoothed-over).

### Chat's account field is per-message, not per-day

Moved to [Chat's account field is per-message, not per-day](./communications/contacts-and-chat.md#chats-account-field-is-per-message-not-per-day).

### Disconnecting Chat clears settings and cursors; the folder itself follows the mailbox rule

Moved to [Disconnecting Chat clears settings and cursors; the folder itself follows the mailbox rule](./communications/contacts-and-chat.md#disconnecting-chat-clears-settings-and-cursors-the-folder-itself-follows-the-mailbox-rule).

### The Chat scopes, and where they sit on Google's own restricted list

Moved to [The Chat scopes, and where they sit on Google's own restricted list](./communications/contacts-and-chat.md#the-chat-scopes-and-where-they-sit-on-googles-own-restricted-list).

### Chat sync is built against an injected client, and now attaches to the one shared row

Moved to [Chat sync is built against an injected client, and now attaches to the one shared row](./communications/chat-sync-and-products.md#chat-sync-is-built-against-an-injected-client-and-now-attaches-to-the-one-shared-row).

### Adding a product must not silently drop another one

Moved to [Adding a product must not silently drop another one](./communications/chat-sync-and-products.md#adding-a-product-must-not-silently-drop-another-one).

### The five open decisions, and who settles them

Moved to [The five open decisions, and who settles them](./communications/chat-sync-and-products.md#the-five-open-decisions-and-who-settles-them).

### The Gmail connection: control plane, sync algorithm, and what phase 1 actually wires up

Moved to [The Gmail connection: control plane, sync algorithm, and what phase 1 actually wires up](./communications/gmail-and-sync-loop.md#the-gmail-connection-control-plane-sync-algorithm-and-what-phase-1-actually-wires-up).

### The forward sync loop: a pull, on a floor of five minutes

Moved to [The forward sync loop: a pull, on a floor of five minutes](./communications/gmail-and-sync-loop.md#the-forward-sync-loop-a-pull-on-a-floor-of-five-minutes).

## Calendar

Moved to [Calendar](./communications/calendar.md#calendar).
