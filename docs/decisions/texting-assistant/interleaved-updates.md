# Tex answers directly, or says what it is doing as it works, never that it is done (2026-11-01)

Dev2 agreed the plan on 2026-11-01. Haiku stays the front door at medium
effort with the advisor on ([front-door](./front-door.md)); this changes what
it says while a turn runs.

**Direct answers first.** Every texted turn is told `DIRECT_LINE`
(`apps/mcp/src/agent/prompt.js`): if what is in front of Tex answers the ask,
reply now in one round, no tools, no deliberating. It sits beside
`OPINION_LINE` and `SETTINGS_LINE`, so a production setup's own prompt keeps
it, and it fits the texted prompt's size budget (`agentInstructions.test.mjs`).

**Interleaved updates.** A streamed turn (every 1:1 text and every group
turn) may send as many progress lines as it judges useful
(`progress.js` `progressChannel`; the cap of 8 is gone). Its prompt says to
send one first naming what it is about to do ("Checking your Friday
calendar."), then a line whenever it finds something they would want now.
Each goes at once as its own text, threaded where the answer goes, and is
logged in the chat's event log as Tex's outbound event with the turn's id.
A line that only says Tex is on it, or will text later, is still ruled out
([progress](./progress.md)).

**Never done mid-turn, checked in code.** A progress line says what Tex is
doing or found. One that claims something is done is refused before it is
sent (`claimsDone`), and the model is told to say what it is doing instead.
The check is the claim check's own words (`claimCheck.js` `claimsAChange`)
plus done-words a task ends on ("done", "sent", "booked", "all set"), said of
Tex's own work or as the line's last word. It is a regular expression, so a
line costs no model call and nobody waits on it; a model check would add
seconds to every line. What Tex found about someone else ("Bo booked the 7pm
last week") still goes. The final answer keeps the checks it has today: none
on a chat turn ([front-door](./front-door.md)), the reply checks on a
background job's turn.

**No repeats.** The final answer loses any row, or a row's opening, that a
progress line already said verbatim (`unsaid`, applied in `agent/route.js`),
unless nothing would be left, in which case the answer goes as written.

**Groups get the answer's safety.**

- A line goes only while the people here are the ones here when the turn
  started: the member list is read again before each line, as before the
  final send (`groupModelTurn.ts`).
- A newcomer, or a list that cannot be read, pauses the turn's lines for
  good; each held line is logged as never delivered, `held_newcomer`.
- A line is kept once per turn by its words (`groupSay.ts` `sayProgress`,
  under the turn's part keys), so a workflow retry never sends it again and
  the answer's parts keep their own positions. A 1:1 turn does the same in
  its object (`inbox.ts` `PROGRESS_PREFIX`), which matters on Sendblue, whose
  sends carry no idempotency key.

**Tests.** `agentProgress.test.mjs` (one round with the line, under a
production setup too; many lines in order; done lines refused; no repeats),
`agentGroupTurn.test.mjs` (the route drops a repeated line from the answer),
`inbox.test.ts` (1:1 lines in order and logged; a run again sends none
twice), `groupProgress.test.ts` (group lines in order and logged; a newcomer
pauses them), `groupTurnWorkflow.test.ts` (a retry sends no line twice).
