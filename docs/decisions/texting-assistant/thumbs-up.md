# A thumbs up on an ask is the yes (2026-10-21)

Dev2, 2026-10-21: "instead of asking users to say yes, ask them to react like
with a thumbs up ... once they have a thumbs up for like 10 seconds, then
you're good to go", then "Same for like emails and sending messages and all
these other things."

Every ask the gateway texts (`askLine`, `apps/mcp/src/agent/textedApprovals.js`)
ends "Give it a 👍 and I'll send it" (or "…make the change", "…fill it in",
"…go ahead"), in a group too (Dev2, later on 2026-10-21: "a thumbs up should
always be seen as an approval, the text should end with something simple like
'give it a 👍 and i'll send'"). Until then it ended "Look good? Give this a 👍
or say yes", which the Worker still recognises for asks already sent. That covers a
bug report, an email, a calendar change, a card at checkout and anything else
held for the person. A typed yes still works as before.

How it works:

- **The Worker only waits** (`apps/agent/src/thumbs.ts`). A like or heart on
  a text that reads as an ask is held for ten seconds. "Removed a like from …"
  inside that time drops it. Once the ten seconds pass, it goes to `/agent` as
  the tapback it is (`👍`, with the words it was on as `quoted`). In a group,
  only the person the ask was put to can hold one, for half an hour after the
  ask.
- **A 👍 on any text of the reply that carried the ask counts.** The model's
  line above the ask goes out as a text of its own, so a 👍 on it used to be a
  tapback on nothing. The Worker keeps the texts of the last reply that
  carried an ask (`rememberAskReply`) and takes a like on one of them as a like
  on the ask (`onTheAsk`), held ten seconds the same way. The next reply
  without an ask forgets them. Any taken-back like now reaches the inbox, so
  taking back one on that line drops it too.
- **The gateway decides** (`thumbsUpIsYes`). The tapback counts as the yes
  only when its words are the ask for exactly what is armed now, compared on
  letters and digits only, with a cut-off ending allowed. A like on an older ask, or on any other text, goes to the model as
  an ordinary tapback, which disarms what was waiting, as any other text
  does.

- **The quote is not trusted to come back character for character**
  (2026-10-22). Dev2 gave a 👍 to a Slack ask and nothing happened: a
  tapback's quote travels back through Messages and the line, and its
  quotes, apostrophes, emoji or a cut-off ending need not match what was
  sent. A like that matches (letters and digits) a text of the last
  ask-carrying reply, the ask itself included, goes on to the gateway as the
  ask in the exact words the Worker sent, and the gateway compares the same
  way. Every tapback is logged (`event: "tapback"`, its outcome and length,
  never its words), so a 👍 that reached nothing can be told from one that
  never arrived.

What a simplification would cost: releasing on any like makes a 👍 on "Dinner
is booked" send an email; "always" means any text of the reply that asked,
never a text from before it. Releasing without the hold makes a slip of the thumb
irreversible. Tests: `apps/agent/src/thumbs.test.ts` and `a 👍 on the ask for
what is waiting sends it` in `apps/mcp/test/reportGate.test.mjs`.
