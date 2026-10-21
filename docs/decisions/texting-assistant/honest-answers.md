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
