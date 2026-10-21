---
job: texting-assistant
run_as: Kofi
today: 2026-10-21
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 1
web: scripted
good_enough:
  score: 100%
  voice: 80%
  price: under $0.05 a question
  speed: under 90 s
  texts: 4 or fewer
every_answer:
  friend: reads like texts from a capable friend, not a report; short, plain words, the answer first, with no Markdown, no preamble and no flattery
  machinery: never mentions searching, tools, workspaces or file paths, and never lists what it looked at
  ending: ends on at most one next step or one question, never both
---

# Meetings

Written from Dev2's report of 2026-10-21 ("this was infuriating"): asked for the to-dos from his last meeting with a colleague, Tex answered from an August meeting, then from an October 14 entry in a people note, and said there were no notes from yesterday's call, which was in his Context. When he pasted the note's link, Tex talked about the link's preview picture ("just a hashtag icon", "the Context banner"), asked three times whether to write the to-dos down, and put the receipts to-do on the wrong person.

They run as Kofi (`workspaces/people.md`), on Wednesday, October 21, 2026. His personal workspace has an August 21 meeting with Ada in `0-inbox/meetings/`, a people note about Ada whose call notes stop at October 14, and his calendar for October 20 with "Ada / Kofi" at 6:15 pm. Yesterday's call is in the studio workspace, at `meetings/1-1s/ada-kofi/untitled-2026-10-20.md`, with a placeholder name and no front matter. Its action items: Ada has the phone line's receipts sent to her; Kofi removes the review-before-publishing rule and publishes the October financials once the credits renew tonight.

`runs: 1` keeps a screen cheap; use 3 runs only to check a promotion. Run it with the Action's `test: meetings`. Every case is a gate: these are the failures Dev2 hit.

## 1. What are some of the things I need to do based on my last meeting with Ada?

The last meeting is yesterday's, filed in the studio workspace.

- kind: task
- must: give Kofi's to-dos from the October 20 call: remove the rule that someone else reviews the financials before they're published, and publish the October financials once the credits renew tonight
- may: mention that Ada is having the phone line's receipts sent to her
- must not: give the August 21 walkthrough's or the October 14 call's items as the last meeting's
- must not: say there are no notes from the October 20 call

## 2. We just had a meeting yesterday? What did we agree about the phone line receipts?

Who owns a to-do comes from the note's action items, not a guess from a garbled transcript.

- kind: task
- must: say the phone line's receipts go to Ada from now on
- may: say the recurring charge stays on Kofi's card
- must not: say the receipts go to Kofi

## 3. https://app.bench.invalid/note/@studio/meetings/1-1s/ada-kofi/untitled-2026-10-20.md what are my to-dos from this

A link to one of their notes is the note, read with their own tools.

- kind: task
- must: give Kofi's to-dos from that note: remove the review-before-publishing rule, and publish the October financials once the credits renew tonight
- must not: mention a picture, a preview, a banner, an icon or a web page
- must not: ask whether to open or read the link

## 4. put my to-dos from yesterday's call with Ada on my list

When they ask, Tex writes them down without asking again.

- kind: task
- must write: kofi/todo.md
- must: say in a few words that they're added
- must not: ask whether to add them, or where
- must not: add Ada's receipts item as Kofi's to-do
