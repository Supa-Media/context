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

## Two modules, span and cap in the config (2026-11-17)

Dev2, 2026-11-17: "split it up ... maybe we show 7d of chat history, maybe 1 month, maybe all, these should all be
config changes, as well as setting the character cutoff ... and then a separate context module for chat summaries";
"make it number of days or all". The single `week` module became two keys in the front door's `ctx`, each carrying
its span and cap:

- `chat:<days|all>:<chars>`: the chat word for word over that many days (from midnight, in the chat's zone), the
  newest kept within `chars`, pictures inline by id;
- `summaries:<days|all>:<chars>`: each earlier day's summary before that window, within the last `days` days, the
  newest kept within `chars`, each ending with its `read_day` line.

Main reads `summaries:all:30000` and `chat:7:130000`. Changing a span or cap is a Lab edit of the front door's
reads, never code. Taking both out puts the front door back on its older view. The history modules run whether or
not conversation threads are on. Test: `apps/mcp/test/weekHistory.test.mjs` ("the chat and its summaries are two
modules…", "a summaries module of 3 days…") and the replay case `history-under-cliff`.

## Under the 100k-token price cliff (2026-11-17)

Haiku 5.5 charges five times for input past 100,000 tokens. A 1:1 front-door round that day wrote 138,187 tokens.
The system modules were 210,914 characters, about 53,500 tokens. The rest was the history the caps allowed: 200,000
characters of the last 7 days plus 120,000 of older summaries, about 85,000 tokens when both caps were full.

40,000 characters of that week had kept 218 of a busy group's 721 texts, so the week itself was about 132,000
characters. `chat:7:130000` holds that week (a thin slice of the oldest texts, if any, is named and `read_day`
opens the day). `summaries:all:30000` keeps the newer older-day summaries, each still ending with its `read_day`
line. A full history is then 160,000 characters, about 40,500 tokens at the measured 3.95 characters per token.
With the system modules, the round stays under 100,000 when the history is the only large part. A 1:1 stretch's tool results are not part of these caps (`promptBudget.js` trims those before a Haiku call is sent). The newest texts of the week stay verbatim. A day the cap
leaves out is still opened by the call its summary names, or by `read_day` when the week's own note says the
oldest texts were left out.

**In the bench (2026-11-17).** A Front door unit test posts the chat before its text at each line's own time
(`apps/mcp/bench/setsFd.mjs` `minutesBefore`, `clock.mjs` `atEarlierTime`), as the Worker posted it live, so the
turn reads the days the way production does. The bench chat has no day summaries, so a line older than the verbatim
days is held just inside them (six days less an hour) rather than dropped, and a run says how many it held. Seeding
real day summaries for those lines is the follow-up. Test: `apps/mcp/test/setsFd.test.mjs` ("each earlier line is
dated…") and `apps/mcp/bench/test/world.test.mjs` ("an earlier line with minutes before…").
