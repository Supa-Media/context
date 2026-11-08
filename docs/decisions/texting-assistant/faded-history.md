# Texting assistant — older days faded by age

### A turn is shown its whole chat, the nearer days whole and older ones clipped

Decided by the owner on 2026-11-06, after Tex in Tex Devs kept citing a
four-day-old remark about an OAuth client: "weight recent heavier, keep old
in context", and not by giving the judges the chat's history.

**What a turn is shown.** The day of the text it answers and the day before,
word for word. From two days back, Tex's own answers are cut to 600
characters; from eight days back, Tex's to 240 and the person's to 800; from
31 days back, 120 and 400 (`ledgerHistory.js` `FADE`). A cut text says
`… [cut]` and keeps every link it held, so a page, a draft or a booking Tex
sent is still findable. Days are counted from the newest text being answered,
so the fade moves once a day, not with every text, and the cached history ahead
of the newest day stays the same between texts. The person can still read any
text in full with `fetch texts:` (or `chat:` in a group).

**Where the budget runs out**, the oldest day before the turn's window is
shown whole or not at all, for the same reason.

**What is not faded.** The History page and the history file show the ledger
as it is; only what a model is shown fades. Quoted replies (`replying to`)
quote the message whole.

**Day summaries** carry the chat past where the texts stop: see
[day-summaries](./day-summaries.md).

Tests: `apps/mcp/test/texFadedHistory.test.mjs`.
