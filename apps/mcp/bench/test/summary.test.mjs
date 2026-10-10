/**
 * `pnpm ai summary`: what the GitHub Action puts on the run's summary page.
 * The scores and the run's summary lines, never an answer and never an id.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { summaryMarkdown } from "../summary.mjs";

const RESULT = [
  "---",
  "job: texting-assistant",
  "date: 2026-10-09",
  "code_commit: abc1234",
  "status: scored",
  "---",
  "",
  "# texting-assistant run",
  "",
  "## Summary",
  "",
  "| Setup | Model | Answers |",
  "| --- | --- | --- |",
  "| haiku | anthropic/claude-haiku-5-5 | 2 |",
  "",
  "Routed: haiku sent 0 of 2 answers to nobody.",
  "",
  "Time: haiku spent 1 min across its conversations: 1 min answering, 0 min playing the person, 0 min on worlds and reruns.",
  "",
  "## Answers",
  "",
  "### acorn-boot-linen-lagoon",
  "",
  "person: secret question",
  "",
  "## Judging",
  "",
  "## Judged by fake-judge, 2026-10-09",
  "",
  "### acorn-boot-linen-lagoon",
  "",
  "## Scored by fake-judge, 2026-10-08",
  "",
  "| setup | score |",
  "| --- | --- |",
  "| haiku | 10% |",
  "",
  "## Scored by fake-judge, 2026-10-09",
  "",
  "| setup | score |",
  "| --- | --- |",
  "| haiku | 60% |",
  "",
  "Best setup that passes every bar: none.",
  "",
].join("\n");

test("the summary carries the latest scores and the run's summary lines, and nothing else", () => {
  const md = summaryMarkdown(RESULT);
  assert.match(
    md,
    /^\*\*texting-assistant, 2026-10-09, commit abc1234, scored\*\*/,
  );
  assert.ok(
    md.indexOf("## Scored by fake-judge, 2026-10-09") <
      md.indexOf("## Summary"),
    "scores first, then the run's summary",
  );
  assert.ok(md.includes("| haiku | 60% |"), "the latest scoring");
  assert.ok(!md.includes("| haiku | 10% |"), "never an earlier scoring");
  assert.ok(md.includes("Routed: haiku sent 0 of 2 answers to nobody."));
  assert.ok(md.includes("Time: haiku spent 1 min"));
  assert.ok(!md.includes("acorn-boot-linen-lagoon"), "never an answer id");
  assert.ok(!md.includes("secret question"), "never an answer");
  assert.ok(!md.includes("## Judged by"));
});

test("an unscored result says so instead of showing nothing", () => {
  const unscored = RESULT.split("## Scored by")[0].replace(
    "status: scored",
    "status: answered",
  );
  const md = summaryMarkdown(unscored);
  assert.match(md, /_Not scored yet\._/);
  assert.ok(md.includes("## Summary"));
});

test("a search result, scored by its own summary, is not called unscored", () => {
  const raw = ["---", "job: search", "date: 2026-10-10", "status: scored", "---", "", "## Summary", "", "| Setup | Found |", "| --- | --- |", "| everywhere | 100% |", ""].join("\n");
  const out = summaryMarkdown(raw);
  assert.doesNotMatch(out, /Not scored yet/);
  assert.match(out, /\| everywhere \| 100% \|/);
  const unscored = raw.replace("status: scored", "status: not judged");
  assert.match(summaryMarkdown(unscored), /Not scored yet/);
});
