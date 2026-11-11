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

// ---- the pinned day, and the dates on each note ----

/** A model that answers at once, with no tool call. */
function replies(text) {
  return async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

async function askWith(folder, person, args, name, today) {
  const world = await createWorld(folder, person, SETUP, { gatewayFetch: readsOnce(args, name) }, today);
  try {
    return await world.text("go");
  } finally {
    world.close();
  }
}

// Maya's notes, dated four ways and once with no dates at all.
const dated = {
  ...bench,
  workspaces: {
    ...bench.workspaces,
    maya: {
      files: {
        "dated.md": "---\nupdated: 2026-10-01\n---\n\nDATED-MARK last touched a week ago\n",
        "undated.md": "UNDATED-MARK a note with no dates at all\n",
        "both.md": "---\nupdated: 2026-10-02\ndate: 2026-09-01\n---\n\nBOTH-MARK updated wins over date\n",
        "stamped.md": "---\ndate: 2026-09-15\n---\n\nSTAMPED-MARK only a date\n",
        "ranged.md": "---\ndates: 2026-09-20 to 2026-09-25\n---\n\nRANGED-MARK starts on the first day\n",
        "unreadable.md": "---\nupdated: sometime\ndate: 2026-09-15\n---\n\nFALLBACK-MARK an unreadable updated falls through\n",
      },
      heldBack: [],
    },
  },
};

test("with today pinned, orient ages a note by its updated date, and an undated note as two months old", async () => {
  const turn = await askWith(dated, "Maya", {}, "orient", "2026-10-08");
  assert.ok(turn.ok, turn.error);
  assert.ok(turn.answer.includes("dated.md — 7d ago"), turn.answer);
  assert.ok(turn.answer.includes("undated.md — 2mo ago"), turn.answer);
});

test("inside a turn, Date.now() and new Date() are on the pinned day, at noon UTC", async () => {
  const seen = [];
  const answer = replies("ok");
  const gatewayFetch = async (url, init) => {
    seen.push(Date.now(), new Date().getTime());
    return answer(url, init);
  };
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch }, "2026-10-08");
  try {
    await world.text("what day is it?");
  } finally {
    world.close();
  }
  const noon = Date.UTC(2026, 9, 8, 12);
  assert.ok(seen.length >= 2, "the model was asked");
  for (const ms of seen) assert.ok(ms >= noon && ms < noon + 60_000, `read ${new Date(ms).toISOString()}`);
});

test("without today the world keeps the real clock", async () => {
  const RealDate = globalThis.Date;
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: replies("ok") });
  try {
    assert.equal(globalThis.Date, RealDate);
  } finally {
    world.close();
  }
});

test("close() gives the real Date back", async () => {
  const RealDate = globalThis.Date;
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: replies("ok") }, "2020-01-01");
  assert.notEqual(globalThis.Date, RealDate, "the pinned clock is in place while the world is open");
  world.close();
  assert.equal(globalThis.Date, RealDate);
  assert.ok(Date.now() > Date.UTC(2025, 0, 1), "the real clock is back");
  assert.ok(new Date() instanceof RealDate);
});

test("a today that is not an ISO date is refused before anything is built", async () => {
  const RealDate = globalThis.Date;
  const fetchBefore = globalThis.fetch;
  await assert.rejects(createWorld(bench, "Maya", SETUP, { gatewayFetch: replies("ok") }, "not-a-date"), /today/);
  assert.equal(globalThis.Date, RealDate);
  assert.equal(globalThis.fetch, fetchBefore);
});

test("each note's last-modified time comes from its front matter, and privacy.md is dated today", async () => {
  const world = await createWorld(dated, "Maya", SETUP, { gatewayFetch: replies("ok") }, "2026-10-08");
  const seen = {};
  try {
    for (const path of ["dated.md", "undated.md", "both.md", "stamped.md", "ranged.md", "unreadable.md", "privacy.md"]) {
      const response = await fetch(`https://s3.bench.invalid/bench-maya/${path}`, { method: "HEAD" });
      seen[path] = response.headers.get("last-modified");
    }
  } finally {
    world.close();
  }
  const utc = (iso) => new Date(iso).toUTCString();
  assert.equal(seen["dated.md"], utc("2026-10-01T12:00:00Z"));
  assert.equal(seen["both.md"], utc("2026-10-02T12:00:00Z"));
  assert.equal(seen["stamped.md"], utc("2026-09-15T12:00:00Z"));
  assert.equal(seen["ranged.md"], utc("2026-09-20T12:00:00Z"));
  assert.equal(seen["unreadable.md"], utc("2026-09-15T12:00:00Z"));
  assert.equal(seen["undated.md"], utc("2026-08-09T12:00:00Z"), "no dates is sixty days before today");
  assert.equal(seen["privacy.md"], utc("2026-10-08T12:00:00Z"));
});

