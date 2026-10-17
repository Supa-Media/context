---
job: housekeeping
mode: housekeeping
run_as: Tomas
today: 2026-10-17
judge: claude-haiku-5-5
runs: 2
good_enough:
  score: 100%
  price: under $0.10 a run
  speed: under 120 s
  texts: 1 or fewer
---

# Housekeeping

Tex's housekeeping (`src/agent/housekeeping.js`, asked for by the owner on 2026-10-17: "fiercely organizing things, updating project statuses, archiving, getting the chaos score lower"). Nobody texts: each case is one run over Tomas's own workspace, which is messy on purpose (`workspaces/tomas/`, and `people.md` says how). The `must file` lines are checked from where each note is after the run (`checks.mjs`), never by the judge; the judge reads the line Tex would text and the log it wrote.

Each case is the same run, graded on one part of the job, so a score says which part slips.

## 1. Finished projects go to the archive

The kitchen remodel says it is finished. The tax return says it is done in its own words while its status still says in progress. Marathon training is live.

- kind: task
- must file: tomas/1-projects/kitchen-remodel/overview.md under tomas/4-archive/
- must file: tomas/1-projects/kitchen-remodel/budget.md under tomas/4-archive/
- must file: tomas/1-projects/tax-return-2026/overview.md under tomas/4-archive/
- must file: tomas/1-projects/marathon-training/overview.md under tomas/1-projects/marathon-training/overview.md
- must: say in the log which projects it archived and why

## 2. A stale status is brought up to date

The tax return's own note says it was filed and the refund arrived, but its status still says in progress. The workspace's word for done is "finished" (the kitchen remodel uses it), so that is the word, wherever the note ends up.

- kind: task
- must file: tomas/1-projects/tax-return-2026/overview.md under tomas/ with status: finished
- must file: tomas/1-projects/marathon-training/overview.md under tomas/1-projects/marathon-training/overview.md with status: in progress

## 3. Duplicate contacts are merged only on a shared address

The two Ana pages share an email address, so they are one person: the fuller page keeps everything, including the activity link only the thinner one had. The two Ben Cole pages share only a name, so they stay two pages and the newer one asks the person.

- kind: task
- must file: tomas/0-inbox/contacts/a/ana-ruiz.md under tomas/0-inbox/contacts/a/ana-ruiz.md containing 2026-05-04-note
- must file: tomas/0-inbox/contacts/a/ana-r.md under tomas/4-archive/
- must file: tomas/0-inbox/contacts/b/ben-cole.md under tomas/0-inbox/contacts/b/ben-cole.md
- must file: tomas/0-inbox/contacts/b/ben-cole-2.md under tomas/0-inbox/contacts/b/ben-cole-2.md with review: *
- must not: say it merged the two Ben Cole pages

## 4. A one-note folder is folded into the folder above

- kind: task
- must not file: tomas/2-areas/car/insurance.md under tomas/2-areas/car/
- must file: tomas/2-areas/car/insurance.md under tomas/2-areas/
- must file: tomas/2-areas/home/boiler.md under tomas/2-areas/home/boiler.md

## 5. The inbox keeps about three months

Today is 17 October. The May and early June notes are past three months; the 14 October note is new.

- kind: task
- must file: tomas/0-inbox/2026-05-04-note.md under tomas/4-archive/
- must file: tomas/0-inbox/2026-05-19-note.md under tomas/4-archive/
- must file: tomas/0-inbox/2026-06-02-note.md under tomas/4-archive/
- must file: tomas/0-inbox/2026-10-14-note.md under tomas/0-inbox/2026-10-14-note.md

## 6. What housekeeping never touches

- kind: task
- must file: tomas/tex/about-me.md under tomas/tex/about-me.md
- must file: tomas/website/index.md under tomas/website/index.md
- must file: tomas/todo.md under tomas/todo.md
- must file: tomas/3-resources/woodworking/joinery.md under tomas/3-resources/woodworking/
- must: keep the line it would text to one plain sentence about what it changed
