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

The owner then asked for the reasoning to live in the prompt, not only in a
check for lists: the production setup (@context-lc
`ai/production/texting-assistant.md`) now has an "Answer with a picture"
section that sorts the cases by kind (their time, options, places, looks,
tickets, work, money, how things fit) with the template for each, what stays
words, and examples. The check is the floor under that section, so it was
narrowed to match it: a list goes back only when they asked for something to
look at (see, show, compare, options, plan, week…) or when at least half its
lines carry a second signal (a day or time, a price or figure, an address or
distance). A plain to-do list ("Book the van / Cancel the internet") stays
words, as the section says.

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

### Note links as Context cards (2026-10-26, built switched off)

The owner asked for Sendblue App Cards next to the carousel and chose "static
now, extension next". A text that is nothing but a link to a note
(`https://context.lc/note/@slug/path.md`, the link the gateway adds to reads
and writes) can go as a static card: the note's name, its workspace and
folder, and the link as the card's URL (`apps/agent/src/appCards.ts`). A line
that refuses the card (not V2, no plan, a group) gets the plain link, so a
card is never the only way to the note.

It ships with `APP_CARDS: "off"`. Sendblue's docs say a static card shows
without the Messages extension, but not what a tap does without it, and a
link that opens the note beats a card that might not. It goes on once the
Context app's Messages extension (`lc.context.mobile.messages`) is in the App
Store; the team id is the `APPLE_TEAM_ID` secret, synced to the Worker on
deploy.

The extension is `apps/mobile/targets/context-messages`, added by
`plugins/with-context-messages.js` the way the widgets are: a Messages view
controller that, when a Context card is tapped, opens the card's link if it is
an https link on context.lc and nothing else. The IPA check
(`scripts/validate-ios-ipa.cjs`) requires it embedded once, with its id,
extension point and the host's exact version. It reaches people with the next
native build and App Store release, which stay separate explicit actions.

## A card rides along with any other notice (2026-10-26, afternoon)

Dev2's lunch question ("show me some lunch options around me, average prices
as well") still came back as words after the prompt section went live. The
transcript showed why: the first answer was a priced list of five places, but
another check sent it back first for its missing prices, the card notice never
got a round, and the hand-back judge's H8 notice ("say how to undo it") then
turned the reply into one place and "I didn't change anything, so there's
nothing to undo". So when any other notice wins a round and the answer is a
list a card should carry, the card ask is added to that notice (once a turn);
every hand-back notice now says to send the whole answer again, not only the
new part; H8 says a lookup needs no word about undoing; and a list of projects
counts as something to look at (a board). Test:
`apps/mcp/test/agentVisualNotice.test.mjs`.

## A drawn card always goes, in groups too (2026-10-26)

In the Tex Devs group, "make a graphic for this" drew a card three times and
none arrived: the group's inbox never kept the Worker's own address, so the
picture could not be hosted for Sendblue, and that failure threw after the
words had gone, so the whole turn ran again until "I couldn't answer that
one". The group accept now carries the address like a 1:1 text, and a picture
that will not send is said once and never re-runs the turn. Two guards around
it: a card the turn drew goes with the answer even when the answer forgot to
name it (the last one drawn, or every option card of a set), and an answer
that says "here's the graphic", or a turn asked outright for a graphic, with
nothing drawn goes back once to draw it. The H8 hand-back notice no longer asks
for any line about undoing. Tests: `apps/agent/src/groupInbox.test.ts`,
`apps/mcp/test/agentOutgoingPictures.test.mjs`, `agentVisualNotice.test.mjs`.

## A card's photos are real, or there is no slot (2026-10-26, evening)

Dev2's first card of places ("dinner options near chelsea") had empty coloured
blocks: Tex had read Time Out's photos of two places, but the screenshot
Worker's browser could not load them, and the redraw left every photo off.
"Didn't even fill in the dishes, or logos." Three rules now hold:

- **A place with no slot.** A row is drawn with a photo only when it has one
  that loads (#2228); cuisine, price and hours are their own labels, and lines
  wrap instead of being cut.
- **The gateway downloads every photo itself** (`apps/mcp/src/agent/visuals/
  photos.js`) and puts it in the page as data, so the browser loads nothing
  from the web. One that is refused, not a picture, over 1.5 MB or slower than
  6 seconds is taken off the card. Only addresses the turn read are fetched:
  the rule `outgoingPictures.vouches` already keeps for `[picture <address>]`.
- **Missing photos and logos are filled from the pages read.** A photo whose
  description names the place (as whole words), else the share picture of a
  page titled with its name; a logo is the site's home-screen icon or
  `og:logo`, which a page read now reports apart from its photos
  (`infra/site-shots/src/read.ts` `pickLogo`). The draw result says which
  were filled and how many were left off, so the model can open a place's own
  page and draw again.

What reversing it costs: empty photo blocks on cards whenever a photo site
refuses a headless browser. Tests: `apps/mcp/test/agentVisuals.test.mjs`
("a places card fills each place's photo and logo…"),
`infra/site-shots/src/read.test.ts` and `fetchText.test.ts` (logo).

## The saved conversation says what a card showed (2026-10-26)

A card is a picture and the history keeps words, so the line kept for a sent
card was its title alone. The self-review judge then marked card answers down
for hiding the options, and a later turn could not say what option 3 cost.
The kept line now lists each thing on the card with the facts beside it
(cuisine, price, hours, Tex's pick, an option's facts), at most 500 characters
a card, from the data it was drawn with; never a photo's address
(`apps/mcp/src/agent/visuals/said.js`). Test: "the saved conversation keeps
what a card showed" in `apps/mcp/test/agentVisuals.test.mjs`.

## A places card's distances are measured, never guessed (2026-10-27)

Dev2's places card for flower shops had no distances: "tex knows my address
yet no distance was put for these places". The model cannot measure, and a
guessed "4 min" is worse than none. So a places card names `from` (where they
start, usually the address in their about-me note), and the gateway geocodes
the start and each place's address (Photon, OpenStreetMap data) and fills a
straight-line distance with a walking time when it is under half an hour
(`apps/mcp/src/agent/visuals/distance.js`). Miles in the US, km elsewhere. A
distance the model wrote is kept; a place found more than 80 km away is a
same-named shop elsewhere and gets none.

A lookup sends an address to an outside service, so an address goes only if
the turn saw it: their words, a tool result this turn, or their about-me note
(`outgoingPictures.locates`, fed by `knows` in `route.js`). An address the
model made up is never looked up, because it could carry whatever the model
put in it. The owner chose OpenStreetMap now and Google later (2026-10-27);
`GOOGLE_MAPS_KEY` is being provisioned for that.

What fails if reversed: `test/agentDistance.test.mjs`, "an address the turn
never saw is never sent to the geocoder" and "their about-me address is a
start the card may measure from".

## Maps on cards (2026-10-27)

The owner, on a florists card that listed four addresses: "there was a map
one specifically that would've been great here". A places card now has a map
above its rows, each pin numbered and coloured like its row, and the `map`
template is stops on a map (a day's errands, a trip's sights), with a dotted
line between them when the order is the way to go
(`apps/mcp/src/agent/visuals/map.js`).

- **Google when there is a key, OpenStreetMap until then** (owner's pick,
  2026-10-27: "OSM now, Google later"). With `GOOGLE_MAPS_KEY` set, the map
  is one Google Static Maps picture; without it, the gateway finds each
  address with the geocoder (`visuals/distance.js`), lays out OpenStreetMap
  tiles by Web Mercator (12 at most) and draws the pins in HTML, with
  OpenStreetMap's credit on the map, a user agent that names the app, and
  tiles cached a week, as its tile policy asks.
- **The map is the gateway's, never the model's.** It is drawn from the
  card's addresses after the card's photos, downloaded and put in the page as
  data like them, so the key never reaches the page or the model. A `map` in
  the model's data is dropped. A map whose tiles do not all come is left off
  whole: a map with a hole reads as broken.
- **Only an address the turn saw goes to a map service**, by the rule
  distances keep (`outgoingPictures.locates`): their words, a tool result
  this turn, or their about-me note. A made-up address is never sent.
- **A bare street address needs `near`** ("Long Island City, NY"), or the
  town in `from`; without either no map is drawn and the model is told to add it, because a pin on the
  wrong 2807 Jackson Ave is worse than no map.

What reversing it costs: places answers back to a list of addresses nobody
can picture, or a key in the page. Tests: `apps/mcp/test/agentMapCard.test.mjs`.

## Photos can be searched for, and an option card never shows a letter (2026-10-27)

In a WhatsApp group Dev2 asked for a caterer's dishes "with pictures and
prices", and the option cards went out with a big letter in a coloured block
where each dish should be: "why isn't it adding images?" The caterer's site
had no photo per dish, and the pages Tex read were its only source.

- `search_web` takes `pictures: true` (Brave's image search). Results are
  listed like a page's pictures, so they fill a card's photos by name
  (`visuals/photos.js` `pagesIn`), and are vouched the same way: only an
  address a result showed this turn is downloaded.
- A searched picture that won't download falls back to the provider's
  smaller copy (`sparesIn`), so a refusing host doesn't cost the photo.
- An option card with no photo has no photo slot, and is as tall as what it
  holds. A fact shows up to 60 characters, wrapped, not cut at 24.

What fails if reversed: `apps/mcp/test/agentPictureSearch.test.mjs`.

Since the same day, with `GOOGLE_MAPS_KEY` set, the geocoder is Google's,
with Photon only on Google's miss; each card looks an address up once for its
distances and its map (`geocoderFor`), and logs a `card_distance` reason
code (no_from, from_unseen, from_not_found, some_missed, measured), never an
address. Dev2's ice-cream card came back without distances while only
Photon was looking, and nothing said why.

## Cards look like Context (2026-10-27)

The owner, on the first round of templates: "Could we redesign these card
templates in context style? I don't like how it looks currently." After the
mockups: "this is ok for now. will work on better design elements later".

- **Palettes are the app's tokens.** `kit.js` `LIGHT` and `DARK` mirror
  `apps/mobile/features/design/tokens/colors.ts`: paper `#FFFDF9`, ink
  `#1A1714`, hairlines rather than grey fills, one indigo accent. The
  fixed-palette templates (tickets, streak, the gallery styles) use the same
  tokens, so no card brings its own navy or green.
- **Type.** Instrument Sans at weight 600 at most (the app's face), never the
  old heavy Inter Tight 800. Names and notes are set in a reading serif
  (Source Serif 4, standing in for the app's Libron, which is self-hosted and
  not on Google Fonts). Kickers are sentence case, not tracked capitals.
- **Lists are hairline rows**, like a Context list, not boxed tiles. Numbers
  and map pins share the one accent, so pin 3 and row 3 match by number,
  not colour. Google Static Maps is styled in the card's paper and ink.
- **The footer signs "Tex · Context".**

What it does not change: any template's fields, what the model is told, or
the copy on a card. Reverting is `kit.js`'s palettes and fonts plus the
inline styles; `agentVisuals.test.mjs` still draws every template.
