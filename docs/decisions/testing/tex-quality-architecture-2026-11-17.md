# Tex quality: what the graph has to change to text like Instinct (2026-11-17)

Asked by the owner, 2026-11-17: bring Tex's overall quality up to Instinct's,
not only the Lab Dev number. Same models: nothing pricier than what each step
runs today. Graph, gates, routing, retrieval, tools and the harness come before
prompt words, because prompt words are what has been tried
([dev-front-door-measure](./dev-front-door-measure.md)).

This is a ranking, and one build. It decides nothing by itself: each change
below still lands as its own pull request with its own proof. No Dev item is
quoted. Causes are read from result codes and from the Training set.

## Where the score is

About 30.5 of 53 on Lab Dev: front door 12.5 of 30, Decide 18 of 23. The
target is 43. The front door moves three points either way between repeats of
one commit. Decide does not move at all: the same five tests fail on every
run. [dev-failure-breakdown-2026-11-17](./dev-failure-breakdown-2026-11-17.md)
splits the front door's fails: grounding 26%, agency 25%, report shape 19%,
quiet versus speak 14%, voice 14%, a lost reply 2%.

Two facts about the measure itself shape everything below.

- **The front door cannot be scored on Training.** A Lab Training run on main
  (18 November) scored Decide 23 of 27 and the front door 0 of 63, and every
  one of the 63 says it can't run: the Training chats' people have no bench
  world, their groups no shared workspace, their check-ins no mail. Training is
  read as examples, so it was never built to run. Until it can, a front-door
  change has no "works where it was taught" proof, only Dev, and Dev's front
  door needs several runs to say anything.
- **Decide is exact.** One run is a result. A Decide change of one test is
  visible; a front-door change of one test is not.

## What Instinct does well

From the repo's own notes, as behaviours a person can see. The reference
thread itself was personal and was not kept
([benchmarks](../texting-assistant/benchmarks.md), 2026-10-09).

1. **Answers first, in short bubbles.** One idea each, then at most a line of
   context. A one-word reply where one word is enough.
2. **Says what was done in a few words**, never how or where. A caveat is one
   clause.
3. **Reacts instead of acknowledging.** A tapback where Tex would write "got
   it".
4. **Says "on it" before slow work**, then comes back with the result.
5. **Asks one clarifying question at a time, then waits.** A reply ends on one
   next step or one question, never both.
