// The Lab's `intake` op (packages/lab/gateway/labSandbox/intake.js): a Tex developer sees where their own chats are
// answered and moves one into the gateway before every chat moves (Dev2's runtime simplification, 2026-11-21: "test on
// your chat first, then Tex Devs, then everyone"). What these prove: only the caller's own chats are named, a 1:1 is
// its phone's object and a group its directory entry's, nothing answered or logged carries a phone or a group id, and a
// stranger moves nothing. Fake numbers and ids only.
//
// Sabotage (temporary local edits, reverted, 2026-11-21):
//   intake.js `chatsOf` accepting any 64-hex chatId               "a group the caller is not in ..." fails
//   intake.js `homeAt` always GET /home (move ignored)              "move: true copies the 1:1 in ..." fails
//   intake.js log line carrying `name`                              "no phone or group id ..." fails
//   intake.js `sweep` counting a refused move as moved              "a sweep moves every chat ..." fails
//   intake.js `workerCensus` dropping the 50-id cap (2026-11-22)      "a census of the Worker's objects ..." fails
//   intake.js `workerCensus` answering the matched name (2026-11-22)  "a census with match ..." fails
//   intake.js adopting without the phone check (2026-11-22)          "a census with match and move ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleLabSandbox } from "../../../packages/lab/gateway/labSandbox/route.js";

const DEV = "tok_dev_example_00000000000000";
const STRANGER = "tok_stranger_example_000000000";
const PHONE = "+15555550100";
const MINE = "a".repeat(64);
const NOT_MINE = "b".repeat(64);
const GROUP_ID = "group-id-example-0001";

function world() {
  // The gateway's chat objects, by name: each knows only whether it was moved in.
  const homes = new Map();
  const asked = [];
  const state = { refuse: false };
  const directory = [];
  const TEX_CHAT = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        // A group's directory entry is its own gateway object (`texChat/directory.js`), read through its chat-call door.
        if (path === "/chat-call/chat-where") {
          directory.push(`${id.name} ${request.headers.get("x-inbox-name")}`);
          return Response.json(id.name === `chat:group-key:${MINE}` ? { line: "+15555550199", groupId: GROUP_ID } : null);
        }
        asked.push(`${id.name} ${request.method} ${path}`);
        if (path === "/move-in") {
          const body = await request.json();
          assert.equal(`chat:${body.inbox}`, id.name);
          if (state.refuse) return Response.json({ home: "worker", refused: true });
          homes.set(id.name, { home: "gateway", movedAt: 5, keys: 12 });
        }
        return Response.json(homes.get(id.name) ?? { home: "worker" });
      },
    }),
  };
  const TEXTING = { inboxFetch: async () => assert.fail("the directory is read in the gateway, never the Worker") };
  const env = { LAB_SANDBOX: {}, TEX_CHAT, TEXTING, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (value) => Response.json(value);
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (body.accessToken !== DEV) return answer({ status: "refused" });
    if (body.action === "intakeChats") return answer({ status: "ok", phones: [PHONE, "+15555550102", "not-a-phone"], groups: [MINE, NOT_MINE, "../x"] });
    if (body.action === "who") return answer({ status: "ok", userId: "u_dev", phone: PHONE, chats: [{ key: MINE, name: "Tex Devs", people: 4 }], timeZone: "America/New_York" });
    return answer({ status: "bad_request" });
  };
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(" "));
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null);
    return { status: response.status, body: await response.json() };
  };
  return { env, call, asked, directory, homes, logs, set refuse(value) { state.refuse = value; }, restore: () => { globalThis.fetch = original; console.log = realLog; } };
}

test("intake lists the caller's own chats and where each is answered", async () => {
  const w = world();
  try {
    const listed = await w.call(DEV, { op: "intake" });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, {
      chats: [
        { chatId: "me", name: "You and Tex", kind: "1:1", home: "worker" },
        { chatId: MINE, name: "Tex Devs", kind: "group", home: "worker" },
      ],
    });
    // The 1:1 is its phone's object; the group is read from its directory entry, then its own object.
    assert.deepEqual(w.asked, [`chat:${PHONE} GET /home`, `chat:sendblue-group:${GROUP_ID} GET /home`]);
    assert.deepEqual(w.directory, [`chat:group-key:${MINE} group-key:${MINE}`]);
    assert.equal(w.homes.size, 0, "listing moves nothing");
  } finally {
    w.restore();
  }
});

