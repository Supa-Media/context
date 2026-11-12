/**
 * THE PAGE DESIGN SKILL: WHAT AN AGENT READS BEFORE IT WRITES A PAGE.
 *
 * Owner, 2026-10-27: pages looked like "a glorified markdown page", and "we
 * should probably create a skill we force the agent to use to create UX/UI
 * components just to make sure we are creating helpful pages"; then "skill
 * should be required when making pages". So it is: this text is served by
 * `orient about: "pages"` (every client, Tex included, has orient), it ends with a
 * stamp, and a `.page.md` write without the current stamp in its front matter
 * is refused (`pages.js`), naming where to read it. The stamp is a hash of
 * the skill itself, so changing the skill makes every agent read it again.
 *
 * It teaches design, not syntax: what a page is for, what goes first, which
 * part fits which shape of facts, the hard cases from the round 2 artboard,
 * and the checks a page must pass before it is sent. The format reference is
 * appended from the block kinds themselves, so it never drifts from the
 * checks. Decision: `docs/decisions/app-and-console/pages.md`.
 */

import { BLOCK_KINDS } from "../../../packages/shared/src/pages/blocks.cjs";
import { templateLines } from "../../../packages/shared/src/pages/templates.cjs";

const DESIGN = `# Page design skill

Read all of this before you write any \`.page.md\`. A page is what people open from a text or a link to decide something or see where things stand. It should look like a real page somebody designed, not a document. You write words and rows of facts; the page draws the photos, map, colors and layout from them.

## 0. Start from a template

Pick the shape before you write. Their own templates come first: list \`tex/templates/\` in their personal workspace, and \`templates/\` in a shared workspace you are writing in; a \`.page.md\` there is a page to copy and fill. Otherwise read the built-in that fits with \`orient about: "template <name>"\`:

${templateLines().join("\n")}

Fill every \`[gap]\`, put real numbers where a template holds 0 or \`?\`, drop a part the facts don't need, and add one they do. A page with a \`[bracket]\` left in it isn't finished. When they ask to keep a page as a template, copy it to \`tex/templates/<name>.page.md\` in their personal workspace (a shared workspace's page goes to its \`templates/\`, so everyone there gets it), with every fact that belongs to this one case turned back into a \`[gap]\`, its photos and \`drawing\` lines dropped, and the stamp kept.

## 1. Lead with the answer

Order, top to bottom:
1. Front matter: \`kind\` (research, plan or status), \`for\` (who it is for), \`status\` (one short line: "Nothing booked yet", "On track"), \`cover\` (a photo file, or leave it out to use the first photo below). A status page also has \`number: 412 of 1,000\`.
2. \`# Title\`: the outcome in a few words ("Sunday services, sorted"), not the topic ("Research on venues").
3. One sentence under it: what this page answers, with the key numbers.
4. If there is a decision, a \`vote\` block right here: your pick as the caption, one line of why, the options. Never leave the decision at the bottom.
5. A \`stats\` block of the 2 to 4 numbers that frame everything (seats needed, budget, people, deadline).
6. One \`##\` section per question, each headed by its own answer ("Three rooms that seat 200", "Lunch for 30, from $420"), then one sentence, then its block.
7. Next steps as \`- [ ]\` tasks, and contacts last.

## 2. Pick the part that fits the facts

- A choice someone has to make: \`vote\` (2 to 6 options). Budgets or packages: \`tiers\` (2 to 4).
- Places (venues, restaurants, churches, offices, stops to visit: anything with an address): \`places\`, with price, seats and facts under each. One to six get photo spreads; seven or more become a shortlist on their own.
- The same kind of price from several sellers: \`prices\`, with \`per\` and \`for\` so the group total is worked out for you. Never a table of prices.
- A day or a night out: \`itinerary\`, with a \`walk\` under each stop. Deadlines or milestones: \`timeline\`, with \`state: done\` or \`now\`.
- Numbers over time: \`chart\`. One number against a goal: a status page's \`number\`, or \`progress\`.
- Who does what this week: \`board\`. Who to call or write: \`contacts\`, with phone, email or site fields.
- How something works, flows or fits together (a route, a floor plan, who hands what to whom, the steps of a setup): a \`drawing\`, your simple line drawing of it in Tex's ink, beside the words that explain it. One per section at most; never a drawing of words you could write.
- Two things compared row by row: \`versus\`. Anything no block draws (a calculator, a bill splitter): a \`box\` of your own HTML and CSS.
- Plain prose only for what is really prose. A paragraph that lists options, prices or times is a block you have not written yet.

## 3. Write it well

- Labels short, names exact, numbers real and from what you read. A price you did not find is \`?\` (or Ask), drawn as one to ask about. Never 0, never a guess.
- Facts as \`key: yes|no|?|word\` under a place (\`on the L: yes; kitchen: ?\`), the same keys on every place so they line up.
- Photos make the page. For every place, dish or stop, use the real pictures you found on its own pages (or a picture search): pass each in the write's \`images\` as \`{ name: "stand-1.jpg", url: "<the picture's address>" }\` and name it in a field (\`photo: stand-1.jpg\`, \`photos: stand-1.jpg, stand-2.jpg\`, \`cover:\`). They are saved with the note and exported with it. Name a photo only when you attach it in the same write; a name with no picture behind it is taken off, so leave the field out and one is found for you. Every option compared (a place, dish, country, hotel, product) gets a real picture: when its pages have none, search_web with pictures: true for its name, or open its page in your browser; never save a comparison page with no pictures because the first try found none. Give a place two to four photos (\`photos: a.jpg, b.jpg, c.jpg\`): they swipe as a carousel. A wrong photo is worse than none, so check the name matches.
- Every option, place, price, stop, person and timeline row gets \`source: <the page you read it on>\`, drawn as a link out to that site. Facts with no source are guesses. A web address written in the words is a link too.
- A page is visual: people get their photo (\`photo:\` under each, or one is found for them), named things in a timeline get theirs, organisations their logo or building. A page with no picture at all is sent back for its drawing; the cover call is never optional.
- A map: draw the places with \`draw_visual\` (template map) and keep that picture as the block's \`map: map.png\`, passing \`images: [{ name: "map.png", data: "picture:N" }]\`. Without one, each place still opens in a map app.
- One idea per section. Five sections at most; move the rest to a linked note.
- \`accent\` only if the subject has a color of its own; otherwise leave it.

## 4. Hard cases

- Two options: still a \`vote\`; they face off. Twelve: shortlist the best 3 to 6 in the vote, the rest in \`places\` or \`prices\`.
- Nothing decided yet: \`status: Nothing booked yet\`, and the vote's \`action\` says the next step ("Ask {pick} for a quote").
- Mixed prices (per head and per event): two \`prices\` blocks, or put the per-event ones in \`places\` as \`price:\`.
- Unknowns: say so once in the dek or a \`> [!NOTE]\`, not in every row.

## 5. Check before you send

1. The title and the first sentence answer the question without scrolling.
2. The decision (if any) is a vote near the top, with your pick and why.
3. Every list of options, prices, places or times is a block, not prose or a table.
4. No invented numbers; unknowns are \`?\`.
5. Every place has an address and a source; every contact has a phone, email or site.
6. Section headings are answers, not topics.
7. It reads on a phone: short labels, nothing that needs a wide screen.
8. Your stamp is in the front matter (below).`;