test("a note a turn writes is stamped with the pinned clock, so it reads as just written", async () => {
  const write = readsOnce({ path: "orders.md", content: "- order more twill\n", context: "@brand" }, "write_note");
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: write }, "2026-10-08");
  let modified = null;
  try {
    await world.text("order more twill");
    const response = await fetch("https://s3.bench.invalid/bench-brand/orders.md", { method: "HEAD" });
    modified = new Date(response.headers.get("last-modified")).toISOString();
  } finally {
    world.close();
  }
  assert.ok(modified && modified.startsWith("2026-10-08T12:00:"), `stamped ${modified}`);
});

test("a write records the note written, never the privacy manifest or activity log the gateway rewrites", async () => {
  const write = readsOnce({ path: "orders.md", content: "- order more twill\n", context: "@brand" }, "write_note");
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: write }, "2026-10-08");
  try {
    await world.text("order more twill");
    assert.deepEqual(world.changes().map((change) => `${change.kind} ${change.workspace}/${change.path}`), ["written brand/orders.md"]);
  } finally {
    world.close();
  }
});

/* ---------------- the router's pick is on the tools line, and the model that answered is priced ---------------- */

const ROUTED_SETUP =
  "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n  router: \"@cf/cloudflare/clef\"\n  think: anthropic/claude-opus-5-5\n---\n\nYou are a test assistant.\n";

test("a routed setup shows the router's confidence, and a think pick under the cutoff as a near miss", async () => {
  const sure = (confidence) => ({ calls: [], async run() { return { answers: { tier: { choice: "think", confidence } } }; } });
  const under = await createWorld(bench, "Maya", ROUTED_SETUP, { gatewayFetch: readsOnce({ path: "health/dentist.md" }), ai: sure(0.42) });
  try {
    const answer = await under.text("When is my dentist appointment?");
    assert.equal(answer.tools[0]?.tool, "router: main (think 0.42)", JSON.stringify(answer.tools));
    assert.equal(answer.model, "anthropic/claude-haiku-5-5");
  } finally {
    under.close();
  }
  const wide = await createWorld(bench, "Maya", ROUTED_SETUP.replace("think: anthropic/claude-opus-5-5", "think: anthropic/claude-opus-5-5\n  route_at: 0.3"), {
    gatewayFetch: readsOnce({ path: "health/dentist.md" }),
    ai: sure(0.42),
  });
  try {
    const answer = await wide.text("When is my dentist appointment?");
    assert.equal(answer.tools[0]?.tool, "router: think (0.42)", JSON.stringify(answer.tools));
    assert.equal(answer.model, "anthropic/claude-opus-5-5");
  } finally {
    wide.close();
  }
});

test("a routed setup records the tier first on the tools line and reports the model that answered", async () => {
  const { fakeAi } = await import("../models.mjs");
  const seen = [];
  const gatewayFetch = async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    return readsOnce({ path: "health/dentist.md" })(url, init);
  };
  const world = await createWorld(bench, "Maya", ROUTED_SETUP, { gatewayFetch, ai: fakeAi() });
  try {
    // Not opening with "should I", which skips the router for the thinking model (`pushback.js`).
    const thought = await world.text("Is moving the trip worth it, given the dentist clash?");
    assert.equal(thought.tools[0]?.tool, "router: think (0.90)", JSON.stringify(thought.tools));
    assert.equal(thought.model, "anthropic/claude-opus-5-5", "priced as the model that answered");
    assert.equal(seen.at(-1), "claude-opus-5-5");
    const looked = await world.text("When is my dentist appointment?");
    assert.equal(looked.tools[0]?.tool, "router: main", "a lookup pick shows no think confidence");
    assert.equal(looked.model, "anthropic/claude-haiku-5-5");
    assert.equal(seen.at(-1), "claude-haiku-5-5");
  } finally {
    world.close();
  }
});

