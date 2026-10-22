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

- **Every shape of Apple's 👍, a 👍 on a preview, and a yes in a sentence**
  (2026-10-22). Three of Dev2's 👍 tapbacks on asks reached nothing while a
  typed "yes" sent at once ("please make sure we are actually counting the
  default 👍 from apple"). Sendblue documents its receive webhook only for
  messages, so the Worker reads a tapback first, in any shape
  (`sendblueTapbacks.ts`): "Liked “…”" whatever `message_type`, `service` or
  `is_outbound` say, or a reaction of its own naming the message it was on,
  whose words are read from Sendblue as an inline reply's are. Never over SMS,
  where anyone could type one from the number. Every payload that is not a
  plain message is logged by its shape (keys, `message_type`, never words or
  numbers). A 👍 on any text of Tex's that asks something in words ("Say yes
  and I'll try sending it again", "Say the word") is answered, no longer only
  noted, and the model is told to say how it went: "Sent ✓", or what failed.
  When Tex's own preview held nothing, a 👍 on it releases a Slack post the
  turn then raises, without a second ask, only when the liked words hold the
  message's whole text and Slack's name for where it goes is in them or in
  Tex's last few texts (`tools/likedPreview.js`), once a turn. A typed yes in
  a sentence ("yes please send it already sent 👍") is a yes when every word
  in it is one of a fixed few and one says yes or send; any other word, "to",
  a name, "but", still goes to the model. A Slack refusal for a missing
  permission is told to the person in their terms. The gateway logs each 👍
  it compares (`event: "thumbs_up"`, how many were armed, whether it matched).

What a simplification would cost: releasing on any like makes a 👍 on "Dinner
is booked" send an email; "always" means any text of the reply that asked,
never a text from before it. Releasing without the hold makes a slip of the thumb
irreversible. Releasing on a liked preview without the name check sends to
whoever the model picked. Tests: `apps/agent/src/thumbs.test.ts`,
`apps/agent/src/sendblueTapbacks.test.ts`, `a 👍 on Tex's own preview` in
`apps/mcp/test/connectors.test.mjs`, `a yes said in a sentence` in
`apps/mcp/test/agentEgressTexting.test.mjs`, and `a 👍 on the ask for
what is waiting sends it` in `apps/mcp/test/reportGate.test.mjs`.
