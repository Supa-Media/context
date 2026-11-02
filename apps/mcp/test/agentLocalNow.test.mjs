/**
 * TEX KNOWS WHAT TIME IT IS WHERE THE PERSON IS (owner, 2026-10-14).
 *
 * Tex told Seyi it had "no clock for this chat" and asked for his phone's time
 * before it would set "remind me to sleep in 2 minutes". Every turn is now told
 * the day, date and time in the person's zone, and the same instant in the
 * form a one-off routine's `at:` line takes.
 *
 * ## Sabotage record
 *
 *   `runTurn` dropping `localNow` from the system prompt
 *     → "a turn is told the time where they are" fails
 *   `localNowPrompt` formatting in UTC instead of the zone
 *     → "the prompt gives the wall clock in their zone, as an at: line too" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { DEFAULT_TIME_ZONE, localNowPrompt, readTimeZone } from "../src/agent/localNow.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";
// Wednesday, October 14, 2026, 03:35 UTC = Tuesday, October 13, 11:35 pm in New York.
const NOW = Date.UTC(2026, 9, 14, 3, 35);

test("the prompt gives the wall clock in their zone, as an at: line too", () => {
  const ny = localNowPrompt(NOW, "America/New_York");
  assert.match(ny, /It is now Tuesday, October 13, 2026, 11:35 pm where they are \(America\/New_York\)/);
  assert.match(ny, /at: line that is 2026-10-13 11:35 pm/);
  assert.match(ny, /never ask them for it/);
  assert.match(localNowPrompt(NOW, "Asia/Tokyo"), /Wednesday, October 14, 2026, 12:35 pm .*\(Asia\/Tokyo\)/);
  assert.match(localNowPrompt(Date.UTC(2026, 9, 14, 4, 5), "UTC"), /4:05 am/);
  assert.match(localNowPrompt(Date.UTC(2026, 9, 14, 0, 0), "UTC"), /12:00 am/);
});

test("a zone that isn't one is never used; the default is, by name", () => {
  assert.equal(readTimeZone("Europe/London"), "Europe/London");
  for (const bad of ["", "Not/AZone", 42, null, undefined, "x".repeat(65)]) assert.equal(readTimeZone(bad), null);
  assert.match(localNowPrompt(NOW, "Not/AZone"), new RegExp(`\\(${DEFAULT_TIME_ZONE.replace("/", "\\/")}\\)`));
});

test("a turn is told the time where they are", async () => {
  const calls = [];
  const ai = {
    async run(model, input) {
      calls.push(input);
      return { choices: [{ message: { content: "Set." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  };
  await runTurn({
    question: "remind me to sleep in 2 minutes",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [],
    callTool: async () => ({ content: [] }),
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    localNow: { now: NOW, timeZone: "America/New_York" },
  });
  // The time is said in the person's turn, after the cached prefix (`turn.js`), never in the system prompt.
  const system = calls[0].messages.find((m) => m.role === "system")?.content ?? "";
  assert.doesNotMatch(system, /It is now /);
  const asked = calls[0].messages.at(-1)?.content ?? "";
  assert.match(asked, /It is now Tuesday, October 13, 2026, 11:35 pm/);
  assert.match(asked, /remind me to sleep in 2 minutes$/);
});
