# The texting assistant — a job's note and who is on its mail

_Part of [the texting assistant](../texting-assistant.md), beside
[background jobs](./background-jobs.md), [machines](./machines.md) and
[delegation](./delegation.md)._

### Every job gets a shared note first, with the job, Tex and the advisor on its mail (2026-11-05)

Decided by the owner, 2026-11-05: "Tex creates a shared project note for each
job first and connects the worker/minion, advisor and Tex itself." It came from
a job on a person's computer that stopped at a GitHub sign-in with no way to
reach Tex or the advisor while its part ran.

- **Before its first part**, the job's object asks the gateway for its note
  (`/agent/job/note`, `apps/mcp/src/agent/jobNote.js`). The note lives where it
  makes most sense: the project note Tex named in `background_job`'s `mail`,
  in the workspace that fits best, written new there if none fits. Tex's own
  notes (`tex/jobs/<name>-<id>.md`) are the last resort; a group chat's job,
  which has no Tex notes of its own to fall back to, goes to
  `projects/tex-jobs/<name>-<id>.md` in the workspace its grant writes to
  (2026-11-06: job 350eddce ran from a group with no note, so no mail, no
  advisor and no way to Tex, and spent two parts looking for one). It must be
  a note the person can see and follow. The note cap does not hold it back.
- The job joins the note's mail bound to itself; `tex` and `advisor` join
  unbound beside it.
- **Every agent is told at its start who it can reach and what each is for**
  (the roster, `rosterText`): `tex`, the only one who can reach the person, and
  nobody else contacts them; `advisor`, a much stronger model that is always
  listening, helps it finish and judges whether it finished; and the other jobs
  on the same note, coworkers on parts of the same ask. A cloud job reads it in
  its prompt, a job on a computer at the foot of its brief, so no runner
  release is needed.
- **One mail mechanism, never a tool per agent** ("why make different sub tools
  like call advisor, call this, call that"). Adding an agent is adding a line
  to the roster.
- A line mailed to `tex` or `advisor` is handed only to the sender's own job
  object (`apps/mcp/src/mail/deliver.js`): to `tex` it becomes the job's word on
  its way, reported to the chat's own turn, the one turn that texts the person
  ([background jobs](./background-jobs.md)); to `advisor` the advisor answers on
  the note (`/agent/job/advise`).
- **The advisor has a cap the job is never told**: ten asks a job
  (`MAX_ADVISOR_ASKS`, `apps/agent/src/jobNote.ts`). Past it the advisor says to
  use its best judgement, without asking the model and without saying why.
- **The advisor orchestrates** (owner, 2026-11-05): it knows the note's mail and
  the coworker jobs on it, so it can tell a job to mail its coworkers to split
  the work, and to mail Tex what the person must see. Its end-of-part verdict
  is also said on the note.
- A job never looks for a saved login: credentials never go to a device. A
  sign-in a computer job needs runs as a one-time link and code it mails Tex.

A run grant (`context_tex_machine_run`) reads and is delivered its job's mail
through its parent texting grant, never anyone else's. It may also join any
other note's mail its grant reaches (owner, 2026-11-06: a computer job talking
to another machine on a shared note is "the whole point"), but only under its
job's own name (the name its job note box has), bound to its job, never as
`tex` or `advisor`, never as another job and never as one of the person's
machines. A refused join says `permission denied`, never "try again": an agent
told to retry a deliberate refusal retried five times (2026-11-06).

**What a simplification would cost:** tools per agent would grow the tool list
with every new agent and hide the others from the job; telling the job the cap
makes it ration asks it needs; letting any line reach `tex` would let another
person's job or a stray connection text through Tex.

**Tests:** `apps/mcp/test/jobNote.test.mjs` (join binding, roster, delivery only
from the sender's own job, the advisor's coworker knowledge),
`apps/agent/src/jobNote.test.ts` (asked once, roster in the brief, mail to Tex
reported, hidden cap), and the run-grant mail test in
`apps/convex/__tests__/texMachineRuns.test.ts`.

### Workers know their advisor, and cloud jobs think hard (2026-11-06)

Decided by the owner, 2026-11-06: workers "need to know that they can call the
advisor", and "for Tex Cloud jobs I want it Haiku reasoning high"; computer
jobs keep Claude Code's default effort.

- A computer part's brief (`apps/mcp/src/machines/jobBackground.js`) always has
  a "Your advisor" section: what it is, how to ask it on the job's mail, when
  (before the first step when the job needs judgment, when stuck, before calling
  it finished), and that it checks the final answer. Never its cap.
- `models.job_effort` in `ai/production/texting-assistant.md` sets how hard a
  cloud job's turn thinks, on whichever model it runs (`production.js`
  `turnEfforts`); other turns keep `models.effort`. Production sets it to
  `high`. Test: `apps/mcp/test/agentJobHaiku.test.mjs`.
