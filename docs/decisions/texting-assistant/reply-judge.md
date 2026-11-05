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
  says what it needs (`sendBackNotice`). Only the failed gates read the
  rewrite. At most `MAX_SEND_BACKS` (2) send-backs a turn; then the reply goes.
- A background job's report runs the gates too, less `short_and_clean` (it is
  read by Tex, not texted).
- `judge_at`, when a setup names it, replaces every gate's own threshold.
- Tuning: each gate has a labelled set (`apps/mcp/bench/gates/<gate>.json`),
  and is also scored on every other gate's good replies, since a gate that
  fires on a good reply is a false alarm wherever that reply came from. `pnpm
  ai gates` (workflow "AI Gates", run by hand on any branch, since it holds
  production's Workers AI token)
  picks the threshold that catches the most faults with at most 10% false
  alarms; a gate clears the bar at 80% caught. No set case may be one of its
  gate's own examples (a test fails if one is).
- Facts stay code, because they are not readings of words: an empty reply, a
  note link no tool gave, held approvals, send limits, step budgets.

**What a simplification would cost:** one call for all gates lets one fault's
wording drown another's (the nine-way choice above); sending back only the
worst fault costs a round per fault; no cap on send-backs is a loop; a gate
shipped without its set scored is a guess. Tests:
`apps/mcp/test/replyJudge.test.mjs`, `apps/mcp/bench/test/gates.test.mjs`.
