/**
 * A warm run: the search database is filled once, then every conversation
 * starts from a copy of it. The claims: the first search of a conversation is
 * answered from the index rather than a bucket scan, a turn's write never
 * reaches the next conversation, and nothing the warming installed is left
 * behind.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { createWorld } from "../world.mjs";
import { prepareRun } from "../warm.mjs";

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const files = { "health/dentist.md": "---\nupdated: 2026-10-01\n---\n\n# Dentist\n\nAppointment: Tuesday 3 pm. DENTIST-MARK\n" };
for (let i = 0; i < 30; i += 1) files[`notes/filler-${i}.md`] = `# Filler ${i}\n\nNothing about teeth here, note ${i}.\n`;

const bench = {
  people: [
    { person: "Maya", workspace: "maya", role: "owner", personal: true },
    { person: "Maya", workspace: "brand", role: "owner", personal: false },
    { person: "Priya", workspace: "priya", role: "owner", personal: true },
    { person: "Priya", workspace: "brand", role: "member", personal: false },
  ],
  workspaces: {
    maya: { files, heldBack: [] },
    priya: { files: { "todo.md": "- nothing\n" }, heldBack: [] },
    brand: { files: { "people/john.md": "PAY-MARK John's pay\n", "todo.md": "TODO-MARK order twill\n" }, heldBack: ["people/john.md"] },
  },
};

/** A model that runs the given calls in order, then says done. */
function scripted(calls) {
  let seen = 0;
  return async (_url, init) => {
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
}

/** The gateway's search log lines written while `work` runs. */
async function searchLogs(work) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    const line = args.map(String).join(" ");
    if (line.includes('"event":"search"')) lines.push(JSON.parse(line));
  };
  try {
    await work();
  } finally {
    console.log = original;
  }
  return lines;
}

test("a warm run indexes every workspace, and the first search of a conversation is served from the index", async () => {
  const fetchBefore = globalThis.fetch;
  const prepared = await prepareRun(bench, { today: "2026-10-08" });
  try {
    assert.equal(globalThis.fetch, fetchBefore, "warming leaves no stub installed");
    assert.ok([...prepared.buckets.get("maya").keys()].some((key) => key.startsWith(".context/")), "the index shards are in the snapshot");
    assert.ok(prepared.passes.get("maya") >= 1);

    const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: scripted([{ name: "search_notes", input: { query: "dentist" } }]) }, "2026-10-08", prepared);
    let logs;
    try {
      logs = await searchLogs(async () => {
        const turn = await world.text("go");
        assert.ok(turn.ok, turn.error);
        assert.deepEqual(turn.tools, [{ tool: "search_notes", ok: true }]);
      });
    } finally {
      world.close();
    }
    const [log] = logs;
    assert.ok(log, "the search was logged");
    assert.equal(log.indexed, true, JSON.stringify(log));
    assert.equal(log.fast, true, "answered from the search database, not a scan");
    assert.ok(log.spent < 20, `a warm search is cheap, spent ${log.spent}`);
  } finally {
    prepared.close();
  }
});

test("a turn's write in one conversation never reaches the next", async () => {
  const prepared = await prepareRun(bench);
  try {
    const first = await createWorld(bench, "Maya", SETUP, { gatewayFetch: scripted([{ name: "write_note", input: { path: "orders.md", content: "ORDER-MARK more twill\n" } }]) }, null, prepared);
    try {
      const turn = await first.text("go");
      assert.ok(turn.ok, turn.error);
      assert.ok(first.changes().some((change) => change.path === "orders.md" && change.kind === "written"));
    } finally {
      first.close();
    }
    const second = await createWorld(bench, "Maya", SETUP, { gatewayFetch: scripted([{ name: "search_notes", input: { query: "ORDER-MARK" } }, { name: "list_notes", input: {} }]) }, null, prepared);
    try {
      const turn = await second.text("go");
      assert.ok(turn.ok, turn.error);
      assert.ok(!turn.answer.includes("orders.md"), turn.answer);
      assert.equal(second.changes().length, 0, "the second world starts from the snapshot");
    } finally {
      second.close();
    }
  } finally {
    prepared.close();
  }
});

test("a warmed world still holds back what the workspace holds back", async () => {
  const prepared = await prepareRun(bench);
  try {
    const world = await createWorld(bench, "Priya", SETUP, { gatewayFetch: scripted([{ name: "search_notes", input: { query: "PAY-MARK", context: "@brand" } }, { name: "read_note", input: { path: "people/john.md", context: "@brand" } }]) }, null, prepared);
    try {
      const turn = await world.text("go");
      assert.ok(turn.ok, turn.error);
      assert.ok(!turn.answer.includes("PAY-MARK"), "the held-back note stayed held back");
    } finally {
      world.close();
    }
  } finally {
    prepared.close();
  }
});

