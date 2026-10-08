/**
 * The benchmark world must hold back what the product holds back, or a setup
 * that leaks would score as one that answers. Driven through a scripted model
 * that reads one note in one workspace, as different invented people.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorld, manifest } from "../world.mjs";

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
    brand: {
      files: { "people/john.md": "PAY-MARK John's pay\n", "todo.md": "TODO-MARK order twill\n" },
      heldBack: ["people/john.md"],
    },
  },
};

/** A model that calls one tool with the given arguments, then repeats the result. */
function readsOnce(args, name = "read_note") {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((block) => block.type === "tool_result") : null;
    const reply = result
      ? { content: [{ type: "text", text: JSON.stringify(result.content) }], stop_reason: "end_turn" }
      : { content: [{ type: "tool_use", id: "toolu_1", name, input: args }], stop_reason: "tool_use" };
    return new Response(JSON.stringify({ ...reply, usage: { input_tokens: 10, output_tokens: 5 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function ask(person, args, name) {
  const world = await createWorld(bench, person, SETUP, { gatewayFetch: readsOnce(args, name) });
  try {
    const turn = await world.text("go");
    return { turn, changes: world.changes() };
  } finally {
    world.close();
  }
}

test("a member never reads a note the workspace holds back", async () => {
  const { turn } = await ask("Priya", { path: "people/john.md", context: "@brand" });
  assert.ok(turn.ok);
  assert.ok(!turn.answer.includes("PAY-MARK"), "the held-back note stayed held back");
});

test("the owner reads the same note, so the refusal above is privacy and not a broken world", async () => {
  const { turn } = await ask("Maya", { path: "people/john.md", context: "@brand" });
  assert.ok(turn.answer.includes("PAY-MARK"));
});

test("a member reads the shared workspace's ordinary notes", async () => {
  const { turn } = await ask("Priya", { path: "todo.md", context: "@brand" });
  assert.ok(turn.answer.includes("TODO-MARK"));
});

test("nobody reaches a workspace people.md does not give them", async () => {
  const { turn } = await ask("Priya", { path: "health/dentist.md", context: "@maya" });
  assert.ok(!turn.answer.includes("DENTIST-MARK"));
});

test("a change from a text is written straight to the note, and recorded with its path", async () => {
  const { changes } = await ask(
    "Maya",
    { path: "orders.md", content: "- order more twill\n", context: "@brand" },
    "write_note",
  );
  // The gateway's own bookkeeping for a new note (privacy.md, activity) is
  // recorded too; what matters is that the note itself was written, not proposed.
  const listed = changes.map(({ workspace, path, kind }) => ({ workspace, path, kind }));
  assert.ok(listed.some((c) => c.workspace === "brand" && c.path === "orders.md" && c.kind === "written"));
  assert.ok(!listed.some((c) => c.kind === "proposed"));
});

test("the world lets no request out except the model's", async () => {
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: readsOnce({ path: "todo.md" }) });
  try {
    await assert.rejects(() => globalThis.fetch("https://example.com/"), /outside the model/);
  } finally {
    world.close();
  }
});

test("a shared workspace shares its folders and root notes, and holds back the named ones", () => {
  const text = manifest({ shared: true, files: ["people/john.md", "people/maya.md", "todo.md"], heldBack: ["people/john.md"] });
  assert.match(text, /default_visibility: private/);
  assert.match(text, /folder_defaults:\n {2}people: team\n/);
  assert.match(text, /note_overrides:\n {2}todo\.md: team\n {2}people\/john\.md: private\n/);
  assert.doesNotMatch(manifest({ shared: false, files: ["todo.md", "a/b.md"] }), /: team/);
});

/**
 * The 2026-10-08 results were worthless because of this: one search spent the
 * free-tier store budget on a bucket scan, and every read, listing and orient
 * after it in the same turn failed. The world must give a turn the deployed
 * budget, so that a search is followed by reads that work.
 */
test("after a search, reads, listing and orient in the same turn still work", async () => {
  const files = { "health/dentist.md": "# Dentist\n\nAppointment: Tuesday 3 pm. DENTIST-MARK\n" };
  for (let i = 0; i < 30; i += 1) files[`notes/filler-${i}.md`] = `# Filler ${i}\n\nNothing about teeth here, note ${i}.\n`;
  const big = { ...bench, workspaces: { ...bench.workspaces, maya: { files, heldBack: [] } } };
  const calls = [
    { name: "search_notes", input: { query: "dentist" } },
    { name: "read_note", input: { path: "health/dentist.md" } },
    { name: "list_notes", input: {} },
    { name: "orient", input: {} },
  ];
  let seen = 0;
  const scripted = async (_url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    if (Array.isArray(last?.content) && last.content.some((block) => block.type === "tool_result")) seen += 1;
    const reply =
      seen < calls.length
        ? { content: [{ type: "tool_use", id: `toolu_${seen}`, name: calls[seen].name, input: calls[seen].input }], stop_reason: "tool_use" }
        : { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" };
    return new Response(JSON.stringify({ ...reply, usage: { input_tokens: 10, output_tokens: 5 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const world = await createWorld(big, "Maya", SETUP, { gatewayFetch: scripted });
  try {
    const turn = await world.text("go");
    assert.ok(turn.ok);
    assert.deepEqual(
      turn.tools,
      calls.map((call) => ({ tool: call.name, ok: true })),
      `every call after the search must succeed, got ${JSON.stringify(turn.tools)}`,
    );
  } finally {
    world.close();
  }
});
