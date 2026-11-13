import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BEHIND_THE_RESPONSE, groupChat, oneToOne } from "../chats.mjs";

const BUDGET = new URL("../speed-budget.json", import.meta.url);
const REPORTING = new URL("../../../src/controlPlane/reporting.js", import.meta.url);

/** The five simple turns the budgets cover, each measured the way production meets it. */
async function measure() {
  const seen = {};
  const chat = await oneToOne();
  try {
    seen["1:1 first text"] = (await chat.text("hi Tex", "Hey.")).calls;
    seen["1:1 warm text"] = (await chat.text("what's on today?", "Nothing on the calendar.")).calls;
    chat.deploy();
    seen["1:1 text after a deploy"] = (await chat.text("thanks", "Anytime.")).calls;
  } finally {
    chat.restore();
  }
  const group = await groupChat();
  try {
    seen["group first tag"] = (await group.tag("ada", "Tex hi", "Hi all.")).calls;
    seen["group tag"] = (await group.tag("bo", "Tex what's up", "Not much.", [{ from: "cy", text: "lol" }])).calls;
  } finally {
    group.restore();
  }
  return seen;
}

export default {
  id: "speed-budgets",
  incident: "2026-10 to 11-13: Tex's reply speed was fixed in several campaigns and kept slipping back, each change adding a step that passed its own tests.",
  cause: "Nothing counted what a simple turn asks for before Tex can speak, so each added call went unseen.",
  path: "1:1 and group, simple turns",
  measure,
  async run() {
    // Every report reporting.js sends behind the response is in the list the count leaves out, and nothing else is.
    const sent = [...(await readFile(REPORTING, "utf8")).matchAll(/post\("(\/gateway\/[^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual([...BEHIND_THE_RESPONSE].sort(), [...new Set(sent)].sort(), "chats.mjs BEHIND_THE_RESPONSE matches src/controlPlane/reporting.js");

    const { paths } = JSON.parse(await readFile(BUDGET, "utf8"));
    const seen = await measure();
    assert.deepEqual(Object.keys(seen).sort(), Object.keys(paths).sort(), "every budgeted path is measured");
    const wrong = Object.entries(seen).flatMap(([path, calls]) =>
      ["model", "beforeModel"].flatMap((kind) => {
        const budget = paths[path][kind];
        if (calls[kind] > budget) {
          const named = kind === "beforeModel" ? `\n    calls before the first model call now:\n      ${calls.before.join("\n      ")}` : "";
          return [`${path}: ${kind} ${calls[kind]} is over its budget of ${budget}.${named}`];
        }
        // A ratchet: a turn that got cheaper lowers its budget in the same change, so the room it freed cannot be spent unseen.
        if (calls[kind] < budget) return [`${path}: ${kind} ${calls[kind]} is under its budget of ${budget}; lower it to ${calls[kind]} in test/replay/speed-budget.json.`];
        return [];
      }),
    );
    assert.deepEqual(wrong, [], `speed budgets (apps/mcp/test/replay/speed-budget.json; raising one needs "Speed budget raised: <why>" in the pull request):\n${wrong.join("\n")}`);
  },
};
