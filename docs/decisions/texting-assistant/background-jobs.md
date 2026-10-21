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
  "are you working on this?" and "how's it going?" are answered from it. A
  finished job stays two hours, so "did you finish?" has an answer.
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
  up to three; only the last one's answer is texted.
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
  object only while it runs; the chat's list holds no ask, and drops a job
  two hours after it ends, or marks one stopped whose object died.

**What a simplification would cost:** running the job inside the texting
turn (as before) makes every other text wait and cuts a long ask at eight
steps; letting the job's brief be its `question` lets a model-written line
vouch for an address the person never gave; carrying the starting turn's
grant into a group job would answer someone who joined meanwhile from a
workspace they aren't in. Tests: `apps/mcp/test/agentBackground.test.mjs`,
`apps/mcp/test/agentBackgroundRoute.test.mjs`, `apps/agent/src/jobs.test.ts`
and `apps/agent/src/groupJobs.test.ts`, each with a sabotage record.

**Open:** a job's pictures are not texted; a text that adds to a running job
("make it Friday") reaches the next turn with the job's status, not the job's
own turn.
