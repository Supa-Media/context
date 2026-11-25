import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createApp } from "../container/app.mjs";
import { RequestError } from "../container/errors.mjs";
import { createLogger, createLogRing } from "../container/log.mjs";

const LINE = "+15550100123";

function fakeRuntime(overrides = {}) {
  const calls = [];
  const runtime = {
    calls,
    health: () => ({ ok: true, configured: true, started: true, lines: [{ line: "0123", frontier: 5 }], queued: 0 }),
    start: async (checkpoints) => {
      calls.push(["start", checkpoints]);
    },
    nextEvent: async () => null,
    ack: (id) => (id === "abc123:1" ? { line: LINE, frontier: 6 } : null),
    execute: async (op, args) => {
      calls.push(["execute", op, args]);
      return { ok: true, guid: "msg-out-1" };
    },
    openAttachment: async () => {
      throw new RequestError(404, "attachmentNotFound");
    },
    ...overrides,
  };
  return runtime;
}

async function serve(runtime, logs = [], ring) {
  const server = createApp({ runtime, log: (record) => logs.push(record), ring, now: () => 1000 }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    logs,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function call(base, path, init) {
  const response = await fetch(base + path, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
}

test("ready and health answer without touching Photon", async () => {
  const server = await serve(fakeRuntime());
  try {
    assert.deepEqual(await call(server.base, "/ready"), { status: 200, body: { ok: true } });
    const health = await call(server.base, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.lines, [{ line: "0123", frontier: 5 }]);
  } finally {
    await server.close();
  }
});

test("start passes validated checkpoints and refuses a malformed one", async () => {
  const runtime = fakeRuntime();
  const server = await serve(runtime);
  try {
    const ok = await call(server.base, "/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpoints: { [LINE]: 12 } }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(runtime.calls[0], ["start", { [LINE]: 12 }]);

    const bad = await call(server.base, "/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpoints: { "not-a-line": 12 } }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_line");
    assert.equal(runtime.calls.length, 1);
  } finally {
    await server.close();
  }
});

test("next returns 204 when nothing is queued, and the event when there is one", async () => {
  const event = { id: "abc123:1", line: LINE, seq: 9, event: { seq: 9, type: "chat.other" } };
  let queued = null;
  const server = await serve(fakeRuntime({ nextEvent: async () => queued }));
  try {
    const empty = await fetch(`${server.base}/next?wait=10`);
    assert.equal(empty.status, 204);
    queued = event;
    const item = await call(server.base, "/next?wait=10");
    assert.equal(item.status, 200);
    assert.equal(item.body.id, "abc123:1");
  } finally {
    await server.close();
  }
});

test("ack advances the frontier for a known id and 404s for one that is gone", async () => {
  const server = await serve(fakeRuntime());
  try {
    const known = await call(server.base, "/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123:1" }),
    });
    assert.deepEqual(known.body, { ok: true, line: LINE, frontier: 6 });
    const gone = await call(server.base, "/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "zzzz:1" }),
    });
    assert.equal(gone.status, 404);
    const malformed = await call(server.base, "/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "../../x" }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    await server.close();
  }
});

test("an op runs only after its body validates, and its result is returned", async () => {
  const runtime = fakeRuntime();
  const logs = [];
  const server = await serve(runtime, logs);
  try {
    const sent = await call(server.base, "/send/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: LINE, chat: "any;-;+15550100999", text: "hi" }),
    });
    assert.deepEqual(sent.body, { ok: true, guid: "msg-out-1" });
    assert.equal(runtime.calls[0][1], "send/text");

    const refused = await call(server.base, "/send/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: "bad", chat: "any;-;+15550100999", text: "hi" }),
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "invalid_line");
    assert.equal(runtime.calls.length, 1, "the runtime was not called for a refused body");

    const op = logs.find((record) => record.event === "op" && record.ok);
    assert.equal(op.op, "send/text");
    assert.equal(op.line, LINE);
    assert.equal(op.status, 200);
    assert.equal(JSON.stringify(logs).includes('"hi"'), false, "message text is never logged");
  } finally {
    await server.close();
  }
});

