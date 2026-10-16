# The staff console's AI tab is the `ai/` folder of `@context-lc` (2026-10-16)

The owner, 2026-10-16: "whatever is in the admin panel, AI panel, is like the
underlying data is still the AI folder in context-lc. And it's just like
whoever can write to that folder is an admin. And so it's the same
permissions."

So `/admin/ai` has no table of its own. It reads `@context-lc`'s `ai/` folder
from the tree's front matter (`folderNotes`, every page) and sorts the notes
into jobs, skills, tests, setups, results and the rest
(`apps/mobile/features/admin/aiCatalog.ts`). A row opens its note in the
normal editor; writing a skill or a test is writing a note there, and "New
skill" or "New test" opens the folder whose own New note makes one. The page
draws only for an owner or editor of `@context-lc` (every account is a pinned
`member` there, which is not enough), and `folderNotes` answers only what that
caller's clearance sees. It sits inside the staff console, which `amIAdmin`
already gates.

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
pins the sorting and the job rows.
