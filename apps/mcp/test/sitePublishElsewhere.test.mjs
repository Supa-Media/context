/**
 * PUBLISHING ANOTHER WORKSPACE'S WEBSITE IS ONE ASK: PUBLISH IT.
 *
 * On 2026-11-18 Dev2 said "publish seyi, public worship and context-lc", and
 * every `manage website publish` with `context: "@seyi"` (and the other two)
 * was refused. The judge was asked about "publish the website, and write
 * website/index.md into @seyi": a site action writes no note (`site.js`
 * refuses content beside it), so the second half was an act nobody asked
 * for, and the judge rightly found no words for it.
 *
 * ## Sabotage record
 *
 *   the `a.site === undefined` guard on the elsewhere facet removed
 *     → "a site publish in another workspace is judged as a publish alone" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { wideningOf } from "../src/privacy/widening.js";

const privacy = async () => ({ rules: [{ prefix: "", vis: "private" }], overrides: new Map() });

test("a site publish in another workspace is judged as a publish alone", async () => {
  const widening = await wideningOf(
    "write_note",
    { path: "website/index.md", site: { action: "publish", draft: "9e254296df358490" } },
    { into: "@seyi", privacy, writes: true },
  );
  assert.equal(widening.audience, "anyone");
  assert.equal(widening.summary, "publish the @seyi website");
  assert.doesNotMatch(widening.summary, /write /);
});

test("a site publish in the caller's own workspace says so plainly", async () => {
  const widening = await wideningOf(
    "write_note",
    { path: "website/index.md", site: { action: "publish" } },
    { privacy, writes: true },
  );
  assert.equal(widening.summary, "publish the website");
});

test("a site check in another workspace is never judged", async () => {
  const widening = await wideningOf(
    "write_note",
    { path: "website/index.md", site: { action: "check" } },
    { into: "@seyi", privacy, writes: true },
  );
  assert.ok(widening === null || widening.elsewhereOnly === true);
  assert.doesNotMatch(widening?.summary ?? "", /website\/index\.md/);
});

test("an ordinary write into another workspace is still an elsewhere write", async () => {
  const widening = await wideningOf("write_note", { path: "notes/a.md", content: "x" }, { into: "@seyi", privacy, writes: true });
  assert.equal(widening.elsewhereOnly, true);
  assert.match(widening.summary, /write notes\/a\.md into @seyi/);
});