test("move: true copies the 1:1 in, then the group, and the list says so", async () => {
  const w = world();
  try {
    const one = await w.call(DEV, { op: "intake", chatId: "me", move: true });
    assert.deepEqual(one.body, { chatId: "me", name: "You and Tex", kind: "1:1", home: "gateway", movedAt: 5, keys: 12 });
    assert.equal(w.homes.has(`chat:sendblue-group:${GROUP_ID}`), false, "only the chat named moves");
    const group = await w.call(DEV, { op: "intake", chatId: MINE, move: true });
    assert.equal(group.body.home, "gateway");
    const listed = await w.call(DEV, { op: "intake" });
    assert.deepEqual(listed.body.chats.map((c) => c.home), ["gateway", "gateway"]);
    // Without move, a named chat is only asked where it is.
    const asked = w.asked.length;
    await w.call(DEV, { op: "intake", chatId: "me" });
    assert.deepEqual(w.asked.slice(asked), [`chat:${PHONE} GET /home`]);
  } finally {
    w.restore();
  }
});

test("a group the caller is not in, a bad chatId, and a stranger move nothing", async () => {
  const w = world();
  try {
    assert.equal((await w.call(DEV, { op: "intake", chatId: NOT_MINE, move: true })).status, 404);
    assert.equal((await w.call(DEV, { op: "intake", chatId: "../x", move: true })).status, 404);
    assert.equal((await w.call(STRANGER, { op: "intake", chatId: "me", move: true })).status, 403);
    assert.equal((await w.call(STRANGER, { op: "intake" })).status, 403);
    assert.equal(w.homes.size, 0);
    assert.deepEqual(w.directory, []);
  } finally {
    w.restore();
  }
});

test("no phone or group id is answered or logged", async () => {
  const w = world();
  try {
    const answers = [await w.call(DEV, { op: "intake", chatId: "me", move: true }), await w.call(DEV, { op: "intake", chatId: MINE, move: true }), await w.call(DEV, { op: "intake" })];
    const said = JSON.stringify(answers) + w.logs.join("\n");
    assert.equal(said.includes(PHONE), false);
    assert.equal(said.includes(GROUP_ID), false);
    assert.ok(w.logs.some((line) => line.includes('"lab_intake"')), "each move is logged, by kind");
  } finally {
    w.restore();
  }
});

test("a sweep counts every chat by home, moves the ones in the Worker with move, and answers counts only", async () => {
  const w = world();
  try {
    const census = await w.call(DEV, { op: "intake", sweep: true });
    // Two phones and two groups pass; NOT_MINE has no directory entry, so it is unknown. Nothing moved.
    assert.deepEqual(census.body, { total: 4, people: 2, groups: 2, after: 0, looked: 4, gateway: 0, worker: 3, moved: 0, refused: 0, unknown: 1, next: null });
    assert.equal(w.homes.size, 0);
    const moved = await w.call(DEV, { op: "intake", sweep: true, move: true });
    assert.equal(moved.body.moved, 3);
    assert.equal(w.homes.size, 3);
    const after = await w.call(DEV, { op: "intake", sweep: true });
    assert.equal(after.body.gateway, 3);
    assert.equal(after.body.worker, 0);
    const said = JSON.stringify([census, moved, after]) + w.logs.join("\n");
    assert.equal(said.includes(PHONE), false);
    assert.equal(said.includes(GROUP_ID), false);
    assert.equal(said.includes("+15555550102"), false);
    assert.equal((await w.call(STRANGER, { op: "intake", sweep: true, move: true })).status, 403);
  } finally {
    w.restore();
  }
});

test("a sweep pages from after, and a refused move is counted as refused, not moved", async () => {
  const w = world();
  try {
    const page = await w.call(DEV, { op: "intake", sweep: true, after: 3 });
    assert.equal(page.body.looked, 1);
    assert.equal(page.body.next, null);
    w.refuse = true;
    const moved = await w.call(DEV, { op: "intake", sweep: true, move: true });
    assert.equal(moved.body.moved, 0);
    assert.equal(moved.body.refused, 3);
  } finally {
    w.restore();
  }
});

test("a census of the Worker's objects by id is staff only, at most 50 well-formed ids, and passes the counts on", async () => {
  const w = world();
  const asked = [];
  const counts = { looked: 1, moved: 1, purged: 0, empty: 0, here: { chat: 0, job: 0, directory: 0, "group-moves": 0 }, hereIds: [], failed: 0 };
  w.env.TEXTING.census = async (call) => { asked.push(call.ids.length); return counts; };
  try {
    assert.equal((await w.call(STRANGER, { op: "intake", workerIds: [MINE] })).status, 403);
    assert.equal((await w.call(DEV, { op: "intake", workerIds: ["../x"] })).status, 400);
    assert.equal((await w.call(DEV, { op: "intake", workerIds: Array(51).fill(MINE) })).status, 400);
    assert.deepEqual(asked, [], "nothing asked before the checks pass");
    const answered = await w.call(DEV, { op: "intake", workerIds: [MINE, NOT_MINE] });
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.body, counts);
    assert.deepEqual(asked, [2]);
    delete w.env.TEXTING.census;
    assert.equal((await w.call(DEV, { op: "intake", workerIds: [MINE] })).status, 501);
  } finally {
    w.restore();
  }
});

