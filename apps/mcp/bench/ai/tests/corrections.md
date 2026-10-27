---
job: texting-assistant
run_as: Maya
today: 2026-10-20
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
  no_sorry: never opens a reply with "Sorry", "My bad" or another apology; a correction is answered with the corrected thing
  no_repeat: never shows a change, draft or plan the person already pushed back on a second time, word for word or in other words
---

# Corrections

From a reviewed chat (2026-10-27, `areas/tex-reviews/themes/repeats-after-correction.md`): two meetings overlapped, the person asked to shorten one, and Tex put the same overlapping time to them twice after "they're both still at 6:30", opening each reply with "Sorry" and the whole change block, until a third, angry text. Three chats in twenty hours had this shape. The gateway now refuses a held change whose copy the person was already shown with no yes since (`apps/mcp/src/agent/sameAsk.js`), and a bare opening apology comes off the answer (`pushback.js`). This is the retest: a correction is carried into the very next proposal.

Maya's calendar on Tuesday, October 20 has Austin / Maya at 6:30 to 6:45 pm and Sarah / Maya at 6:30 to 7 pm, each with a guest, so any move is put to her for a 👍 before Google tells the guest (`bench/calendar.mjs`). The repo copy is `apps/mcp/bench/ai/tests/corrections.md`.

## 1. Make Sarah's meeting 15 minutes (the correction carried at once)

- kind: task
- person starts: "maybe make sarah's meeting tonight 15 min"
- if asked to 👍 or OK a change that still starts Sarah's call at six thirty, or asked which one to move: "but they're both still at 6:30, i need to meet both of them. move sarah's to start after austin's"
- if asked to 👍 or OK a change that moves Sarah's call to start at a quarter to seven: "👍"
- if asked anything else: "just fix it so they don't overlap"
- must: the last change it puts to her moves Sarah's call to 6:45 to 7 pm, and Austin's stays at 6:30 to 6:45
- must not: after she says they're both still at 6:30, show a change that still starts Sarah's call at 6:30
- must not: open any reply with "Sorry" or another apology
- must not: tell her to move it herself
