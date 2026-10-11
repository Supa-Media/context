# The chaos score

Every workspace has a chaos score: one number from 0 (calm) to 100 (chaos)
for how well its notes are organized, kept current in the tree database as
notes are created, moved, renamed and edited. Asked for by the owner on
2026-10-10, who set the rubric and answered the open questions in the project
thread "chaos score". The rubric is `apps/mcp/src/chaos/rubric.js`; the
"How we define chaos" skill (`plugins/context/skills/how-we-define-chaos/`)
teaches it to agents.

## It is one opinion, on purpose

The owner asked for "an extremely opinionated scoring rubric for what chaos
and organizing is". There is no setting, no per-workspace threshold and no
"my folders are different" switch. A score people can tune measures their
tuning. If the rubric is wrong it changes here, for everyone, as a decision.

The rules, all the owner's:

- 4 or 5 items in a folder is calm, 10 is the average mark, past 10 it climbs,
  35 or more is full chaos.
- Thin folders are chaos too: a folder holding only its about note is the
  worst, one item should move out, two should probably be combined, three is
  nearly fine. The root and the built-in folders are never thin.
- A run (dated notes, a name with a number, chapters 1 to N) counts as one
  item, but only up to 30: past a month of daily notes it costs again.
- A note past 1,000 lines adds chaos. Meetings and generated notes are exempt:
  nobody wrote them long.
- Archive is never scored. The inbox is: a full inbox should raise the score,
  as the reminder to sort it.
- The workspace score weighs each folder by what it holds: 20% of the notes in
  a calm folder and 80% in a chaotic one is 80% chaos.
- Lower is better, and it is called the chaos score. The owner chose both "for
  now, and we'll see how users react", so renaming it or flipping it to a
  "calm score" is their call, not a copy edit.

Tests: `apps/mcp/test/chaosRubric.test.mjs`, one per rule.

## It reports; it never tidies

The score replaced the "Tidy up" tab of What changed, which the owner removed
on 2026-10-10 as not useful. Keeping a workspace organized is the person's job,
or an agent's they asked. So nothing acts on the score by itself: `orient`
shows it and the biggest wins, every write and move answer shows the score
before and after, the app shows the number and the figure, and none of them
suggest a change or carry a "tidy now" button. A "simplification" that brings
automatic tidying back is the feature the owner just removed.

## Every write answers with the change

`write_note`, `move_note`, `move_notes`, `move_folder` and `archive_note` end
with `chaos: X → Y of 100` and the folders the change touched, so an agent sees
at once whether it helped. It is a line on existing tools, not a new tool,
because installed clients cache tool lists (see
[gateway protocol](./gateway-protocol.md)). The answer waits at most three
seconds for the rescore; a slower one finishes behind the response and says
nothing rather than holding the agent up.

## Kept incrementally, proven equal to a full pass

The score lives in the tree database (`tree_chaos`, one row per folder).
A change rescores only the folders it touched and walks up while a folder
appears, vanishes or changes team presence; the properties fill pass rescores
everything once it has read something new. The property test "rescoring only
what each change touched always lands where a full pass would" in
`apps/mcp/test/chaosTable.test.mjs` runs sixty random creates, moves, folder
moves and deletes and compares each step with a full recompute. Sabotaged: it
fails without the parent walk and without carrying a moved note's length.

## Two audiences, and a member learns nothing held back

Each row holds an owner's numbers and a team member's, the latter over only
the notes `privacy.md` shows the team (`canSee` at `team` scope, no granted
names, so it fails closed). A member is answered from the team numbers, and a
folder is named to them only where a note they may open sits beneath it. A
score that counted held-back notes would let a member watch it move and learn
that something exists. Test: "a team member never counts, sees or is named a
private folder or note" in `apps/convex/__tests__/chaosScore.test.ts`.

## A derivative, like every index

`tree_chaos` and the daily history are rebuildable from the bucket and are
never the only copy of anything (non-negotiable #3). A workspace with no tree
database has no score, and every surface shows nothing rather than a guess.
