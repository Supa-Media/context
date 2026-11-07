import test from "node:test";
import assert from "node:assert/strict";

import { SAY_NOTHING, sendCall, typedCallNotice, typedCallOf } from "../src/agent/sayNothing.js";

// A group, 2026-11-06 20:01 UTC: Tex texted `{ action: "say_nothing" }`. Dev2 chose a code catch plus prompts that name calls in words.

test("a call typed out as the reply is found; words a person could mean are not", () => {
  for (const [text, action] of [
    ['{ action: \u201csay_nothing" }', "say_nothing"],
    ['send { action: "say_nothing" }', "say_nothing"],
    ["say_nothing", "say_nothing"],
    ['{"action":"background","args":{"title":"x"}}', "background"],
    ['```json\n{ "action": "job_status" }\n```', "job_status"],
  ]) assert.equal(typedCallOf(text), action, text);
  for (const text of ['The action is { action: "x" }', "{ curly } thing", "I will say nothing.", "", "Sure: say_nothing works if you call it"]) assert.equal(typedCallOf(text), null, text);
});

test("prompts name a call in words, never as code", () => {
  assert.equal(SAY_NOTHING, "call send with action say_nothing");
  assert.equal(sendCall("steer_job", "title, note"), "call send with action steer_job (args: title, note)");
  assert.doesNotMatch(SAY_NOTHING, /[{}]/);
  assert.match(typedCallNotice("background"), /Not sent/);
});
