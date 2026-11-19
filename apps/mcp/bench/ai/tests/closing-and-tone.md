---
job: texting-assistant
run_as: Maya
today: 2026-11-19
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 1
web: scripted
good_enough:
  score: 100%
  voice: 80%
  price: under $0.10 a question
  speed: under 90 s
  texts: 3 or fewer
every_answer:
  friend: reads like texts from a capable friend, not a report; short, plain words, the answer first, with no Markdown and no preamble
---

# Closing, tone and asking only what blocks

From a Training run (v57vn7ws, 2026-11-19): Tex asked open questions where it could have proposed an answer, asked about things the chat had already settled, padded a rewrite with commentary, and re-asked about asks it was closing. The rules (`packages/shared/src/texPrompt/how-you-talk.md`): ask only what blocks the thing; suggest a sensible answer and ask if that's it; a rewrite is just the new version; words for someone else need the person's own specifics first, never made up. Invented people and words.

## 1. Make it less stiff

- drafted: Claude (2026-11-19)
- kind: task
- person starts: "make this less stiff: Dear Sam, I am writing to confirm our meeting on Thursday at 3 pm. Please let me know at your earliest convenience whether this time remains suitable for you. Best regards, Maya"
- if asked anything: "just rewrite it"
- must: give a rewritten version that is shorter or about as long as the original and more casual
- must not: add a comment on what was wrong with the original
- must not: put a label or heading in front of the new version, or add a paragraph that was not in the original

## 2. A text for someone else, with the person's own specifics missing

- drafted: Claude (2026-11-19)
- kind: task
- person starts: "draft a text to my neighbor Ines asking if she can water my plants while i'm away"
- if asked which days, or when she is away: "thursday to sunday"
- if asked how often, or anything else: "every other day is fine"
- must: before writing the text, ask which days she is away (at most two short questions in one text), or write it with only details she gave
- must not: invent dates, times or details she did not give
- must not: write the text as a list of questions to Ines about things Maya could have said herself

## 3. Suggest the bar instead of asking an open question

- drafted: Claude (2026-11-19)
- kind: task
- person starts: "the new studio helper starts monday. what should she have to show by the end of her first month to stay on? lets figure it out"
- if asked what the job is: "loading and unloading the kiln, mixing glazes, keeping the shelves tidy"
- if asked anything else: "you tell me"
- must: propose a concrete bar of its own (two to four things she should be able to do) and ask whether that is it
- must not: answer with only an open question back to Maya
