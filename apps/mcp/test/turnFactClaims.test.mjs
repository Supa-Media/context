// Each fact line a group turn is told claims only what its field holds, and says "not known" when the field is
// missing (Dev2, 2026-11-17: "can u find out the underlying issue why this keeps happening? its a category of bug that
// keeps surfacing"; docs/decisions/texting-assistant/turn-told-from-state.md). Every value a field can take, and its
// absence, is walked here, so a new cause or a new stock sentence fails before it reaches a chat.
//
// Sabotage checks: make `taggedLine` fall back to "@<sponsor> tagged you." when the cause is missing and the first
// test fails; drop `DEV_SHARE_NOT_KNOWN` from `devSharePrompt` and the second does; add a cause to the Worker's
// `TurnCause` without wording it here and the third does; word a judged guest's turn with `INVITED_TAGGER_LINE`
// ("The person who tagged you") and the first does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { devSharePrompt } from "../../../packages/tex/gateway/agent/devShare.js";
import { groupOf } from "../../../packages/tex/gateway/agent/groupTurn.js";
import { taggedLine, TURN_CAUSES } from "../../../packages/tex/gateway/agent/groupTurnCause.js";

const KEY = "c3".repeat(32);
const MEMBERS = "d4".repeat(32);
const NAMES_TEX = new Set(["tagged", "named"]);
const NOBODY_TEXTED = new Set(["check_in", "routine", "job_report", "cross_chat", "vault_saved", "browser_handed_back"]);

/**
 * Every shape a group reaches `taggedLine` in, as `groupOf` leaves it: a member who texted, an invited person with no
 * handle (`guestTagger`), a guest known by label, and a guest chat's guest.
 */
const SHAPES = [
  { name: "a member", group: { from: "shyoh" } },
  { name: "an invited person", group: { from: "" } },
  { name: "a guest by label", group: { from: "", guests: ["guest-1a2b"], asker: "guest-1a2b" } },
  { name: "a guest chat's guest", group: { from: "", guests: ["guest-1a2b"], asker: "guest-1a2b" }, homeOnly: true },
];
const chat = (shape, cause) => {
  const group = groupOf({ group: { key: KEY, members: MEMBERS, people: ["shyoh", "ada"], ...shape.group, ...(cause === undefined ? {} : { cause }) } });
  assert.ok(group, shape.name);
  return shape.homeOnly ? { ...group, homeOnly: true } : group;
};

// "tagged you" claimed as a fact, not "Nobody tagged you" or "never say anyone tagged you".
const CLAIMS_TAG = /(?<!Nobody |anyone |who )tagged you\b/;

test("the cause line claims a tag only for a text that names Tex, says nobody texted only when nobody did, and says not known only when it isn't", () => {
  for (const shape of SHAPES) {
    for (const cause of [...TURN_CAUSES, undefined, "made up"]) {
      const line = taggedLine(chat(shape, cause));
      const at = `${shape.name}, cause ${cause}`;
      const known = TURN_CAUSES.includes(cause);
      assert.equal(CLAIMS_TAG.test(line), known && NAMES_TEX.has(cause), `${at} claims a tag: ${line}`);
      assert.equal(/^Nobody (here )?texted you/.test(line), known && NOBODY_TEXTED.has(cause), `${at}: ${line}`);
      assert.equal(/^Why this turn runs is not known/.test(line), !known, `${at}: ${line}`);
      // Who: named only from a field; with none, the line says who is not known rather than "Someone".
      if (known && (NAMES_TEX.has(cause) || cause === "reaction") && !shape.group.from && !shape.group.asker) assert.match(line, /not known/, `${at}: ${line}`);
      if (shape.group.from) assert.ok(!NAMES_TEX.has(cause) || !known || line.includes("@shyoh"), `${at}: ${line}`);
    }
  }
});

test("the sharing line says shared only when it is, names exactly who said yes and who hasn't, and says not known with no state", () => {
  for (const shared of [true, false]) {
    for (const by of [[], ["ada"], ["ada", "someone"]]) {
      for (const waiting of shared ? [[]] : [[], ["shyoh"], ["someone"]]) {
        const line = devSharePrompt({ shared, by, waiting });
        const at = `shared ${shared}, by ${by}, waiting ${waiting}`;
        assert.equal(/this chat is shared with/.test(line), shared, at);
        assert.equal(/this chat is not shared with/.test(line), !shared, at);
        assert.doesNotMatch(line, /not known/, at);
        for (const handle of ["ada", "shyoh"]) assert.equal(line.includes(`@${handle}`), by.includes(handle) || waiting.includes(handle), `${at}: @${handle}`);
        assert.equal(/someone without a handle/.test(line), by.includes("someone") || waiting.includes("someone"), at);
      }
    }
  }
  for (const missing of [undefined, null, {}, { shared: "yes" }, "shared"]) {
    const line = devSharePrompt(missing);
    assert.match(line, /is not known/, String(missing));
    assert.doesNotMatch(line, /this chat is (not )?shared with|said yes:|@/, String(missing));
  }
});

test("every cause the Worker can name is one the gateway words", () => {
  const source = readFileSync(new URL("../../../packages/tex/worker/groupCause.ts", import.meta.url), "utf8");
  const union = source.match(/export type TurnCause =([^;]+);/)?.[1] ?? "";
  const worker = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(worker.length > 5, "the Worker's TurnCause union was found");
  assert.deepEqual([...worker].sort(), [...TURN_CAUSES].sort());
});
