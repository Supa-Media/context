---
job: texting-assistant
run_as: Maya
today: 2026-10-08
time_zone: America/New_York
calendar: connected
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 3
web: scripted
good_enough:
  score: 100%
  price: under $0.08 a question
  speed: under 90 s
  texts: 4 or fewer
---

# Front door completion bench

Asked for by the owner on 2026-11-26: the Front door's (`fd`) top failures in live self-reviews are `incomplete` (half an ask done, or deferred with "want me to…") and `cant_first` (saying it can't, or punting, with the tools to do it), across calendar, email, notes and files, and the Lab's sealed Test Set has no `fd` unit tests. Each case here is one invented ask Tex must finish in one pass. Every scenario, name and place is invented; nothing comes from a real chat.

Every line ends with the metrics it measures (`[metrics: …]`, `bench/metrics.mjs`), the Area 1 ids of `@supa projects/tex-quality/eval-metrics.md`: `task_completion_rate`, `cant_first_rate`, `unnecessary_handback_rate`, `write_and_confirm_accuracy`, `tool_attempt_before_punt_rate` and `turns_to_resolution_clean`. The tag is taken off before the line is judged or checked, and `pnpm ai score` prints each metric's rate under the scores. A "higher" metric counts a run when every line tagged with it passed; a "lower" one (target 0%) counts a run when any line tagged with it failed.

Every case is `kind: task`, a gate. The `must call`, `must reach` and `must write` lines are checked from the run's record (`bench/checks.mjs`), never by the judge; the rest are the judge's. Today is Thursday, October 8, 2026, so "tomorrow" and "Friday" are October 9. Maya's calendar (`workspaces/maya/0-inbox/calendar/`) has Haircut with Lena at 11 am to noon and Dinner at Nia and Kofi's at 7:30 pm on Friday, neither with guests, so a move changes at once with no yes to ask for (`bench/calendar.mjs`). Her Gmail has Corner Studio's email asking her to say by Friday whether she keeps her Saturday 10am mat class (`workspaces/maya/gmail/2026-10-06-corner-studio-spot.md`); her notes never mention the class. The Eastside Runners folder is on the scripted `sites/filebox.example.md`, open to anyone with the address. The repo copy is the only one: no `@context-lc ai/tests/fd-completion.md` exists, so `pnpm ai pull` leaves it as it is.

## 1. Push my haircut to 1 (calendar lookup and move, not cant_first)

- kind: task
- person starts: "what time is my haircut tomorrow? can you push it to 1"
- if asked whether to move it, or to confirm the new time: "yes, 1 to 2"
- must call: calendar_event [metrics: task_completion_rate, cant_first_rate, write_and_confirm_accuracy]
- must: say the haircut with Lena was at 11 am tomorrow, Friday, October 9 [metrics: task_completion_rate]
- must: say it moved the haircut to 1 pm (to 2 pm) tomorrow [metrics: task_completion_rate, write_and_confirm_accuracy]
- must not: say it can't change her calendar, or that only she can [metrics: cant_first_rate]
- must not: tell Maya to move the event herself, in Google Calendar or anywhere else [metrics: unnecessary_handback_rate]
- must not: ask whether to move it, or to confirm the time, before moving it [metrics: turns_to_resolution_clean]
- must not: end with "let me know if you need anything else" or another offer of more help [metrics: turns_to_resolution_clean]

## 2. Draft a reply to Corner Studio (email lookup and draft, not a hand-back)

- kind: task
- person starts: "can you draft a reply to corner studio's email saying i'll keep my saturday spot? i'll send it myself"
- must call: search_email [metrics: task_completion_rate]
- must call: save_email_draft [metrics: task_completion_rate, cant_first_rate, write_and_confirm_accuracy]
- must: say the reply to Corner Studio is saved as a draft in her Gmail, and that it says she's keeping the Saturday 10am class [metrics: task_completion_rate, write_and_confirm_accuracy]
- may: show the draft's words, or say she can send it from her drafts
- must not: say it can't write or draft emails [metrics: cant_first_rate]
- must not: give Maya words to copy and paste into an email herself instead of saving the draft [metrics: unnecessary_handback_rate]
- must not: ask her to find the email, or to forward it to Tex [metrics: unnecessary_handback_rate]
- must not: ask what the reply should say before drafting it [metrics: turns_to_resolution_clean]