/** One line per block kind, from the kinds themselves, so the reference never drifts from the checks. */
const KIND_LINES = Object.entries(BLOCK_KINDS).map(([kind, { about }]) => `- \`${kind}\`: ${about}`);

const FORMAT = [
  "## Format",
  "",
  "A note whose name ends in `.page.md` is drawn as a page: words, pictures and choices people read, vote on, tick and comment on in the app. It is still Markdown, so every word stays editable and searchable.",
  "",
  "- **Words** are ordinary Markdown: `#` title, `##` sections (each a section, or a tab with `layout: tabs`), lists, `- [ ]` tasks people tick, tables, `> [!NOTE]` callouts, links and `[[wiki links]]`.",
  "- **Front matter**: `skill` (the stamp below, required), `kind` (research, plan, status), `for`, `status`, `updated`, `cover` (photo files, comma separated), `number` (a status page's big number, `412 of 1,000`), `kicker` (replaces the kind line), `theme` (light, dark; else the reader's), `accent` (indigo, green, orange, plum, red, ink), `layout: tabs`. `drawing` and `drawing-dark` are the picture Tex draws for a page with none (draw_visual template page with a scene saves them): keep them as they are.",
  "- **Blocks** are fenced data the page draws: the fence names the kind and a caption, then one `- ` line per item and `key: value` settings. An item is `|`-separated parts, and the first may start with `Label: `. Lines indented under an item are its fields (`photo: stand.jpg`, `seats: 300-500`, or facts split with `; `). Example:",
  "",
  "  ```places Three rooms that seat 200",
  "  need: 200 seats",
  "  - The Stand: 116 E 16th St, New York | Own kitchen and a stage",
  "    price: Ask",
  "    seats: 300-500",
  "    on the L: yes; kitchen: yes",
  "  ```",
  "",
  ...KIND_LINES,
  "",
  "- **Drawings**: a ```` ```drawing <caption> ```` fence holds SVG shapes on a 1200 x 900 canvas (`rect`, `circle`, `ellipse`, `line`, `path`, `polyline`, `polygon`, `text` of a few words, `g`, and one `<tex x y size>` for Tex himself). Fills are `none`, `ink`, `paper` or `hatch`; every stroke is Tex's ink, in light and dark. No colours, styles, links or images: anything else is refused with what to fix.",
  "- **Look**: a ```` ```css ```` fence restyles the page (`--pg-accent`, `.pg-nums`, `h1`); it can load nothing from the network.",
  "- **Layout**: a ```` ```layout ```` fence holds HTML (and a `<style>`) that places the page's parts, for work that should look designed: an editorial review with numbered findings beside their exhibits, a research brief in two columns. `data-from=\"cover\"` is the title, opening line and cover; `data-from=\"<a ## heading>\"` is that section; `data-from=\"rest\"` is every section not named. The words stay in the Markdown, so editing and comments still work, and a section you don't place is added at the end. No script, form, link, picture address, `on...=`, `@import` or `url(`: refused with what to fix. Pictures and drawings in a page enlarge when tapped. Use a layout only when the shape matters; most pages read best without one.",
  "- **Code boxes**: a ```` ```box height=320 ```` fence holds HTML and script for something no block draws (a calculator, a quiz, a custom chart). It runs sealed in its own frame, loads nothing, and reads the page's blocks as `window.page.blocks`. Prefer a block; reach for a box only when none fits.",
  "- A write with a block that cannot be drawn is refused with the line to fix. A `choose`, `vote` or `tiers` block's decision comes back as its `chosen:` line, and votes as `votes:` under each option: read the note again to see them.",
].join("\n");

/** FNV-1a, 32 bits, as hex: a stamp that is the same everywhere this runs, with no Web Crypto round trip. */
function fnv(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** What a page's front matter must say to be saved: proof its writer read this skill as it is now. */
export const PAGE_SKILL_STAMP = `pages-${fnv(`${DESIGN}\n${FORMAT}`)}`;

/** The whole skill, as `orient about: "pages"` answers it. */
export const PAGE_SKILL = [
  DESIGN,
  "",
  FORMAT,
  "",
  "## Your stamp",
  "",
  `Every page you write carries this line in its front matter, or the write is refused: \`skill: ${PAGE_SKILL_STAMP}\``,
].join("\n");
