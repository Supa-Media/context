# Search this chat's own history (2026-11-25)

**Raised by the 2026-11-12 durable-memory audit and taken up by Dev2 on 2026-11-25:** Tex keeps every text of every
chat in the chat's ledger, but a turn could only read it by recency: the last days word for word, each older day's
summary, and `read_day` to open one day by its date. Nothing found a line by what was said, so "when did I tell you
about the Atlanta flight?" meant guessing the day, and a 1:1 could word-search its person's group chats
([group-reads-from-1to1](./group-reads-from-1to1.md)) but not itself.

## What it is

One read-only local tool, `search_chat` (`packages/tex/gateway/agent/chatSearch.js`), reached through the six as
`search { query, args: { history: true, who, since, until } }`. It reads this chat's own ledger, the one `read_day`
reads, with the same grant, back to its first text (15 pages of 2,000 entries; a longer chat says only its newest part
was searched and to narrow by days). Whole words with plain endings, never inside another word, the same matching the
group search uses (`findTexts`). Each hit names its day, time and speaker and the `day:` fetch that opens that day.

It is offered when the front door's `ctx` lists the module `chatSearch` (on main since 2026-11-25: Dev2 chose word
search, Lab draft "Search own chat history"), built beside the turn's history from the same ledger whichever way that
history was read (`texEntryPoint/readTheHistory.js`). `oldest: true` puts the first mention first. The fixed tool list shows it only when the turn holds it (`sixToolsFixed.js`), so main's cached
bytes do not change while it is off, and a config that offers it gets the same bytes on every turn. Replay case `finds-old-line`.

## What a "simplification" would cost

- Searching by meaning instead of words needs an index of every chat to keep fresh; words were chosen first because
  they need nothing kept and the group search already proved them. Add meaning only if word misses show up.
- Reading another chat's ledger, or a key the model wrote, would let one chat see another's texts:
  `apps/mcp/test/chatSearch.test.mjs` "never another chat's texts" fails.
- Listing it in the fixed catalogue for every turn would show main a search it cannot call: the same file's fixed-list
  test fails.
