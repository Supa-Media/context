# Tex answers with a designed card, in one line of words (2026-10-26)

The owner, comparing Tex with assistants people like for trips, plans and
architectures: "people say that they like the more visual responses our
competitors give … essentially I want the responses to be less wordy more
visuals." The cards were designed and approved on an artboard first ("THIS IS
PERFECT + AMAZING PLEASE BUILD THIS").

## What it is

`draw_visual` is a `send` action beside `draw_picture` and `make_picture`
(`apps/mcp/src/agent/visuals/`, wired in `pictureMaker.js`). The model picks
one of fifteen templates and fills its fields as data:

| Template | For |
|---|---|
| `compare` | options ranked on one number against a limit (quotes, prices) |
| `gallery` | things whose looks matter: clothes (`editorial`), food (`warm`), gifts (`polaroid`) |
| `versus` | two things side by side: homes, cars, jobs |
| `places` | places to go, numbered, a photo each |
| `tickets` | flights, trains, shows |
| `trip` | a trip or event by day |
| `day` | one day hour by hour |
| `plan` | a plan over weeks as bars |
| `board` | work by status ("what projects are being worked on") |
| `chart` | numbers that moved and what moved them ("what are we doing about latency") |
| `spending` | where money went |
| `steps` | how to do something |
| `people` | who is in a meeting |
| `system` | how a system, team or process fits together |
| `streak` | a habit over five weeks |

The gateway builds the page, the screenshot Worker photographs it at 1200×1500
(designed at 600×750 and zoomed 2×, so it is sharp on a phone), and the turn's
`outgoingPictures` numbers it like every other picture.

**Why templates, not free HTML.** The model only fills fields, so Haiku does it
well and fast, every card looks like the same assistant, and nothing the model
writes reaches the page except as escaped text (`esc`), a palette colour, or a
checked picture address (`photoUrl`). `draw_picture` stays for a poster or an
invite that fits no template.

## When to draw, and how short the words get

`VISUALS_LINE`, on every texted turn: count six signals in the answer about to
be given (3+ things side by side; numbers worth comparing; times or dates;
places; parts that connect or who owns what; things whose looks matter). Two or
more, or an ask to see, compare, plan or map, draws a card, and the words
become **one line of at most 25 words**: the verdict and the next step. The
card carries the detail, so the words never repeat it. Never for a yes or no,
one fact, a draft they will send, hard news, or after they ask for text only.

### When the prompt line is not enough (2026-10-26, the same morning)

The first live texts after launch came back as lists: "What does my week look
like" got seven lines of days, and dinner options got four lines of
restaurants. The production setup's long rules for how to write a list
outweighed one line about drawing. So a texted answer is now also read once
by the turn's checks (`visuals/notice.js`, run from `claimCheck.js`). If it is
a list of three or more things, nothing was drawn, it is not a draft or code,
and they didn't ask for words only, it goes back once with the card notice.
The model then draws and texts one line. Reverting this leaves the card to
the model's choice, which in production meant no card.

### Option cards, sent as one swipeable set

When each of 2 to 8 options needs its own photo and facts, Tex draws one
`option` card each, numbered "2 of 4", with "Reply 2 for more on this one"
along the bottom. An answer with two or more pictures goes out over Sendblue
as one carousel (`apps/agent/src/carousel.ts`, `send-carousel`, V2 lines
only). If the line refuses that, the pictures go one by one, and the carousel
is not retried for the rest of the answer. The saved conversation names each
card ("1. Blend LIC; 2. Lugo's"), so "the 2nd one" has an answer. An answer
carries at most 8 pictures.

## Photos

A card shows the thing itself (the dress, the dish, the flat) through a CSS
`background-image`, so a photo that does not load leaves the card's tone fill
and the card still reads. Two rules carry over from `draw_picture`:

- **A web photo loads only if this turn read its address** (`vouches`), so a
  card cannot carry a private note's words to somebody's server. Google Fonts
  are the one fixed exception and never count as "did not load".
- `attachment:N` / `picture:N` photos are inlined as bytes the turn already
  holds.
- An address holding a character reference (`&#39`, `&apos;`) is no photo:
  the page decodes it inside the style attribute and it would close the
  `url('…')`.

To make vouched addresses exist, page reads now return the page's pictures
(`infra/site-shots/src/read.ts`, `fetchText.ts`): the share image first, then
large `<img>`s, public https only, no SVG, logos, icons or trackers, at most 12.
`open_page` lists up to 8 of them.

## The card in the note

A note saved with `write` and `args: { images: [{ name: 'card.png', data:
'picture:N' }] }` gets the card's bytes (`withDrawnImages`, the same shape as
`attachment:N`). **Only a picture this turn drew or made may be kept by its
number**: a picture `read_image` showed from a note stays where it was, since
copying it into another note would be a second way to move it.

## What reverting costs

Drop the templates and the model writes free HTML again: slower, inconsistent,
and an injection surface. Drop the one-line rule and the card arrives under a
paragraph that says the same thing. Checks: `apps/mcp/test/agentVisuals.test.mjs`
(sabotage record in its header).
