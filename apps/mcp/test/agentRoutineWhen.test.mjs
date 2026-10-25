/**
 * A WRITTEN REMINDER SAYS WHEN IT TEXTS, OR WHY IT WON'T (a review of a chat,
 * 2026-10-25: "remind me to respond to elizabeth tmrw 5pm", one write_note,
 * "Will do.", and nothing showing a reminder would come; `routineWhen.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `withRunTime` returning the result untouched → "a reminder written by
 *     text is told when it texts" fails.
 *   `routineWhen` ignoring the turn's zone (UTC) → "…in their zone" fails.
 *   `nextRunAt`'s null not turned into `runs: false` → "a time already gone"
 *     fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { routineWhen } from "../src/agent/routineWhen.js";
import { textingAwareCallTool } from "../src/agent/textingWrites.js";

// Saturday, October 24, 2026, 10:43 pm in New York (02:43 UTC on the 25th), when the text came.
const NOW = Date.parse("2026-10-25T02:43:00Z");
const ZONE = "America/New_York";
const REMINDER = "---\nat: 2026-10-25 5:00 pm\n---\nRespond to Elizabeth.\n";
const PATH = "tex/routines/once/respond-to-elizabeth.md";
const textOf = (result) => result?.content?.map((part) => part.text).join("\n") ?? "";

test("a one-off says the day and time it texts, in their zone, and that it's tomorrow", () => {
  const when = routineWhen(PATH, REMINDER, ZONE, NOW);
  assert.equal(when.runs, true);
  assert.equal(when.text, "It first texts them Sunday, October 25 at 5:00 pm, tomorrow (America/New_York). If that isn't when they asked for, fix its at: line now.");
  // The same line read in UTC would be "today": the zone is theirs, not the server's.
  assert.match(routineWhen(PATH, REMINDER, "UTC", NOW).text, /October 25 at 5:00 pm, today \(UTC\)/);
});

test("a time already gone, a line it can't read, and a paused one each say it won't text", () => {
  const gone = routineWhen(PATH, "---\nat: 2026-10-24 5:00 pm\n---\nRespond to Elizabeth.\n", ZONE, NOW);
  assert.equal(gone.runs, false);
  assert.match(gone.text, /already passed where they are \(it is now Saturday, October 24 at 10:43 pm, today\)/);
  const unread = routineWhen(PATH, "---\nat: tmrw 5pm\n---\nRespond to Elizabeth.\n", ZONE, NOW);
  assert.equal(unread.runs, false);
  assert.match(unread.text, /won't run as written: "at: tmrw 5pm" isn't a date and time/);
  assert.equal(routineWhen(PATH, "---\nat: 2026-10-25 5:00 pm\npaused: yes\n---\nx\n", ZONE, NOW).runs, false);
  assert.equal(routineWhen("projects/elizabeth.md", REMINDER, ZONE, NOW), null, "not a routine");
  assert.match(routineWhen("tex/routines/daily/standup.md", "---\nat: 9:00 am\n---\nMy day.\n", ZONE, NOW).text, /Sunday, October 25 at 9:00 am, tomorrow/);
});

test("a reminder written by text is told when it texts; any other write is not", async () => {
  const writeTools = [{ name: "write_note", inputSchema: { type: "object", properties: { path: {}, content: {}, expected_etag: {}, context: {} } } }];
  const callTool = async (name) => (name === "list_notes" ? { content: [{ type: "text", text: "" }] } : { content: [{ type: "text", text: "Saved." }] });
  const call = textingAwareCallTool(callTool, writeTools, { timeZone: ZONE });
  const told = textOf(await call("write_note", { path: PATH, content: REMINDER }));
  assert.match(told, /^Saved\.\nIt first texts them Sunday, October 25 at 5:00 pm/);
  assert.equal(textOf(await call("write_note", { path: "todo.md", content: "- [ ] Elizabeth" })), "Saved.");
});