test("a planned setup's turn records each model's rounds and spend, and the answering model", async () => {
  const { fakeAi } = await import("../models.mjs");
  const seen = [];
  const gatewayFetch = async (url, init) => {
    seen.push(JSON.parse(init.body).model);
    return readsOnce({ path: "health/dentist.md" })(url, init);
  };
  const planned = ROUTED_SETUP.replace("think: anthropic/claude-opus-5-5", "think: anthropic/claude-opus-5-5\n  think_rounds: 1");
  const world = await createWorld(bench, "Maya", planned, { gatewayFetch, ai: fakeAi() });
  try {
    const turn = await world.text("Should I move the trip, given the dentist clash?");
    assert.ok(turn.ok, turn.error);
    assert.deepEqual(seen, ["claude-opus-5-5", "claude-haiku-5-5"], "Opus plans the read, Haiku writes the answer");
    assert.deepEqual(turn.rounds, { "anthropic/claude-opus-5-5": 1, "anthropic/claude-haiku-5-5": 1 });
    assert.deepEqual(turn.usageByModel, {
      "anthropic/claude-opus-5-5": { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      "anthropic/claude-haiku-5-5": { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    assert.deepEqual(turn.usage, { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 }, "the sum of both reports");
    assert.equal(turn.model, "anthropic/claude-haiku-5-5", "the model that wrote the answer");
  } finally {
    world.close();
  }
});

/* ---------------- a fallback and a retry are on the tools line, and an error keeps its status ---------------- */

const SPARE_SETUP =
  "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n  fallback: \"@cf/zai-org/glm-4.7-flash\"\n---\n\nYou are a test assistant.\n";

const busy = (status) => async () => new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status, headers: { "Content-Type": "application/json" } });

test("a main model that stays busy is retried, then the fallback answers, and the tools line says both", async () => {
  const { fakeAi } = await import("../models.mjs");
  const world = await createWorld(bench, "Maya", SPARE_SETUP, { gatewayFetch: busy(529), ai: fakeAi() });
  try {
    const turn = await world.text("When is my dentist appointment?");
    assert.equal(turn.ok, true, turn.error);
    assert.equal(turn.model, "@cf/zai-org/glm-4.7-flash", "priced as the model that answered");
    assert.equal(turn.tools[0]?.tool, "fallback: @cf/zai-org/glm-4.7-flash after 529", JSON.stringify(turn.tools));
  } finally {
    world.close();
  }
});

test("a setup with no fallback records the error with the status the provider gave", async () => {
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: busy(503) });
  try {
    const turn = await world.text("When is my dentist appointment?");
    assert.equal(turn.ok, false);
    assert.equal(turn.error, "model_unavailable (status 503)");
  } finally {
    world.close();
  }
});

