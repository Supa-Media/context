// The Lab's `intake` op (packages/lab/gateway/labSandbox/intake.js): a Tex developer sees where their own chats are
// answered, and staff count every chat by home. Every chat lives in the gateway, born there on its first call; the
// texting Worker's SenderInbox class is deleted (part C of the runtime simplification, 2026-11-25), so nothing here moves,
// copies or asks the Worker. What these prove: only the caller's own chats are named, a 1:1 is its phone's object and a
// group its directory entry's, nothing answered or logged carries a phone or a group id, and a stranger sees nothing.
// Fake numbers and ids only.
//
// Sabotage (temporary local edits, reverted):
//   intake.js `chatsOf` accepting any 64-hex chatId (2026-11-21)          "a group the caller is not in ..." fails
//   intake.js log line carrying `name` (2026-11-21)                       "no phone or group id ..." fails
//   intake.js `sweep` counting "none" as gateway (2026-11-25)             "a sweep counts every chat by home ..." fails
//   intake.js `homeAt` POSTing /move-in again (2026-11-25)                "nothing is moved or copied ..." fails

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
  // The gateway's chat objects, by name: each knows only whether it has had its first call.
  const homes = new Map();
  const asked = [];
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
        if (path !== "/home") return Response.json({ error: "unknown_route" }, { status: 404 });
        return Response.json(homes.get(id.name) ?? { home: "none" });
      },
    }),
  };
  const TEXTING = { inboxFetch: async () => assert.fail("the Worker is never asked") };
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
  return { env, call, asked, directory, homes, logs, restore: () => { globalThis.fetch = original; console.log = realLog; } };
}

test("intake lists the caller's own chats and where each is answered", async () => {
  const w = world();
  try {
    w.homes.set(`chat:${PHONE}`, { home: "gateway", movedAt: 5, keys: 12 });
    const listed = await w.call(DEV, { op: "intake" });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, {
      chats: [
        { chatId: "me", name: "You and Tex", kind: "1:1", home: "gateway", movedAt: 5, keys: 12 },
        { chatId: MINE, name: "Tex Devs", kind: "group", home: "none" },
      ],
    });
    // The 1:1 is its phone's object; the group is read from its directory entry, then its own object.
    assert.deepEqual(w.asked, [`chat:${PHONE} GET /home`, `chat:sendblue-group:${GROUP_ID} GET /home`]);
    assert.deepEqual(w.directory, [`chat:group-key:${MINE} group-key:${MINE}`]);
    const one = await w.call(DEV, { op: "intake", chatId: "me" });
    assert.deepEqual(one.body, { chatId: "me", name: "You and Tex", kind: "1:1", home: "gateway", movedAt: 5, keys: 12 });
  } finally {
    w.restore();
  }
});

test("nothing is moved or copied, whatever the call asks", async () => {
  const w = world();
  try {
    await w.call(DEV, { op: "intake", chatId: "me", move: true });
    await w.call(DEV, { op: "intake", sweep: true, move: true });
    await w.call(DEV, { op: "intake", workerIds: [MINE], archive: true });
    assert.ok(w.asked.length > 0);
    assert.ok(w.asked.every((line) => line.endsWith(" GET /home")), w.asked.join("\n"));
  } finally {
    w.restore();
  }
});

test("a group the caller is not in, a bad chatId, and a stranger are refused", async () => {
  const w = world();
  try {
    assert.equal((await w.call(DEV, { op: "intake", chatId: NOT_MINE })).status, 404);
    assert.equal((await w.call(DEV, { op: "intake", chatId: "../x" })).status, 404);
    assert.equal((await w.call(STRANGER, { op: "intake", chatId: "me" })).status, 403);
    assert.equal((await w.call(STRANGER, { op: "intake" })).status, 403);
    assert.equal((await w.call(STRANGER, { op: "intake", sweep: true })).status, 403);
    assert.deepEqual(w.directory, []);
  } finally {
    w.restore();
  }
});

test("no phone or group id is answered or logged", async () => {
  const w = world();
  try {
    const answers = [await w.call(DEV, { op: "intake", chatId: "me" }), await w.call(DEV, { op: "intake", chatId: MINE }), await w.call(DEV, { op: "intake" }), await w.call(DEV, { op: "intake", sweep: true })];
    const said = JSON.stringify(answers) + w.logs.join("\n");
    assert.equal(said.includes(PHONE), false);
    assert.equal(said.includes("+15555550102"), false);
    assert.equal(said.includes(GROUP_ID), false);
    assert.ok(w.logs.some((line) => line.includes('"lab_intake"')), "each ask is logged, by kind");
  } finally {
    w.restore();
  }
});

test("a sweep counts every chat by home, answers counts only, and pages from after", async () => {
  const w = world();
  try {
    w.homes.set(`chat:${PHONE}`, { home: "gateway" });
    const census = await w.call(DEV, { op: "intake", sweep: true });
    // Two phones and two groups pass; NOT_MINE has no directory entry, so it is unknown.
    assert.deepEqual(census.body, { total: 4, people: 2, groups: 2, after: 0, looked: 4, gateway: 1, none: 2, unknown: 1, next: null });
    const page = await w.call(DEV, { op: "intake", sweep: true, after: 3 });
    assert.equal(page.body.looked, 1);
    assert.equal(page.body.next, null);
  } finally {
    w.restore();
  }
});
