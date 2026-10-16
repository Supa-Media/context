# The staff console's AI tab is the `ai/` folder of `@context-lc` (2026-10-16)

The owner, 2026-10-16: "whatever is in the admin panel, AI panel, is like the
underlying data is still the AI folder in context-lc. And it's just like
whoever can write to that folder is an admin. And so it's the same
permissions."

So `/admin/ai` has no table of its own. It reads `@context-lc`'s `ai/` folder
from the tree's front matter (`folderNotes`, every page) and sorts the notes
into jobs, skills, tests, setups, results and the rest
(`apps/mobile/features/admin/aiCatalog.ts`). The page draws only for an owner
or editor of `@context-lc` (every account is a pinned `member` there, which is
not enough), and `folderNotes` answers only what that caller's clearance sees.
It sits inside the staff console, which `amIAdmin` already gates.

**It is a library, and it edits in place** (boards 5-7; the owner, 2026-10-16,
after a first version that was a plain list whose rows opened the note editor:
"the UI looks nothing like what I was promised I also cant edit anything
inline"). The tree on the left is the folder's parts and opens on Needs
attention: jobs failing their last round, jobs with no test, skills no test
`covers:`, jobs with no setup note. Jobs show their model, quality, uses and
cost (from the AI costs report). A skill, setup or other note opens beside the
tree as its whole Markdown and saves back with the version it was read at; a
test list opens as a form (cases, what the person texts, how they answer,
rules coloured by who checks them) or as Markdown, and the form rewrites only
the lines it shows (`testList.ts`), with the last round's gate failures for
the case beside it. "Open in notes" stays for the full editor.

**Jobs are declared in code, never from the page** (the owner, 2026-10-16:
"a job should be like kind of predefined in the code"). `AI_JOBS` lists every
place AI runs, grouped Talking to people, Working in the background and Other.
A job whose setup note or test list is missing is drawn with that gap, not
hidden: the gap is what the page is for. There is no New job button; the page
links to the list on GitHub.

**Run tests is the AI Benchmark workflow on GitHub.** A round runs the live
setup with the live skills and the tests edited in `ai/tests/` (see
[benchmarks](../texting-assistant/benchmarks.md)); a scores note's front
matter carries the live setup's score, gates and good-enough verdict, which is
what the Jobs and Results lists show.

What a "simplification" would cost: a second store for skills or tests would
let the page and Tex disagree about what runs, and a page-made job would have
no code, no test and no cost behind it. `__tests__/adminAiCatalog.test.ts`
pins the sorting and the job rows, `adminTestList.test.ts` that the form's
edits leave every other line of a test list as written, and
`adminAiRender.test.ts` that rows open and save in place.

## The tab is the AI system's parts, and the folder is one link away (boards 8-16)

The owner, 2026-10-16: "I want to be able to see it, change the workflow, see
how things are doing … also being able to drill down and edit things." The
library became the Files view, behind a quiet link at the foot of a rail of
Overview, Jobs, Helper agents, Skills and Activity (`AiSection.tsx`). Every
place has an address (`aiPlace.ts`: `jobs/<job>/<tab>`,
`jobs/<job>/compare/<setup>`, …), validated segment by segment, so a link to
a comparison can be pasted into a thread.

- **A job's page is its setups, runs and cases.** Which setup is live comes
  from the production note's `from:`; every other setup under
  `ai/setups/<job>/` is a candidate, ranked by its last scored round against
  live (`aiModel.ts` `jobPage`). Prompt sizes come from the tree listing's
  byte count, shown as tokens at four characters each, never read from the
  bodies.
- **Promoting is a person's one-way door.** Compare shows the case-by-case
  table and the prompt diff; "Make it live" asks first, in bold red inline,
  then writes the production note (`promotedText`: the setup's front matter
  without `based_on`/`change`/`status`/`made_by`, plus `from`, `live_since`,
  `promoted_by`) with the version it read, and retires the old live setup.
- **Nothing an AI writes is trusted until a person checks it.** A case or
  setup an AI drafted carries `- drafted: <who>` (or `status: draft`), shows
  as drafted, is skipped by the bench until a person marks it checked, and
  the improver never promotes: it drafts setups and cases and leaves them in
  Activity under "needs a person".
- **Skill reach is front matter.** A skill is on for Tex when the live
  texting setup lists it under `skills:`; "Every AI" and "Helpers" write
  `reach: [tex, mcp, helpers]` on the skill note. Turning one off for Tex
  asks first, because the next text uses it.
- **Helper agents are declared in code** (`AI_HELPERS`), with the tools they
  may call named as the v2 tools and actions (`send · email.send`), and who
  may call them in their note's `callers:`.
- **Try it chats with any setup as yourself, read-only.** `/agent/try`
  (`apps/mcp/src/agent/tryIt.js`) runs one turn of a live or drafted setup on
  the console's own grant for the person's own workspace, offered only the
  read tools and refusing any other name before the dispatcher (a
  cross-context call opens its context from the connection's grant, so the
  scope clamp alone would not hold). A judge turn then checks the reply
  against the open case's `must`/`must not`/`may`/`judge` lines; the record
  checks stay with the bench. The control plane lets the console grant spend
  the built-in model only for this, and only for an owner or editor of
  `@context-lc`, decided from the grant (`builtinModel.ts` `editsAiNotes`).
- **An AI runs a round the way a person does**: it edits the notes through
  the Context tools, and dispatches the AI Benchmark workflow on GitHub when a
  person asked it to. There is still no schedule: a round spends money, and
  only a person's ask starts one.

`apps/mcp/test/agentTryIt.test.mjs` proves a member, an ordinary connection
and a non-setup path are refused, and that no write tool is offered or
reachable; `apps/convex/__tests__/builtinModel.test.ts` "Try it on the AI
tab" that only an editor's console grant may spend; the
`apps/mobile/__tests__/adminAi*.test.ts` files pin each screen's reads and
writes.
