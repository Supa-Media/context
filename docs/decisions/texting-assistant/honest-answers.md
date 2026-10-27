# A texted answer never says a change was made that wasn't (2026-10-21)

On 2026-10-21 the owner's chat with Tex went wrong in four ways in a few
minutes. A check-in texted them about a failed deploy from a GitHub
notification; they answered "never message me about github stuff unless i
ask" and Tex said "Will do." with nothing kept. Tex offered to send a receipt
on to their bookkeeper and then said it couldn't attach the PDF. It said "It's
on your to-do list now", then "I can't confirm I added it". And after "do it
for me, and if you can't do it, file a bug to the developers", it drafted the
report and waited for a thumbs-up. The owner: "you asked to do it but you
can't even finish the task?"

Each was fixed where the gateway can tell for itself, rather than in the
prompt alone:

- **Claims are checked against the calls that ran** (`apps/mcp/src/agent/claimCheck.js`).
  A texted answer that says something was added, saved or put somewhere, on a
  turn where no write succeeded, goes back to the model once with a notice: do
  it now, or say plainly it is not done. A text asking never to be texted about
  something, on a turn that did not change `tex/attention.md` or
  `tex/heartbeat.md`, goes back the same way, told to add the words to `mute:`.
  The notice is given once a turn (`turn.js` `answerCheck`), so it can never
  loop, and the gateway never writes on the model's behalf.
- **Check-ins honour muted words** ([heartbeat](./heartbeat.md)), and are told
  to offer only what Tex can actually do once the person says yes.
- **A forward carries its attachments** ([sending email](../communications/sending-email.md)).
- **A text asking for a bug report is the yes for one without their texts**
  ([bug reports](./bug-reports.md)).

**What a simplification would cost.** Dropping the claim check lets "it's on
your list" go out with nothing on the list, which is the overpromise the owner
called ridiculous. Letting the notice repeat could spend a turn's rounds on it.
Having the gateway write the mute itself would put words in the person's
settings that no allowed call wrote. Tests: `apps/mcp/test/agentClaimCheck.test.mjs`
(three sabotages recorded there).

### An offer of a calendar change or an email is held when it is made

Raised by the owner on 2026-10-21 ("This is annoying. why does this happen?").
Tex texted "Want me to add 'Emmanuela/Sayo,' 7 to 8 pm today?", the owner said
"yes", and only then did the model call `calendar_event`. The gate held it, so
the reply was a second ask ("From 2026-10-21T19:00:00-04:00 …"), led by the
model's own "Still waiting on the calendar yes. Check your messages from
Context for the confirmation", and a second "YES" made it.

The yes was not released directly, because only a yes to the exact change the
person was shown may make one ([calendar writes](../communications/calendar-writes.md)),
and prose names a change loosely. Instead the hold is raised with the offer,
so the first yes is to the exact change:

- **An offer in words with nothing held goes back once** (`claimCheck.js`
  `OFFER_NOTICE`): a question offering to add, move or cancel something at a
  day or time or on the calendar, or to send, forward or reply to an email.
  The model makes the call, the ask goes out under its words, and the
  person's one yes makes the change. Offers about their own list or notes take
  no yes and are left alone.
  After that shipped, the same afternoon, Tex texted its own preview of a
  forward ("To: … Forward of: …  Say yes and I'll send it."), with no
  question mark and nothing held. The owner's 👍 and "yes" on it only raised
  the hold, and they were asked a third time. So an email laid out in Tex's
  own words ("To:", "Subject:", "Forward of:"), or its own request for a yes
  or 👍 about sending, filing or the calendar, counts as an offer too. The
  first preview the person sees is the gateway's ask, so a 👍 or yes on it
  sends.
- **Talk of a yes waited on elsewhere comes out** (`heldEcho.js`
  `withoutWaitTalk`): with an ask attached, a sentence about "still waiting",
  "messages from Context", a confirmation in the app, or the model's own
  request for a yes ("Say yes to the exact email I just texted you") is
  dropped. The ask is right below it, and it asks once. The held result tells the model the same.
- **Calendar changes are shown in words** (`calendarWrite.js` `spanWords`):
  "Wednesday, October 21, 7 to 8 pm", read off the time as given, with "UTC"
  said when that is the clock, and the year only when it is not this one.

**What a simplification would cost.** Releasing on a yes to prose would make a
change the person never saw exactly. Dropping the offer check brings back the
double yes. Tests: `apps/mcp/test/calendarGate.test.mjs` (the owner's chat end
to end), `agentClaimCheck.test.mjs`, `agentHeldEcho.test.mjs`,
`calendarWords.test.mjs`.

## Four more things an answer is checked for (owner's review, 2026-10-24)

In one afternoon's chat Tex sent nothing at all four times (the Worker sends no
text for an empty answer), texted "The bulk of that is医保 and necessities",
said "your notes have been down all afternoon" when no note call had failed,
and answered "is Kansi on the email thread?" by pointing back at the forward
waiting for a 👍. It also promised a breakdown "within the next 10–15 minutes"
with nothing started.

`apps/mcp/src/agent/replyChecks.js` catches each, once a turn, before
`claimCheck.js`'s other checks: an empty answer, a word in a script the
person's text doesn't use, an answer blaming their notes when no note read or
write failed in the turn, and, while an ask waits, an answer that only points
at it. Each sends one more round with a notice. An answer still empty after
it is texted as a fixed line saying the answer got lost, never as nothing.
`otherRoutes.js` counts "I'll … within N minutes" as a promise to keep, like
"I'll text you". A background job's follow-ups that say stop are a rule for
the rest of the job, retries included. Tests: `agentReplyChecks.test.mjs`.

### A correction never leaves the ask it corrects waiting for a yes (2026-10-26)

> **Superseded in part (Dev2, 2026-10-26):** the decide step now judges whether a message makes a waiting ask stale; the rule below stays as a code rail that can only end an ask sooner. See [Tex reads one event log and decides when to answer](./event-log.md).

Agreed with Dev2. An ask stays armed through the person's side texts ("one
sec", 2026-10-22), and the model is told to draft again only if their text
changes it. When their text was a correction ("actually send it to Bo
instead") and the model answered as if it had changed without drafting
again, the old ask still stood, and their next yes or 👍 sent the email they
had just corrected.

`claimCheck.js` rule 6 is judged on the person's own words, never the
model's (`correctsTheAsk`): "actually", "instead", "send it to", "make it",
"cc", "wrong", or an address the waiting draft does not have. A side text
("one sec", "add milk to my list", "not now") carries none, so whatever the
model answers it never touches the ask. A correction with nothing held gets
one more round telling Tex to make the call with the change; a turn that
still holds nothing drops exactly the asks that text corrected, never another
of theirs and never another person's in a group, and the gateway says so in
its own words in place of the model's line ("I haven't sent the earlier
one…"). When an ask cannot be withdrawn the text says so and asks for a "no",
rather than claiming it is gone. An earlier version read the model's answer
for "changed" or "I'll send"; review found it dropped asks over unrelated
words ("Updated your list") and missed "Sure, Bo it is".
Reverse it and "a correction the model does not
act on leaves nothing a yes can send" (`apps/mcp/test/agentSupersededAsk.test.mjs`)
fails.
