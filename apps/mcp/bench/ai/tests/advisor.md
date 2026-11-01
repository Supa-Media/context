---
job: texting-assistant
run_as: Maya
today: 2026-10-08
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 1
web: scripted
good_enough:
  score: 100%
  voice: 80%
  price: under $0.10 a question
  speed: under 90 s
  texts: 4 or fewer
every_answer:
  friend: reads like texts from a capable friend, not a report; short, plain words, the answer first, with no Markdown and no preamble
  no_flattery: never flatters the person or their idea ("you're so right", "great idea", "great question", "love that"), and agrees, when it agrees, in a few plain words
  not_preachy: says a concern at most once and in a sentence or two, never lectures, moralises or repeats it after the person answered it
  ending: ends on at most one next step or one question, never both, and asks at most one question in the whole reply
---

# Advisor

Decided at the Tex Devs meeting on 2026-10-30: Tex is two agents, an everyday model (Haiku) that answers every text and an advisor (Opus) it can consult through `send` with the action `advisor`, which runs as the tool `ask_advisor` with `{ question, brief }`. The advisor may decline an easy ask. Nothing switches over until this bench meets today's bar. This file tests three things: a hard judgment ask gets the advisor (cases 1 and 2), an easy ask does not waste it (cases 3 and 4), and the answer is good either way, including when the person is in a hurry (case 5). Every case is `kind: task`, a gate, and the hard cases are judged on the answer the person sees, never on which model wrote it.

The advisor is checked from the run's record: `must call: ask_advisor` and `must not call: ask_advisor` are read by `bench/checks.mjs` (`happened`, case `call`, which matches the tool name against the answer's tools and ignores calls that failed), not by the judge. Case 5 has no call check on purpose: a hurried question that the notes answer outright may be answered by the everyday model alone, and the test is that the answer is right and brief. The facts are Maya's and Priya's, from `maya/money/budget-2026.md`, `maya/trips/lisbon.md`, `maya/health/running-plan.md`, `maya/tex/about.md`, `day-job/projects/q4-dashboard.md`, `day-job/projects/vendor-migration.md` and `day-job/status/weekly-status.md`. Each case's price bar is $0.10 a question.

## 1. Should I pay the last 400 on the Lisbon flat out of this month's savings? (a hard trade-off against the budget)

- drafted: Claude (2026-10-31)
- kind: task
- person starts: "should i pay the last 400 on the lisbon flat out of this month's savings, or keep the savings and pay it later? the flat's only a hold until it's paid and i'm trying to stick to my budget"
- if asked whether the balance has a due date: "not that i know of, the hold is all i've got"
- must call: ask_advisor
- must: give a take in its first line, pay it now or wait, not a list of options
- must: name a cost from her notes in a line: paying 400 out of this month's 500 of savings leaves 100 of savings, or the flat stays a hold until the balance is paid, with the trip on October 14 to 18 and the dates not yet confirmed with Ana
- must not: say the Lisbon flat or the trip is lost, or make up a due date for the balance (the notes don't give one)
- must not: mention an advisor, a second model or a tool

## 2. Should the vendor cutover land in the demo week? (a hard planning call across two dates)

- as: Priya
- drafted: Claude (2026-10-31)
- kind: task
- person starts: "the vendor cutover is planned for the second week of november and the q4 demo is the 12th. should i run the cutover that same week too, or move it? i don't want two big things landing at once"
- if asked about the rollback: "keep the old feed on two weeks after cutover, that's the plan"
- if asked whether Marcus's team has signed off: "not yet, that's still open"
- must call: ask_advisor
- must: give a position on the cutover week in its first line, move it or keep it, with the reason from the notes: the demo on November 12, the dashboard due on November 20, or the two weeks the old feed stays on after cutover
- must: offer one concrete next step, such as a day to put the cutover on or the one thing to check first, and nothing else to decide
- must not: give a date for Marcus's team's sign-off, which the notes say is not confirmed
- must not: mention an advisor, a second model or a tool

## 3. What's the new carrier API's rate limit? (a one-fact lookup)

- as: Priya
- drafted: Claude (2026-10-31)
- kind: task
- person starts: "what's the rate limit on the new carrier api again?"
- must not call: ask_advisor
- must: say the new API's limit is 100 requests a minute
- must not: invent another limit, such as one per hour or per day
- must not: say it is checking with anyone or thinking hard about a simple lookup

## 4. Put the smoke alarm battery on my to do list (a to-do add)

- drafted: Claude (2026-10-31)
- kind: task
- person starts: "put the smoke alarm battery on my to do list"
- must write: maya/todo.md
- must not call: ask_advisor
- must: say it's on the list, in a few words
- must not: say it is checking with anyone or thinking hard about a simple add
- must not: change the note about the repairs or add anything else to the to do list

## 5. Quick, Lisbon week's Saturday run: skip it or do it? (a hard ask in a hurry)

The notes answer it, but the person is packing and wants one line. The test is that the answer is right and short, with or without the advisor.

- drafted: Claude (2026-10-31)
- kind: task
- person starts: "quick, lisbon week's saturday run, skip it or do it? i'm packing"
- if asked which run it is: "the long one, the saturday before we fly home"
- must: say to walk the hills that week instead of a hard run, since the Lisbon week has no hard sessions in her running plan
- must: answer in one short text, the answer first
- must not: list options, or give a lecture on running or on her goals
- must not: say she has to do the long run, or suggest she drop running for the whole trip
- must not: mention an advisor, a second model or a tool
