---
job: texting-assistant
run_as: Maya
today: 2026-10-08
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 2
web: scripted
bench_area: pictures
good_enough:
  score: 100%
  speed: under 90 s a text
  texts: 4 or fewer
---

# Pictures bench

Asked for a picture, Tex makes one and texts it, and asked for a fact, it does not (`capabilities.js`, Pictures and cards; `pictureMaker.js`). A bench area of its own (`bench_area: pictures`), never a Lab Dev or Training set case. Written 2026-11-17 by Capabilities: the Lab `picture` step had 0 bench cases. Every scenario is invented; none is a person's conversation. The one site is `sites/lunch.example.md`.

Tex has three picture tools, each a `send` action that runs as a tool of the same name (`sixTools.js` `ASSISTANT_SEND_ACTIONS`): `make_picture` generates or edits a photo with an image model, `draw_picture` photographs an HTML graphic Tex writes, and `draw_visual` turns an answer into one of its designed cards (a plan, a board, a chart). `must call` and `must not call` are graded from the run's record (`bench/checks.mjs`), never by the judge, and match the tool that ran: `must call: send` sees none of the three. `must call` cannot count calls, read a call's arguments, or see the picture, so "a second picture" and "what the picture shows" are judged lines.

Before removing `drafted`: the bench stands in a blank picture for a drawn card (`bench/sites.mjs`, `/render`), but nothing in `bench/` answers the image model, so check that a bench turn is offered `make_picture` and that its call does not fail (a failed call does not satisfy `must call`). The Context copy (`@context-lc ai/tests/pictures.md`) must change with this file.

## 1. A picture asked for is made, not described

Maya wants a mascot for her office lunch club. A scene with an animal in it is a photo-style picture, so it is the image model's (`make_picture`), not an HTML graphic. Tex makes it first and guesses what she left out.

- drafted: Capabilities, 2026-11-17
- area: bench (pictures), not a Dev or Training set case
- kind: task
- person starts: "make me a picture for our office lunch club: a corgi in a chef's hat carrying a lunch tray"
- must call: make_picture
- must: text her the picture it made, with at most one short line
- must not: answer with only a description of a picture, or a prompt for her to paste into another app
- must not: ask what style, size or colours she wants before making one
- must not: tell her it can't make pictures

## 2. A simple process comes back as a drawn diagram

Three steps in a row are a plan, which is one of Tex's designed cards. `must call: draw_visual` is the tool the trace records.

- drafted: Capabilities, 2026-11-17
- area: bench (pictures), not a Dev or Training set case
- kind: task
- person starts: "can you show me as a diagram how our lunch order works? i collect orders by 10, phone them in by 10:30, pick up at noon"
- must call: draw_visual
- must: send a drawn diagram that shows the three steps in order: orders collected by 10, phoned in by 10:30, picked up at noon
- must not: answer with only a numbered list or a paragraph in the chat
- must not: add steps or times she did not give
- must not call: make_picture

## 3. A quick price is a text, never a picture

One figure from the scripted lunch guide. A short fact is answered in the text: no card, no graphic, no photo.

- drafted: Capabilities, 2026-11-17
- area: bench (pictures), not a Dev or Training set case
- kind: task
- person starts: "quick q, how much is a banh mi at pho corner? it's on lunch.example"
- must: say $9 in the text
- must not: send a picture, a card or a page link
- must not call: draw_visual
- must not call: draw_picture
- must not call: make_picture

## 4. A change to the picture it just made is made by Tex

Maya asks for a picture, then asks for one change. The image model keeps nothing between calls, so Tex hands it the last picture (`last-picture`, `pictureMaker.js`) and sends the changed one. `must call` passes on the first picture alone, so the second picture is a judged line.

- drafted: Capabilities, 2026-11-17
- area: bench (pictures), not a Dev or Training set case
- kind: back-and-forth
- person starts: "make a picture of a red bicycle leaning on a bakery window, for my sister's birthday card"
- if asked anything, or sent a picture, before she has asked for the change: "love it. can you make the bike yellow and keep everything else the same"
- if asked anything else: "that's the one, thanks"
- must call: make_picture
- must: after she asks for the yellow bike, send a second picture with that change made
- must not: tell her to edit the picture herself, or in another app
- must not: ask her to describe the picture again or send it back
- must not: say the bike is yellow now without sending a new picture
