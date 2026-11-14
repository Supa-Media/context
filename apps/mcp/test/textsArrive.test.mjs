/**
 * The texting Worker's arrival route (`src/agent/textsArrive.js`) over the `TexTexts` entrypoint: the body's size and
 * shape, the 501 without a binding, the placement of each chat's object, the forwarded outcome, and a log line that
 * carries the kind and outcome only.
 *
 * Sabotage record (to be applied, run, observed failing, reverted):
 *  1. Forward the arrival with `idFromName` directly, skipping `objectByName` → "placed in eastern North America" must fail.
 *  2. Log the message in the arrival line → "the log line carries no text" must fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TEXTS_ARRIVE_PATH, MAX_ARRIVE_BYTES, arriveForTexts } from "../src/agent/textsArrive.js";
import { TexTexts, TexChat } from "../src/index.js";
import { TexChatDurableObject } from "../src/texChat.js";
import { chatState } from "./texChatFixture.mjs";

/** A `TEX_CHAT` namespace over real `TexChat` objects, one per name, recording each stub's name and placement. */
function chatNamespace() {
  const objects = new Map();
  const placements = [];
  const namespace = {
    idFromName: (name) => name,
    get(id, options) {
      placements.push({ id, locationHint: options?.locationHint });
      if (!objects.has(id)) objects.set(id, new TexChatDurableObject(chatState(), {}, { now: () => 1_000_000 }));
      const object = objects.get(id);
      return { fetch: (url, init) => object.fetch(new Request(url, init)) };
    },
  };
  return { namespace, placements, objects };
}

const post = (body, extraHeaders = {}) => new Request(`https://texts${TEXTS_ARRIVE_PATH}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: extraHeaders });
const arrival = (extra = {}) => ({ kind: "one", inbox: "chat-one", eventId: "e1", message: { text: "hello there" }, ...extra });

/** Runs `run` with `console.log` captured, returning what it answered and the log lines. */
async function logged(run) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    return { result: await run(), lines };
  } finally {
    console.log = original;
  }
}

test("the route is on the texting entrypoint and the chat object is exported", () => {
  assert.equal(TEXTS_ARRIVE_PATH, "/texts/arrive");
  assert.equal(typeof TexChat, "function");
  assert.equal(typeof TexTexts.fetch, "function");
});

test("a valid arrival is queued in its chat's object, placed with the hint", async () => {
  const { namespace, placements } = chatNamespace();
  const { result } = await logged(() => arriveForTexts(post(arrival()), { TEX_CHAT: namespace }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { outcome: "queued", seq: 1 });
  assert.deepEqual(placements, [{ id: "chat:chat-one", locationHint: "enam" }]);
});

test("the same chat's second arrival reaches the same object, and a duplicate is answered", async () => {
  const { namespace, placements, objects } = chatNamespace();
  await arriveForTexts(post(arrival()), { TEX_CHAT: namespace });
  const again = await arriveForTexts(post(arrival()), { TEX_CHAT: namespace });
  assert.deepEqual(await again.json(), { outcome: "duplicate" });
  assert.equal(objects.size, 1);
  assert.equal(placements.length, 2);
});

test("the entrypoint routes the arrival path to the handler", async () => {
  const { namespace } = chatNamespace();
  const response = await TexTexts.fetch(post(arrival()), { TEX_CHAT: namespace }, undefined);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { outcome: "queued", seq: 1 });
});

test("without the binding the arrival is 501 no_chat_home, after the body is checked", async () => {
  const { result } = await logged(() => arriveForTexts(post(arrival()), {}));
  assert.equal(result.status, 501);
  assert.deepEqual(await result.json(), { error: "no_chat_home" });
  assert.equal((await arriveForTexts(post({ kind: "bogus", inbox: "x", message: {} }), {})).status, 400);
});

test("bad bodies are refused 400 before anything is forwarded", async () => {
  const { namespace, placements } = chatNamespace();
  const bad = [
    "not json",
    arrival({ kind: "bogus" }),
    arrival({ inbox: "has/slash" }),
    arrival({ inbox: "" }),
    arrival({ message: "a string" }),
    arrival({ message: [1] }),
    arrival({ message: null }),
    arrival({ eventId: 42 }),
    arrival({ eventId: "x".repeat(201) }),
    arrival({ eventId: "" }),
    arrival({ origin: 9 }),
    [1, 2],
  ];
  for (const body of bad) {
    const { result } = await logged(() => arriveForTexts(post(body), { TEX_CHAT: namespace }));
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(placements.length, 0);
});

test("a body over 256 KiB is refused 413 and nothing is forwarded", async () => {
  const { namespace, placements } = chatNamespace();
  const big = arrival({ message: { text: "x".repeat(MAX_ARRIVE_BYTES) } });
  const { result } = await logged(() => arriveForTexts(post(big), { TEX_CHAT: namespace }));
  assert.equal(result.status, 413);
  assert.equal(placements.length, 0);
});

test("the log line carries the kind and outcome, never the message or the inbox name", async () => {
  const { namespace } = chatNamespace();
  const secretInbox = "secret-chat-handle";
  const { lines } = await logged(async () => {
    await arriveForTexts(post(arrival({ inbox: secretInbox, message: { text: "TOP SECRET WORDS" } })), { TEX_CHAT: namespace });
    await arriveForTexts(post(arrival({ inbox: secretInbox, message: { text: "TOP SECRET WORDS" } })), { TEX_CHAT: namespace });
    await arriveForTexts(post(arrival({ kind: "bogus" })), {});
  });
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { event: "texts_arrive", kind: "one", outcome: "queued" });
  assert.deepEqual(JSON.parse(lines[1]), { event: "texts_arrive", kind: "one", outcome: "duplicate" });
  for (const line of lines) {
    assert.ok(!line.includes("SECRET"));
    assert.ok(!line.includes(secretInbox));
  }
});