6. **Shows a draft before anything goes out.**
7. **Gives the exact fact from the source that owns it** (the release page's
   version and date, not a mirror's). On the Instinct web-fact test Tex scored
   4 of 6 and took 12 to 38 seconds to its first reply
   ([one-judge-one-record](../texting-assistant/one-judge-one-record.md)).
8. **Runs on its own**: searches and browses without asking
   ([texting-assistant](../texting-assistant.md), 2026-10-07 and 2026-10-11).
9. **Answers inside the thread it was asked in**
   ([history](../texting-assistant/history.md)).
10. **Knows which message is for it** in a group, and stays out of the rest
    ([chat-state-machine](../texting-assistant/chat-state-machine.md)).
11. **Matches the person's register**: contractions, an emoji only after
    theirs, a real opinion in one line when asked.

## How Tex falls short on each

| Instinct behaviour | Tex today | Dev cause it shows up as |
| --- | --- | --- |
| 7. Exact fact from the owning source | Answers about a note, page, mail, picture or stored record without reading it. The record check (#3550) is a notice on a narrow pattern; the prefetch (#3613) opens only a link, an address or a named note. | Grounding, 26%, five stable tests |
| 8. Runs on its own; 4. "on it" then the result | Offers, promises or talks instead of doing the act. The front door has two rounds; a multi-step ask does not finish, and it often does not start the job it has. | Agency, 25%, five stable tests |
| 1. Answer first, short; 2. what was done in a few words | Length, what leads, and saying how long a lookup takes are left to one model reading 200,000 characters of setup. Nothing in the graph knows what kind of answer the turn is. | Report shape, 19%, three stable tests |
| 3. Reacts instead of acknowledging | A finished simple act gets a sentence. In a one-to-one chat a single text skips Decide, so the tapback is the front door's to remember, as a tool call it must choose. A check-in or a job report stays silent when it had something. | Quiet versus speak, 14%, three stable tests |
| 11. Register | Playful and cheeky lines flip between repeats. | Voice, 14%, two stable tests |
| 10. Which message is for it | Decide gets the act right on 21 of 23. Two tests stay quiet where the label answers. Three are quiet, correctly, with the wrong reason or no reaction. | Decide's five stable misses |
| 5, 6, 9 | Held today (one question, drafts shown, threads). Not a measured gap. | none |

### Decide's five, by mechanism

Read from the result codes of a Dev run, and the same run on Training:

- **The reason contradicts the act (2 of 5 on Dev, 1 of 4 on Training).**
  Decide stays quiet, rightly, and gives a reason that by its own definition
  says the message is for Tex ("it replies to one of Tex's texts", "it @-tags
  Tex"). Clef answers each typed question on its own, so `why` is never told
  what `act` chose. The judge's rule says a message with one of those reasons
  is answered, so the pair is impossible, and it is logged anyway.
- **No reaction where a friend would react (2 of 5, one shared with the
  above).** Quiet is right and `also_react` is under its cutoff. No Training
  test fails this way, so there is no proof of a cause yet.
- **Quiet where the label answers (2 of 5).** People are talking to each
  other, or about Tex, and Tex should have spoken. No Training test fails this
  way either. Widening the reason for it was tried and dropped: it made the
  judge answer banter (`textDecide.cjs` `WHY`).

Training's other three misses are neighbouring reasons for the right act (a
tag that is also a correction). That is a labelling question, not a graph one.

## Ranked changes

Ranked by expected points that would hold, counting how sure the evidence is
and whether the gain can be proved today. A change the front door's noise
would hide ranks below a smaller one that can be read exactly. "Shared infra"
means a Convex schema or function, a gateway surface other than Tex's own
agent code, the texting Worker, or anything that changes a deploy: those need
Architect's review.

Prices are the bench's: Haiku 5.5 at $0.10 in and $0.50 out per million
tokens, a Clef judging about $0.0004. A Dev run of 53 tests costs $0.11 to
$0.18.

### 1. Decide looks again when its reason contradicts its act (built with this note)

- **What.** A second Clef question, asked only when Decide stays quiet (or
  only reacts) and its reason is one of the five that mean "this is for Tex".
  It asks for the reason again, told the act, with only the reasons a quiet
  message can have. The act never changes. A node of its own, `decideWhy`,
  wired from Decide and switched in config.
- **Causes.** Decide's contradiction misses: 2 of its 5 on Dev, one of which
  also wants a reaction this does not give.
- **Expected gain.** Dev Decide 18 to 19, possibly 20 if the reaction miss is
  fixed separately. Training Decide 23 to 24. Exact, not a mean.
- **Evidence.** The same impossible pair fails one Training test and two Dev
  tests, with the act right on all three.
- **Latency and cost.** Nothing on a message whose verdict is coherent. One
  more Clef call, about half a second and $0.0004, on the few that are not,
  and those are quiet verdicts: nobody is waiting for a reply.
- **Risk.** Low. It cannot turn quiet into an answer. The reason is a log
  field today; what it buys a person is nothing yet. What it buys the graph is
  a reason that can be trusted, which change 5 routes on.
- **Shared infra.** None. Tex's agent code, the shared Decide questions, the
  bench and the config. The control plane's fallback copy of Decide is not
  touched and does not look again.

### 2. A shape gate beside the Door: what kind of answer this turn is

- **What.** A Clef node that runs in parallel with the Door on every text the
  front door will answer, and types the turn: the ending (a tapback, one
  line, an answer, a report, an "on it" and a job), whether it is an order to
  act, and whether it asks about something stored. Its output is used twice.
  The front door reads it as its `notice`. The Answer check holds it in code:
  an ending of tapback with a successful simple write and nothing new to say
  ends on the tapback; one line with a draft several times that long goes
  back once; an order with no call behind the draft goes back once (the check
  `doItChecks.js` already has, now told when it applies).
- **Causes.** Quiet versus speak (the two tapback tests), report shape (three
  tests), agency (five, in part: it names the turn an order; it does not add
  rounds), voice a little.
- **Expected gain.** 2 to 5 front-door points if the contracts hold. Every
  notice and prompt change so far stayed inside the band, so the gain rests on
  the code-held half, not the notice.
- **Evidence.** The tapback is already allowed and already refused when
  tagged; the failures are the model not choosing it. Report shape is three
  stable tests on one judgment (length and lead) that nothing types.
- **Latency and cost.** None on the reply: Clef answers in about half a
  second while the Door is still gathering. $0.0004 a text. A send-back costs
  one more Haiku round, about 2 seconds, on the turns that needed it.
- **Risk.** A wrong type makes a full answer terse. Hold the contract only
  above a high confidence, and never on a tagged text.
- **Shared infra.** None if it is asked inside the gateway turn. It cannot be
  proved on Training until change 3 exists, so it is not the build here.

### 3. Make the Training front door runnable (harness)

- **What.** Give the Training chats people with bench worlds, or worlds for
  the people they have, and shared workspaces for their groups, so the 63
  front-door tests run. Leave their words out of the examples of the run that
  scores them (hold each conversation out of `train:fd` when it is the one
  being run).
- **Causes.** None directly. It is what lets changes 2, 4 and 6 be proved
  before they touch Dev, and it stops Dev being the only place a front-door
  change is ever read.
- **Expected gain.** Zero points and the largest lever: harness fixes are
  what moved a full run from 19 to 28
  ([dev-front-door-measure](./dev-front-door-measure.md)).
- **Latency and cost.** None in production. A Training run goes from about
  $0.01 to about $0.25.
- **Risk.** A front door scored on chats it reads as examples flatters
  itself; the hold-out is the guard.
- **Shared infra.** The bench only, and the Lab run script. No Convex change:
  `set: "training"` already exists.

### 4. Retrieval prefetch: read what the ask is about, beside the Door

- **What.** A code node parallel with the Door. It searches the person's
  notes and contacts, and their mail when connected, with the text's own
  names and nouns, and puts the best few hits, with their paths, in the front
  door's context. The record check counts them as reads. #3613 does this for a
  link, an address or a named note; this is the same for an ask that names
  nothing.
- **Causes.** Grounding: five stable tests.
- **Expected gain.** 2 to 4 points. Three of the five are facts that live in
  notes, contacts or a stored record and would be in front of the model. A
  picture and a paraphrased page are not fixed by a search.
- **Evidence.** The notice alone did not move the score (mean 11.8, inside
  the band). The model answers from what is in front of it.
- **Latency and cost.** Parallel with the Door, so none unless the search is
  slower than the Door (about a second). No model call. About 600 more input
  tokens a turn: $0.00006.
- **Risk.** Hits that are near and wrong get repeated as fact. Show the path
  and the line, never a summary.
- **Shared infra.** Yes: it adds a search to every turn against the workspace
  object, so the gateway's search path and its load need review. It also
  overlaps the named-record work in flight, so it is not built here.

### 5. Route on Decide's reason

- **What.** Wires out of Decide by reason, once the reason can be trusted
  (change 1). Only thanks or an ok: the tapback and no front door at all. A
  correction: the front door starts with what it got wrong at the top. An
  answer to Tex's question: straight to the step that was waiting. In a
  one-to-one chat this needs Decide to run beside the Door on a single text,
  which today skips it.
- **Causes.** Quiet versus speak (the tapback tests), and the Instinct habit
  of reacting instead of acknowledging; some agency (an answer to Tex's
  question resumes work instead of restating it).
- **Expected gain.** 1 to 3 points, and a faster first response on thanks
  and oks, which never reach Haiku.
- **Latency and cost.** Saves a Haiku turn on those texts. Adds $0.0004 to
  every one-to-one text that skips Decide today.
- **Risk.** A thanks that carried an ask gets only a tapback. The judge
  already has that label ("only thanks ... that asks nothing").
- **Shared infra.** Yes: the texting Worker's triage and queue decide who
  runs, so this is a Worker change and a deploy.

### 6. The front door hands off a long job (in flight)

Planned in [front-door-hands-off](./front-door-hands-off.md) and built as a
shelf node in #3620. Agency's multi-step half. Expected 1 to 3 points. Not
ranked against the others here because it is someone else's work; changes 2
and 4 are designed to sit beside it: the shape gate's "on it and a job"
ending is the same decision, made before the first round instead of after the
send-back budget is spent.

### 7. One lookup tool across notes, mail, calendar and contacts

- **What.** A `search` that fans out to every source the person has
  connected in one call and answers with one ranked list. The front door has
  two rounds: a fact that might be in a note or in mail takes both to find.
- **Causes.** Grounding, and report shape's "how long a lookup takes".
- **Expected gain.** About 1 point, more with change 4.
- **Latency and cost.** One round saved, about 2 seconds, on asks that
  searched twice.
- **Risk.** Longer results in the context.
- **Shared infra.** Yes: an MCP tool's behaviour.

### 8. A second look at "quiet" in a live thread with Tex

- **What.** When Decide says quiet with a reason of people talking, and Tex
  spoke within the last few lines or holds an open question, one focused
  yes-or-no: does this need Tex? It may turn quiet into respond.
- **Causes.** Decide's two "stayed quiet where the label answers".
- **Expected gain.** 0 to 2 Decide points.
- **Risk.** High. This is the leaning that made Tex answer banter, 68 to 49,
  when a rule told it to follow up (`textDecide.cjs`). No Training test fails
  this way, so there is nothing to prove it on. Add Training conversations
  with this shape first.
- **Shared infra.** None.

### 9. React on its own cutoff

- **What.** `also_react` passes at 0.5 everywhere. A reaction beside quiet
  costs nothing when wrong and reads as presence when right; a lower cutoff
  for that pair only.
- **Causes.** Decide's two missing reactions.
- **Expected gain.** 0 to 2 Decide points. No Training test fails this way;
  it needs the near misses logged first, as the router's cutoff was set
  ([benchmarks](../texting-assistant/benchmarks.md)).
- **Shared infra.** None.

### 10. A lost reply is retried in code

Five fails in fourteen runs. When the turn ends with no answer and no
tapback, run one more round with the work so far instead of texting that the
answer was lost. About 0.3 points. No shared infra.

### Not ranked: voice

Two stable tests and the lines that flip between repeats. A rewrite step
after the draft would cost about a second on every casual text and would be
graded by the same judgment that flips. Read voice as a mean over three runs
before changing anything for it.

## Measured so far

**Nothing below is a score yet.** The bench's Anthropic keys stopped answering
at 8:22 PM ET on 17 November, and every Lab run after that, including the
Training run that first scored the front door (27 of 63), ran Tex and the
judges on the fallback model. Those numbers are not Tex's. Each change is
proved by unit tests and a run on fake models until a Training and a Dev run
can be trusted again.

### Change 3, built (18 November): Training measures Tex, not the test world

What the code showed, each reproduced in a test
([test-sets](./test-sets.md), "A conversation brings its own world"):

- **Every undated row ran on a Thursday.** No Training chat names a date, so
  each test ran on the bench's own day. A Monday routine stayed quiet, rightly.
- **A drawn card always failed twice.** The bench renders a blank picture, the
  card check looks at it and holds it back, twice, and the tool says "Not
  sent". The bench now answers the look at its own stand-in.
- **A settings change always failed.** The bench's control plane had no route
  for Tex's chat commands. It has one now.
- **Empty replies were never empty texts.** The gateway cannot text nothing:
  a model's empty answer becomes "my answer got lost", and the Worker treats
  an empty body as a failed turn. The rows that read "Tex: " with nothing were
  Tex choosing to say nothing, or an answer that was only a picture, which
  the record dropped. The record now says which.
- **The chats' records did not exist.** Each conversation now declares its
  world, and runs in a folder of its own.

On fake models, 62 of Training's 63 front-door tests run, none a harness row.
The one left is a group check-in that found only a calendar event.

### Change 1, built and off (18 November): Decide's reason is asked again

The step `decideWhy` is in the config, wired from Decide, and switched off.
When it is on, a verdict that stays quiet or only reacts for one of the five
reasons that mean "this is for Tex" is asked for its reason once more, told
the act, from the seven reasons a quiet message can have. The verdict comes
back with that one field replaced: the question it asks has no act in it, so
it cannot turn quiet into an answer
(`replay/cases/decide-why-told-the-act.mjs`). A second look that fails or
names no such reason keeps the verdict as it was. The bench asks Decide the
same way, so a Lab draft that switches the step on is scored with it.

Not scored: it stays off until a Training run (Decide must not drop, and the
contradiction test should pass) and one Dev run say keep it. Decide runs on
Clef, which the credit outage does not touch, but a Lab run also runs the
front door, so none was started.

### Change 2, built and off (18 November): the shape gate

The step `shapeGate` is in the config, wired from the Door as a helper, on
Clef, and switched off. When it is on, the Door calls it as soon as it has
read the text and goes on gathering, so its one call runs beside the Door. It
asks three typed questions about the text alone: how the turn ends (a
tapback, one line, an answer, a report, or "on it" and a job), whether the
text is an order to act, and whether it asks about something stored. Only a
text a person sent is typed: never a routine's run, a check-in, a job's part
or a report.

Three things in the design above did not match the code, and the build
follows the code:

- **There is no notice on the front door's first call.** `notice` is read
  only on a send-back. The read goes into the turn's own note, the words said
  per text after the cached prefix, from a confidence of 0.6.
- **`doItChecks.js` had no "order with no call" check.** The gate adds one,
  with the other two contracts, as findings in the code checks.
- **The Answer check cannot end a turn on a tapback, and "nothing new to say"
  is not something code can know.** So the tapback contract sends the draft
  back once, toward the tapback tool, and the front door decides. It never
  forces the ending.

The contracts, each sent back at most once a turn, only from a confidence of
0.85, and never on a text that tagged Tex: a tapback ending with a call that
worked and words drafted; a one-line ending with a draft over three times a
line; an order with no call behind the draft (unless the ending is a job).
A gate that failed, ran out of its three seconds or was not sure says
nothing, and the turn is what it was
(`replay/cases/shape-gate-types-the-turn.mjs`, `shapeGate.test.mjs`).

Not scored: it stays off until a Training run and two Dev runs, read as a
mean against the baseline after change 3, say keep it.

## What this adds up to

If changes 1, 2, 4 and the handoff each land in the middle of their range:
about 1.5, 3.5, 3 and 2, near 40 of 53. The last three points are Decide's
two missing reactions and its two missed answers, which need Training
conversations before they can be touched honestly, and voice, which needs a
steadier measure. Change 3 is what makes the front-door numbers in that sum
checkable instead of hoped for.

## For Architect

Touch shared infra, and need review before they are built:

- **4. Retrieval prefetch**: a search on every turn against the workspace
  object (gateway search path, load).
- **5. Route on Decide's reason**: the texting Worker's triage and queue
  (a Worker deploy), and Decide on every one-to-one text.
- **7. One lookup tool**: an MCP tool's behaviour.

Do not: 1, 2, 3, 8, 9, 10. None changes a Convex schema.

## What a simplification would cost

Ranking by the size of a cause alone puts the front door's largest causes
first and spends the next week reading three-point noise. Building the shape
gate before the Training front door runs repeats the last four pull requests:
merged on unit tests, never scored. Letting the second look change the act
because it is already asking turns a log fix into the banter problem.
