/**
 * The specialist doors' own prompts (`texConfig.json` fdQuick, fdRead, fdAct; words in packages/shared/src/texPrompt):
 * each shorter than the front door's, quick clearly the smallest, and their examples drawn from Training only.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TEX_CONFIG, TEX_PROMPT_WORDS, texModules } from "../src/agent/texConfig.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SETS = join(ROOT, "apps/mcp/bench/sets");
const SOURCES = JSON.parse(readFileSync(join(ROOT, "packages/shared/src/texDoorExampleSources.json"), "utf8")).sources;
const convs = (set) => readdirSync(join(SETS, set)).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(SETS, set, file), "utf8")));
const size = (names) => names.reduce((sum, name) => sum + TEX_PROMPT_WORDS[name].length, 0);

test("each door's prompt is shorter than the front door's, and quick's is clearly the smallest", () => {
  const drawn = texModules(TEX_CONFIG);
  // The front door's whole prompt, its Training module (train-fd) included: the doors read their own examples instead.
  const fd = size(drawn.texts);
  const [quick, read, act] = ["quick", "read", "act"].map((door) => size(drawn[`door-${door}`]));
  assert.ok(act < fd, `act ${act} < fd ${fd}`);
  assert.ok(read < act, `read ${read} < act ${act}`);
  assert.ok(quick < read * 0.75, `quick ${quick} clearly under read ${read}`);
});

test("door examples come from Training messages only: every source is a Training message, none a Dev conversation", () => {
  const training = convs("training");
  const dev = convs("dev");
  const devIds = new Set(dev.map((c) => c.id));
  assert.ok(SOURCES.length >= 15);
  for (const { door, conv, msg } of SOURCES) {
    assert.ok(["quick", "read", "act"].includes(door));
    assert.ok(!devIds.has(conv), `${conv} is a Dev conversation`);
    const c = training.find((t) => t.id === conv);
    assert.ok(c, `${conv} is not a Training conversation`);
    assert.ok(c.msgs.some((m) => m.id === msg), `${conv} has no ${msg}`);
  }
});

test("door examples carry no conversation ids and copy no Dev or Training line", () => {
  const words = ["quick", "read", "act"].map((door) => TEX_PROMPT_WORDS[`door-${door}-examples`]).join("\n").toLowerCase();
  const all = [...convs("training"), ...convs("dev")];
  for (const c of all) {
    assert.ok(!words.includes(String(c.id).toLowerCase()), `names conversation ${c.id}`);
    for (const m of c.msgs ?? []) {
      const text = String(m.text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      // Any 8-word run of a set's message, word for word, would be a copied line.
      const w = text.split(" ");
      for (let i = 0; i + 8 <= w.length; i += 1) assert.ok(!words.includes(w.slice(i, i + 8).join(" ")), `copies "${w.slice(i, i + 8).join(" ")}" from ${c.id}`);
    }
  }
});
