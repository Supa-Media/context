# A decision model judges each texted reply before it goes (2026-11-04)

In a customer's group chat on 2026-11-04, Tex was asked where a logo was. It
searched the notes once, said someone else would know, and offered to keep
looking. When told which folder the logo was in, it answered with a thanks and
did nothing. The owner rejected a phrase-pattern check on reply wording ("pattern
is not the right fix") and asked for "a small judge that sits between the
interaction agent and the user that just makes sure that no bs gets through",
on Clef, with verdicts such as "did not complete or start what the user asked",
"too verbose" and "accepted", reading every action the turn took and its final
reply, with the model going back to correct itself before anything is sent.

**What it is** (`apps/mcp/src/agent/replyJudge.js`):

- A setup turns it on with `reply_judge: clef` or `reply_judge: clef-flash`,
  and `judge_at` (0 to 1, default 0.5) the yes a fault needs to be acted on.
  Absent, there is no judge.
- On a texted chat turn (one-to-one or group, front door included; not a
  background job), after the turn's other answer check, Clef reads the
  person's text, the reply about to be sent, every call the turn made with its
  arguments and what came back, and the last few texts, and answers eight
  yes/no checks in one call, one per fault (`CHECKS`): `not_started`,
  `not_finished`, `offered_instead`, `only_acknowledged`, `sent_elsewhere`,
  `unbacked_claim`, `wrong_question`, `too_verbose`.
- The fault with the highest yes, at or above `judge_at`, goes back to the
  model once with that fault's reason (`VERDICT_NOTICES`), through the same
  recheck note every answer check uses (`recheck.js`). Below it the reply is
  `accepted`. The second reply is sent as it is: one retry, never a loop (the
  owner's pick, the same day).
- Why yes/no and not one choice (owner's pick, 2026-11-04): asked as one
  nine-way choice, Clef and Clef Flash spread their confidence near evenly
  over the verdicts (0.03 to 0.14, benchmark rounds gh-168 to gh-170),
  accepted a reply asking the person to send the file herself, and sent good
  one-line link replies back as too long. Clef is built for yes/no.
- A judge that fails, answers no check, or takes longer than 3 s is no
  verdict: the reply goes. The verdict is in the turn's trace (`kind:
  "judge"`), so the turn log and the benchmark show it. The log line
  `tex_reply_judge` carries the model, verdict, confidence, time and whether
  it acted, never words.

**What a simplification would cost:** a pattern over the reply's words is what
the owner rejected; judging without the turn's actions cannot tell "found it"
from a claim with nothing behind it; judging more than once a turn turns one
slow reply into a loop. Tests: `apps/mcp/test/replyJudge.test.mjs`.

## Ten parallel gates, sent back at most twice (2026-11-05)

The owner asked for the pattern checks on replies to go ("a series of parallel
judges, fine tuned individually ... [when] they don't [pass] it's given back to
the model and they are told which gates don't pass"), on Clef Flash, with "a
limit that the judges can only send back 2 times", and "make sure each of these
judges are also well tuned". This replaces the one-call, eight-check judge
above:

- Ten gates (`apps/mcp/src/agent/replyGates.js`): did what it says, tried
  first, does it, finished, sourced, heard them, followed them, never arrived,
  promises kept, short and clean. "Never arrived" was split out of "followed
  them" because Clef Flash missed it inside a three-part question. Each is one yes/no question with passing and failing examples, the
  notice the model gets when it fails, and its own threshold (`at`).
- Every gate is its own decision call on the same packet (`judgeState`), all
  at once, so the wait is the slowest gate. Every gate at or over its
  threshold fails; all failed gates go back in one notice that names each and
  says what it needs (`sendBackNotice`). Every gate reads the rewrite too
  (at first only the failed ones did, until review found a rewrite can bring
  in a new fault: "checked your email, nothing there" with no call made). At most `MAX_SEND_BACKS` (2) send-backs a turn; then the reply goes.
- A background job's report does not run the gates (it did for a few hours
  on 2026-11-05): each gate reads a person's text and the reply to it, and
  none was tuned on a report Tex reads. `claimCheck.js` and the hand-back
  judge check a report.
- A draft the gates passed that a late text then holds is recorded in the
  history as held (`by: "late"`), so the history never says a draft went
  out that was not sent.
- `judge_at`, when a setup names it, replaces every gate's own threshold.
- Tuning: each gate has a labelled set (`apps/mcp/bench/gates/<gate>.json`),
  and is also scored on every other gate's good replies, since a gate that
  fires on a good reply is a false alarm wherever that reply came from. `pnpm
  ai gates` (workflow "AI Gates", run by hand on any branch, since it holds
  production's Workers AI token)
  picks the threshold that catches the most faults with at most 10% false
  alarms; a gate clears the bar at 80% caught. No set case may be one of its
  gate's own examples (a test fails if one is).
- With the gates on, the front door's two word checks are off:
  `untriedWeb.js` ("I can't open it" with nothing tried, now `tried_first`)
  and `doItChecks.js` (an advisor asked for and not asked, now
  `followed_them`). They still run for a setup without gates, or with no
  Workers AI binding to run them. `claimCheck.js`
  (later and job turns) still runs first, its own untried-web check
  included; its word checks are next to go, its facts stay. Test: `apps/mcp/test/agentProduction.test.mjs` ("with reply judges,
  the word checks they replace stay off").
- Facts stay code, because they are not readings of words: an empty reply, a
  note link no tool gave, held approvals, send limits, step budgets.

**What a simplification would cost:** one call for all gates lets one fault's
wording drown another's (the nine-way choice above); sending back only the
worst fault costs a round per fault; no cap on send-backs is a loop; a gate
shipped without its set scored is a guess. Tests:
`apps/mcp/test/replyJudge.test.mjs`, `apps/mcp/bench/test/gates.test.mjs`.

## A send-back is written from the turn's ledger (Dev2, 2026-11-05)

"When judges send something back ... it should know his entire history. I
tried to reply with this, but the judges said this. It should just read the
ledger ... and based off the ledger, try to tweak its response. It should know
... the tool calls that it already did."

On 2026-11-05 (14:47-15:02Z) every send-back in Dev2's 1:1 made the answer
worse: the held draft was put back into the conversation as something Tex had
said, then the notice, so the model took it as sent, and each rewrite dropped
the answer it had found; one also saved a second, unasked email draft.

- The held draft is never put in as said. The model gets one note
  (`sendBackNote`, `apps/mcp/src/agent/sendBack.js`) built from the turn's
  ledger entries (`tool` and `judge`, the same ones the chat's history keeps):
  every action the turn took and how it went, every draft so far quoted and
  marked NOT sent with the judges that held it (score against threshold), the
  notice, and "revise the latest draft, keep its answer, don't start over".
- After a send-back, a write (an MCP tool marked `readOnlyHint: false`) that
  already succeeded, or was held for their yes, this turn with the same
  arguments is not run again (`repeatedWrite`); the model is told so in band
  and the refusal is a ledger entry ("already done this turn"). The same tool
  with other arguments runs, because one tool covers many actions and a check
  may ask for exactly that (the page notice's "write it again as a page", the
  rest of several calendar events). Reads, browser steps, the turn's own local
  tools and unannotated agent tools (`job_status`) may run again.

**What a simplification would cost:** the draft back as an assistant message
is the 11-05 failure; a note without the actions makes the rewrite redo them;
letting a write run again on a rewrite saves or sends twice; refusing by tool name alone blocks the second, different write a check asks for. Test:
`apps/mcp/test/sendBackLedger.test.mjs`, built from the 14:47 turn.
