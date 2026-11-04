---
job: texting-assistant
run_as: Maya
today: 2026-10-08
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 2
web: scripted
background: on
computer: Studio Mac (claude, codex) 3 slots
good_enough:
  score: 100%
  voice: 80%
  price: under $0.15 a question
  speed: under 90 s
  texts: 3 or fewer
every_answer:
  friend: reads like texts from a capable friend, not a report; short, plain words, the answer first, with no Markdown and no preamble
  no_flattery: never flatters the person or their idea, and agrees, when it agrees, in a few plain words
  ending: ends on at most one next step or one question, never both, and asks at most one question in the whole reply
---

# Splitting big asks

Asked for by Dev on 2026-11-04: a big ask whose parts can run side by side is split into one background job per part while job slots are free, and a simple ask is never split. Tex runs three jobs at once in a chat (`MAX_RUNNING_JOBS`), and every setup gets the same slots: `background: on` sends the chat's running jobs with every text, none unless a case says `- running: N` (`run.mjs` `benchRunning`). Every case's person has one paired computer, `computer: Studio Mac (claude, codex) 3 slots` (`bench/world.mjs` `benchMachines`), the same for every setup. Code goes to it, never the cloud (Dev, 2026-11-04): a question about how a codebase works, reading a repo, and any change to code; everything else runs in the cloud. A small code change is one job on the computer, a big one splits there. Nothing runs the jobs here: the test is what the texted turn starts.

What a turn started is checked from the run's record, never by the judge (`bench/checks.mjs` `start`): `must start: 2+ jobs on one note's mail` needs two or more jobs, every one joined to the same project note's mail under a name of its own; `must not start: a job` needs none; `on a computer` and `in the cloud` count only the jobs that ran there. The task notes are checked with `must write` under the folder the project goes in. A setup may split by starting the jobs itself or through its advisor's planner (`plan_big_ask`, `src/agent/planBigAsk.js`); the test does not say which. The facts are Maya's, from `maya/trips/lisbon.md`, `maya/health/running-plan.md` and `maya/todo.md`.

## 1. Plan the Lisbon week: restaurants, a day trip, and what to pack (three parts that run side by side)

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "can you sort out the lisbon week properly? i want a dinner spot picked for each night, one day trip out of the city, and a packing list for the weather that week"
- if asked about food: "anything, we like seafood, nothing too fancy"
- if asked about the budget: "whatever's in my budget note"
- must start: 2+ jobs on one note's mail
- must not start: a job on a computer
- must write: maya/projects/
- must: tell her in one short text that it's on it, in parts, and will text the result
- must not: ask more than one question before starting
- must not: do the research in this text, or list restaurants, trips or packing items it hasn't found yet

## 2. Shoes, a physio and a November plan (three unrelated parts at once)

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "ok three things for running. compare 3 good beginner shoes for me, find a physio near me who does knees, and write me a training plan for november that gets me to the 10k"
- if asked where she lives: "whatever's in my notes"
- if asked about her knee: "a bit sore after the long runs, nothing serious"
- must start: 2+ jobs on one note's mail
- must write: maya/projects/
- must: tell her in one short text that it's on it and will text the results
- must not: write the November plan or name shoes or a physio in this text

## 3. The same kind of ask with one slot free (split as far as the slots go)

Two jobs are already running, so one slot is free. The ask still gets done, as one job, and is not refused.

- drafted: Claude (2026-11-04)
- running: 2
- kind: task
- person starts: "can you also plan the lisbon week? dinner spot each night, one day trip, and a packing list for the weather"
- if asked about food: "seafood, nothing fancy"
- must start: 1 job
- must: tell her in one short text that it's on it
- must not: say it can't take the ask, or tell her to ask again later

## 4. A big ask with every slot taken (nothing starts, and she hears why)

- drafted: Claude (2026-11-04)
- running: 3
- kind: task
- person starts: "can you plan the lisbon week too? dinner spot each night, a day trip and a packing list"
- must not start: a job
- must: say it will start this once one of the running jobs finishes, or offer to do a small part now, in a line or two
- must not: say it started the work, or promise results it isn't working on

## 5. When do we fly back from Lisbon? (a one-fact lookup)

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "when do we fly back from lisbon?"
- must not start: a job
- must not call: plan_big_ask
- must: say October 18, in the morning
- must not: invent a flight time or number

## 6. Add sunscreen to the packing list (one write)

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "add sunscreen to the lisbon packing list"
- must not start: a job
- must not call: plan_big_ask
- must write: maya/trips/lisbon-packing.md
- must: say it's added, in a few words

## 7. Which travel insurance should I buy for Lisbon? (one piece of work, never split)

One research task with one answer: it may be done now or as one job, never split into parts.

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "can you find me decent travel insurance for the lisbon trip and tell me which one to get?"
- if asked who's covered: "just me, ana sorts her own"
- must not start: 2+ jobs
- must: either give one pick with its reason, or say in one short text that it's on it and will text the pick
- must not: invent a price or a policy it did not find

## 8. What's left before Lisbon? (two quick lookups in one text, never jobs)

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "what's left to do before lisbon and how far am i on the running plan?"
- must not start: a job
- must not call: plan_big_ask
- must: name the open Lisbon to-dos from her list (the flat check-in time, Ana's train, the packing list)
- must: say 3 of 3 sessions were done the week of October 5
- must not: add a to-do that isn't on her list

## 9. How does Next.js decide to cache a fetch? (a question about a public codebase goes to the computer)

Reading a repo to answer is code work: it runs on her computer with Claude Code or Codex, never in the cloud, and it is one job.

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "how does vercel's next.js decide whether a fetch in the app router gets cached? i want the actual logic from their repo, not a blog post"
- must start: 1 job on a computer
- must not start: a job in the cloud
- must: tell her in one short text that it's on it and will text what it finds
- must not: explain Next.js caching from memory in this text

## 10. Change the "On it" text in Context (a small code change: one job on the computer)

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "in the context repo, change the text tex sends when a job starts from On it to On it, I'll text you back. small change, open a PR"
- must start: 1 job on a computer
- must not start: a job in the cloud
- must: tell her in one short text that it's on it
- must not: ask which repo or which computer

## 11. Build a weekly digest into Tex (a big code change: split on the computer)

Several pieces of one feature that can be built at once: each is a part on her computer, sharing one project note's mail.

- drafted: Claude (2026-11-04)
- kind: task
- person starts: "big one for the context repo: build a weekly digest for tex. a sunday routine that gathers what every background job finished that week, a new card to draw it, and the tests and docs for both. open PRs"
- if asked about the day: "sunday at 6 pm"
- must start: 2+ jobs on one note's mail on a computer
- must not start: a job in the cloud
- must write: maya/projects/
- must: tell her in one short text that it's on it, in parts
