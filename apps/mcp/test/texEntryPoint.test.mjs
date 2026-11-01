/**
 * The timed Tex entry point (`src/agent/texEntryPoint.js`): every step is a
 * named point, a step on the off list is skipped only on a chat's text when
 * the deployment is lean, and work handed to `after` waits for the response.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { OFF_IN_CHATS, allowedFirst, texEntry } from "../src/agent/texEntryPoint.js";

function dataset() {
  const points = [];
  return { points, writeDataPoint: (point) => points.push(point) };
}

function clock(start = 1_000) {
  let at = start;
  return { now: () => at, tick: (ms) => (at += ms) };
}

test("a step is one point: its name, state, milliseconds and start, indexed by workspace, never its value", async () => {
  const TEX_ENTRY = dataset();
  const time = clock();
  const tex = texEntry({ TEX_ENTRY }, { who: "ws_1", now: time.now });
  tex.kind = "one";
  time.tick(5);
  const value = await tex.step("read_request", async () => {
    time.tick(40);
    return { question: "a secret" };
  });
  assert.deepEqual(value, { question: "a secret" });
  await assert.rejects(tex.step("history", async () => {
    time.tick(10);
    throw new Error("boom");
  }));
  tex.responded();
  assert.deepEqual(TEX_ENTRY.points, [
    { blobs: ["gateway", "one", "read_request", "ok"], doubles: [40, 5], indexes: ["ws_1"] },
    { blobs: ["gateway", "one", "history", "failed"], doubles: [10, 45], indexes: ["ws_1"] },
    { blobs: ["gateway", "one", "to_response", "ok"], doubles: [55, 0], indexes: ["ws_1"] },
  ]);
  assert.doesNotMatch(JSON.stringify(TEX_ENTRY.points), /secret/);
});

test("an off step is skipped only on a chat's text on a lean deployment, and still logs as off", async () => {
  const name = [...OFF_IN_CHATS][0];
  for (const [env, kind, skipped] of [
    [{ TEX_LEAN: "on" }, "one", true],
    [{ TEX_LEAN: "on" }, "group", true],
    [{ TEX_LEAN: "on" }, "job", false],
    [{ TEX_LEAN: "on" }, "routine", false],
    [{}, "one", false],
  ]) {
    const TEX_ENTRY = dataset();
    const tex = texEntry({ ...env, TEX_ENTRY });
    tex.kind = kind;
    let ran = false;
    const value = await tex.step(name, () => ((ran = true), "read"), "fallback");
    assert.equal(ran, !skipped, `${kind} ${JSON.stringify(env)}`);
    assert.equal(value, skipped ? "fallback" : "read");
    assert.equal(TEX_ENTRY.points[0].blobs[3], skipped ? "off" : "ok");
    assert.equal(tex.lean, env.TEX_LEAN === "on" && (kind === "one" || kind === "group"));
  }
  const tex = texEntry({ TEX_LEAN: "on" });
  tex.kind = "one";
  let ran = false;
  await tex.step("model", () => (ran = true));
  assert.equal(ran, true, "a step not on the list always runs");
});

test("after-work waits for the response; a promise already running is handed over too, so the Worker keeps it alive", async () => {
  const TEX_ENTRY = dataset();
  const later = [];
  const tex = texEntry({ TEX_ENTRY }, { later });
  let ran = false;
  await tex.after("usage", () => (ran = true));
  let settle;
  const running = new Promise((resolve) => (settle = resolve));
  await tex.after("close_job", running);
  assert.equal(ran, false, "nothing ran before the response");
  assert.equal(later.length, 2, "both are handed to afterTurn");
  await later[0]();
  assert.equal(ran, true);
  settle("closed");
  assert.equal(await later[1](), "closed");
  assert.deepEqual(TEX_ENTRY.points.map((point) => point.blobs[2]).sort(), ["after:close_job", "after:usage"]);
});

test("ahead never leaves a rejection unhandled, and wait times how long it held the turn", async () => {
  const TEX_ENTRY = dataset();
  const tex = texEntry({ TEX_ENTRY });
  const started = tex.ahead("tools_list", async () => {
    throw new Error("no tools");
  });
  await assert.rejects(tex.wait("tools_list", started), /no tools/);
  assert.deepEqual(TEX_ENTRY.points.map((point) => point.blobs.slice(2)), [["tools_list", "failed"], ["wait:tools_list", "failed"]]);
});

test("points stop at the cap and a dataset that throws never fails a turn", async () => {
  const TEX_ENTRY = dataset();
  const tex = texEntry({ TEX_ENTRY });
  for (let i = 0; i < 250; i += 1) await tex.step("note_read", () => i);
  assert.equal(TEX_ENTRY.points.length, 100);
  const broken = texEntry({ TEX_ENTRY: { writeDataPoint: () => { throw new Error("down"); } } });
  assert.equal(await broken.step("read_request", () => "ok"), "ok");
  assert.equal(await texEntry({}).step("read_request", () => "no binding"), "no binding");
});

test("a tool waits for the allowed check, and none runs when it says no", async () => {
  const ran = [];
  const callTool = async (name) => (ran.push(name), "done");
  assert.equal(allowedFirst(null, callTool), callTool);
  assert.equal(await allowedFirst(Promise.resolve(), callTool)("search_notes", {}), "done");
  const refused = Promise.reject(new Error("daily_limit"));
  refused.catch(() => {});
  await assert.rejects(allowedFirst(refused, callTool)("send_email", {}), /daily_limit/);
  assert.deepEqual(ran, ["search_notes"]);
});

test("each store call is timed by operation and by where it went, a Tex object or the bucket, never by key", async () => {
  const TEX_ENTRY = dataset();
  const tex = texEntry({ TEX_ENTRY }, { who: "ws_1" });
  const store = {
    get: async (key) => ({ key }),
    head: async () => null,
    put: async () => {
      throw new Error("refused");
    },
  };
  tex.watch(store);
  await store.get("tex/person:ws_1/notes/0195f3a0-1b2c-7d3e-8f40-123456789abc.md");
  await store.get("notes/abc.md");
  await store.head(".context/collaboration/abc/state.json");
  await assert.rejects(store.put("notes/abc.md", "x"));
  assert.deepEqual(TEX_ENTRY.points.map((point) => point.blobs.slice(2)), [
    ["store:get:object", "ok"],
    ["store:get:bucket", "ok"],
    ["store:head:bucket", "ok"],
    ["store:put:bucket", "failed"],
  ]);
  assert.doesNotMatch(JSON.stringify(TEX_ENTRY.points), /abc|0195f3a0/);
  for (let i = 0; i < 200; i += 1) await store.get("notes/x.md");
  assert.equal(TEX_ENTRY.points.length, 120, "store calls have their own cap");
  await tex.step("model", () => "ok");
  assert.equal(TEX_ENTRY.points.at(-1).blobs[2], "model", "and never crowd out a step");
});
