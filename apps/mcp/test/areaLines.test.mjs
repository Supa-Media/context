/**
 * A project's `area:` line follows its area when the area's folder moves (`src/moves/areaLines.js`; the owner,
 * 2026-11-25). The promises: a folder move or rename of the area points the line at the new folder, a sub-area's
 * line too, quotes and the rest of the note kept; moving one note out of the area is not moving the area; an
 * `area: true` marker is never rewritten; a line is never pointed where the note's own readers cannot go; and the
 * gateway's move rewrite reads the project's front note even though no link fact names it.
 *
 * ## Sabotage record
 *
 * Following the line on any rename under the folder failed "moving one note out of an area does not move the area".
 * Dropping the front-note candidates from `rewriteReferences` failed "a move's rewrite reads the projects' front
 * notes".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { R2Store } from "../src/store/r2.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { loadPrivacyState } from "../src/privacy/state.js";
import { followAreaLine } from "../src/moves/areaLines.js";
import { referenceCandidates, rewriteReferences } from "../src/tools/moves/references.js";

const folderMove = (from, to, names) => new Map(names.map((name) => [`${from}/${name}`, `${to}/${name}`]));

test("an area's folder move points the line at the new folder and keeps the rest", () => {
  const text = "---\nstatus: In progress\narea: areas/finance\nowner: \"@seyi\"\n---\n\n# Website\n";
  const renames = folderMove("areas/finance", "areas/money", ["about.md", "budget.md"]);
  const followed = followAreaLine(text, renames);
  assert.equal(followed.text, "---\nstatus: In progress\narea: areas/money\nowner: \"@seyi\"\n---\n\n# Website\n");
  assert.equal(followed.changed, 1);
});

test("a quoted line keeps its quotes, and a sub-area follows its parent's move", () => {
  const renames = folderMove("areas/finance", "areas/money", ["about.md", "payroll/about.md"]);
  assert.equal(
    followAreaLine("---\narea: \"areas/finance/payroll\"\n---\n", renames).text,
    "---\narea: \"areas/money/payroll\"\n---\n",
  );
});

test("moving one note out of an area does not move the area", () => {
  const renames = new Map([["areas/finance/budget.md", "inbox/budget.md"]]);
  assert.equal(followAreaLine("---\narea: areas/finance\n---\n", renames), null);
  // Its front note leaving under another name is not the area moving either.
  assert.equal(followAreaLine("---\narea: areas/finance\n---\n", new Map([["areas/finance/about.md", "inbox/finance.md"]])), null);
});

test("a line naming no moved area, an area marker, or a line outside front matter is left alone", () => {
  const renames = folderMove("areas/finance", "areas/money", ["about.md"]);
  assert.equal(followAreaLine("---\narea: areas/design\n---\n", renames), null);
  assert.equal(followAreaLine("---\narea: true\n---\n", renames), null);
  assert.equal(followAreaLine("# Note\n\narea: areas/finance\n", renames), null);
  assert.equal(followAreaLine("---\narea: areas/financeX\n---\n", renames), null);
});

test("a line is not pointed where the note's own readers cannot go", () => {
  const renames = folderMove("areas/finance", "areas/secret/finance", ["about.md"]);
  assert.equal(followAreaLine("---\narea: areas/finance\n---\n", renames, () => false), null);
});

test("a move's rewrite reads the projects' front notes, though no link fact names them", async () => {
  const raw = memoryBucket();
  await raw.put("privacy.md", "");
  await raw.put("areas/money/about.md", "---\nowner: \"@seyi\"\n---\n\n# Finance\n");
  await raw.put("projects/website/about.md", "---\nstatus: In progress\narea: areas/finance\n---\n\n# Website\n");
  await raw.put("projects/website/plan.md", "# Plan\n");
  const store = Object.create(new R2Store(raw));
  Object.defineProperty(store, "treeManifest", {
    value: async () => ({
      served: true,
      entries: [{ path: "areas/finance/about.md" }, { path: "projects/website/about.md" }, { path: "projects/website/plan.md" }],
      cursor: null,
    }),
    enumerable: false,
  });
  Object.defineProperty(store, "treeFacts", {
    value: async () => ({ served: true, candidates: { pointing: [], unparsed: [] } }),
    enumerable: false,
  });
  const renames = new Map([["areas/finance/about.md", "areas/money/about.md"]]);
  const options = await referenceCandidates(store, renames);
  const state = await loadPrivacyState(store);
  const result = await rewriteReferences(store, "private", state.rules, state.overrides, renames, options);
  assert.equal(result.notes, 1);
  assert.match(await (await raw.get("projects/website/about.md")).text(), /^area: areas\/money$/m);
});
