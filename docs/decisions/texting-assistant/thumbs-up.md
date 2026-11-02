# A thumbs up on an ask is the yes (2026-10-21)

> **Superseded in part (Dev2, 2026-10-26):** a model's decision may now end a waiting ask sooner (never later) than the rules below. Only the asker's yes still releases it. See [Tex reads one event log and decides when to answer](./event-log.md).

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

- **The Worker only hands it on** (`apps/agent/src/thumbs.ts`). A like or
  heart on a text that reads as an ask goes at once (Dev2, 2026-10-22: "can
  we remove the 10 second wait, there is just no need"; until then it was
  held for ten seconds). "Removed a like from …"
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

- **Tex's asks are answered in the texts and nowhere else** (Dev2,
  2026-10-22: a day of re-asks had left a pile of them in the app's
  Approvals panel, two copies of one email each one tap from sending). A
  record raised for a texted turn carries `asked_by_text`; once the thread
  moves on it is dropped, not left for the app, and the app neither lists
  nor settles one (`askedByText` in `apps/mcp/src/tools/approvals.js`; older
  records are known by Tex's client name). A key's first use, which Tex too
  is allowed in the app, and every other AI's ask still wait in the panel.
  Test: `a texted ask is answered in the texts and never in the app` in
  `apps/mcp/test/agentEgressTexting.test.mjs`.

- **Fewer rounds per ask (Dev2, 2026-10-22, asked for each):** any yes
  releases what the ask showed, an email or a bug report included: "ok",
  "sure", "go ahead", "sounds good", "perfect" (a courtesy like "ok thanks"
  is still not one). An ask stands through a side text ("one sec"): the
  model is told it still waits and must not ask again; it stops listening
  only when Tex's own answer asks something else (a "?" in it, so a bare yes
  answers that), when a newer ask replaces it, on a no, or when it expires.
  Several emails in one turn go in one ask, each shown whole, and one yes
  sends them all; one that would outgrow a text is withdrawn, not cut. Tests:
  `an "ok" to an email is a yes`, `a side text leaves the ask standing`, `a
  yes after Tex asked something else sends nothing` and `two emails in one
  texted turn go in one ask` in `apps/mcp/test/emailGate.test.mjs`.
- **A text Tex sends by itself is Tex asking something else** (2026-10-26,
  from a self-review: a "yes" to a routine's reminder sent a bug report held
  before it, with the person's last 12 texts). A routine, a check-in, an
  agent's ping or a fixed Worker text after an ask means a bare yes or no
  answers that text. The runs disarm the ask themselves, and the yes checks
  again against the conversation as it was texted (`askOvertaken.js`: any
  "Not a text from them" entry after the ask was armed, unless the ask was
  shown again after it), so a disarm that missed still sends nothing; the
  ask is dropped and the model is told so, and calling again asks again. A
  👍 on the ask's own words still sends it. The person's own side texts never
  count. Tests: `a yes after a text Tex sent by itself does not release an
  ask shown before it` and the `overtaken` checks in
  `apps/mcp/test/agentEgressTexting.test.mjs`.

What a simplification would cost: releasing on any like makes a 👍 on "Dinner
is booked" send an email; "always" means any text of the reply that asked,
never a text from before it. Releasing without the hold makes a slip of the thumb
irreversible. Releasing on a liked preview without the name check sends to
whoever the model picked. Tests: `apps/agent/src/thumbs.test.ts`,
`apps/agent/src/sendblueTapbacks.test.ts`, `a 👍 on Tex's own preview` in
`apps/mcp/test/connectors.test.mjs`, `a yes said in a sentence` in
`apps/mcp/test/agentEgressTexting.test.mjs`, and `a 👍 on the ask for
what is waiting sends it` in `apps/mcp/test/reportGate.test.mjs`.

- **A one-to-one 👍 is never taken by the group drain** (2026-10-22). Proven
  from Sendblue's record of the line (`.github/workflows/tapback-evidence.yml`,
  shapes only): Dev2's Apple 👍 arrived as a plain inbound text, "Le gustó
  “…”" (the relay writes tapbacks in Spanish; a take-back is "Dejó de
  gustarle “…”"), naming the ask in `reply_to`. It was held, and then the
  inbox's alarm drained a group's queue first, and the group drain took the
  👍 out of the shared `thumb` key as a group's and dropped it. Every held
  one-to-one 👍 was lost this way; a typed yes never passes through the hold,
  which is why it always worked. A group's 👍 is held under `gthumb`. Test:
  `thumbs.test.ts`, "a real Apple 👍 on an email ask survives the alarm".
- **One text, not two.** The model's one line about what it held ("Drafted
  it again…") said what the ask says, as a second text; it is dropped when it
  is only that (`answerWithAsk`), and anything else it said stays above the
  ask. A typed yes or a 👍 to an email Tex previewed in its own words, with
  nothing held, sends it once its every recipient and whole body are in that
  preview (`likedPreview.js`, `agreedWordsHold`).
- **Never put to decide (2026-10-28).** Since decide chose which texts a
  turn answers (2026-10-26), a held 👍 reached it as a tapback, which
  `pureAck` counts as asking nothing, so decide's "silent" or "react", an
  answer whose `covers` left it out, or a mid-turn "fold" could drop it
  before the gateway saw it: no send and no reply. Found from the source
  after a controlled test's 👍 on Tex's email ask got no answer. `react` now
  marks a held like or love `askYes`, and `decidedByCode` answers it on its
  own, intact, as a group's already was (`byCode`). Nothing else changes: the
  gateway's `thumbsUpIsYes` still decides whether it is the yes to what is
  armed, and any other tapback is decide's as before. Test:
  `askThumbDecide.test.ts`.
- **A 👎 is the no, and a yes-or-no invites both (2026-10-30).** A new
  tester (SB Studio) asked why Tex says "say yes" when a 👍 already counts.
  Three changes. Every texted turn is told to end a yes-or-no question with
  "👍 or 👎?", never "say yes" (`chatVoice.js`, `YES_NO_LINE`). A 👎 on a
  held ask, or on the line above it, is held and answered by code exactly as
  a 👍 is (`holdsAsNo`, groups included), and the gateway's `thumbsDownIsNo`
  drops what is armed when its words are that ask: before, a 👎 reached the
  model as a bare emoji, nothing was dropped, and a later "yes" could still
  send it. A typed 👎 is a no (`NO`). And a 👍 or 👎 on any text of Tex's
  that asked something is never left silent by decide (`pureAck`), since Tex
  invited it as the answer. Tests: `emailGateThumbDown.test.mjs`,
  `askThumbDecide.test.ts`, `thumbs.test.ts`.
