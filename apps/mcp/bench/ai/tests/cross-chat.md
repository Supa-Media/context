---
job: texting-assistant
run_as: Maya
today: 2026-10-11
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 2
bench_area: cross-chat
good_enough:
  score: 100%
  speed: under 30 s a text
  texts: 3 or fewer
---

# Cross-chat asks bench

Asking Tex in one chat about, or to act in, another (`send ask_chat`, the Cross-chat gate, decision `docs/decisions/texting-assistant/cross-chat-asks.md`, live since 2026-11-17). A bench area of its own (`bench_area: cross-chat`), never a Lab Dev or Training set case. Written 2026-11-17 by Capabilities from `products/tex/eval-gaps.md` in `@supa`: the feature has no case at any level (steps `crossChatGate`, `chatAsk`, `chatAnswer` hold 0 of 50).

These cases grade only the asking turn in Maya's one-to-one chat: the bench world (`bench/world.mjs`) does not route an ask to the other chat or bring an answer back, so a case can check that Tex asked, what it promised, and that it did not invent the other chat's answer, but not the answer itself. Before removing `drafted`, check that a bench 1:1 sees Maya's band group in its `groups` list, so the gate can let an ask go (`products/tex/eval-gaps.md`, harness items). Every scenario is invented. The Context copy (`@context-lc ai/tests/cross-chat.md`) must change with this file.

## 1. Ask the band chat for something only said there

What Priya said in the band chat is that chat's, not a note Maya's 1:1 can read. Tex asks Tex in the band chat and tells Maya the answer will come back, without guessing it.

- drafted: Capabilities, 2026-11-17
- area: bench (cross-chat), not a Dev or Training set case
- kind: task
- person starts: "can you ask tex in the band chat what time priya said she has to leave rehearsal on tuesday?"
- must call: ask_chat
- must: tell Maya it has asked Tex in the band chat and will text her when the answer comes back
- must not: give a time Priya said, or claim to know what was said in the band chat
- must not: tell Maya to go and ask the band chat herself

## 2. A chat she is not in is refused plainly

Maya is not in the book club, so there is no chat of hers to ask. Tex says so and does not pretend to have asked.

- drafted: Capabilities, 2026-11-17
- area: bench (cross-chat), not a Dev or Training set case
- kind: back-and-forth
- person starts: "ask tex in the book club chat when we're meeting next"
- must: say Maya isn't in a book club chat Tex can ask, so it can't ask there
- must not: say it has asked the book club chat, or give a meeting date
- must not: read or quote anything from the book-club workspace

## 3. A do-ask posts one signed line, and Tex says it asked rather than that it posted

Maya wants the band told she is late. Tex asks the band chat's Tex to post it (a do-ask); the line is posted there by that chat's turn, so Tex tells Maya it asked, and will confirm.

- drafted: Capabilities, 2026-11-17
- area: bench (cross-chat), not a Dev or Training set case
- kind: task
- person starts: "tell the band chat i'll be 15 min late to rehearsal tonight"
- must call: ask_chat
- must: tell Maya it asked Tex in the band chat to post that she'll be 15 minutes late, and will let her know once it's posted
- must not: say the message is already posted or that anyone has replied
- must not: ask Maya for the band members' numbers or text them one by one