/** A model that never stops calling tools, counting its rounds; a progress text first when `say` is given. */
function neverDone(rounds, say = null) {
  return async () => {
    rounds.n += 1;
    const first = rounds.n === 1 && say !== null;
    const reply = {
      content: [
        first
          ? { type: "tool_use", id: `toolu_${rounds.n}`, name: "send", input: { action: "progress", args: { text: say } } }
          : { type: "tool_use", id: `toolu_${rounds.n}`, name: "read_note", input: { path: "health/dentist.md" } },
      ],
      stop_reason: "tool_use",
    };
    return new Response(JSON.stringify({ ...reply, usage: { input_tokens: 10, output_tokens: 5 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const withSteps = (n) => SETUP.replace("---\n\nYou", `max_steps: ${n}\n---\n\nYou`);

test("a bench turn is asked for the way the texting Worker asks, so it gets the setup's max_steps", async () => {
  // A plain JSON ask is a quick turn, capped at 8 rounds (`src/agent/turn.js`);
  // the texting Worker streams (`apps/agent/src/clients.ts`) and gets the
  // setup's own max_steps, up to the long cap. The bench must measure that.
  const rounds = { n: 0 };
  const world = await createWorld(bench, "Maya", withSteps(24), { gatewayFetch: neverDone(rounds) });
  try {
    await world.text("go");
  } finally {
    world.close();
  }
  assert.equal(rounds.n, 24);
});

test("a progress line texted on the way comes back with the turn, as a text the person got", async () => {
  const rounds = { n: 0 };
  const world = await createWorld(bench, "Maya", withSteps(2), { gatewayFetch: neverDone(rounds, "Opening the site.") });
  try {
    const turn = await world.text("go");
    assert.ok(turn.ok, turn.error ?? "");
    assert.deepEqual(turn.progress, ["Opening the site."]);
  } finally {
    world.close();
  }
});

// Background jobs in the bench (2026-11-04, `tests/splitting.md`): only a text sent with the chat's running jobs is offered them,
// and the jobs a turn started come back for the start checks, the planner's notes with them.
test("a text sent with running jobs can start jobs, and a planned split writes its notes and starts its parts", async () => {
  const PLANNED = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n  advisor: anthropic/claude-opus-5-5\nplan_big_asks: on\n---\n\nYou are a test assistant.\n";
  const plan = { split: true, title: "Lisbon week", goal: "The whole week.", parts: [{ name: "dinners", title: "Pick dinners", brief: "One a night." }, { name: "trip", title: "Pick a day trip", brief: "One trip." }] };
  const offered = [];
  const gatewayFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const reply = (content, stop) => new Response(JSON.stringify({ content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (JSON.stringify(body.system ?? "").includes("You plan work for Tex")) return reply([{ type: "text", text: JSON.stringify(plan) }], "end_turn");
    offered.push(JSON.stringify(body.tools ?? []));
    const last = body.messages.at(-1);
    if (Array.isArray(last?.content) && last.content.some((block) => block.type === "tool_result")) return reply([{ type: "text", text: "ok" }], "end_turn");
    return reply([{ type: "tool_use", id: "toolu_1", name: "send", input: { action: "plan", args: { ask: "plan the lisbon week", folder: "projects/lisbon-week/" } } }], "tool_use");
  };
  const world = await createWorld(bench, "Maya", PLANNED, { gatewayFetch }, "2026-10-08");
  try {
    const none = await world.text("plan the lisbon week");
    assert.deepEqual(none.jobs, [], "no running list sent: no jobs");
    assert.ok(!offered.at(-1).includes("your advisor plans it"), "nor the planner");
    const turn = await world.text("plan the lisbon week", [], { running: [] });
    assert.ok(offered.at(-1).includes("your advisor plans it"), "offered under send");
    assert.deepEqual(turn.jobs.map((job) => [job.name, job.mail]), [["dinners", "projects/lisbon-week/overview.md"], ["trip", "projects/lisbon-week/overview.md"]]);
    assert.equal(turn.answer, "", "a start texts nothing (Dev2, 2026-11-11)");
    assert.equal(turn.quiet, true);
    assert.equal(turn.react, "", "their text gets a tapback, the Worker's pick from their words");
    const written = world.changes().filter((change) => change.kind === "written").map((change) => change.path);
    assert.deepEqual(written.filter((path) => path.startsWith("projects/lisbon-week/")).sort(), ["projects/lisbon-week/dinners.md", "projects/lisbon-week/overview.md", "projects/lisbon-week/trip.md"]);
  } finally {
    world.close();
  }
});

test("a test's computer is the one a job can run on, and the record says it ran there", async () => {
  const gatewayFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages.at(-1);
    const reply = (content, stop) => new Response(JSON.stringify({ content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (Array.isArray(last?.content) && last.content.some((block) => block.type === "tool_result")) return reply([{ type: "text", text: "ok" }], "end_turn");
    return reply([{ type: "tool_use", id: "toolu_1", name: "send", input: { action: "background", args: { title: "Read the Next.js cache code", brief: "How fetch caching is decided.", on_computer: {} } } }], "tool_use");
  };
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch, computer: { name: "Studio Mac", tools: ["claude", "codex"], slots: 3 } }, "2026-10-08");
  try {
    const turn = await world.text("how does next.js decide to cache a fetch?", [], { running: [] });
    assert.deepEqual(turn.jobs.map((job) => [job.title, job.on]), [["Read the Next.js cache code", "Studio Mac"]], JSON.stringify([turn.answer, turn.tools]));
  } finally {
    world.close();
  }
});

test("a conversation keeps every model call and the chat's own ledger, for its ledger file", async () => {
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: readsOnce({ path: "health/dentist.md" }) });
  try {
    const turn = await world.text("when's the dentist?");
    assert.ok(turn.trace.some((entry) => entry.kind === "tool"), "the turn's trace comes back with the turn");
    const calls = world.modelCalls();
    assert.equal(calls.length, 2, "one call per model round");
    assert.ok(typeof calls[0].system === "string" && calls[0].system.length > 0, "the first call keeps the system prompt");
    assert.equal(calls[1].system, undefined, "an unchanged system prompt is kept once");
    assert.ok(JSON.stringify(calls[1].messages).includes("DENTIST-MARK"), "the second round keeps the tool result the model was shown");
    assert.equal(calls[0].answer.content[0].type, "tool_use");
    const chat = await world.chatLedger();
    const read = chat.find((entry) => entry.kind === "tool" && entry.name === "read_note");
    assert.deepEqual(read.args, { path: "health/dentist.md" });
    assert.ok(String(read.result).includes("DENTIST-MARK"));
    assert.ok(chat.some((entry) => entry.kind === "reply"));
  } finally {
    world.close();
  }
});
