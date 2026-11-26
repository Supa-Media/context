---
job: texting-assistant
run_as: Lena
today: 2026-11-12
judge: claude-haiku-5-5
played_by: claude-haiku-5-5
runs: 3
web: scripted
gmail: sends
calendar: connected
groups: supper-club
person_brief: lines
good_enough:
  score: 80%
  price: under $0.10 a question
  speed: under 90 s
  texts: 4 or fewer
every_answer:
  friend: reads like texts from a capable friend, not a report; short, plain words, the answer first, with no Markdown and no preamble
  proof: never says it sent, saved, added, moved or set something its tools did not do
---

# Everyday tasks

Asked for by the owner on 2026-11-26, after weighing public agent benchmarks (tau2-bench's airline and retail tasks, AppWorld, BFCL) and finding none tests what people actually text Tex for. This is tau2-bench's shape on Tex's own work: a simulated person texts, Tex works with its real tools in an invented world, and each task is graded on the state it leaves (the email in the right thread, the calendar change, the reminder written), read from the run's record (`bench/checks.mjs`), with the judge only for what code can't see. Every task runs three times and passes only when all three pass (pass^3), because a task Tex gets right two times in three is one people can't rely on.

The asks are drawn from the self-reviews of real conversations (`@context-lc areas/tex-reviews/`, October 24 to November 26: research, notes, email, reminders, calendar and messaging are most of what people ask), never copied: every name, place, address and number here is invented. Group-chat asks are in `everyday-groups.md`.

The world is Lena's (`workspaces/lena/`, `workspaces/people.md`): Thursday, November 12, 2026, in Riverside. Her Gmail (connected, and it may send) holds a Puttery booking to answer in its thread, her landlord's question about the plumber (Monday 10 am or 2 pm, and she has the dentist at 10), a CloudNine statement, Ines's housewarming invite and a newsletter. Her calendar (connected) holds November 12 to 16: a standup with Ines and the gym today, dinner with Omar on Friday (with Omar as a guest), Puttery on Saturday, and the dentist on Monday. An email or a calendar change Omar or anyone else sees waits for her yes, and the bench says yes the moment Tex asks (`run.mjs` `personAnswers`), unless a case plays her answers (`- person answers asks`). She is also in the supper club's group chat (`groups: supper-club`, `everyday-groups.md`), so her own chat can ask Tex there (`ask_chat`, `bench/crossWorld.mjs`).

Hardened on 2026-11-26 after the owner asked whether these were "trust me bro benchmarks": the person played by the bench reads only a case's person-facing lines (`person_brief: lines`, `bench/load.mjs` `personBrief`), never its prose or a must line, so it can't hint at the answer; every name, number, date, time, recipient, thread and saved text is checked in code (`must say`, `containing`, `bench/checks.mjs`), and the judge keeps only what code can't see.

## 1. Email Puttery in the thread asking if we can bring a cake on Saturday

The ask in the owner's screenshot of 2026-11-26. The booking email is the thread; a new email to Puttery would land outside it.

- kind: task
- person starts: "can you email puttery in the thread asking if we can bring a cake on saturday"
- must send email: events@puttery.example replying to 19b2putt0001 containing cake
- must not email: lena@example.invalid
- must not: ask Lena for Puttery's address or which email she means

## 2. Tell my landlord which plumber slot works

Monday 10 am clashes with the dentist, so the answer is 2 pm, found by reading her calendar before replying.

- kind: task
- person starts: "reply to my landlord about the plumber, pick whichever slot works with my calendar"
- must call: read_calendar
- must send email: martin.kell@example.invalid replying to 19b2land0002 containing 2 pm | 2pm | 2:00 | 14:00 | 2 o'clock
- must say: 2 pm | 2pm | 2:00 | 14:00 | 2 o'clock
- must not: pick 10 am

## 3. Forward the CloudNine statement to the accountant

- kind: task
- person starts: "forward my cloudnine october statement to accounts@ledgerly.example"
- must forward: 19b2invo0003
- must send email: accounts@ledgerly.example
- must not: ask Lena to forward it herself

## 4. Put Ines's housewarming on my calendar

- kind: task
- person starts: "put ines's housewarming on my calendar"
- must calendar: add "housewarming" at 2026-11-20 20:00
- must say: november 20 | nov 20 | 20th | 11/20 | friday
- must say: 8 pm | 8pm | 8:00 | 20:00
- must not: ask Lena for the date or time

## 5. Move dinner with Omar to 8

Omar is a guest, so Google would tell him: this waits for her yes, and the bench gives it.

- kind: task
- person starts: "move dinner with omar tomorrow to 8pm"
- must calendar: move "dinner with omar" to 2026-11-13 20:00
- must not calendar: move "gym"

## 6. Two changes in one text

From the reviews' "partial work" family: an ask with two parts gets both done.

- kind: task
- person starts: "push gym tonight to 7 and add a haircut friday at 10am"
- must calendar: move "gym" to 2026-11-12 19:00
- must calendar: add "haircut" at 2026-11-13 10:00

## 7. What's on Monday

- kind: task
- person starts: "what's on my calendar monday?"
- must call: read_calendar
- must say: dentist
- must say: 10 am | 10am | 10:00
- must not: say it can't see or reach her calendar

## 8. A reminder with two things in it

- kind: task
- person starts: "remind me at 2:30 to grab the envelopes and the keys"
- must write: lena/tex/routines/once/ with at: 2026-11-12 2:30 pm
- must write: lena/tex/routines/once/ containing envelope
- must write: lena/tex/routines/once/ containing key
- must: confirm in a few words

## 9. Two reminders in one text

- kind: task
- person starts: "remind me to call mum at 6 and to take the bins out at 9 tonight"
- must write: lena/tex/routines/once/ with at: 2026-11-12 6:00 pm
- must write: lena/tex/routines/once/ with at: 2026-11-12 9:00 pm

## 10. Add my words to a note, word for word

From the reviews' notes family: people want their words saved as they wrote them, where they said, with nothing added.

- kind: task
- person starts: "add this under day 2 in my spanish notes, word for word: ser is for what something is, estar is for how it is"
- must write: lena/study/spanish.md containing ser is for what something is, estar is for how it is
- must: put her words under Day 2 in study/spanish.md
- must not: add a heading, summary or section she didn't ask for

## 11. Recall a fact from the notes

- kind: task
- person starts: "what's omar's sister called again"
- must say: leila
- must not: say it has no record or ask Lena to tell it

## 12. Add up what I pasted

From the reviews' "make sense of data I pasted" family, where totals came back wrong.

- kind: task
- person starts: "coffee 4.50, lunch 12.75, cab 18.20, groceries 41.35. what's the total"
- must say: 76.80 | 76.8
- must not: give any other total

## 13. Brunch spots open on Sunday, with prices

From the reviews' most common ask, looking things up: Tex stopped at one result, guessed hours and prices, or listed a place that was closed. Every place's hours and prices are only on its own page (`sites/brunch.example.md`).

- kind: task
- person starts: "find me brunch spots in riverside open this sunday, with rough prices. try brunch.example"
- must reach: brunch.example/the-pantry
- must reach: brunch.example/juniper
- must reach: brunch.example/bakehouse
- must say: pantry
- must say: juniper
- must say: bakehouse
- must: give a rough price for each place it names
- must not: list Eggshell as open on Sunday

## 14. Anything in my email I need to deal with?

From the reviews' recap family, where deadlines were stated without a source.

- kind: task
- person starts: "anything in my email i need to deal with this week?"
- must say: plumber
- must say: housewarming
- must not: name a deadline or a task no email gives
- may: mention the Puttery booking on Saturday

## 15. Draft it, don't send it

She asks for a draft and says not to send it: a yes to anything else is not a yes to send. The case plays her answers to Tex's asks (`- person answers asks`).

- kind: task
- person answers asks
- person starts: "draft an email to ines saying i can make the housewarming and i'll bring wine. don't send it yet, i want to read it first"
- if asked whether to send it: "no, not yet"
- must email: ines@example.invalid containing wine
- must not send email: ines@example.invalid
- must: say the draft is saved and not sent

## 16. Check what the group chat said about dinner

From real group failures (the owner, 2026-11-26): asked about another chat, Tex said to go and ask there instead of asking itself. Omar said the time only in the supper club chat: no note has it, so the 1:1 asks Tex there (`ask_chat`; a group can't ask a personal chat since 2026-11-26, so this ask starts in Lena's own chat).

- kind: task
- earlier in supper-club @omar: "sunday's at mine, starting 7:30 not 7, and bring your own drinks"
- person starts: "can you check what the supper club chat said about dinner sunday? what time is it"
- must call: ask_chat
- must say: 7:30
- must not: tell Lena to look in the group chat or ask there herself
- must not: give a time before the supper club chat's answer came back
