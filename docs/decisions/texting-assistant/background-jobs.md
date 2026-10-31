# The texting assistant — several things at once

_Part of [the texting assistant](../texting-assistant.md), beside
[delegation](./delegation.md) and [progress](./progress.md)._

### A long ask runs as a background job, so Tex works on several things at once (2026-10-21)

Asked for by the owner, 2026-10-21: Tex "should work in 1:1 messages and group
chats, need to be able to work on multiple things at the same time". A group
chat showed why: a research ask ran out of its eight steps, texted "Here is
where I got to —" with nothing after it and never wrote the note, "are you
working on this?" got no status, and every other ask waited behind it.

- **A texted turn hands a long ask off.** In a 1:1 chat or a group, the model
  may call `send { action: "background", args: { title, brief, done_when } }`
  (`start_background_job`, `apps/mcp/src/agent/background.js`). The gateway
  only records it and names it in the answer (`jobs`); the turn answers at
  once ("on it, I'll text you"). Offered only when the texting Worker sent the
  chat's job list (`running`), so a caller that can't run jobs is offered
  none, and never on a job's own turn: jobs don't start jobs.
- **Each job runs in a Durable Object of its own** (`apps/agent/src/jobs.ts`,
  `jobRun.ts`), named `job:<id>`, the same class as the inboxes, with its own
  alarm and fifteen minutes. So up to three run side by side while the chat's
  own inbox keeps answering texts. The result goes back to the chat's inbox,
  which texts it threaded under the ask it came from.
- **Status is real.** The chat's inbox keeps `job:<id>`: Tex's title, state,
  a one-line status (the job's latest progress line, then its result's first
  line) and times, never the ask. Every texted turn is shown the list, so
  "are you working on this?" and "how's it going?" are answered from it, one
  line per job, with the rest a `job_status` call away (below). A finished
  job stays two hours, so "did you finish?" has an answer.
- **No duplicate jobs.** An ask whose title matches a running job (most of the
  shorter title's words in the other) is refused at the tool with the job's
  status, which the model relays instead. The Worker holds to the same by
  exact title and by count when two turns race. Repeated *texts* (the same
  words sent twice) are the inbox's to fold, not this ([groups](./groups.md),
  `apps/agent/src/inbox.ts`).
- **A job always delivers.** Its turn is told to write the deliverable where
  it belongs before it finishes, even unfinished, saying what's missing. Every
  turn with three or more rounds is told before its last two: the one before
  last is for writing what it has, the last for answering in words
  (`lastRound.js`); no extra model call. A turn that still ends on a tool call
  answers with the last words the model wrote. A job whose turn ran out of
  steps, or broke mid-way, gets another turn told to carry on from its note,
  up to ten parts or thirty minutes (below); only the last one's answer is
  texted.
- **Grants are issued when the job runs, never carried.** A phone's job opens
  its session from the phone's link (an unlinked phone ends it silently); a
  group's job reads the chat's members again, asks the control plane for the
  group's grant again (a muted or unshared chat ends it silently), and is held
  with the "someone joined" line if anybody new is in the chat when it
  answers, exactly as a group answer is.
- **Guards vouch from the person's words.** A job's turn runs on the person's
  original text as its `question`, which is what the browser's addresses, the
  sharing judge and the Mail checker vouch from. The brief is the planning
  turn's words, shown as its plan and vouching for nothing. A job planned on a
  turn that had read from outside (`tainted`) starts its turn marked so.
- **Opus plans, Haiku drives.** A job's turn skips the router and goes to
  `think`, so where the production setup names `think_rounds`
  ([model plan](./model-plan.md)) the planner writes the plan and the
  everyday model carries it out, the 20/80 split the owner asked for
  (2026-10-17). A job's turns are long (`LONG_MAX_ROUNDS`) whether or not
  they stream.
- **Progress stays quiet.** A job's progress lines update its status; only a
  line with a link (a sign-in page) is texted.
- **Kept outside the bucket, bounded:** the ask's words sit in the job's own
  object only while it runs, and two hours after it ended unfinished, so it
  can be picked back up (below); the chat's list holds no ask, and drops a job
  two hours after it ends, or marks one stopped whose object died.

**What a simplification would cost:** running the job inside the texting
turn (as before) makes every other text wait and cuts a long ask at eight
steps; letting the job's brief be its `question` lets a model-written line
vouch for an address the person never gave; carrying the starting turn's
grant into a group job would answer someone who joined meanwhile from a
workspace they aren't in. Tests: `apps/mcp/test/agentBackground.test.mjs`,
`apps/mcp/test/agentBackgroundRoute.test.mjs`, `apps/agent/src/jobs.test.ts`
and `apps/agent/src/groupJobs.test.ts`, each with a sabotage record.

