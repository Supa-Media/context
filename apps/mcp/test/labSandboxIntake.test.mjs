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
  const TEX_CHAT = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        asked.push(`${id.name} ${request.method} ${path}`);
        if (path === "/move-in") {
          const body = await request.json();
          assert.equal(`chat:${body.inbox}`, id.name);
          homes.set(id.name, { home: "gateway", movedAt: 5, keys: 12 });
        }
        return Response.json(homes.get(id.name) ?? { home: "worker" });
      },
    }),
  };
  const directory = [];
  const TEXTING = {
    async inboxFetch({ name }, request) {
      directory.push(`${name} ${new URL(request.url).pathname}`);
      if (name === `enam:group-key:${MINE}`) return Response.json({ line: "+15555550199", groupId: GROUP_ID });
      return Response.json(null);
    },
  };
  const env = { LAB_SANDBOX: {}, TEX_CHAT, TEXTING, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (value) => Response.json(value);
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (body.accessToken !== DEV) return answer({ status: "refused" });
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
  return { call, asked, directory, homes, logs, restore: () => { globalThis.fetch = original; console.log = realLog; } };
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
    assert.deepEqual(w.directory, [`enam:group-key:${MINE} /chat-where`]);
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
