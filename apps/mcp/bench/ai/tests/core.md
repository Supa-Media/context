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

Decided by the owner on 2026-10-14: "we have like sixty questions, we probably need to reduce it to twenty golden task questions or ten for now and see if we could do some basic things." These are the basics Tex must do, fifteen of them, and every one is a gate. It is the texting assistant's default test (`pnpm ai run texting-assistant`, and the Action with `test` left empty); the long sets, `texting-assistant.md` (59 questions) and `tasks.md` (the golden tasks), stay as they are for a full round (`--test texting-assistant`, `--test tasks`).

Every question is `kind: task`, which makes it a gate: a failed must or must-not line, a failed check, or an unanswered run fails the setup. Judge lines and the `every_answer` lines grade nothing; the share of `every_answer` lines passed is the setup's voice, held to the `voice` bar.

Most questions are copied from the long sets with their wording, the person asking and their lines, so a result here reads against the same question there: 1 is `texting-assistant.md` 1, 2 is 9, 3 is 16, 4 is 21, 5 is 59, 6 is 30, 7 is 33, 8 is 57, 9 is 51, 10 is 58; 11 is `tasks.md` 5, 12 is task 1, 13 is task 3. Question 10 names Tex since the owner named the assistant (2026-10-14). Questions 14 and 15 are new: a reminder is a routine note, acknowledged the way a friend would ("Will do.", the owner, 2026-10-14, after Tex restated a whole reminder back) (`docs/decisions/routines.md`), and a one-off reminder is a note in `tex/routines/once/` whose `at:` names the full date and time (new routines go in Tex's own `tex/` folder, the owner, 2026-10-14).

Today is Thursday, October 8, 2026, the long set's day, so "Friday" is October 9 and "tomorrow" is October 9 too. The web is scripted (`web: scripted`, `bench/sites.mjs`): every site lives in `sites/` and nothing reaches the real web. Lines like `must call`, `must reach` and `must write` are checked from the run's own record (`bench/checks.mjs`), never by the judge. `must write: <workspace>/<path>` is a note the answer wrote there (under a folder when the path ends in `/`), and `with key: value, ...` names front matter it must carry, read the way `packages/shared/src/routines.cjs` reads a routine.

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
- must: say the notes don't give the address, only that it is a two-bedroom flat held for all four nights
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

## 11. Find me the cheapest flight from Lisbon to London on November 14

A lookup on the web.

- kind: task
- person starts: "find me the cheapest flight from lisbon to london on nov 14 on harborair.example"
- if asked whether to book it: "No, just tell me"
- must reach: harborair.example/results
- must not set: started booking
- must: say the cheapest is HA 219, leaving at 19:30, for 71 euros
- must not: say it booked or started booking a flight
- must not: say it cannot browse websites

## 12. Can you make sure my ChatGPT is properly set up to use Context?

Maya's ChatGPT has never been connected.

- kind: task
- person starts: "can you make sure my chatgpt is properly set up to use context"
- if asked to sign in, open a link, or take over the browser: "Done, I'm signed in"
- if asked whether to go ahead: "Yes, go ahead"
- if asked which plan she has: "Plus"
- must call: read_skill
- must reach: chatgpt.com/plugins
- must hand off: chatgpt.com
- must type: https://mcp.context.lc/mcp
- must choose: Authentication: OAuth
- must set: connected chatgpt
- must not call: vault_add_link
- must: end by telling Maya that ChatGPT is now connected to Context
- must not: ask Maya for a password or a sign-in code in a text
- must not: say it cannot use the browser, or cannot use ChatGPT without a saved login

## 13. Save my Streamly login so you can sign in for me

- kind: task
- person starts: "can you save my streamly login so you can sign in for me next time"
- must call: vault_add_link
- must: send Maya a link to save the login herself
- must: say the link is private to her and expires after 30 minutes
- must not: ask Maya to text her password or username
- must not: claim the login is already saved

## 14. remind me to call Sam about the venue deposit tomorrow at 9am

A one-off reminder: a routine note in `tex/routines/once/` that runs once, at the full date and time. Tomorrow is Friday, October 9.

- kind: task
- must write: maya/tex/routines/once/ with at: 2026-10-09 9:00 am
- must: acknowledge it the way a friend would, in a few words ("Will do.", "Sure."), without restating the reminder she just gave
- must not: claim it called or texted Sam
- must not: ask her to confirm the day or the time, which she gave

## 15. text me every weekday at 7:30 what's due

A routine that repeats: a note in `tex/routines/daily/` that runs at 7:30 am on weekdays only.

- kind: task
- must write: maya/tex/routines/daily/ with at: 7:30 am, on: weekdays
- must: acknowledge it the way a friend would, in a few words ("Will do.", "Sure."), without restating the schedule she just gave
- must: the routine's note says in plain words to text Maya what's due that day
