/**
 * Pages start from a template (owner, 2026-11-10: pages "were supposed to
 * have templates"). Six built-ins, each a page that draws; the page skill
 * names them and where a person's own live; `orient about: "template <name>"`
 * hands one out with the current stamp in it.
 *
 * Sabotage record (2026-11-10): a template with a block that can't be drawn,
 * the template list dropped from the skill, and the stamp left as its
 * placeholder each failed the test named for it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { pageProblems, pageSkillMissing } from "../src/pages.js";
import { PAGE_SKILL, PAGE_SKILL_STAMP } from "../src/pageSkill.js";
import { toolOrient } from "../src/orient/tool.js";
import templates from "../../../packages/shared/src/pages/templates.cjs";
import pages from "../../../packages/shared/src/pages/index.cjs";

const { TEMPLATES, templateSource } = templates;
const text = (result) => result.content.map((part) => part.text).join("\n");
const orient = (about) => toolOrient({}, "team", [], {}, { about });

test("every built-in template is a page that draws, and is saved as one", () => {
  assert.deepEqual(TEMPLATES.map((t) => t.name), ["decision", "research", "plan", "status", "review", "trip"]);
  for (const { name } of TEMPLATES) {
    const source = templateSource(name, PAGE_SKILL_STAMP);
    assert.equal(pageSkillMissing(source), null, name);
    assert.equal(pageProblems(source), null, name);
    const { html } = pages.renderPage(pages.parsePage(source));
    assert.ok(html.length > 500, name);
  }
});

test("the page skill names every template and where their own templates live", () => {
  for (const { name } of TEMPLATES) assert.ok(PAGE_SKILL.includes(`- \`${name}\``), name);
  assert.ok(PAGE_SKILL.includes("`tex/templates/`"));
  assert.ok(PAGE_SKILL.includes("keep a page as a template"));
  assert.ok(PAGE_SKILL.includes('orient about: "template <name>"'));
});

test("orient hands out a template with the current stamp, and names them all for a wrong name", async () => {
  const decision = await orient("template decision");
  assert.notEqual(decision.isError, true);
  assert.ok(text(decision).includes(`skill: ${PAGE_SKILL_STAMP}`));
  assert.ok(!text(decision).includes("{stamp}"));
  assert.ok(text(decision).includes("```vote"));
  const colon = await orient("template: Trip");
  assert.ok(text(colon).includes("```places"));
  const wrong = await orient("template invoice");
  assert.equal(wrong.isError, true);
  for (const { name } of TEMPLATES) assert.ok(text(wrong).includes(`\`${name}\``), name);
});
