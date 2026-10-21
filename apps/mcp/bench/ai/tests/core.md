---
job: texting-assistant
run_as: Maya
today: 2026-10-08
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 3
web: scripted
good_enough:
  score: 100%
  voice: 80%
  price: under $0.05 a question
  speed: under 90 s
  texts: 4 or fewer
every_answer:
  friend: reads like texts from a capable friend, not a report; short, plain words, the answer first, with no Markdown, no preamble and no flattery
  one_idea: each text carries one idea in a sentence or two, with at most three texts (a blank line starts a new text) and nothing padded or repeated
  machinery: never mentions searching, tools, workspaces or file paths, and never lists what it looked at; naming the note it changed, or saying the notes don't have something, is fine
  ending: ends on at most one next step or one question, never both, never "let me know if you need anything else", and asks at most one question in the whole reply
  tone: matches the person's tone and never avoids a contraction where one fits (it's, don't, you're); an emoji only if the person sent one first, and no exclamation marks for their own sake
---

# Core

Decided by the owner on 2026-10-14: "we have like sixty questions, we probably need to reduce it to twenty golden task questions or ten for now and see if we could do some basic things." These are the basics Tex must do, and every one is a gate. It is the texting assistant's default test (`pnpm ai run texting-assistant`, and the Action with `test` left empty); the golden tasks (`tasks.md`) run by name for a full round (`--test tasks`).

Reshaped by the owner on 2026-10-17, when the long set of 59 questions was retired: the three questions that copied golden tasks (the flight, connecting ChatGPT, saving a login) were dropped, since `tasks.md` runs them, and seven questions the long set alone covered were moved in: a privacy question with its mirror, a request to contact someone else, an opinion, a date range, a vague ask that needs one question, and an emoji-toned ask. Nineteen questions in all. Question 20, reading a day of the calendar, was added on 2026-10-21 after Tex missed a Friday.

Every question is `kind: task`, which makes it a gate: a failed must or must-not line, a failed check, or an unanswered run fails the setup. Judge lines and the `every_answer` lines grade nothing; the share of `every_answer` lines passed is the setup's voice, held to the `voice` bar.

