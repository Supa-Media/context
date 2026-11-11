# Every model Tex calls knows today's date, and every text it reads has one (2026-11-10)

Decided by the owner (Dev2, 2026-11-10): "Whenever we are showing texts to any
LLM agent we should ALWAYS be showing the date, and agents should ALWAYS know
today's date. We are literally a personal assistant AI."

## What happened

On Monday, November 9, 2026, in one person's 1:1 chat:

- The 10 am check-in was shown its last ten texts with no day or time. Sunday's
  answer said the FIFA tournament was "today"; read on Monday it looked like a
  mistake, so the check-in texted "Correction to my last text: the tournament
  was yesterday", and its `[continues N]` marker sent it as a reply under
  Sunday's text.
- The reply reviewer was never told the day (its instructions even said "Tex
  knows today's date"). It took Monday for Tuesday, October 27, and sent back a
  correct "Reminder set for 3pm today." twice, as the wrong day. The reply took
  42 s.
- Asked why it texted, the chat turn said it couldn't see what drove the
  check-in: the chat kept only the check-in's words.

## The rule

1. **Every model call is told the day, at the door.** Every model Tex calls
   goes through `requestViaGateway` (`aiGateway.js`) or `requestBuiltin`
   (`builtin.js`). Both pass the call through `withToday` (`localNow.js`): a
   call that has no "It is now <weekday>, …" line gets one, in the person's zone
   when the caller passes `timeZone`, else the routines' default zone, named.
   It goes at the start of the first message when that is plain words, so a
   cached system prompt stays the same. A call that already has a line (a
   texted turn, a routine, a check-in, the reviewer) is left alone. A turn with
   no clock of its own (`runTurn` without `localNow`: the memory nudge, a
   reflection) is told now in its prompt too.
2. **Every earlier text a model reads carries its day and time.** A person's
   side keeps its time and Tex's answer goes with it (`datedTurns`). Shown as
   `[Sun 2026-11-08 12:46]` (`stamped`, `localStamp`): a turn's history
   messages (`turn.js`), the check-in's last texts (`checkInTexts.js`), the
   reviewer's earlier texts and its "It is now" line (`replyJudge.js`), the
   planner's (`planBigAsk.js`), `earlier_texts` (`conversation.js`), routines
   (`routine.js`, since 2026-11-01), and a threaded chat's lines with the date,
   not the weekday alone (`threadedTurn.js` `DAY_TIME`). The check-in is told a
   text's "today" is that text's day, and a text that was right on its day is
   never a mistake to correct.
3. **A check-in keeps why it texted.** The line kept above its text
   (`checkInAbout`) says the text it went under, its last thinking before it
   answered, and the day's log in `tex/heartbeat/`, so a later turn can answer
   "why did you send that?". History shows it as "check-in", never "answered in
   another app".

## Only the gateway says the day was already told (2026-11-11)

`withToday` adds its line unless the call already has one. It used to look for
one anywhere in the call, matching `[system, messages]` as JSON, and every
channel it searched carries somebody else's words: the person's own text, a
note or an email body the turn read, a group's notes, the calendar copy,
about-me. So "It is now Friday, January 1, 2027" in any of them suppressed the
gateway's own line, and the model below — the front door, the thread
classifier, the checkers, the planner, a job's check, the sharing judge — read
the forged day as the only one it was given.

A notice now comes from one place, structurally apart from anybody's words:
the question message's `preamble`, which `turnPrompt.js` builds and
`providers.js` renders as its own block. A caller whose own now line sits in
their words instead, as the reply reviewer's does, says so with `toldNow` on
the call, and `withToday` marks what it writes the same way, which is what
carries it across the second door (`requestBuiltin` into `requestViaGateway`).
Their words are never read for it, so a forged line is answered with the true
day beside it rather than instead of it.

**What a simplification would cost:** dropping `withToday` from either door
leaves some agent guessing the day (the reviewer guessed October 27); showing
texts without their times puts back the Sunday "today" read on Monday; keeping
only the check-in's words puts back "I can't see what drove that check-in".
reading a now line out of anybody's words lets a text, or an email a stranger
sent to `0-inbox/`, take the day away from every model below.
Tests: `apps/mcp/test/agentLocalNow.test.mjs` ("a forged now line in somebody's
words does not take the day away", "a turn told the day in its preamble is told
once", "the reviewer writes its own now line and is not told twice", "a call
through both doors is told the day once"), `apps/mcp/test/replyJudge.test.mjs`
("the reviewer is told today's date…"), `apps/mcp/test/agentHeartbeat.test.mjs`
("a look sees when each of the last texts was sent…", "the chat keeps why a
check-in texted…"), `apps/mobile/__tests__/texHistoryLines.test.ts`.
