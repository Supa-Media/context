/**
 * VISUAL PAGES (owner, 2026-11-10, on a background job's page of new NYC
 * churches: "no photos of church logos, no photos of the lead pastors, no
 * buildings, WE NEED TO MAKE VISUAL PAGES"; "there are no hyperlinks either,
 * no ability to click on a link to learn more").
 *
 * The job wrote the churches as a timeline and their pastors as people, which
 * no hunt looked at; skipped the cover call ("the draw is optional"), so the
 * page had no drawing either; and listed its sources as bare addresses, drawn
 * as plain words. Pinned here:
 *  - a turn that saved a page with no picture and made no cover call is sent
 *    back to make it (`agent/pageCoverFloor.js`), and one that did is not;
 *  - people and named timeline rows are hunted a photo each, after the
 *    options (`agent/visuals/pagePhotos.js`), and "Book the venue" never is;
 *  - a person's or a row's photo and its `source:` are drawn;
 *  - a bare web address in a page's words is a link, named by its site.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`, "A page always has a picture, and its people and links show".
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-10).
 *   `bareCoverMissing` always "" → "a bare page with no cover call is sent back" fails.
 *   `unpictured` without the row kinds → "people and named timeline rows are hunted" fails.
 *   `people` drawing faces only → "a person's photo and source are drawn" fails.
 *   `inlineRuns` without the bare-address branch → "a bare web address is a link" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../packages/shared/src/pages/render.cjs";
import { inlineRuns } from "../../../packages/shared/src/pages/inline.cjs";
import { bareCoverMissing, bareCoverNotice, barePageWritten } from "../src/agent/pageCoverFloor.js";
import { replyChecks } from "../src/agent/replyChecks.js";
import { unpictured } from "../src/agent/visuals/pagePhotos.js";

const CHURCHES = [
  "---",
  "skill: x",
  "kind: research",
  "---",
  "",
  "# Eight new NYC churches",
  "",
  "Words first.",
  "",
  "## When they launched",
  "",
  "```timeline Launches",
  "- Sep 2024: Harlem Community Church | Weekly services in a gym",
  "  state: done",
  "- Mar 2025: Redeemer Brooklyn | Downtown Brooklyn",
  "  source: https://www.redeemerbk.com/who-we-are",
  "- Jun 2025: Book the venue | for the launch",
  "```",
  "",
  "## Who leads them",
  "",
  "```people Leads",
  "- Rev. David Lee: Senior Pastor, Redeemer Brooklyn | Downtown Brooklyn",
  "- Tim Shutes: Pastor, Citylight New York | Sent from Philadelphia",
  "  photo: tim.jpg",
  "```",
  "",
  "## Sources",
  "",
  "- Redeemer Brooklyn: https://www.redeemerbk.com/who-we-are.",
  "",
].join("\n");

/** The page as the job wrote it: not one picture. */
const BARE = CHURCHES.replace("  photo: tim.jpg\n", "");

test("a bare page with no cover call is sent back to draw it, once", () => {
  const path = "projects/churches.page.md";
  assert.equal(barePageWritten({ path, content: BARE }), path);
  assert.equal(barePageWritten({ path, content: CHURCHES }), "", "a person's photo is a picture");
  const steps = [{ name: "write_note", ok: true, page: true, bare: path }];
  assert.equal(bareCoverMissing(steps), path);
  const check = replyChecks({ question: "find new church plants" });
  const notice = check("Eight plants. https://context.lc/p/@seyi/projects/churches.page.md", steps);
  assert.equal(notice, bareCoverNotice(path));
  assert.match(notice, /draw_visual[\s\S]*template page[\s\S]*scene/);
  assert.equal(check("Eight plants, link again.", steps), null, "once a turn");
});

test("a page with a picture, a drawing, or a cover call after it is let go", () => {
  const path = "p.page.md";
  assert.equal(barePageWritten({ path, content: BARE.replace("kind: research", "kind: research\ndrawing: d.png") }), "");
  assert.equal(barePageWritten({ path, content: BARE.replace("## Sources", "![A church](church.jpg)\n\n## Sources") }), "");
  assert.equal(barePageWritten({ path: "notes/plain.md", content: "# Hi" }), "");
  assert.equal(barePageWritten({ path, content: "" }), "", "an edit that sends no words is never counted");
  assert.equal(bareCoverMissing([{ name: "write_note", ok: true, bare: path }, { name: "send", action: "draw_visual", ok: true }]), "");
  assert.equal(bareCoverMissing([{ name: "send", action: "draw_visual", ok: true }, { name: "write_note", ok: true, bare: path }]), path, "a cover drawn before the save doesn't count");
  assert.equal(bareCoverMissing([{ name: "write_note", ok: true, bare: path }, { name: "send", action: "draw_visual", ok: false }]), path);
});

