// The nightly, run now from the Lab (packages/lab/gateway/labSandbox/nightly.js, packages/tex/gateway/agent/nightlyNow.js;
// Dev2, 2026-11-20: "I want to be able to be like, okay, let's run it now"). Fake ids and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-20):
//   route.js nightlyInTestChat without the 1:1 check          "a group test chat is refused" fails
//   route.js nightlyForReal taking a drawn graph               "a real run takes main or a saved draft" fails
//   nightlyNow.js dropping `force` from the run's ctx           "the run follows the config's wires ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { handleLabSandbox } from "../../../packages/lab/gateway/labSandbox/route.js";
import { nightlySummary, runOf } from "../../../packages/lab/gateway/labSandbox/nightly.js";
import { runNightlyNow } from "../../../packages/tex/gateway/agent/nightlyNow.js";
import { durableSql } from "./texStoreFixture.mjs";

const KEY = "d".repeat(64);
const ALICE = "tok_alice_example_000000000000";
const BOB = "tok_bob_example_00000000000000";

function routeWorld(people) {
  const objects = new Map();
  const object = (name) => {
    if (!objects.has(name)) objects.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
    return objects.get(name);
  };
  const ns = { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
  const env = { LAB_SANDBOX: ns, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body.action);
    const who = people[body.accessToken];
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (!who) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: who.userId, chats: [{ key: KEY, name: "Team" }] });
    if (body.action === "draft") return answer({ status: "not_found" });
    if (body.action === "session") {
      if (body.args.chat === KEY) return answer({ status: "ok", session: { grantId: "g2", clientId: "context_texts_group", actorUserId: who.userId, scopes: ["context:read"], defaultWorkspaceId: who.workspaceId, workspaces: [] }, people: [{ handle: "alfa", name: "Alfa" }, { handle: "bravo", name: "Bravo" }] });
      if (body.args.chat !== "me") return answer({ status: "not_found", error: "There is no such chat." });
      return answer({ status: "ok", session: { grantId: "g1", clientId: "context_texts", actorUserId: who.userId, scopes: ["context:read"], defaultWorkspaceId: who.workspaceId, workspaces: [{ workspaceId: who.workspaceId, role: "owner", kind: "personal", slug: "alfa" }] }, people: [{ handle: "alfa", name: "You" }] });
    }
    return answer({ status: "bad_request" });
  };
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, {});
    return { status: response.status, body: await response.json() };
  };
  return { call, asked, restore: () => (globalThis.fetch = original) };
}

test("a stranger is refused the nightly; a group test chat and another person's test chat are refused", async () => {
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" }, [BOB]: { userId: "u_bob", workspaceId: "ws_bob" } });
  try {
    assert.equal((await w.call("tok_nobody_example_0000000000", { op: "nightly", real: true })).status, 403);
    const group = await w.call(ALICE, { op: "open", source: "chat", chatId: KEY });
    assert.equal(group.status, 200);
    const refused = await w.call(ALICE, { op: "nightly", sandboxId: group.body.sandboxId });
    assert.equal(refused.status, 400, "a group test chat is refused");
    assert.match(refused.body.error, /your own 1:1/);
    const mine = await w.call(ALICE, { op: "open", source: "chat" });
    assert.equal((await w.call(BOB, { op: "nightly", sandboxId: mine.body.sandboxId })).status, 404, "another person's test chat does not exist for them");
    assert.equal((await w.call(ALICE, { op: "nightly", sandboxId: mine.body.sandboxId, run: "everything" })).status, 400);
  } finally {
    w.restore();
  }
});

