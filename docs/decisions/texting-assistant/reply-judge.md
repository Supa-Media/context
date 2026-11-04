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
  and `judge_at` (0 to 1, default 0.5) the confidence a verdict needs to be
  acted on. Absent, there is no judge.
- On a texted chat turn (one-to-one or group, front door included; not a
  background job), after the turn's other answer check, Clef reads the
  person's text, the reply about to be sent, every call the turn made with its
  arguments and what came back, and the last few texts, and picks one verdict:
  `accepted`, `not_started`, `not_finished`, `offered_instead`,
  `only_acknowledged`, `sent_elsewhere`, `unbacked_claim`, `wrong_question`
  or `too_verbose`.
- Anything but `accepted`, at or above `judge_at`, goes back to the model once
  with that verdict's reason (`VERDICT_NOTICES`), through the same recheck
  note every answer check uses (`recheck.js`). The second reply is sent as it
  is: one retry, never a loop (the owner's pick, the same day).
- A judge that fails, answers with no verdict, or takes longer than 3 s is no
  verdict: the reply goes. The log line `tex_reply_judge` carries the model,
  verdict, confidence, time and whether it acted, never words.

**What a simplification would cost:** a pattern over the reply's words is what
the owner rejected; judging without the turn's actions cannot tell "found it"
from a claim with nothing behind it; judging more than once a turn turns one
slow reply into a loop. Tests: `apps/mcp/test/replyJudge.test.mjs`.