test("close() removes every database copy and the snapshot", async () => {
  const prepared = await prepareRun(bench);
  const copies = [];
  const db = prepared.openCopy("db-bench-maya", copies);
  db.close();
  assert.equal(copies.length, 1);
  assert.ok(existsSync(copies[0]));
  prepared.close();
  assert.ok(!existsSync(copies[0]));
  assert.equal(prepared.openCopy("db-not-a-workspace"), undefined);
});

/* ---------------- search by meaning: the warm pass fills an index, and a conversation searches it ---------------- */

test("with an embedder, the warm pass fills a meaning index per workspace, and a conversation's search asks it", async () => {
  const { fakeAi, fakeEmbedding } = await import("../models.mjs");
  const { createVectorizeBackend } = await import("../../test/vectorizeStub.mjs");
  const ai = fakeAi();
  const prepared = await prepareRun(bench, { today: "2026-10-08", ai });
  try {
    assert.ok(prepared.vectors instanceof Map, "the warmed vectors come back as a seed");
    assert.equal(prepared.embedded.get("maya"), 31, "one passage per short note: the dentist note and thirty fillers");
    assert.equal(prepared.embedded.get("brand"), 2);
    // The index answers by closeness: a query about the dentist lands on the dentist note.
    const backend = createVectorizeBackend({ seed: prepared.vectors });
    const reply = await backend.handle("https://api.cloudflare.com/client/v4/accounts/x/vectorize/v2/indexes/meaning-maya/query", {
      body: JSON.stringify({ vector: fakeEmbedding("Dentist appointment Tuesday"), topK: 3, returnMetadata: "all" }),
    });
    const { result } = await reply.json();
    assert.equal(result.matches[0]?.metadata?.path, "health/dentist.md", JSON.stringify(result.matches.map((m) => m.metadata.path)));
    // A held-back note is indexed at the private tier, so a team caller's query never spends a candidate on it.
    const brand = prepared.vectors.get("meaning-brand");
    const tiers = new Map([...brand.values()].map((entry) => [entry.metadata.path, entry.metadata.tier]));
    assert.deepEqual(Object.fromEntries(tiers), { "people/john.md": "private", "todo.md": "team" });

    // In a conversation's world the gateway searches both ways: the result is not marked words-only.
    const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: scripted([]), ai }, "2026-10-08", prepared);
    try {
      const found = await world.search("tooth doctor visit");
      assert.ok(found.ok, found.text);
      assert.ok(!found.text.includes("not their meaning"), "meaning search is on in a warmed world");
    } finally {
      world.close();
    }
  } finally {
    prepared.close();
  }
});

test("without an embedder the warm pass makes no meaning index, as before", async () => {
  const prepared = await prepareRun(bench, { today: "2026-10-08" });
  try {
    assert.equal(prepared.vectors, null);
    assert.equal(prepared.embedded.size, 0);
  } finally {
    prepared.close();
  }
});

/* ---------------- search everywhere: one search across the person's workspaces, under each one's own privacy ---------------- */

test("by default one search reaches the other workspaces, a held-back note stays absent for a member, and a setup may keep to one", async () => {
  const { fakeAi } = await import("../models.mjs");
  const ai = fakeAi();
  const prepared = await prepareRun(bench, { today: "2026-10-08", ai });
  try {
    // No search settings at all: the default (decided 2026-10-10) is every workspace.
    const models = { gatewayFetch: scripted([]), ai };
    const maya = await createWorld(bench, "Maya", SETUP, models, "2026-10-08", prepared);
    try {
      const found = await maya.search("twill order");
      assert.ok(found.ok, found.text);
      assert.ok(found.text.includes("@brand/todo.md"), `the brand's to-do list is found from Maya's own workspace:\n${found.text}`);
      assert.match(found.text, /pass context: "@name"/, "the result says how to reach a path from another workspace");
      const pay = await maya.search("John's pay");
      assert.ok(pay.text.includes("@brand/people/john.md"), `the owner sees the held-back note:\n${pay.text}`);
    } finally {
      maya.close();
    }
    const priya = await createWorld(bench, "Priya", SETUP, models, "2026-10-08", prepared);
    try {
      const pay = await priya.search("John's pay");
      assert.ok(pay.ok, pay.text);
      assert.ok(!pay.text.includes("john.md"), `a member never sees the held-back note through the fan-out:\n${pay.text}`);
      assert.ok(!pay.text.includes("PAY-MARK"), "nor its words");
    } finally {
      priya.close();
    }
    // Restricted, the same search stays in the person's own workspace.
    const alone = await createWorld(bench, "Maya", SETUP, { gatewayFetch: scripted([]), ai, searchSettings: { everywhere: false } }, "2026-10-08", prepared);
    try {
      const found = await alone.search("twill order");
      assert.ok(!found.text.includes("@brand/"), found.text);
    } finally {
      alone.close();
    }
  } finally {
    prepared.close();
  }
});