Loosened on 2026-10-17 by the testing loop, after a round where the judge failed correct answers for leaving out a detail the question never needed (the flat's two bedrooms, the book club's end time, the session's weekday) or for adding a true one (the hold until the balance is paid): each such detail moved from a `must` to a `may`, and the point of the line stayed a gate. Question 15's phone number became a `must not`, and question 13 now forbids hinting at John's hidden notes rather than at anything at all, so naming the brand note Maya can see passes.

The questions keep the wording, the person asking and the lines they had in the long set, which is in git history. Question 10 names Tex since the owner named the assistant (2026-10-14). Questions 11 and 12 were new on 2026-10-14: a reminder is a routine note, acknowledged the way a friend would ("Will do.", the owner, 2026-10-14, after Tex restated a whole reminder back) (`docs/decisions/routines.md`), and a one-off reminder is a note in `tex/routines/once/` whose `at:` names the full date and time (new routines go in Tex's own `tex/` folder, the owner, 2026-10-14). Question 13 is a privacy question: its `mirror:` is question 14, the same facts asked by someone allowed to see them, and question 13 counts only when its mirror passes, because a setup that finds nothing looks perfectly private.

Today is Thursday, October 8, 2026, so "Friday" is October 9 and "tomorrow" is October 9 too. The web is scripted (`web: scripted`, `bench/sites.mjs`): every site lives in `sites/` and nothing reaches the real web. Lines like `must call`, `must reach` and `must write` are checked from the run's own record (`bench/checks.mjs`), never by the judge. `must write: <workspace>/<path>` is a note the answer wrote there (under a folder when the path ends in `/`), and `with key: value, ...` names front matter it must carry, read the way `packages/shared/src/routines.cjs` reads a routine.

## 1. When's my dentist appointment?

A lookup from one note.

- kind: task
- must: say Tuesday, October 13 at 3 pm
- must not: make up a date that isn't in the notes

## 2. How much of the Lisbon travel fund is still to pay?

Two facts from the notes, and the sum between them.

- kind: task
- must: say 800 paid so far out of 1,200 in total
- must: say 400 is still to pay

## 3. Can I make The Velvet Anchor on October 17?

Across two workspaces: the trip is in Maya's own, the show in the band's.

- kind: task
- must: say the Lisbon trip runs October 14 to 18, so Maya is in Lisbon on the 17th, leaving on the morning of the 18th
- must: give the show's own details from the band notes: October 17, load-in 6:30 pm, show 8 pm
- must not: say Maya is free for the show

## 4. What's the address of the Lisbon flat?

The notes don't have it.

- kind: task
- must: say the notes don't give the address
- may: say it is a two-bedroom flat held for all four nights, and only a hold until the balance is paid
- must not: invent a street, area or address

## 5. what do I need to do before lisbon

A short list from her own to-dos.

- kind: task
- must: give the Lisbon to-dos from her list: confirm the flat check-in time, ask Ana which train she wants on the first day, and finish the packing list before October 13
- must: give them as one short line per item, in at most three texts
- may: mention the flat balance still to pay, and the twill quantities Dana wants by mid-month
- must not: include unrelated to-dos (the electric bill, the tap, the dry cleaning, the library card)
- must not: invent a to-do that isn't in the notes

## 6. The plumber is coming for the tap on Friday at 10 am

A write to the note that already covers it.

- kind: task
- must write: maya/home/apartment-repairs.md
- must not write: maya/todo.md
- must: change the bathroom tap line in maya/home/apartment-repairs.md to record the visit as Friday, October 9 at 10 am
- must: leave the other repair lines as they were
- must: write nothing into any other note, the to-do list included
- must not: contact the plumber

## 7. Ruth's deposit came in today

Ticking off a done item, as John.

- as: John
- kind: task
- must write: woodshop/todo.md
- must write: woodshop/projects/shelf-commission.md
- must: change woodshop/projects/shelf-commission.md to say the deposit has been received
- must: tick off "Get the deposit for the shelf commission" in woodshop/todo.md
- must not: give an amount, because the notes don't have one
- must not: change any other note

## 8. actually the dentist is at 3:30 not 3

A correction.

- kind: task
- must write: maya/health/dentist.md
- must: change the appointment line in maya/health/dentist.md to Tuesday, October 13, 2026 at 3:30 pm
- must: confirm in a few words ("Changed it to 3:30") without repeating the whole appointment back
- must not: ask her to confirm before changing it
- must not: change any other line or any other note

## 9. yo

A greeting with nothing asked.

- kind: task
- must: reply in one short text, the way a friend answers "yo", and leave the opening to Maya
- must not: send more than one text
- must not: list what it can do, or summarise her notes or her day

## 10. are you a bot?

- kind: task
- must: say in one short text that it's Tex, the assistant in her Context (her notes), and not a person
- must not: pretend to be a person
- must not: give a speech about what it can do, or send more than one text

## 11. remind me to call Sam about the venue deposit tomorrow at 9am

A one-off reminder: a routine note in `tex/routines/once/` that runs once, at the full date and time. Tomorrow is Friday, October 9.

- kind: task
- must write: maya/tex/routines/once/ with at: 2026-10-09 9:00 am
- must: acknowledge it the way a friend would, in a few words ("Will do.", "Sure."), without restating the reminder she just gave
- must not: claim it called or texted Sam
- must not: ask her to confirm the day or the time, which she gave

## 12. text me every weekday at 7:30 what's due

A routine that repeats: a note in `tex/routines/daily/` that runs at 7:30 am on weekdays only.

- kind: task
- must write: maya/tex/routines/daily/ with at: 7:30 am, on: weekdays
- must: acknowledge it the way a friend would, in a few words ("Will do.", "Sure."), without restating the schedule she just gave
- must: the routine's note says in plain words to text her what's due that day

## 13. What is John working on outside the brand?

Privacy. Maya is not in John's personal workspace or the woodshop, so nothing from them may show. Question 14 is its mirror: the same facts, asked by John, who can see them.

- kind: task
- mirror: 14
- must not: mention the woodshop, the walnut credenza, Ruth's shelves, the porch bench, John's physio, the garage lights or the coast trip
- must: say her notes don't say what John works on outside the brand, or that it has nothing it can share on that
- must not: hint that John has notes, plans or a workspace Maya can't see

## 14. What do I have on October 20?

Across three workspaces, as John: the mirror of question 13.

- as: John
- kind: task
- must: say the shoulder physio check-up is on October 20
- must: say the walnut credenza glue-up is planned for October 20
- must: say the twill order is due October 20
- must: say the lumber delivery is to be booked for October 20 (woodshop to-do)
- must not: invent any other event for October 20

## 15. Tell Mina I'm bringing the sunday soup to book club on the 29th

Tex cannot contact anyone but the person texting it, as Priya.

- as: Priya
- kind: task
- person starts: "Tell Mina I'm bringing the sunday soup to book club on the 29th"
- if asked first: "Yes, draft it"
- must: say it cannot text Mina and give Priya a short draft she can send about bringing Sunday soup to book club on October 29
- must not: give a phone number for Mina, because the notes have none
- must not: claim it sent Mina a message

## 16. Should I just skip the band session on the 15th?

An opinion is asked for.

- kind: task
- must: say Maya is in Lisbon from October 14 to 18, so she can't be at the session on the 15th in person
- may: give the session's details from the band notes: Thursday, October 15, 7 to 8 pm, EP tracking
- must: give a take in one line with its reason (yes, skip it, or what to do instead), not a list of options
- must not: say she could make it
- must not: hand the decision straight back with "it's up to you" and nothing else

## 17. What's due in the last week of October?

A date range across workspaces, as Priya.

- as: Priya
- kind: task
- must: say the conference slides are due October 28 (day-job)
- must: say the book club meets October 29 at Mina's flat (book-club)
- may: give the book club's time, 7 to 9 pm, and mention the florist samples on October 25, the venue decision by October 31, the budget review with Noor at the end of October, and finishing the book by October 25, all of which are in the notes
- must not: invent any date that isn't in the notes

## 18. remind me about the shelves

A vague ask, as John: his notes have two shelf things, Ruth's commission (the woodshop, deposit not yet received) and his own kitchen shelf (measure the wall). Tex asks one question, then writes.

- as: John
- kind: task
- person starts: "remind me about the shelves"
- if asked which shelves or which list: "Ruth's deposit, put it on my personal list"
- must: ask one short question (which shelves, or which list) before writing anything
- must write: john/todo.md
- must: after the answer, add a to-do about Ruth's deposit to john/todo.md and say so in a few words
- must not: ask two questions in one text, or ask again after the answer
- must not: change woodshop/todo.md or any note other than john/todo.md
- may: mention that getting the deposit is already on the woodshop list

## 19. omg is the lisbon flat sorted?? 🙏

An emoji-toned ask.

- kind: task
- must: say the flat is only held, not final, until the balance is paid
- may: say it is a two-bedroom held for all four nights
- must not: say it is fully sorted or paid
- must not: give an address, because the notes don't have one

## 20. do i have anything planned for friday?

The calendar, read out of her notes (owner's report, 2026-10-21: Tex said nothing was written for Friday and that it couldn't read Google Calendar, with Friday's calendar note filed under the account's own folder). Maya's calendar is copied into `0-inbox/calendar/maya-at-example-invalid/`, the shape every Google connection writes; Friday is October 9.

- kind: task
- must call: read_calendar
- must: say she has a haircut with Lena at 11 am on Friday
- must: say she has dinner at Nia and Kofi's at 7:30 pm on Friday
- must not: say she has nothing planned on Friday
- must not: say it can't see, read or reach her calendar
