# Texting assistant — day summaries

### Each finished day is summed up the night after, and shown where the texts stop

Decided by the owner on 2026-11-06, in the review of Tex's context: a daily
summary kept inside the chat's history, so the old stays in context without
its every word.

**Where it is kept.** In the chat's ledger, the one record of the chat
([chat-ledger](./chat-ledger.md)), as a `day` entry: `{day, text, model}`,
id `day-<YYYY-MM-DD>`, so a day keeps one summary however often the night runs.
Its `at` is that day's last entry. It exports with the ledger.

**Who writes it.** After the nightly dream, the gateway (never the turn's
model) reads the last week of the person's one-to-one chat as the dream reads
it (texts, thinking and tool calls, never what a tool returned) and has Haiku
sum up each finished day that had a text from them and has no summary yet,
at most three a night, in two to five sentences that keep names, dates,
amounts and links (`daySummaries.js`). Today and the part-day a read begins
in are never summed up. The log counts days, never words.
`DAY_SUMMARIES = "off"` turns it off.

**What a turn is shown.** A turn reads its chat newest first until the
history budget is spent ([faded-history](./faded-history.md)). When the chat
runs past that, one more read takes the `day` entries before it, and the
history opens with the summaries of the days that ended before every text it
shows, oldest first, within 12,000 characters (`ledgerHistory.js`
`summaryLines`). A day the turn shows is never also summed up, and a short
chat makes no extra read. The History page shows texts, not summaries.

**Not yet.** Group chats have no dream, so no summaries; a group's turn shows
its texts as before.

**What reversing it costs.** Without it, a chat longer than the budget loses
its older days entirely. Tests: `apps/mcp/test/texDaySummaries.test.mjs`.
