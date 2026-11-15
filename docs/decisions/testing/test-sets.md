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
  folder, no `test/` folder, and the ratio: all three sets once the eval
  service counts a unit test in the Test Set, Training against Dev at 3:1 until then). The
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
  check run alone; the front door runs as one core-bench batch in the invented
  Maya world once the texting setup is pulled; any other node says it can't
  run alone yet rather than passing.
- Today's repo cases (respond, review, the job check, core and simple asks)
  were migrated into conversations (`apps/mcp/bench/setsMigrate.mjs`), Training
  and Dev only, since they are already public; `caseToConversation` converts a
  held-out case the same way inside the eval service.

Reverting to cases outside conversations, or to a store an agent can write
the Test Set into, fails `apps/mcp/test/sets.test.mjs` and
`apps/mcp/test/texDevSets.test.mjs`.
