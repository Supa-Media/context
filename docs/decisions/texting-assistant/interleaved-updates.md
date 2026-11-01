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
(`progress.js` `progressChannel`; the cap of 8 is gone). Its prompt says a
line goes only just before a slow step that reaches outside their notes
(opening a site, browsing, a long job of many steps: "Opening OpenTable for
Friday."), never before a search, a note read or the advisor; after that,
only something they could act on before the answer, such as a link. A line is
never the answer itself. Each goes at once as its own text, threaded where the
answer goes, and is logged in the chat's event log as Tex's outbound event
with the turn's id. A line that only says Tex is on it, or will text later, is
still ruled out ([progress](./progress.md)). A routine, a group check-in and a
job's report get no lines (they text once), and neither does a chat set to
one bubble (`agent/route.js`; a group routine's Worker drops any, as its
gateway cannot tell it from a tag).

**Never done mid-turn, checked in code.** A progress line opens with what Tex
is doing ("Checking", "Now opening"), names what it found ("Found ..."), or
carries a link; one that opens with a change made ("Emailed Bo", "Booked the
7pm") is refused whatever follows (`claimsDone`), and the model is told to
start with what it is doing. It reads the line's shape, not the turn's tool
results: the rule is that a line never carries the answer, so a true "Emailed
Bo." is refused as a false one is. On the three reviews' probes (2026-11-01:
39 doing or finding lines, 44 done claims) it refuses 4 doing lines and sends
1 done claim ("Holding Friday at 6."), against 21 and 30 for the done-word
list it replaced. A line already sent this turn is refused, and the model is
told so. It is a regular expression, so a line costs no model call and nobody
waits on it. The final answer keeps the checks it has today: none on a chat
turn ([front-door](./front-door.md)), the reply checks on a background job's
turn.

**The answer stands on its own.** Nothing is cut from the answer for what a
line said: a line can be cut at 280 characters, fail to send, or be held for a
newcomer, so the person may never have seen it (an earlier cut, `unsaid`, was
removed the same day).

**Groups get the answer's safety.**

- A line goes only while the people here are the ones here when the turn
  started: the member list is read again before each line, as before the
  final send (`groupModelTurn.ts`).
- A newcomer, or a list that cannot be read, pauses the turn's lines for
  good; each held line is logged as never delivered, `held_newcomer`.
- A line is kept once per turn by its words (`groupSay.ts` `sayProgress`,
  under the turn's part keys), so a workflow retry never sends it again and
  the answer's parts keep their own positions; a redraft, a new turn over the
  same messages, skips a line one before it sent over any of them. A 1:1 turn
  keeps its lines by the oldest text it answers (`inbox.ts`
  `PROGRESS_PREFIX`), so a rerun with a newer text merged in sends none
  twice, which matters on Sendblue, whose sends carry no idempotency key; they
  go once the work is answered, or after a day.
- A chat stopped or muted while the turn runs gets no more lines. Its answer
  still goes (an open question for the owner).
- A line that won't send costs a line, never the turn, in a group as in a 1:1
  text, and a control word ("SKIP") is never texted as one.

**Tests.** `agentProgress.test.mjs` (one round with the line, under a
production setup too; many lines in order; the probe lists for `claimsDone`;
no line twice; the prompt's slow-step rule), `agentGroupTurn.test.mjs` (the
answer goes whole; one bubble and a job's report get no lines),
`agentBackgroundRoute.test.mjs` (a 1:1 chat set to one bubble gets none),
`inbox.test.ts` (1:1 lines in order and logged; a rerun, a newer text merged
in or not, sends none twice; kept lines pruned after a day; no control word),
`groupProgress.test.ts` (group lines in order and logged; a newcomer pauses
them; a routine says none; a failed line keeps the answer; a redraft sends
none twice; a stop ends them), `groupTurnWorkflow.test.ts` (a retry sends no
line twice).
