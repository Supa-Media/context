# Tex is tested on conversations, split 60/20/20, gated on the Test Set

Decided by the owner, 2026-11-15: "we need a way to add some sample or test
conversations, and every Tex response in the same conversation is a datapoint
along with the conversation history"; "unit tests should be marked per message,
per node"; "60/20/20 doesn't mean we have to have 100 test cases ... it's just a
ratio i want to enforce"; "Training Set, Dev Set, Test Set"; and, approving the
Lab's Testing tab: "the test set should become the actual thing that the CI/CD
gates on ... training shouldn't affect CI/CD speed. Even the dev shouldn't".

## The rule

- **A case is a conversation.** Whole chats, with special messages (a
  reaction, a reply, an edit or a delete of an earlier message). A Tex row is
  what Tex should have said: history for the rows after it, never a test,
  since a reply is every node together. A person's message with no Tex row
  after it is Tex staying quiet.
- **A label is one message × one node**, in that node's real output fields
  from `texConfig.json`; a **unit test is a starred label**. The node runs
  alone on everything before the message, its config context modules, and its
  wires' inputs: the upstream node's label on that message if it has one, else
  its recorded run on main.
- **60/20/20 over unit tests**: Training / Dev / Test, a whole conversation in
  one set, each set within ten points of its share. It is a target, reported
  and never a CI failure (Dev2, 2026-11-17: "no need to enforce the 60 20 20,
  thats just the target").
- **One pooled split; per scope only a warning** (Dev2, 2026-11-17: "one
  pooled 60/20/20 split across all scopes, not a separate split per scope. The
  only per-scope piece is the non-blocking warning when a scope has no Test
  cases"). A scope is what a label is keyed by: a node today, a config group
  once group labels arrive. `missingTest` in `texSets.cjs` names each scope
  with Training or Dev unit tests and none in the Test Set, from the eval
  service's public `byNode` count; CI prints it as a GitHub warning
  (`scripts/tex-sets-check.mjs`), the Lab marks the column and the ratio chip,
  and tex_dev's `set_ratio` returns it as `noTest`. It never fails anything,
  and names nothing when the counts can't be read. A per-scope ratio would
  push most of a small, costly scope's cases into Training, where nothing
  runs; `apps/mcp/test/texSets.test.mjs` fails if a zero count is taken for a
  Test case.
- **Training** is read by the nodes as an examples module in their context and
  never run in CI. **Dev** is replayed on demand and nightly for agents to tune
  against, and never gates. **Test** is the only gate, people-only (written and
  read by hand, never shown to an agent), sealed in the eval service.

**How Training reaches a step**: a context module per node, `train:<nodeId>`,
listed in a step's `ctx` in `texConfig.json` like any other read. A step reads
its own labels with `train:<its id>`, another step's by naming that one, and
none when the entry is taken out; the Lab and `tex_dev` add, move and remove it
as they do any module. `scripts/tex-training-module.mjs` writes every Training
label as a moment (the chat before, the message, the label) into
`packages/shared/src/texTraining.generated.json`, which `texTraining.cjs`
renders; CI fails when it is stale. Decide's judge examples are Training
conversations (`apps/mcp/bench/sets/training/decide-*.json`) and its prompt
was unchanged by a byte by the move; the front door and the background job get
theirs as prompt modules where their context puts them, and every other step
whose prompt goes through `withArchitecture` after its own words. A step whose
code does not read the module may not name it (`apps/mcp/test/texTraining.test.mjs`).

**Whole conversations** (Dev2, 2026-11-17: "would it be better to add the
entire conversation instead?", chose whole chats, capped in config):
`train:<nodeId>:all:<chars>` shows every Training conversation that node has a
label in, whole, each label under the message it is on, as many whole
conversations as fit in `<chars>`; one that would pass the cap is left out whole
and counted, never cut. The front door reads `train:fd:all:60000`, so it sees the
back-and-forth and long history the Training chats were rebuilt for (from real
texts, disguised). A setup built from modules may run to 200,000 characters; a
note's own body keeps its 40,000. Simplifying back to snippets loses the rhythm
of a long chat; `texTraining.test.mjs` fails if the front door stops reading
whole conversations.

`packages/shared/src/texSets.cjs` is the one contract every reader uses (the
Lab's Testing tab, the store, the eval service, the prompts' examples).

## What a "simplification" would cost

Gating on Dev or Training again makes every Tex change slower and lets an
agent tune to the cases that judge it. Labelling a whole reply as a test hides
which node broke. Fixed counts instead of a ratio force invented filler.
`apps/mcp/test/texSets.test.mjs` fails if a Tex row can be starred, if the
ratio counts labels instead of stars, or if the drift limit is ignored.

## Where the conversations live, and how they change

- **Training and Dev are files**, one conversation each, at
  `apps/mcp/bench/sets/<training|dev>/<id>.json`, checked by
  `scripts/tex-sets-check.mjs` in Fast guards (every file sound, in its set's
  folder, no `test/` folder, and the ratio over all three sets, Test as the
  eval service counts it, reported only). The
  gateway and the Lab read them as generated data
  (`texSetsRepo.generated.json`, the Lab's `SETS`).
- **A change is a draft first.** The Lab's Testing tab and `tex_dev` edit a
  conversation with the same small edits (`packages/shared/src/texSetOps.cjs`),
  kept in the control plane over the repo file (`functions/texSets.ts`, with a
  per-piece conflict check like the Lab's drafts). Promote opens one pull
  request writing the drafts into the folder (`tex-lab-promote.yml`,
  `scripts/tex-sets-promote.mjs`); once it merges, the drafts it carried go.
- **Agents see and change Training and Dev through `tex_dev`** (`sets`,
  `set_get`, `set_fields`, `set_edit`, `set_move`, `set_create`, `set_delete`,
  `set_restore`, `set_ratio`, `set_promote`), and turn a real chat into a
  conversation with `set_import`: the save reads the chat again and refuses a
  line that shares six words in a row with a real text or a member named as
  someone in it, because examples from real chats are never verbatim
  (decided by the owner, 2026-11-12). The Test Set is refused by every one of
  these, and by the store.
- **A node alone** is `node apps/mcp/bench/run.mjs sets run` (`setsRun.mjs`):
  each starred label through that node's code from `--tree`, put the way
  production puts it, scored by the caller's harness, rows only in `--out` and
  counts by node on standard output. Decide, the reply reviewer and the job
  check run alone. The front door runs as one bench batch (`setsFd.mjs`): each
  test is the person's one text in their invented bench world, the chat before
  it posted to the chat's history first, answered by the tree's code and
  config and judged on its must and never lines (decided by Dev2, 2026-11-16,
  after its twenty Dev tests all read "can't run alone"; it had run only a
  chat with no earlier texts, and only with the setup pulled from Context). A
  tree with no pulled setup runs with the live note's settings minus its task
  skills, since Tex's models and words come from the config. A group chat, a
  picture or a tapback still says why it can't run; any other node says it
  can't run alone yet rather than passing, and the Lab shows that reason.
- **About ten long conversations, not one per case** (decided by the owner,
  2026-11-16: "only like around 10 conversations, but the conversations are much
  longer ... 100, 500 different turns ... Tex is trained on having a bunch of
  history"). Today's repo cases (respond, review, the job check, core and simple
  asks, and the judge's examples) sit inside ten invented chats of 140 to 300
  messages, five one-to-one and five groups, each case one unbroken run of
  messages named in its conversation's `from`, with ordinary history around it.
  `node apps/mcp/bench/setsMigrate.mjs --check` holds every case a conversation
  names to that, and `caseToConversation` still converts a held-out case for the
  eval service. Dev2 removed those ten on 2026-11-17 for chats rebuilt from real
  texts, disguised; a case no conversation names is retired from the sets and
  still runs in its own bench area.
- **A Dev chat's people are the bench's** (Dev2, 2026-11-17: "why dont we use
  existing people that we do have worlds for then, and then why dont we
  restrict the people that can be put in these test sets"). Each Dev unit test
  runs as a real turn in its person's invented bench world
  (`apps/mcp/bench/setsFd.mjs`), so `texSets.cjs` `BENCH_PEOPLE` (exactly the
  people of `apps/mcp/bench/ai/workspaces/people.md`) is the only cast a Dev
  chat may have, and the facts it leans on live in their notes and Gmail. A
  group runs in the shared workspace that has all its members, each earlier
  line sent as its speaker, and each test on its own day, walked from the
  first time line that names a date ("Tue Oct 13 10:14"). `texSets.test.mjs` and
  `setsFd.test.mjs` fail if either part is undone.
- **Training is cast from the bench's own people** (Seyi, 2026-11-17,
  reversing "Training is read as examples and never run, so anyone may be in
  it"). Training is run and scored from the Lab, and its Front door read 0/63
  in thirty seconds, each row "has no bench world", because Remi, Lucia, Omar
  and the rest were nobody `people.md` knew. Two fixes landed the same day.
  #3631 gave those seven people thin worlds (removed 2026-11-18: nothing ran in
  them, and a conversation now brings its own world, below).
  Then, on Seyi's decision, the six Training conversations were recast onto
  people who already had worlds, their words otherwise unchanged:
  `trial-hire` and `running-the-shop` are John's (his brother is Mateo in both
  worlds), `loose-ends` is Maya's, `truck-crew` runs in the-flat (Priya, John,
  Kofi), `build-crew` and `side-talk` in fashion-brand (Maya, John, Priya). A
  recast chat reads its person's real notes and Gmail; a thin world has only a
  time zone. The thin worlds are still there and no conversation uses them:
  removing them is the owner's call. Another AI assistant in a group
  (`side-talk`'s Nova, `OTHER_ASSISTANTS`) is a member and never a person, so
  it needs no world. A Training chat may have anyone with a world, a Dev chat
  only the bench's own six. `sets.test.mjs` fails when any Training or Dev
  conversation has someone without a world or a group without a shared
  workspace.
- **A run that could not run fails; it never scores 0.** A Lab run refuses, in
  `prepare`, a conversation whose Front door tests the bench has no cast for,
  and fails after the tests when a whole step ran none of its tests
  (`scripts/tex-lab-run.mjs` `uncast`, `unrun`), with why as the run's error.
  One test that can't run alone (a picture not kept, a check-in with no
  email) still says so on its own row. `texDevRuns.test.mjs` fails if either
  is undone.
- **A step's examples show the recent stretch.** Each Training example carries
  the newest four messages before it (two for Decide) and a line counting the
  earlier ones (`texTraining.cjs` `historyLines`), because every example rides
  in the step's prompt on every call: Clef reads at most 24,000 characters,
  live chat included, and the front door's setup at most 40,000. A node run
  alone reads the whole conversation. `apps/mcp/test/texTraining.test.mjs` fails
  if Decide's examples take more than half of what Clef reads.

Reverting to cases outside conversations, or to a store an agent can write
the Test Set into, fails `apps/mcp/test/sets.test.mjs` and
`apps/mcp/test/texDevSets.test.mjs`.

## A conversation brings its own world (2026-11-18)

Asked by the owner, 2026-11-17: "Make Training measure Tex, not the test
world." Recast onto the bench's people, a podcast crew's chat ran in the
fashion brand's workspace: the gear note, the outreach email and the budget it
talks about did not exist, and Tex was graded on not finding them.

- **A world is declared with the conversation**, in
  `apps/mcp/bench/sets/worlds/<conversation id>/`: `workspaces/<name>/` holds
  notes, emails and calendar days in the forms every bench workspace uses, and
  `sites/` holds scripted sites. A name that is a member's own workspace is
  laid over it, so the person keeps their bench world. Any other name is a new
  shared workspace of the conversation's people, and a group chat runs in it.
  Training and Dev conversations work the same way (`setsWorld.mjs`).
- **Each conversation runs in a copy of the bench folder of its own**, so one
  person's two conversations never see each other's records.
- **A world is the state of things when the chat began.** Notes are as they
  were then. Mail is dated, and an email dated after a test's own day has not
  arrived for that test. A world is written from what the conversation's own
  lines say exists, never from a test's must and never lines.
- **Every row runs on its own weekday.** A chat that names no date starts on
  the first day on or after the bench's day that is its first line's weekday;
  rows before a chat's first dated line are walked back from it. A world may
  say the day its chat begins (`world.md`, `starts:`), so its dated mail and
  the chat agree without touching the chat's words. Before this
  every undated Training row ran on the bench's day, a Thursday, so a Monday
  routine rightly stayed quiet. A routine row whose words open "one-off" runs
  as a one-off reminder.
- **The bench's failures are the bench's rows.** A stand-in with no answer for
  a call a turn made is kept on the conversation's record (`benchGaps.mjs`),
  and a missed test whose turn hit one is a row that could not run, with what
  the bench lacked, never a miss of Tex's. The settings tools, a drawn card
  and the connected-apps list now have stand-ins
  (`texCommands.mjs`, `drawnPictures.mjs`, `world.mjs`).
- **The hold-out is a switch** (the owner, 2026-11-17: "keep the hold-out as a
  switch, and report both Training numbers"). Off, a Training conversation's
  Front door tests read it among their examples, as production does: the
  in-context score, whose bar is 95%. On (`sets run --hold-out on`, or the
  repository variable `TEX_SETS_HOLD_OUT=on` for a Lab run), each runs with
  its own conversation left out of every step's examples
  (`texTraining.cjs` `heldOutOf`): the held-out score.

What a simplification would cost: one shared world for every conversation
puts each chat's records in front of every other chat's tests; reading the
bench's own failures as misses spends a week tuning Tex against a blank
picture. `setsWorld.test.mjs`, `setsFd.test.mjs` and
`bench/test/benchTools.test.mjs` fail if any part is undone.