test("a real run takes main or a saved draft, never a drawn graph, and only a known run", async () => {
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" } });
  try {
    const drawn = await w.call(ALICE, { op: "nightly", real: true, graph: JSON.stringify({ nodes: [], edges: [] }) });
    assert.equal(drawn.status, 400);
    assert.match(drawn.body.error, /never a drawn graph/);
    assert.equal((await w.call(ALICE, { op: "nightly", real: true, run: "rm -rf" })).status, 400);
    assert.equal((await w.call(ALICE, { op: "nightly", real: true, versionId: "no-such-draft" })).status, 404, "a draft that is not there is refused");
    assert.ok(!w.asked.includes("session"), "no session is asked for a refused run");
  } finally {
    w.restore();
  }
});

test("runOf knows dream and housekeeping only", () => {
  assert.equal(runOf({}), "dream");
  assert.equal(runOf({ run: "housekeeping" }), "housekeeping");
  assert.equal(runOf({ run: "x" }), null);
});

test("the run follows the config's wires from nightly, forces weekly steps, and says what About me became", async () => {
  let about = "# About\n\n- Likes tea (2026-10-01)\n- Party Sat (Tex noticed, 2026-11-19, until 2026-11-21)\n";
  const dispatch = async (name, args) => {
    if (name === "read_note" && args.path === "tex/about.md") return { content: [{ type: "text", text: `etag: e1\npath: tex/about.md\n\n${about}` }] };
    if (name === "write_note" && args.path === "tex/about.md") {
      about = args.content;
      return { content: [{ type: "text", text: "written" }] };
    }
    return { isError: true, content: [{ type: "text", text: "not here" }] };
  };
  const seen = {};
  const nodes = {
    nightly: async (input) => ({ to: input.run, timeZone: input.timeZone }),
    dream: async (input) => ({ outcome: "unchanged", status: 200, body: {}, when: ["about"], timeZone: input.timeZone, now: Date.UTC(2026, 10, 22, 15) }),
    aboutExpire: async (input, io) => {
      const text = (await io.ctx.dispatch("read_note", { path: "tex/about.md" })).content[0].text.split("\n\n").slice(1).join("\n\n");
      await io.ctx.dispatch("write_note", { path: "tex/about.md", content: text.replace(/- Party.*\n/, "") });
      return { outcome: "expired", dropped: 1, when: ["check"] };
    },
    aboutCheck: async (_input, io) => {
      seen.force = io.ctx.force;
      return { outcome: "unchanged" };
    },
    housekeep: async () => ({ outcome: "never" }),
  };
  const node = (id, model = "code") => ({ id, label: id, on: true, model, log: true });
  const config = {
    models: {},
    nodes: [node("nightly"), node("dream"), node("aboutExpire"), node("aboutCheck"), node("housekeep")],
    edges: [
      { from: "nightly", to: "dream", mode: "wait", when: ["dream"] },
      { from: "nightly", to: "housekeep", mode: "wait", when: ["housekeeping"] },
      { from: "dream", to: "aboutExpire", mode: "wait", when: ["about"] },
      { from: "aboutExpire", to: "aboutCheck", mode: "wait", when: ["check"] },
    ],
  };
  const out = await runNightlyNow({ env: {}, store: {}, session: { actorUserId: "u_alice", workspaces: [] }, controlPlane: null, config, run: "dream", timeZone: "America/New_York", dispatch, nodes });
  assert.deepEqual(out.ran, ["nightly", "dream", "aboutExpire", "aboutCheck"]);
  assert.equal(seen.force, true, "a run now forces the weekly recheck");
  assert.deepEqual(out.about.removed, ["- Party Sat (Tex noticed, 2026-11-19, until 2026-11-21)"]);
  assert.deepEqual(out.about.added, []);
  assert.ok(out.about.after < out.about.before);
  const summary = nightlySummary(out);
  assert.match(summary, /About me: \d+ → \d+ characters\./);
  assert.match(summary, /− - Party Sat/);
  assert.match(summary, /Steps: nightly → dream → aboutExpire → aboutCheck\./);
  await assert.rejects(() => runNightlyNow({ env: {}, store: {}, session: {}, config, run: "wipe", dispatch, nodes }), /run is dream or housekeeping/);
});
