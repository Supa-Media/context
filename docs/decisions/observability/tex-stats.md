# Tex's basics for any window: people, texts, cost and notes (2026-11-10)

Dev2 asked (2026-11-10) for one place to see Tex's basic numbers: daily active people, texts sent and received,
average AI inference cost per text, total inference cost, and notes created and edited, for the last 24 hours, the
last 7 days or a custom range. tex.lc/admin already had turn counts and spend, but only over 7, 30 or 90 days, read
from Convex's `agentTurns` (kept 30 days, capped at 4,000 rows a read). It had nothing for people, texts out, or
notes. These figures now sit at the top of tex.lc/admin as **The basics**, with their own window.

## Where each figure comes from

- **Texts in and out, and who texted.** The texting Worker writes one Analytics Engine point per text to
  `tex_text_counts` (binding `TEX_COUNTS`; staging `tex_text_counts_staging`; `apps/agent/src/textCounts.ts`).
  An incoming point is written when the inbox keeps the text: a 1:1 text that was queued (`text`), or a group
  message that was queued for Tex (`for_tex`) or only heard (`heard`). Duplicates, tapbacks, reactions, simulator
  texts and routine runs are not counted. An outgoing point is written once the line has taken the message, by the
  1:1 `Line` and the group `GroupLine`. Every reply, progress text, routine text and job report goes through one of
  those two, so each is counted.
- **People.** An incoming point's index is the sender's own inbox object id, `SENDER_INBOX.idFromName("enam:" +
  number)`. Cloudflare derives that id with a key we do not hold. So it counts the same person once in 1:1 and in
  groups, and it cannot be turned back into a phone number. "Daily active" is the average, across the window's UTC
  days, of each day's distinct people who texted Tex 1:1 or wrote to it in a group. A group member Tex only heard is
  not counted as a person.
- **Notes created and edited.** A workspace object writes a `note` point to `context_calls`
  (`countNoteWrite`, `apps/mcp/src/observability/callCounts.js`) from the object's own `put`, for keys
  `notes/<id>.md` only. The point is `created` for a new key and `edited` for changed bytes. A save of the same bytes
  is not counted. A note is named by its id alone. "Notes edited" counts distinct notes, because live typing saves
  continuously, and the saves are shown beside it. Workspaces still on the bucket for reads, and Tex's own notes, are
  not counted.
- **Cost.** This is what Cloudflare's AI gateway billed for Tex's labels, the same set the Spend card uses
  (`TEX_FEATURES`, `texSpend.ts`), asked for exactly the window by the hour or the day. It is account-wide, so
  staging's Tex is included. Test runs are shown apart. Cost per text is the total divided by the texts people sent
  Tex: 1:1 texts plus group messages for Tex.

`api.functions.texStats.report` (staff only) asks for all of this with the analytics token the AI costs tab already
uses. It sends Analytics Engine SQL built from numbers and fixed names only, and on a deployment whose `APP_ENV` is
`staging` it reads the `_staging` datasets. A source that fails says so in our words, and the other sources still
show. A window is held to the last 60 days, because Cloudflare keeps the gateway's figures about that long. Counting
began when this shipped, so earlier hours read zero.

## What a simplification would cost

- Counting people by phone number, or by a plain hash of it, would put a recoverable number in the dataset. The inbox
  object id is what keeps the count pseudonymous.
- Counting texts in the webhook rather than at the inbox would count Sendblue's retries and duplicates.
- Counting note writes at the gateway would miss the object's own saves (`ws.create`, collaboration flushes). The
  object's `put` is the one place every note's text lands.

Tests: `apps/agent/src/textCounts.test.ts`, `apps/mcp/test/callCounts.test.mjs` (the note test),
`apps/convex/__tests__/texStats.test.ts`, and `apps/mobile/__tests__/texDashboardRender.test.ts` (the basics).