## 3. Our flight home moved (a note correction, not an appended line)

- kind: task
- person starts: "our lisbon flight home moved, we now leave on the 18th at 6:40 pm, not the morning"
- must write: maya/trips/lisbon.md [metrics: task_completion_rate, write_and_confirm_accuracy]
- must not write: maya/todo.md [metrics: write_and_confirm_accuracy]
- must: change the flights line in maya/trips/lisbon.md so it says they leave October 18 at 6:40 pm, and leave no line saying they leave in the morning [metrics: task_completion_rate, write_and_confirm_accuracy]
- must: say in a few words what it changed in the Lisbon note [metrics: write_and_confirm_accuracy]
- must not: add a second flights line beside the old one, so the note says both times [metrics: write_and_confirm_accuracy]
- must not: ask whether to update the note before updating it [metrics: turns_to_resolution_clean]
- must not: end with "let me know if you need anything else" or another offer of more help [metrics: turns_to_resolution_clean]

## 4. Send me the October route map (carry-on: open, link, save, confirm)

The direct half of `tests/carry-on.md` case 1: Maya names the folder in her first text, so the whole task is Tex's at once.

- kind: task
- person starts: "the run club's route maps are on filebox.example, in the eastside runners folder under routes. send me the october one and keep a note of where they live"
- if asked whether to open the folder, send the link or save where they live: "yes"
- must reach: filebox.example/eastside-runners/routes [metrics: task_completion_rate, cant_first_rate]
- must write: maya/ [metrics: task_completion_rate, write_and_confirm_accuracy]
- must: give the link https://filebox.example/eastside-runners/routes/october-route-map.pdf [metrics: task_completion_rate]
- must: say it saved where the route maps live in her notes [metrics: write_and_confirm_accuracy]
- must not: answer with only a thanks or an acknowledgement [metrics: task_completion_rate, cant_first_rate]
- must not: ask Maya to open the folder, or find or download the file herself [metrics: unnecessary_handback_rate]
- must not: offer to open the folder, fetch the file or save the location instead of doing it [metrics: cant_first_rate, turns_to_resolution_clean]

## 5. Do I need to do anything about Saturday's class? (the next source before "I don't know")

Her notes say nothing about a Saturday class and her calendar has only Thursday's Pilates at Corner Studio; the ask is in Corner Studio's email.

- kind: task
- person starts: "do i need to do anything about my saturday class at corner studio?"
- must call: search_email [metrics: tool_attempt_before_punt_rate]
- must: say Corner Studio asked her to reply by Friday, October 9, saying whether she keeps her Saturday 10am mat class spot, or it goes to the waitlist [metrics: task_completion_rate, tool_attempt_before_punt_rate]
- may: offer to draft or send the reply
- must not: say her notes or calendar don't mention it and stop there [metrics: cant_first_rate, tool_attempt_before_punt_rate]
- must not: tell Maya to check her email or ask the studio herself [metrics: unnecessary_handback_rate]

## 6. Oat milk, Friday and a reminder (three parts in one pass)

- kind: task
- person starts: "put oat milk on my list, what's on friday, and remind me tomorrow at 9 to call the plumber"
- must write: maya/todo.md [metrics: task_completion_rate, write_and_confirm_accuracy]
- must write: maya/tex/routines/once/ with at: 2026-10-09 9:00 am [metrics: task_completion_rate, write_and_confirm_accuracy]
- must: say oat milk is on her list [metrics: write_and_confirm_accuracy]
- must: give Friday's haircut with Lena at 11 am and dinner at Nia and Kofi's at 7:30 pm [metrics: task_completion_rate]
- must: say it will remind her tomorrow at 9 am to call the plumber [metrics: write_and_confirm_accuracy]
- must not: answer only one or two of the three asks, or leave one for a later text [metrics: task_completion_rate]
- must not: ask which list to use, or whether to set the reminder, before doing it [metrics: turns_to_resolution_clean]
- must not: end with "let me know if you need anything else" or another offer of more help [metrics: turns_to_resolution_clean]
