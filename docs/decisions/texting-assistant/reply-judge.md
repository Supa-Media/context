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

## One Haiku reviewer in place of the gates (Dev2, 2026-11-06)

Dev2: "replace the judges with one haiku model that is able to understand
nuances and give feedback". The ten gates below were each benched alone to
send back at most 10% of good replies, but any one could veto, and on the Tex
Devs chat from 2026-11-05 18:16 to 2026-11-06 17:52 UTC they sent back 39 of 59
replies (66%), 31 of them twice, so the cap of two, not the checks, decided
what went out; the same gate failed the redraft again 30 times. A gate asked
one yes/no question about words without knowing what kind of turn it was, so
a roast's "nine-bullet essay" read as an unbacked claim (did_what_it_says failed
38 times, most of any gate). The analysis is the artifact "Tex reply checks:
redesign".

**What it is** (`apps/mcp/src/agent/replyJudge.js`):

- One Haiku 5.5 call (effort low) per draft, through the AI gateway, filed
  under `client: reviewer`. It reads the same state the gates read (their
  text, the draft, a job's report, every action with its result, the last six
  texts) and answers JSON: the kind of turn (task, question, chat, correction,
  report), `send`, the problems by name (`PROBLEMS`, the gates' faults folded
  into one rubric) and feedback for Tex that quotes the words and says what to
  do instead. The feedback goes to Tex word for word in the send-back note.
- The rubric says what the gates could not: in chat, jokes, roasts,
  exaggeration and opinions are never claims, facts or promises; a fact from
  earlier in the chat is not unsourced because the reviewer can't see it
  (the OAuth roast, 2026-11-06); a minor problem, taste, or doubt lets the
  reply go.
- A rewrite is reviewed beside the reviewer's own earlier feedback this turn,
  and passes when it fixes what was asked; no new small point is raised on a
  rewrite. At most two send-backs a turn stays (Dev2, 2026-11-05).
- No verdict (an error, more than 8 s, an answer that is not the JSON, or a
  send-back with no feedback) lets the reply go.
- `reply_judge: haiku` turns it on; the gates' `clef` and `clef-flash` mean
  the reviewer too, so production's setup kept a check across the switch
  without an edit. `judge_at` is read and ignored. Without an AI gateway the
  older word checks (`doItChecks.js`, `untriedWeb.js`) run instead.
- A review is a `judge` entry with `by: "review"`, `turnKind` and the problems
  in `failed`; the Tex page and History show "Sent back by the reviewer: …".
- The bench is one bar for the whole reviewer, because that is what a person
  meets: `pnpm ai review` (workflow AI Reviewer, file `ai-gates.yml`) puts
  every labelled case in `apps/mcp/bench/review/` (the gates' sets, plus
  `chat`: roasts and banter that must go) to the reviewer, and it must send
  back at least 80% of faults and at most 10% of good replies across all of
  them.

What a "simplification" would cost: splitting it back into per-fault calls
brings back the stacked vetoes; dropping the earlier feedback brings back
redrafts that never converge. Tests: `apps/mcp/test/replyJudge.test.mjs`,
`apps/mcp/bench/test/review.test.mjs`.

## Ten parallel gates, sent back at most twice (2026-11-05; replaced 2026-11-06)

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
- A background job's own turn (its answer, which Tex reads) runs no gates:
  `claimCheck.js` and the hand-back judge check it. What Tex then texts about
  the report is judged, by a set of its own (Dev2, 2026-11-05: "the judges
  should run on everything sent to the user including reports ... maybe a
  different set of judges? because reports should have artifacts and a
  page.md most of the times"): `reached_them` (the job's result itself
  reaches the person, its links kept; they never see the report) and
  `on_a_page` (a long result goes on a page or card, with one or two lines and
  its link). The packet carries the report. The text set never reads a report
  turn: there is no text of theirs to answer, and on 2026-11-05
  `short_and_clean` cut a ten-PR report to "the report has the details".
  The wiring had passed `job: job !== null` on a turn built only when
  `job === null`, so it was always false; `report` is passed now.
- A gate may read only some drafts (`when`; Dev2: short and clean "should
  also only be activated some times"). `short_and_clean` reads a draft over
  `LONG_DRAFT_WORDS` (60) words, or over `MADE_LINE_WORDS` (30) beside a
  page, card or picture the turn made, links not counted, and one with
  letters in a script neither their text nor the chat uses. `on_a_page`
  reads a report's text over 30 words. In Tex Devs on 2026-11-05 the gate
  made 7 of 9 send-backs, on 30- to 55-word answers that were fine, and each
  rewrite dropped content; every draft it was right about ran past 75. A
  mid-length retelling now goes through: the cost of this choice. The bench
  scores an unread case as passed, as production would.
- A gate may name a `fact`, a fault code can see, which fails it with no
  Clef call: a stray script fails `short_and_clean` this way, since Clef
  scored one 0.04 (AI Gates, 2026-11-05). Facts stay code.
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

Follow-up the same day, from the review thread: the framing (`recheck.js`)
now points at the draft quoted below, not "above", and asks for plain text
without the quote marks; an email or email draft to the same people from the
same account (and the same email replied to or forwarded) counts as the same write however it is reworded (`SAME_TARGET`);
the note says a browser step already happened on the real site and must not
be clicked, submitted or paid again; a text that comes in mid-reply quotes
the unsent draft the same way (`lateText`) instead of putting it in as said,
and arms the same repeat refusal; and every held draft is remembered by the
turn itself, so a second send-back from a code check (no reply gates, no
judge entry) still shows draft 1.
