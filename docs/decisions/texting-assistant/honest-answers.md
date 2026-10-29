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

### A check-in promised for a set time is set in the same turn, or not promised (2026-10-27)

Two self-reviews in 18 hours (@context-lc
`areas/tex-reviews/themes/promised-checkin-not-set.md`): "I'll check with you
tonight" and "I'll check the log at 4:30 and text you", each with only
`read_note` and `write_note` in the turn. The first never says "text you"; in
the second, "4:30" was not a word to `PROMISE`, so neither reached
`LATER_NOTICE`. `otherRoutes.js` now lets a promise's words carry a clock
time, and `checksInAt` counts a check-in, follow-up or reminder ("I'll check
with you", "I'll remind you", "I'll look") with a set time ("tonight", "at
4:30", "tomorrow", "after lunch") as a promise. Its notice, `CHECK_IN_NOTICE`,
asks for a one-off under `tex/routines/once/` with `at:` at that time, or the
promise taken out; an untimed later keeps the hourly routine. A routine
written in the turn keeps either. Tests: `agentCheckInPromise.test.mjs`.

## Their sleep lines and check-in answers are their data, and get logged

Tex's self-review, 2026-10-28 and 2026-10-29 (@context-lc
`areas/tex-reviews/themes/sleep-log-wrong.md`, `time-audit-drops-plans.md`).
Tex took the sleep totals a person's phone Shortcut sent ("You have slept for
a total of: …") for texts it had sent itself, and apologised for them. It
quoted a watch email's night as real when the total could not fit between its
own asleep and up times, and answered a time-audit check-in's plan with "Will
do." and saved nothing. `agent/timeLog.js` reads a sleep line in their text
before the model sees it (`sleepLineNote`, also on texts steered in mid-turn,
never written into the conversation). The note says whose the line is and
whether it is one night: not over 16 hours, a total its own times can hold,
not blank. Three answer checks in `replyChecks.js` catch a figure only they
sent being taken back as Tex's, a quoted night its own times contradict, and a
bare acknowledgement of a check-in plan (within Tex's last three texts) with
no write. A routine run is told to stay quiet while they asked not to be
bothered. Simplifying it away brings back the apology for their own data and
an empty log. Tests: `agentTimeLog.test.mjs`.

### A check's note is never the person's text, and a "no" changes the approach (2026-10-29)

In a tester's chat, Tex's browser stopped on a passkey page. Tex kept asking
for an approval that, the person said, never arrived. One draft said Google
"refused" the sign-in, and `claimsCalendarTry` counted "Google" as a calendar
word. The resulting notice reached the model as the next user message after
the unsent draft, and Tex answered the notice as if the person had sent it,
with a denial about a calendar nobody had mentioned.

- `recheck.js`: every recheck notice now opens with `RECHECK_FROM`. It says
  the note is Context's own check, that the person has not seen the draft,
  and that their newest text is still the one being answered.
- `CALENDAR_WORDS` now holds calendar words only.
- `stuckAsks.js`: if they say a prompt or code never came, the answer may
  not ask for it again. If they turn down a method, the answer may not drop
  the goal.
- `pageWalls.js`: a passkey page's reading says to try another way. A Google
  Form editor or responses address built from the published `1FAIpQL…` id is
  refused.
- `LATER_NOTICE` now says to set nothing when they didn't ask to be told
  later, or when the work is blocked on a step only they can take.
- A check-in sent as an iMessage reply under an earlier text is kept in
  that text's thread (`heartbeat.js`, `threadView.js` `threadOf`), and a
  reply in a thread always sees the message it replied to. Before this, a
  "yes" typed under a check-in's question was shown the thread without the
  check-in, and Tex asked what the yes was for.

Tests: `agentLosesTrack.test.mjs`.

## One checked account of a save, and no made-up cause (2026-10-29)

From the same Tex Devs review: after its texts disagreed about a page save,
Tex said it had "signed in anyway with the code", though nothing in the chat
had signed in. `saveAccount.js`, beside the confession check, sends an answer
back once when it says a note didn't save while the turn's last failed save
of it was never read back (read it, then tell it either way; a later save
that worked is told as saved), and once when it gives a sign-in or a code as
the cause with no browser, login or code step on the record of the turn or
the last six texts. Tests: `apps/mcp/test/agentSaveAccount.test.mjs`.