test("a census with match says which kind of chat each object still here is and whether the gateway holds it, never its name", async () => {
  const w = world();
  w.homes.set(`chat:${PHONE}`, { home: "gateway" });
  let names = [];
  w.env.TEXTING.census = async (call) => {
    names = call.names;
    const at = (name) => call.names.indexOf(name);
    return {
      looked: 4, moved: 0, purged: 0, empty: 0, here: { chat: 3, job: 0, directory: 1, "group-moves": 0 }, failed: 0,
      hereIds: ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)],
      hereObjects: [
        { id: "1".repeat(64), kind: "chat", keys: 9, shape: ["history"], named: at(PHONE) },
        { id: "2".repeat(64), kind: "chat", keys: 4, shape: ["history"], named: at("+15555550102") },
        { id: "3".repeat(64), kind: "directory", keys: 1, shape: ["chatwhere"], named: at(`group-key:${MINE}`) },
        { id: "4".repeat(64), kind: "chat", keys: 2, shape: ["gstate"] },
      ],
    };
  };
  try {
    const answered = await w.call(DEV, { op: "intake", workerIds: ["1".repeat(64)], match: true });
    assert.equal(answered.status, 200);
    assert.ok(names.includes(PHONE) && names.includes(`group-key:${MINE}`) && names.includes(`sendblue-group:${GROUP_ID}`), "the Worker is handed every name Tex can work out");
    assert.deepEqual(answered.body.hereObjects.map(({ id, match, inGateway }) => [id[0], match, inGateway]), [["1", "1:1", true], ["2", "1:1", false], ["3", "directory", true], ["4", null, undefined]]);
    const text = JSON.stringify(answered.body) + w.logs.join("\n");
    for (const secret of [PHONE, "+15555550102", GROUP_ID, MINE]) assert.ok(!text.includes(secret), "no name in the answer or the logs");
  } finally {
    w.restore();
  }
});

test("a census with match and move copies in each 1:1 object that worked out its own name, and answers no name", async () => {
  const w = world();
  let asked = null;
  w.env.TEXTING.census = async (call) => {
    asked = call.adopt;
    return {
      looked: 3, moved: 0, purged: 0, empty: 0, here: { chat: 3, job: 0, directory: 0, "group-moves": 0 }, failed: 0,
      hereIds: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
      hereObjects: [
        { id: "1".repeat(64), kind: "chat", keys: 8, shape: ["chat"] },
        { id: "2".repeat(64), kind: "chat", keys: 8, shape: ["chat"] },
        { id: "3".repeat(64), kind: "chat", keys: 8, shape: ["gseq"] },
      ],
      adoptable: [{ id: "1".repeat(64), name: "+15555550103" }, { id: "2".repeat(64), name: "../x" }],
    };
  };
  try {
    const answered = await w.call(DEV, { op: "intake", workerIds: ["1".repeat(64)], match: true, move: true });
    assert.equal(answered.status, 200);
    assert.equal(asked, true);
    assert.deepEqual(answered.body.adopted, { moved: 1, refused: 0 });
    assert.deepEqual(answered.body.hereObjects.map((object) => object.adopted), [true, undefined, undefined]);
    assert.ok(w.asked.includes("chat:+15555550103 POST /move-in"), "the 1:1 is copied in by its own name");
    assert.ok(!w.asked.some((line) => line.includes("../x")), "a name that is not a phone is never moved");
    const text = JSON.stringify(answered.body) + w.logs.join("\n");
    assert.ok(!text.includes("+15555550103"), "no name in the answer or the logs");
  } finally {
    w.restore();
  }
});

test("an iMessage sender's 1:1, named by an email address, is copied in too", async () => {
  const w = world();
  w.env.TEXTING.census = async () => ({
    looked: 1, moved: 0, purged: 0, empty: 0, here: { chat: 1, job: 0, directory: 0, "group-moves": 0 }, failed: 0,
    hereIds: ["1".repeat(64)], hereObjects: [{ id: "1".repeat(64), kind: "chat", keys: 8, shape: ["chat"] }],
    adoptable: [{ id: "1".repeat(64), name: "someone@example.invalid" }],
  });
  try {
    const answered = await w.call(DEV, { op: "intake", workerIds: ["1".repeat(64)], match: true, move: true });
    assert.deepEqual(answered.body.adopted, { moved: 1, refused: 0 });
    assert.ok(w.asked.includes("chat:someone@example.invalid POST /move-in"));
    assert.ok(!JSON.stringify(answered.body).includes("example.invalid"));
  } finally {
    w.restore();
  }
});
