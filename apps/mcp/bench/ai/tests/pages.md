---
job: texting-assistant
run_as: Maya
today: 2026-10-08
judge: claude-haiku-5-5
played_by: claude-sonnet-5-5
runs: 2
web: scripted
bench_area: pages
good_enough:
  score: 100%
  speed: under 90 s a text
  texts: 4 or fewer
---

# Pages bench

Web and research work comes back as a designed page (a `.page.md` note) with one short chat line, and a page is never sent without a picture or a Tex drawing (`capabilities.js`, Pages; `draw_visual` in PR #3532). A bench area of its own (`bench_area: pages`), never a Lab Dev or Training set case. Written 2026-11-17 by Capabilities for eval gap 4 in `products/tex/eval-gaps.md` at `@supa`: nothing measured page form, and the Lab `picture` step had 0 cases. Every scenario is invented. The sites are `sites/caterers.example.md`, `sites/lunch.example.md` and `sites/orders.example.md`. None of them carries a photo.

`must call` and `must write` are graded from the run's record (`bench/checks.mjs`), never by the judge. `must call` matches the tool that ran. `send` with action `draw_visual` runs as the tool `draw_visual` (`sixTools.js` `ASSISTANT_SEND_ACTIONS`), so `must call: draw_visual` is that drawing. `must call: send` does not see it, and `must call` cannot name the template (`page`) or require the drawing to have been saved onto the note. `must write` matches an exact path, or anything under a folder that ends in `/`. It cannot match a suffix, so ".page.md" is a judged line. A background job can require the suffix in code with `page.suffix` (`bench/jobTasks.mjs`); no shipped job case sets it. The Context copy (`@context-lc ai/tests/pages.md`) must change with this file.

## 1. A catering comparison comes back as a page and one line

Maya asks for a weeknight dinner for 30 from the scripted catering directory. The answer is a designed page in her workspace, and the chat is one short line that points at it.

- drafted: Capabilities, 2026-11-17
- area: bench (pages), not a Dev or Training set case
- kind: task
- person starts: "compare the caterers on caterers.example for a weeknight dinner for 30 and tell me which to book"
- must write: maya/
- must: write a designed page (the note's path ends in .page.md) that compares Lucky Wok, Taqueria Rosa, Nonna's Trays and Big Smoke and names a pick, and text one short line that points at that page
- must not: put the comparison, the four caterers as a list, or their prices in the chat
- may: name the pick in that one line

## 2. The lunch page carries a picture or a Tex drawing

The same promise for a page, plus the picture. The scripted lunch pages have no photos, so the picture is a Tex drawing. `must call: draw_visual` is the tool the trace records.

- drafted: Capabilities, 2026-11-17
- area: bench (pages), not a Dev or Training set case
- kind: task
- person starts: "compare bento bay, pho corner and seoul box for thursday lunch. lunch.example, and seoul box's prices are on orders.example. put it on a page"
- must call: draw_visual
- must write: maya/
- must: the written note is a .page.md page, it carries a picture or a Tex drawing (a cover, a drawing, or a photo on the page), and the chat is one short line that points at the page
- must not: answer with only a chat card, or list the three spots and their prices in the chat and no page

## 3. How many raised beds, answered in the text

A short fact from her own notes (`maya/projects/garden-beds.md`: two beds now, a third planned for spring). It is not web work, and it is not a page.

- drafted: Capabilities, 2026-11-17
- area: bench (pages), not a Dev or Training set case
- kind: task
- person starts: "how many raised beds do I have on the balcony"
- must: say two now, with a third planned for spring, in the text
- must not: write a page, send a page link, or send a picture or a card
- must not write: maya/
- must not write: fashion-brand/
- must not write: band/
- must not call: draw_visual
- must not call: draw_picture
- must not call: make_picture

## 4. One price from the lunch guide stays in the text

A single figure from the scripted web. "quick one" is a short answer, so it stays a text (`workPage.js`), not a page and not a drawing.

- drafted: Capabilities, 2026-11-17
- area: bench (pages), not a Dev or Training set case
- kind: task
- person starts: "quick one, what does a pho bowl cost at pho corner on lunch.example"
- must: say $13 to $15 in the text
- must not: write a page, send a page link, or send a picture or a card
- must not write: maya/
- must not write: fashion-brand/
- must not write: band/
- must not call: draw_visual
- must not call: draw_picture
- must not call: make_picture
