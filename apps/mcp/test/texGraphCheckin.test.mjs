/**
 * The check-in's start node on its own (`src/agent/graph/nodes/checkin.js`):
 * the wire each outcome leaves on, and that what it returns is plain data.
 *
 * The end-to-end check-in tests (`agentHeartbeat.test.mjs`) run the whole
 * worker. These run the node alone, with the same fixtures where they reach
 * that far (`AI_GATEWAY_ENV`, `BUILTIN_ALLOWED`) and small in-memory stand-ins
 * for the note tools and the tree, so a graph runner can rely on the node's
 * outputs without the rest of the check-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkin } from "../src/agent/graph/nodes/checkin.js";
import { heartbeatPath, NOTHING_NEW_WORDS } from "../src/agent/heartbeat.js";
import { AI_GATEWAY_ENV, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
/** Words that must never reach an output: a note's text, which the node may hold but never hand on. */
const SENTINEL = "FAKE-NOTE-BODY-SENTINEL-7f3a";

/** Note reads and writes as the check-in's `read_note` and `write_note` answer them, kept in memory. */
function notesFixture(files) {
  const notes = new Map(Object.entries(files));
  const writes = [];
  const dispatch = async (name, args) => {
    if (name === "read_note") {
      const note = notes.get(args.path);
      if (!note) return { isError: true, content: [{ type: "text", text: `not found: ${args.path}` }] };
      return { content: [{ type: "text", text: `etag: ${note.etag}\n\n${note.body}` }] };
    }
    if (name === "write_note") {
      writes.push(args);
      notes.set(args.path, { body: args.content, etag: `w${writes.length}` });
      return { content: [{ type: "text", text: "written" }] };
    }
    throw new Error(`the check-in node called ${name}, which this fixture does not answer`);
  };
  return { dispatch, writes };
}

/** The `io` a runner gives the node: its live parts in `io.ctx.checkin`, as `handleHeartbeat` builds them. */
function ioFor({ files = {}, tree = [], verdict = BUILTIN_ALLOWED, delivered = null } = {}) {
  const { dispatch, writes } = notesFixture(files);
  const delivers = [];
  const store = {
    // A served index with `entries` as the tree's answer: `objectOf` reads `path` and `updatedAt`.
    treeManifest: async () => ({ served: true, entries: tree, cursor: null }),
  };
  const checkinCtx = {
    dispatch,
    store,
    session: { workspaceId: "ws_node", grantId: "grant_node", actorUserId: "user_node", accessToken: "cat_node_fixture", workspaceSlug: "node" },
    env: { ...AI_GATEWAY_ENV },
    controlPlane: { startBuiltinTurn: async () => verdict },
    deliver: async (_dispatch, _store, options) => {
      delivers.push(options);
      return delivered;
    },
  };
  return { io: { ctx: { checkin: checkinCtx } }, checkinCtx, writes, delivers };
}

const input = (overrides = {}) => ({ timeZone: "UTC", since: null, attention: false, started: NOW, ...overrides });

/** Plain data only: a JSON round trip changes nothing, and no note text is in it. */
function assertPlain(output) {
  const text = JSON.stringify(output);
  assert.deepEqual(JSON.parse(text), output);
  assert.equal(text.includes(SENTINEL), false, "the output carries note text");
}

test("a paused check-in ends on done with the paused body, reads only its settings, and writes nothing", async () => {
  const { io, writes } = ioFor({ files: { "tex/heartbeat.md": { body: `---\npaused: true\n---\n${SENTINEL}\n`, etag: "h1" } } });
  const out = await checkin(input(), io);
  assert.deepEqual(out, { to: "done", status: 200, body: { outcome: "paused" } });
  assertPlain(out);
  assert.equal(writes.length, 0);
});

test("nothing changed ends on done with nothing_new, and its one log line says why", async () => {
  const { io, writes } = ioFor({});
  const out = await checkin(input(), io);
  assert.deepEqual(out, { to: "done", status: 200, body: { outcome: "nothing_new" } });
  assertPlain(out);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /^tex\/heartbeat\/\d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(writes[0].content.includes(NOTHING_NEW_WORDS));
});

test("a ping the agents asked for goes to attention with the text it delivered", async () => {
  const { io, delivers } = ioFor({ delivered: { text: "Your 3pm call moved to 4.", count: 1 } });
  const out = await checkin(input({ attention: true }), io);
  assert.deepEqual(out, { to: "attention", outcome: "speak", answer: "Your 3pm call moved to 4." });
  assertPlain(out);
  assert.deepEqual(delivers, [{ now: NOW, timeZone: "UTC", onlyEmergencies: false }]);
});

test("a ping with nothing to deliver is quiet, and quiet hours say when to come back", async () => {
  const quiet = await checkin(input({ attention: true }), ioFor({}).io);
  assert.deepEqual(quiet, { to: "attention", outcome: "quiet" });
  // NOW is 15:00 UTC, so a window from 14:00 to 16:00 holds it.
  const hours = ioFor({ files: { "tex/heartbeat.md": { body: "---\nquiet-hours: 14:00-16:00\n---\n", etag: "q1" } } });
  const held = await checkin(input({ attention: true }), hours.io);
  assert.equal(held.to, "attention");
  assert.equal(held.outcome, "quiet_hours");
  assert.equal(typeof held.until, "number");
});

test("a look with something changed goes on to look, with its counts and the live values on the ctx, never in the output", async () => {
  const tree = [{ path: "1-projects/launch.md", etag: "c1", updatedAt: NOW - 1000 }];
  const { io, checkinCtx } = ioFor({ tree, files: { "1-projects/launch.md": { body: `${SENTINEL}\n`, etag: "c1" } } });
  const out = await checkin(input({ since: NOW - HOUR_MS }), io);
  assert.deepEqual(out, {
    to: "look",
    counts: { changed: 1, mail: 0, slack: 0, chat: 0, owed: 0 },
    calendar: false,
  });
  assertPlain(out);
  assert.deepEqual(
    checkinCtx.look.changed.map((note) => note.key),
    ["1-projects/launch.md"],
  );
});

test("a refused provider ends on done with the refusal's status and body, logged first", async () => {
  const tree = [{ path: "1-projects/launch.md", etag: "c1", updatedAt: NOW - 1000 }];
  const { io, writes } = ioFor({ tree, verdict: { allowed: false, reason: "daily_cap" }, files: {} });
  const out = await checkin(input({ since: NOW - HOUR_MS }), io);
  assert.deepEqual(out, { to: "done", status: 429, body: { error: "daily_limit" } });
  assertPlain(out);
  assert.equal(writes.length, 1);
});
