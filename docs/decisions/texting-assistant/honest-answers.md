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
