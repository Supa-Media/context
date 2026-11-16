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
  one set, each set within ten points of its share.
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
  folder, no `test/` folder, and the ratio over all three sets, which fails
  CI once every set has a unit test (Test as the eval service counts it) and
  until then names the empty set and is only reported). The
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
  `node apps/mcp/bench/setsMigrate.mjs --check` holds every case to that, and
  `caseToConversation` still converts a held-out case for the eval service.
  Maya's chat is in Dev: its answers are facts from her setup notes, which would
  mislead a step shown them as examples.
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