test("an SDK-shaped failure keeps its status and code, with no message", async () => {
  const runtime = fakeRuntime({
    execute: async () => {
      throw Object.assign(new Error("no chat for +15550100999 saying secret"), { code: "chatNotFound" });
    },
  });
  const server = await serve(runtime);
  try {
    const response = await fetch(`${server.base}/unsend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ line: LINE, chat: "any;-;+15550100999", guid: "msg-1" }),
    });
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.error, "chatNotFound");
    assert.equal(JSON.stringify(body).includes("secret"), false);
  } finally {
    await server.close();
  }
});

test("GET ops other than the health and attachment routes, and unknown paths, are 404", async () => {
  const server = await serve(fakeRuntime());
  try {
    assert.equal((await fetch(`${server.base}/send/text`)).status, 404);
    assert.equal((await fetch(`${server.base}/nope`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${server.base}/attachment/%20bad`)).status, 400);
  } finally {
    await server.close();
  }
});

test("a missing attachment is reported with its status", async () => {
  const server = await serve(fakeRuntime());
  try {
    const response = await fetch(`${server.base}/attachment/at_0_fixture`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "attachmentNotFound");
  } finally {
    await server.close();
  }
});

test("an attachment streams its primary chunks", async () => {
  const server = await serve(fakeRuntime({
    openAttachment: async () => ({
      info: { mimeType: "image/png" },
      chunks: (async function* () {
        yield Buffer.from("abc");
        yield Buffer.from("def");
      })(),
    }),
  }));
  try {
    const response = await fetch(`${server.base}/attachment/at_0_fixture`);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(await response.text(), "abcdef");
  } finally {
    await server.close();
  }
});

test("logs reads the container's records after a number, allowlisted, with the process's boot id", async () => {
  const ring = createLogRing(3, "boot1");
  const log = createLogger({ write: () => {} }, ring);
  log({ event: "line.start", line: LINE });
  log({ event: "line.stream_failed", line: LINE, attempt: 1, error: "unavailable", text: "never logged" });
  const server = await serve(fakeRuntime(), [], ring);
  try {
    const all = await call(server.base, "/logs?after=0");
    assert.equal(all.body.boot, "boot1");
    assert.equal(all.body.next, 2);
    assert.deepEqual(all.body.records.map((record) => [record.id, record.event, record.line]), [[1, "line.start", "0123"], [2, "line.stream_failed", "0123"]]);
    assert.equal("text" in all.body.records[1], false);
    const after = await call(server.base, "/logs?after=1");
    assert.deepEqual(after.body.records.map((record) => record.id), [2]);
    log({ event: "a" });
    log({ event: "b" });
    const kept = await call(server.base, "/logs?after=0");
    assert.deepEqual(kept.body.records.map((record) => record.id), [2, 3, 4], "only the last three are kept");
  } finally {
    await server.close();
  }
});

test("the frontiers are served on the container's own port for the object to store", async () => {
  const server = await serve(fakeRuntime({ frontiers: () => ({ [LINE]: 9 }) }));
  try {
    assert.deepEqual(await call(server.base, "/frontiers"), { status: 200, body: { checkpoints: { [LINE]: 9 } } });
  } finally {
    await server.close();
  }
});

test("next passes the chats to skip on, and refuses a skip list that is too long", async () => {
  let seen = null;
  const server = await serve(fakeRuntime({ nextEvent: async (_ms, skip) => { seen = skip; return null; } }));
  try {
    const empty = await fetch(`${server.base}/next?wait=10&skip=any%3B%2B%3Ba&skip=any%3B%2B%3Bb`);
    assert.equal(empty.status, 204);
    assert.deepEqual([...seen], ["any;+;a", "any;+;b"]);
    const many = new URLSearchParams(Array.from({ length: 201 }, (_, i) => ["skip", `c${i}`]));
    const refused = await fetch(`${server.base}/next?${many}`);
    assert.equal(refused.status, 400);
  } finally {
    await server.close();
  }
});
