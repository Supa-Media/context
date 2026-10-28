/**
 * PAGES THAT LOOK DESIGNED (owner, 2026-10-27: "pages look so ugly ... this
 * is just a glorified markdown page"; round 2 artboard approved 19:19): item
 * fields, the cover by kind, and the richer blocks (vote, places, prices,
 * itinerary, tiers, contacts) in `packages/shared/src/pages/`.
 *
 * The runtime is sealed and draws a note anybody with write access wrote, so
 * besides what each block draws these pin that the new places words and
 * pictures enter the markup stay words and pictures: a field is escaped, a
 * photo is never a `javascript:` or `data:` address, a contact button only
 * ever calls, texts, mails or opens a web page.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `SAFE_SRC` accepting any value (`html.cjs`) → "a photo is a picture's name,
 *     never a script or data address" fails.
 *   `itemFields` dropping the `; ` split (`parse.cjs`) → "indented lines are
 *     the item's fields" fails.
 *   `castVote` keeping the voter on the old option (`edits.cjs`) → "a vote
 *     moves" fails.
 *   `UNKNOWN` matching nothing (`blocks.cjs`) → "a price nobody listed is
 *     asked for" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../packages/shared/src/pages/render.cjs";
import { castVote, chooseOption, editableRuns } from "../../../packages/shared/src/pages/edits.cjs";

const page = (lines) => parsePage(lines.join("\n"));
const draw = (lines, options) => renderPage(page(lines), options).html;

test("indented lines are the item's fields, facts split at '; ', and each is words a reader can edit", () => {
  const source = ["```places Rooms", "- The Stand: 116 E 16th St", "  seats: 300-500", "  on the L: yes; Stage, AV: included", "```", ""].join("\n");
  const parsed = parsePage(source);
  assert.deepEqual(parsed.problems, []);
  const [item] = parsed.nodes[0].items;
  assert.deepEqual(
    item.fields.map((field) => [field.key, field.value.text]),
    [["seats", "300-500"], ["on_the_l", "yes"], ["stage_av", "included"]],
  );
  const runs = editableRuns(parsed);
  for (const field of item.fields) assert.ok(runs.has(`${field.value.from}:${field.value.to}`), field.key);
});

test("a field's words are escaped like every other word", () => {
  const html = draw(["```places X", "- A: 1 St", '  <img src=x onerror=alert(1)>: <script>alert(2)</script>', "```", ""]);
  assert.ok(!html.includes("<script") && !html.includes("<img src=x"));
  assert.match(html, /&lt;script&gt;/);
});

test("a photo is a picture's name, never a script or data address", () => {
  const html = draw([
    "```places X",
    "- A: 1 St",
    "  photos: javascript:alert(1), data:image/svg+xml;base64,PHN2Zz4=, ok.jpg",
    '- B: 2 St',
    '  photo: x" onerror="alert(1)',
    "```",
    "",
  ]);
  assert.ok(!/data-src="(?:javascript|data):/i.test(html));
  assert.match(html, /data-src="ok\.jpg"/);
  assert.ok(!html.includes('onerror="alert'));
  // A cover is handed bytes it was given, by name; a name it was not given stays a slot.
  const cover = draw(["---", "kind: plan", "cover: a.jpg, b.jpg", "---", "# T", ""], { images: new Map([["a.jpg", "data:image/png;base64,AAAA"]]) });
  assert.match(cover, /<img src="data:image\/png;base64,AAAA"/);
  assert.match(cover, /data-src="b\.jpg"/);
});

test("a contact button only ever calls, texts, mails or opens a web page", () => {
  const html = draw([
    "```contacts",
    "- Smart Value: Events desk",
    "  phone: (212) 555-0101",
    "  email: events@example.com",
    "- Bad: x",
    "  phone: javascript:alert(1)",
    '  email: a@example.com" onclick="alert(1)',
    "  site: javascript:alert(1)",
    "```",
    "",
  ]);
  assert.match(html, /href="tel:2125550101"/);
  assert.match(html, /href="mailto:events@example\.com"/);
  for (const href of html.matchAll(/href="([^"]*)"/g)) assert.match(href[1], /^(tel:|sms:|mailto:|https?:\/\/)/, href[1]);
  assert.ok(!html.includes('onclick="alert'));
  assert.ok(!/href="tel:"/.test(html), "a phone with no digits gets no button");
});

test("the vote: the pick as the caption, why under it, options with faces, one button that follows the pick", () => {
  const html = draw([
    "```vote Ask The Stand first",
    "It's on the L and has its own kitchen.",
    "action: Ask {pick} for a quote",
    "voters: 5",
    "- The Stand | Union Square",
    "  votes: LK, Segun Okafor",
    "- 3 West Club | Midtown",
    "  votes: Sam",
    "```",
    "",
  ]);
  assert.match(html, /class="pg-verdict"/);
  assert.match(html, /Ask The Stand first\.<\/span> <span data-edit>/);
  assert.match(html, />Ask The Stand for a quote</);
  assert.match(html, /3 of 5 voted/);
  assert.match(html, /<i class="f\d" title="LK">LK<\/i><i class="f\d" title="Segun Okafor">SO<\/i>/);
  // Without a caption there is no pick to show, and one option is not a vote.
  assert.match(page(["```vote", "- A", "- B", "```"]).problems[0].message, /caption/);
  assert.match(page(["```vote Go", "- A", "```"]).problems.map((p) => p.message).join(" "), /at least 2 options/);
});

test("a vote moves: one name on one option, and tapping your own takes it back", () => {
  const source = ["```vote Go", "- A | x", "  votes: Bo", "- B", "```", ""].join("\n");
  const block = parsePage(source).nodes[0].from;
  const once = castVote(source, block, "B", "LK").text;
  assert.match(once, /- B\n {2}votes: LK\n```/);
  const moved = castVote(once, block, "A", "lk").text;
  assert.match(moved, /votes: Bo, lk/);
  assert.doesNotMatch(moved, /- B\n {2}votes/);
  assert.equal(castVote(moved, block, "A", "LK").text, source);
  assert.equal(castVote(source, block, "C", "LK").error, "not an option");
  assert.equal(castVote(source, block, "A", " , ").error, "no voter");
  // A name cannot smuggle a second field or another option's line in.
  assert.deepEqual(parsePage(castVote(source, block, "B", "Eve: yes\n- C").text).problems, []);
  // Deciding is chosen:, in a vote or tiers block as in a choose block.
  assert.match(chooseOption(source, block, "B").text, /chosen: B\n```/);
});

test("prices sit on one axis, totals come from for:, and a price nobody listed is asked for", () => {
  const html = draw(["```prices Lunch", "per: guest", "for: 30", "- Smart Value: $14 | Boxed", "- Gotham: $26.50 | Deluxe", "- Mangia: ? | No prices listed", "```", ""]);
  assert.match(html, /<span class="pg-tot">\$420<\/span>/);
  assert.match(html, /<span class="pg-tot">\$795<\/span>/);
  assert.match(html, /pg-dot hollow/);
  assert.match(html, /pg-tot ask">Ask/);
  assert.match(html, /class="pg-prow pick"/, "the cheapest is the pick when none is named");
  assert.match(page(["```prices", "- A: free-ish", "- B: $3", "```"]).problems[0].message, /needs a price, or \?/);
});

test("places: photo spreads with the seats against the need and a fact strip, a shortlist past six", () => {
  const html = draw([
    "```places Rooms",
    "need: 200 seats",
    "- The Stand: 116 E 16th St | Own kitchen",
    "  price: Ask",
    "  seats: 300-500",
    "  photos: a.jpg, b.jpg, c.jpg, d.jpg",
    "  on the L: yes; kitchen: ?; parking: no",
    "- Small Room: 2 St",
    "  seats: 120",
    "```",
    "",
  ]);
  // Every photo, to swipe through (owner, 2026-10-28), not the first three in a grid.
  assert.match(html, /class="pg-gal n2"><span class="pg-no">1<\/span><div class="pg-gal-track"/);
  assert.equal((html.match(/data-src="[a-d]\.jpg"/g) ?? []).length, 5, "the four, and the first again as the cover");
  assert.equal((html.match(/<div class="pg-gal-dots"[^>]*>(<i[^>]*><\/i>)+<\/div>/)?.[0].match(/<i[ >]/g) ?? []).length, 4);
  assert.match(html, /4 photos/);
  assert.match(html, /pg-vprice ask">Ask for price/);
  assert.match(html, /class="pg-fit short"/, "fewer seats than needed is flagged");
  assert.match(html, /class="y"/);
  assert.match(html, /class="q"/);
  assert.match(html, /class="n"/);
  const many = draw(["```places Lots", ...Array.from({ length: 7 }, (_, i) => `- Place ${i}: ${i} St`), "```", ""]);
  assert.match(many, /class="pg-short"/);
  assert.doesNotMatch(many, /pg-venue/);
});

test("the cover follows the kind: a split with the first photo, a collage, a big number with its dots", () => {
  const research = draw(["---", "kind: research", "for: LK", "status: Nothing booked yet", "---", "# Title", "", "The answer.", "", "```places X", "- A: 1 St", "  photo: a.jpg", "```", ""]);
  assert.match(research, /pg-cover pg-cover-split/);
  assert.match(research, /RESEARCH|Research · for LK/);
  assert.match(research, /<p class="pg-dek" data-edit/);
  assert.match(research, /class="pg-pill">Nothing booked yet/, "nothing booked is not a green pill");
  const plan = draw(["---", "kind: plan", "cover: a.jpg, b.jpg, c.jpg", "---", "# Night out", ""]);
  assert.match(plan, /pg-cover-col n3/);
  const status = draw(["---", "kind: status", "number: 412 of 1,000", "status: On track", "---", "# The first 1,000", ""]);
  assert.match(status, /pg-cover-num/);
  assert.match(status, /<div class="pg-big">412<small> \/ 1,000<\/small>/);
  assert.match(status, /<rect width="400" height="100" fill="url\(#pg-dot-on\)"\/><rect y="100" width="120"/, "412 of 1,000 fills ten rows and 12 dots");
  assert.match(status, /class="pg-pill ok">On track/);
  const plain = draw(["# Just words", "", "Hello."]);
  assert.match(plain, /pg-cover-plain/);
});

test("itinerary and tiers draw from their fields", () => {
  const night = draw(["```itinerary Night", "- 7:00: Dinner | Table for 8", "  photo: food.jpg", "  walk: 6 min", "- 8:45: Bowling", "  walk: never shown, last stop", "```", ""]);
  assert.match(night, /<time class="pg-tm" data-edit>/);
  assert.equal((night.match(/class="pg-leg"/g) ?? []).length, 1);
  const tiers = draw(["```tiers Budget", "pick: Good", "- Easy: $45 | a head", "- Good: $85 | a head", "  Korean BBQ: $48", "  votes: LK, SO", "```", ""]);
  assert.match(tiers, /class="pg-tier pick"/);
  assert.match(tiers, /The pick<\/span>/);
  assert.match(tiers, /<span>Korean BBQ<\/span>/);
  assert.match(tiers, /2 picked this/);
});
