/**
 * A bench world's people by handle: `set_visibility`'s `people` names a world person as `@handle`, and the control plane
 * stub resolves it through the directory `benchHandles` seeds (`world.mjs`). Driven through the world's own MCP endpoint,
 * as the person's AI client calls it.
 *
 * Sabotage: drop the `benchHandles` seeding in `createWorld` and the first test fails with GRANTEE_NOT_FOUND's refusal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { benchHandles, createWorld } from "../world.mjs";

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const bench = {
  people: [
    { person: "Maya", workspace: "maya", role: "owner", personal: true },
    { person: "Maya", workspace: "brand", role: "owner", personal: false },
    { person: "Priya", workspace: "priya", role: "owner", personal: true },
    { person: "Priya", workspace: "brand", role: "member", personal: false },
  ],
  workspaces: {
    maya: { files: { "health/dentist.md": "DENTIST-MARK Tuesday 3 pm\n" }, heldBack: [] },
    priya: { files: { "todo.md": "- nothing\n" }, heldBack: [] },
    brand: { files: { "people/john.md": "PAY-MARK John's pay\n" }, heldBack: [] },
  },
};

const noModel = async () => {
  throw new Error("no model call in this test");
};

/** Maya's world, asked over her own MCP endpoint: one `set_visibility` on her note, naming `who` as `people`. */
async function shareDentist(people) {
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: noModel });
  try {
    const body = await world.mcp("tools/call", { name: "set_visibility", arguments: { path: "health/dentist.md", people } });
    return { isError: body?.result?.isError === true, text: body?.result?.content?.[0]?.text ?? "" };
  } finally {
    world.close();
  }
}

test("a world person named by handle is added to the note", async () => {
  const answer = await shareDentist([{ who: "@priya" }]);
  assert.equal(answer.isError, false, answer.text);
  assert.match(answer.text, /^shared: health\/dentist\.md/);
});

test("a handle nobody in the world holds is refused, and the answer names no one", async () => {
  const answer = await shareDentist([{ who: "@stranger" }]);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /^nothing changed/);
  assert.doesNotMatch(answer.text, /stranger/);
});

test("the directory holds the world's people and nobody else", () => {
  const handles = benchHandles(bench);
  assert.deepEqual([...handles.keys()].sort(), ["@maya", "@priya"]);
  assert.deepEqual(handles.get("@priya"), { kind: "user", id: "user_bench_priya" });
});
