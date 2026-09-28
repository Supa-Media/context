import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bringPrompt, DEFAULT_TOPICS, SYNC_REPORT } from "../features/agentSetup/bring";

/**
 * The setup widget's pasted prompt and the plugin's `/context:sync` skill do
 * the same job for people with and without the plugin, so they must carry the
 * same rules. A rule changed in one place and not the other is how a pasted
 * prompt starts overwriting notes that the skill protects.
 */
const skill = readFileSync(join(__dirname, "../../../plugins/context/skills/sync/SKILL.md"), "utf8");
const prompt = bringPrompt("supa", DEFAULT_TOPICS);

const SHARED_RULES: readonly [string, RegExp][] = [
  ["orient first", /orient/],
  ["adds to an existing note and removes nothing", /remove nothing/i],
  ["keeps a disagreement beside the note instead of replacing it", /According to <?your name>?:/],
  ["writes without stopping to ask", /Don't stop to ask/],
  ["writes only what it knows", /Only write what you actually know/],
  ["leaves the front page alone", /index\.md/],
  ["leaves the privacy manifest alone", /privacy\.md/],
  ["ends with the report note the widget watches for", new RegExp(`"${SYNC_REPORT}"`)],
];

describe("the sync prompt and the sync skill say the same thing", () => {
  for (const [label, rule] of SHARED_RULES) {
    test(label, () => {
      expect(prompt).toMatch(rule);
      expect(skill).toMatch(rule);
    });
  }
});