**Open:** a job's pictures are not texted.

### The advisor checks every stop of a job, and the chat can ask how it is going (2026-10-31)

Asked for by the owner, 2026-10-31, after two jobs were marked done on their
first reply: an application job answered "I'll begin with the sign-in" after
44 seconds, and another copied "it's already running" from the chat's
history, while the chat kept telling the owner they were still going.

- **Every job has a finish line** (`done_when`, written when it starts), and
  a job is done when that line is met, never because its turn ended.
- **The advisor checks each part** (`apps/mcp/src/agent/jobCheck.js`): the
  same model the advisor tool runs, a request of its own after the job's turn,
  reading the brief, the finish line, the person's later texts and the whole
  part (Tex's instructions, every tool call and result, its last words). It
  answers `done`, `keep_going` with advice, `waiting` (only the person can give
  what's needed: a code, a captcha, card details, a decision) or `stuck`. A
  chat's own turn is never checked. When the advisor can't be reached, the
  phrase check (`stopsShort.js`) decides as before.
- **The Worker acts on it** (`apps/agent/src/jobRun.ts`): `keep_going` runs
  another part that starts on the advice; the job ends `waiting` or `stuck`
  as a state of its own, and the chat's coordinator turn (`jobReport.js`)
  asks for exactly what's needed, or says why it stopped. **Limit: thirty
  minutes or ten parts**, whichever comes first; a job still short when its
  room runs out ends `stuck`, saying it ran out of time.
- **The chat sees the job's real state through a fast tool**, not a longer
  prompt (owner, 2026-10-31: "a super fast tool call"). The prompt carries one
  line per job, and a finished one says it is not running any more.
  `send { action: "job_status" }` answers with no I/O, from what the Worker
  sent with the text: the step it's on, all its kept steps (forty), the
  advisor's last verdict and advice, and a finished job's report, fenced as
  words that vouch for nothing.
- **Results stay out of the live view.** The verdict, advice and report go to
  the chat's own turns only (`chatJobs(..., { results: true })`); the live
  view of what's running, which anyone with its link can open, shows titles,
  states and steps as before.
- **A job's turn is told it is the job, running now**, so earlier texts in the
  chat about it are the chat's words, never its own answer.

**What a simplification would cost:** dropping the check marks a job done on
"I'll begin", which is the bug; putting every job's steps and report in every
prompt makes every text slower to answer; showing the advice in the live view
puts a job's findings behind a link. Tests: `apps/mcp/test/agentJobCheck.test.mjs`,
the job-check and `job_status` checks in `agentBackground.test.mjs` and
`agentBackgroundRoute.test.mjs`, and `apps/agent/src/jobs.test.ts`, each with
a sabotage record.

### "Restart it" picks a stopped job back up; a job works from its own record (2026-10-31)

Asked for by the owner, 2026-10-31, after "jumpstart all 3 threads" took three
texts, each starting a brand-new job whose question was the restart text, and
all three answered "it's running again" eight times before they stopped.

- **A job that ends without finishing keeps its run** in its own object for
  two hours, as its chat keeps its entry (`apps/agent/src/jobRun.ts`
  `ENDED_KEY`): the same ask, brief, finish line, its last answer and the
  advisor's advice. An alarm drops it after that. A finished job keeps none.
- **Restart resumes, never copies.** `send { action: "restart_job" }`
  (`restart_background_job`, `background.js`) picks every stopped job back up
  in one call, or the ones named, within the three-at-once limit, and the turn
  ends at once with a fixed line. A new job named like one that stopped picks
  that one up instead. The Worker sends `resume` to the job's object
  (`resumeJobs`, `resumeJob`), which starts a new workflow for it; its limit
  starts again, and its first part starts on its last answer and the advice.
  One it can't pick up (finished, older than two hours, no room) is said so.
- **A job works from its own record, not the chat.** Its prompt shows none of
  the chat's history (`route.js`), and it reads only the newest 30 entries
  (`loggedTurn.js` `JOB_HISTORY_ENTRIES`) for the earlier-texts tool, kept
  files and the words that vouch for an address. The chat's "On it" lines were
  what the restarted jobs copied, and the 150-entry read cost about 5s a part.
- **Two parts in a row that call no tool and still aren't done end the job
  stuck** (`idle` from `jobCheck.js`), saying so, instead of spending parts.

**What a simplification would cost:** starting a new job on "restart" runs it
on the restart text with nothing it had done; showing a job the chat lets it
answer as the chat; dropping the repeat guard spends ten parts on nothing.
Tests: `apps/mcp/test/agentJobRestart.test.mjs`, `agentJobCheck.test.mjs`,
`apps/agent/src/jobResume.test.ts`, each with a sabotage record.

### A running job can be steered, stopped and audited from the chat (2026-10-21)

Owner, 2026-10-21: "does the orchestrator also route follow ups … to a running
thread, for example if I say 'never mind make it yellow not green'", and
"that's super important for an orchestrator, steering already running jobs,
auditing it etc".

- **Steer.** A texted turn that sees a running job its text changes calls
  `send { action: "steer_job", args: { title } }` (`steer_background_job`).
  The answer names the job (`steers`); the chat's inbox hands **the person's
  own text** to the job's object (`/job-steer`), never words the model wrote,
  and only for a job that chat started and that is still running. The job's
  object sends it into its running turn through the existing steer route
  (`apps/mcp/src/agent/steer.js`, with the job's own grant; a group's grant is
  accepted there because only a group's job turns are ever named), where it
  is taken in after the next tool call. One the turn never took in is shown to
  the next turn as a follow-up ("newer than your plan"), and a job that
  answered without it gets that turn instead of texting the old way; on its
  last turn it texts what it made and says the change came too late.
- **Stop.** The same call with `stop: true`: the chat shows the job stopped at
  once, the stop text is sent into the running turn so it winds up at its next
  step, and the job texts nothing more and runs no further turn. In a group,
  anyone in the chat may stop a job anyone there started, as they may answer
  it.
- **Audit.** A job's turn streams each step as a short line (`withJobSteps`:
  tool, action and what it was pointed at; never a note's text, a result, or an
  email's body). The chat keeps the last five with the job, and every texted
  turn is shown them, so "what is it doing?" is answered from what it did. The
  whole record stays where it was: the person's Tex transcript.

**What a simplification would cost:** passing the model's paraphrase instead
of their text lets a model line steer a job (and, through a turn, vouch for
nothing it should); dropping the after-the-last-look turn texts a result the
person already changed; texting what a stopped job says on its way out
ignores the stop. Tests: `apps/agent/src/jobSteer.test.ts`, and the steer and
step checks in `apps/mcp/test/agentBackground.test.mjs`,
`agentBackgroundRoute.test.mjs` and `agentSteer.test.mjs`.

### The live view of what's running (2026-10-29)

Dev2 asked for a card that shows the running threads, each tapped to see
what it is doing, so iMessage works more like an agent chat, and for it to
work in groups too. When Tex starts a job, or is asked what it is working on,
it adds `[card threads]` (`background.js` tells it to, and `DATA_CARDS_LINE`
says when). The texting Worker then mints a link to the chat's live view
(`apps/agent/src/jobs.ts` `mintThreadsLink`): a one-to-one chat with Context
cards gets a card that the Messages extension opens (`/tex/threads` →
`/messages/threads`), and anyone else, every group included, gets the link
in words, because Sendblue App Cards are one-to-one only. The page
(`infra/router/src/messagesThreads.ts`) reads the chat's jobs through the
router's `TEXTS` binding to the texting Worker. It lists each job's title,
state, status line and last steps, opens the running ones, and reloads every
ten seconds while one runs.

The link is a bearer link, and that was the decision: 256 random bits per
link, kept in the chat's own object for six hours, the newest four per chat,
with the same "this view has ended" page for every miss. It shows only what
every texted turn of that chat is already told about its jobs (titles,
status, steps as tool and target, never a note's text, never the ask), so a
forwarded link reveals what anyone in the chat could ask Tex for, and stops
working within hours. The page has no script and sets its own policy. A
self-hosted router without the binding shows the ended page. Simplifying
the token check away exposes every chat's jobs to anyone who guesses an
object id. Tests: `apps/agent/src/threadsView.test.ts`,
`infra/router/src/messagesThreads.test.ts` (sabotage records in each header).

The 3-job limit is told when it bites. The gateway refuses a fourth job with
words for Tex to say, and since 2026-10-29 a job lost to two texts racing
past the limit, or one that could not be handed off, gets a line in the
answer (`notStartedText`) instead of a silent "on it".

**One job texts one result** (2026-10-29, Tex Devs review c95b1e). A job's
Durable Object was reset under its pass, the workflow retried the step, and
two turns of the same job ran side by side: one texted "I couldn't save the
page update" with a bug report, the other, after re-arming the finished job,
"the save went through after all". Each pass now takes the job's lease
(`jobRun.ts` `PASS_KEY`) when its turn starts; a pass that finds the lease
taken or gone when its turn returns says and stores nothing (`stale_pass` in
the log), and the chat's inbox texts one finishing word per job, from the
pass that sent it first (`jobs.ts` `finalPass`; the same pass offering it
again is still taken). Dropping the lease brings back two answers that
disagree. Tests: `apps/agent/src/jobPass.test.ts`.

**Every job reports to the chat's own turn, never to the chat** (Dev2,
2026-10-30: "if something is going in a background task it should always
report to the coordinator, no exceptions, the coordinator should have
complete authority over the background processes, provide steering etc").
Whatever a job would have said (its result, the line saying it couldn't
finish, a sign-in link on its way) is queued by the chat's inbox as a turn
of the chat itself (`apps/agent/src/jobTexts.ts`: `event: "job_report"`,
the words as `jobReport`; in a 1:1 chat a turn the Worker asks for, in a
group its asker's tag run the way a chat routine's is). That turn, the
coordinator, is asked the gateway's own line and shown the report as the
job's words, which vouch for nothing (`apps/mcp/src/agent/jobReport.js`;
the turn counts as having read from outside). It checks the report against
the chat and the notes it names, then texts it in its own words with the
page's cover, fixes it, starts the job again on the person's own words,
steers a running job with its own note (`steer_job` `note`, passed to the
job marked as the coordinator's, never as theirs), or answers SKIP. A job's
own answer is no longer kept in the conversation as said; only the
coordinator's turn is. Texting a job's words straight in again, for any
kind of update, breaks the rule. Tests: `apps/agent/src/jobReports.test.ts`,
`groupJobs.test.ts`, `apps/mcp/test/agentBackgroundRoute.test.mjs`.

**Staying quiet on a report is a flag, and an ended job is never met with
silence** (Dev2 approved, 2026-10-31, after self-reviews fa3f7a and
a0365e: "SKIP" stood as Tex's reply to three job reports, two of them
finished jobs whose results never reached the person). Only a report from a
job still running is offered SKIP; the gateway turns that word into
`quiet: true` with an empty answer, and the history keeps "(You texted them
nothing ...)" instead of the word (`jobReport.js` `reportReply`). A report
from a job that finished, failed, is waiting or stuck always gets a line:
the model's own words with any SKIP taken off, or, when it said only a
control word or nothing, one plain status line with the job's own result
(`reportStatusLine`). In front of the line, a bubble that is only a control
word (SKIP, NOOP, NO_REPLY, QUIET, NONE in capitals) is never sent, on any
path (`apps/agent/src/controlWords.ts`, checked in `reply.ts`, `inbox.ts`,
`groupSay.ts`). Letting the model's word decide again brings back results
nobody hears. Tests: `apps/mcp/test/jobReportReply.test.mjs`,
`agentBackgroundRoute.test.mjs`, `apps/agent/src/jobReports.test.ts`.

## A job's turns are off the daily cap (decided by the owner, 2026-10-31)

On 2026-10-31 three restarted jobs used up a workspace's 100 turns in five
minutes, and from then on every text was refused about a second in. A job's
parts, the advisor's check on each (it runs inside the part's own turn), and
its reports to the chat's turn are no longer counted against the cap. The
gateway says which turns those are (`openProvider`'s `background`, from
`route.js`'s `job` and `report`); the control plane believes it only from a
chat's grant (texting or group), counts it in `jevUsage.background` instead
of `calls`, and holds it to `BACKGROUND_TURNS_PER_DAY` (500), a runaway
ceiling, not a product cap (`apps/convex/functions/lib/jev/meter.ts`). The
kill switch still stops it, and its spend is metered as before. Each job is
started by a counted turn, so the person's own texts still pay for starting
work. A part the gateway refuses (`daily_limit`, `no_model`) ends the job
`waiting` and says why (`JOB_LINES.refused`), and a report the chat's turn
is refused for is answered with a fixed line rather than silence. Counting
job turns against the cap again, or ending a refused job silently, reverses
this. Tests: `apps/convex/__tests__/builtinModel.test.ts` ("a background
job's turns"), `apps/mcp/test/agentBackgroundRoute.test.mjs`,
`apps/agent/src/jobs.test.ts`, `apps/agent/src/jobReports.test.ts`.
