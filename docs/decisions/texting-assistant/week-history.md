# One history module for every chat: the last 7 days, and each earlier day summed up (2026-11-16)

**Decided by Dev2, 2026-11-16:** "the context module for messages for one-on-one and groups to be the exact same. They
shouldn't be different. What they should be is 7 days worth of text fully, and then before that summarization, and at
the end of the summary ... to read the rest of it, call, and then list the tool call with the exact ID it needs to call
... to get that day's transcript." Day summaries run for every chat, groups included, and pictures are kept by id in
the chat's own store and "always added to the conversation history ... if it's within that 7 day range".

## Why

Since the conversation threads (2026-11-07, [conversation-threads](./conversation-threads.md)) a turn saw only the
last 24 to 30 hours word for word. A one-to-one chat got its older days as night-after summaries; a group got none
(no summaries ever ran for a group), and since 2026-11-11 a group's older texts dropped out unless an open ask or an
old moment brought one back. A group's pictures were seen only on the turn they came. After a quiet weekend a Monday
group turn was nearly blank, and Tex said it could not see a picture sent two minutes before (thread "Find why Tex
forgets in Tex Devs", 2026-11-16).

## What it is

The front door's context module `week` (`apps/mcp/src/agent/weekHistory.js`), chosen in a Lab draft in place of
`hist`. Main's config reads `hist` until that draft is promoted, so the code ships ahead of it and changes nothing
live (the node-shelf rule, [config-graph](./config-graph.md)).

1. **The last 7 days, word for word**: from midnight six days before the newest text the turn answers, in the
   chat's time zone. The window moves once a day, so the history is the same from text to text within a day and is
   read from the cache. Nothing in it is faded or cut, up to 300,000 characters (past that, the oldest texts go first,
   and the history says so).
2. **Each earlier day as its summary**, oldest first, up to 60 days and 48,000 characters, each ending with the same
   fixed line: `To read that day's whole transcript, call read_day with {"day": "YYYY-MM-DD"}.` `read_day` opens that
   day of this chat word for word, in parts of 60,000 characters. A day with no summary is not listed.
3. **Pictures inline**: each picture sent in the 7 days, by the id it is kept under, as a `[picture <id>]` line under
   the text that sent it, with the picture's own block right after that line in the history message (at most 20, the
   newest, and 12 MB). A one-to-one chat's are kept in `tex/pictures/` as before; a group's are now kept in its home,
   `<home>/pictures/YYYY-MM.md`, sealed to the chat's people like the rest of the home.
4. **Day summaries for every chat**: the shelf node **Chat day summaries** (`chatDays`), on a background wire after
   Text them, sums up each finished day of the turn's chat in the last 21 days that has none, three a run, newest
   first, into that chat's own ledger. A group's summary names who said what. A day is summed up the first text after
   it ends, so it has its summary days before it leaves the 7. The one-to-one nightly run (`daysum`) goes on; both
   write one `day-<YYYY-MM-DD>` entry a day.

A turn that answers no named text (a routine, a check-in, a job's report) reads the same module.

The thread list stays its own module (`threads`) and now says its texts are the last 7 days. The old moments a group
turn was offered (`callbacks.js`) are not offered with `week`: the summaries carry the older days, alike in every chat.

## What a "simplification" would cost

- Giving groups a shorter window or no summaries again brings back the blank Monday turn.
- Moving the window text by text rewrites the whole history to the cache on every text.
- Dropping the fixed `read_day` line leaves Tex knowing a day happened with no way to open it (read_thread was called
  0 times in 1,464 group turns over 14 days).

Tests: `apps/mcp/test/weekHistory.test.mjs` (a one-to-one chat and a group get the same history from the same entries;
the window; the fixed line; pictures after their marker; group summaries; read_day), `texDevDraftFit.test.mjs` (a
draft runs Chat day summaries from the shelf).
