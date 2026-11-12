---
job: texting-assistant
run_as: Maya
today: 2026-10-08
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 2
web: scripted
good_enough:
  score: 100%
  price: under $0.05 a question
  speed: under 5 s
  texts: 1
every_answer:
  short: one short text, the answer first, with no Markdown and no preamble
---

# Simple asks

Added on 2026-11-11 for one-judge PR 3 (Dev2: "a simple ask gets its first reply in under 5 s"). The Instinct test measured 12 to 38 s for asks like these. Each is answered from what Tex already knows, with no tool and no page, so its time is the gates around the answer and one model round.

Questions 1 to 5 are the speed bar: their median time must be under 5 s. Question 6 reads one of Maya's notes, so it is a lookup and is reported apart from the bar; one notes search adds a model round.

## 1. what's 17 times 23

- kind: task
- person starts: "what's 17 times 23"
- must: say 391
- must not: send more than one text

## 2. Capital of Australia

- kind: task
- person starts: "quick one, what's the capital of australia"
- must: say Canberra
- must not: send more than one text

## 3. thanks

- kind: task
- person starts: "thanks!"
- must: reply in a few words, the way a friend takes thanks
- must not: send more than one text, or offer a list of what it can do

## 4. yo

- kind: task
- person starts: "yo"
- must: reply in one short text and leave the opening to Maya
- must not: send more than one text

## 5. How many days in a leap year

- kind: task
- person starts: "how many days in a leap year again"
- must: say 366
- must not: send more than one text

## 6. When's my dentist appointment?

- kind: task
- person starts: "when's my dentist appointment?"
- must: say Tuesday, October 13 at 3 pm
- must not: send more than one text