test("people and named timeline rows are hunted, after the options, and a plain task never is", () => {
  const rows = unpictured(CHURCHES).map((row) => [row.name, row.query]);
  assert.deepEqual(rows, [
    ["Harlem Community Church", "Harlem Community Church"],
    ["Redeemer Brooklyn", "Redeemer Brooklyn"],
    ["Rev. David Lee", "Rev. David Lee Senior Pastor, Redeemer Brooklyn"],
  ]);
  const withPlaces = CHURCHES.replace("## Sources", "```places Where\n- The Stand: 116 E 16th St | A room\n```\n\n## Sources");
  assert.equal(unpictured(withPlaces)[0].name, "The Stand", "options come first");
});

test("a person's photo and source, and a timeline row's, are drawn", () => {
  const page = CHURCHES.replace("- Rev. David Lee: Senior Pastor, Redeemer Brooklyn | Downtown Brooklyn", "- Rev. David Lee: Senior Pastor, Redeemer Brooklyn | Downtown Brooklyn\n  source: redeemerbk.com")
    .replace("  state: done", "  state: done\n  photo: harlem.jpg");
  const { html } = renderPage(parsePage(page));
  assert.match(html, /<div class="pg-person"><div class="pg-ph pg-face"[^>]*><img data-src="tim\.jpg"/);
  assert.match(html, /<div class="pg-person">[^]*?redeemerbk\.com ↗/);
  assert.match(html, /<div class="pg-rail-t pictured"><div class="pg-ph [^"]*"[^>]*><img data-src="harlem\.jpg"/);
  assert.match(html, /<a class="pg-src" href="https:\/\/www\.redeemerbk\.com\/who-we-are"/);
  assert.deepEqual(parsePage(page).problems, []);
});

test("a bare web address is a link, named by its site, and its full stop stays a word", () => {
  const source = "See https://www.redeemerbk.com/who-we-are. Or (https://renewalnyc.com/) too.";
  const runs = inlineRuns(source);
  const links = runs.filter((run) => run.href);
  assert.deepEqual(links.map((run) => [run.href, run.bare, run.editable]), [
    ["https://www.redeemerbk.com/who-we-are", true, false],
    ["https://renewalnyc.com/", true, false],
  ]);
  const { html } = renderPage(parsePage(CHURCHES));
  assert.match(html, /<a class="pg-out" href="https:\/\/www\.redeemerbk\.com\/who-we-are" data-href="https:\/\/www\.redeemerbk\.com\/who-we-are" title="[^"]+">redeemerbk\.com\/who-we-are ↗<\/a>/);
  assert.doesNotMatch(inlineRuns("javascript:alert(1) and ahttps://x.example").map((run) => run.href ?? "").join(""), /./, "only an address that starts a word, and only the web's");
});

test("through the turn's checks, a bare page saved and texted is sent back for its cover", async () => {
  const { claimCheck } = await import("../src/agent/claimCheck.js");
  const watch = claimCheck({ question: "research new church plants in NYC" });
  const call = watch.wrap(async (name) => ({ content: [{ type: "text", text: name === "write_note" ? "saved" : "drawn" }] }));
  await call("write_note", { path: "projects/churches.page.md", content: BARE });
  assert.match(String(await watch.check("Eight plants.\n\nhttps://context.lc/p/@seyi/projects/churches.page.md")), /has no picture at all/);
  const drawn = claimCheck({ question: "research new church plants in NYC" });
  const again = drawn.wrap(async () => ({ content: [{ type: "text", text: "ok" }] }));
  await again("write_note", { path: "projects/churches.page.md", content: BARE });
  await again("send", { action: "draw_visual", args: { template: "page", data: { path: "projects/churches.page.md" } } });
  assert.doesNotMatch(String(await drawn.check("Eight plants.\n\nhttps://context.lc/p/@seyi/projects/churches.page.md")), /has no picture at all/);
});
