// The chat's Tex page in its Tex object (src/texStore/pageRecords.js, pageLive.js):
// records kept once and seven days, and a write reaching an open page's socket.
import { test } from "node:test";
import assert from "node:assert/strict";

import { TexStore } from "../src/texStore.js";
import { texObjects } from "../src/texStore/objects.js";
import { readPageRecords } from "../src/texStore/pageRecords.js";
import { PAGE_CLOSE_REAUTH, PAGE_LIVE_PATH, PAGE_VIEWER_HEADER, pageLive, pokeTexPage } from "../src/texStore/pageLive.js";
import { serveTexStore, texBucket } from "../src/texStore/wire.js";
import { R2Store } from "../src/store/r2.js";
import { arrivedSql, durableSql, texStoreNamespace } from "./texStoreFixture.mjs";

/** A socket's server end, as the runtime hands one to the object: what was sent, and how it closed. */
function fakeSocket() {
  const ws = {
    sent: [],
    closed: null,
    readyState: 1,
    attachment: null,
    send(frame) {
      if (ws.readyState !== 1) throw new Error("closed");
      ws.sent.push(JSON.parse(frame));
    },
    close(code, reason) {
      ws.closed = { code, reason };
      ws.readyState = 3;
    },
    serializeAttachment(value) {
      ws.attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return ws.attachment;
    },
  };
  return ws;
}

/** A Durable Object state with hibernatable sockets. */
function socketState(sql = durableSql()) {
  const sockets = [];
  const storage = {
    sql,
    alarm: null,
    setAlarm(at) {
      storage.alarm = at;
    },
    deleteAlarm() {
      storage.alarm = null;
    },
  };
  return {
    sockets,
    storage,
    blockConcurrencyWhile: (run) => run(),
    acceptWebSocket(ws, tags) {
      ws.tags = tags;
      sockets.push(ws);
    },
    getWebSockets(tag) {
      return sockets.filter((ws) => ws.tags?.includes(tag));
    },
  };
}

const viewerRequest = (viewer) =>
  new Request(`https://tex-store.internal${PAGE_LIVE_PATH}`, { headers: { Upgrade: "websocket", [PAGE_VIEWER_HEADER]: JSON.stringify(viewer) } });


/** A chat's log, as the page sees it: the views `objects.records` gives the object (the log provides the real ones). */
function viewOver(items) {
  return {
    list: (kind, { limit = 20 } = {}) => ({ items: items.filter((item) => item.kind === kind).slice(0, limit), count: items.filter((item) => item.kind === kind).length }),
    waiting: () => items.filter((item) => item.kind === "mailcheck" && item.verdict === "waiting").length,
  };
}

test("page_list answers the log's views, and an empty page while the object has none", async () => {
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  assert.deepEqual(await readPageRecords(env, { person: "ws_rec" }, "thinking"), { items: [], count: 0 });
  const objects = texObjects(arrivedSql(durableSql()));
  objects.records = viewOver([{ kind: "mailcheck", id: "m1", at: 5, verdict: "waiting" }, { kind: "thinking", id: "t1", at: 4 }]);
  const stubEnv = { TEX_STORE: { idFromName: (name) => name, get: () => ({ fetch: (request) => serveTexStore(objects, request) }) } };
  const mail = await readPageRecords(stubEnv, { person: "ws_rec" }, "mailcheck", { since: 0 });
  assert.deepEqual(mail.items.map((item) => item.id), ["m1"]);
  assert.equal(mail.waiting, 1);
  assert.deepEqual(await readPageRecords(stubEnv, { person: "ws_rec" }, "secrets"), { items: [], count: 0 });
  assert.deepEqual(await readPageRecords({}, { person: "ws_rec" }, "thinking"), { items: [], count: 0 });
});

function liveOver({ now = () => 1_000_000, texting } = {}) {
  const state = socketState();
  const sockets = [];
  const page = pageLive(state, state.storage.sql, { TEXTING: texting }, {
    now,
    pair: () => {
      const client = { client: true };
      const server = fakeSocket();
      sockets.push(server);
      return [client, server];
    },
    upgraded: (client) => ({ status: 101, client }),
  });
  return { state, page, sockets };
}

test("live: a record or a note written in the object reaches an open page; a socket past its deadline is closed to re-authorize", async () => {
  let clock = 1_000_000;
  const { page, sockets } = liveOver({ now: () => clock });
  const answer = page.accept(viewerRequest({ deadline: clock + 60_000, chat: { phone: "+15555550100" } }));
  assert.equal(answer.status, 101);
  const objects = texObjects(arrivedSql(durableSql()));
  const live = { changed: (sections) => page.changed(sections) };
  const stub = { fetch: (request) => serveTexStore(objects, request, null, live) };
  // A change the log or a page act announces.
  await stub.fetch(new Request("https://tex-store.internal/page_poke", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "page_poke", sections: ["thinking"] })) } }));
  assert.deepEqual(sockets[0].sent.map((frame) => frame.section), ["thinking", "tiles"]);
  // A note Tex saved (About, a routine): the note sections.
  await new R2Store(texBucket(stub)).put("notes/0199a000-0000-7000-8000-000000000009.md", "# About me\n\n- Likes tea");
  assert.deepEqual(sockets[0].sent.slice(2).map((frame) => frame.section), ["about", "routines", "checkins", "tiles"]);
  // The object's bookkeeping is not a change on the page.
  await new R2Store(texBucket(stub)).put("state/agent/history/texts.json", "{}");
  assert.equal(sockets[0].sent.length, 6);
  // A ping is answered.
  page.message(sockets[0], JSON.stringify({ t: "ping" }));
  assert.deepEqual(sockets[0].sent.at(-1), { t: "pong" });
  clock += 61_000;
  assert.equal(page.changed(["settings"]), 0);
  assert.equal(sockets[0].closed.code, PAGE_CLOSE_REAUTH);
});

test("live: the gateway's viewer header is required, and a socket never outlives five minutes", () => {
  const { page, sockets } = liveOver();
  assert.equal(page.accept(viewerRequest(null)).status, 400);
  page.accept(viewerRequest({ deadline: Number.MAX_SAFE_INTEGER, chat: null }));
  assert.equal(sockets[0].attachment.deadline, 1_000_000 + 5 * 60 * 1000);
});

test("live: an open page polls the chat's jobs and is pushed only what changed, with values", async () => {
  let clock = Date.UTC(2026, 10, 2, 12);
  const calls = [];
  let jobs = [{ id: "j1", title: "Book dinner Friday", state: "running", startedAt: clock - 60_000, steps: [{ at: clock - 30_000, text: "Opened resy.com" }] }];
  const texting = { pageJobs: async (call) => (calls.push(call), { now: clock, jobs }) };
  const { page, sockets } = liveOver({ now: () => clock, texting });
  page.accept(viewerRequest({ deadline: clock + 60_000, chat: { groupKey: "a".repeat(64) }, timeZone: "America/New_York" }));
  assert.equal(page.pollAt(), clock);
  const next = await page.poll();
  assert.deepEqual(calls[0], { chat: { groupKey: "a".repeat(64) } });
  assert.equal(next, clock + 2_000);
  const sections = sockets[0].sent.map((frame) => frame.section);
  assert.deepEqual(sections, ["status", "minions", "earlier", "earlierWeek", "job"]);
  const minions = sockets[0].sent.find((frame) => frame.section === "minions").value;
  assert.equal(minions[0].job.title, "Book dinner Friday");
  assert.equal(minions[0].job.now, "Opened resy.com");
  assert.equal(minions[1].job, null);
  // Nothing changed: nothing pushed.
  await page.poll();
  assert.equal(sockets[0].sent.length, 5);
  // A new step: the slot and the job page, nothing else.
  jobs = [{ ...jobs[0], steps: [...jobs[0].steps, { at: clock, text: "Found 3 places", failed: true, why: "slow" }] }];
  await page.poll();
  assert.deepEqual(sockets[0].sent.slice(5).map((frame) => frame.section), ["minions", "job"]);
  assert.equal(sockets[0].sent.at(-1).value.failedSteps, 1);
  // Done: slot freed, earlier today has it, polled slower.
  jobs = [{ ...jobs[0], state: "done", finishedAt: clock }];
  assert.equal(await page.poll(), clock + 15_000);
  const earlier = sockets[0].sent.filter((frame) => frame.section === "earlier").at(-1).value;
  assert.equal(earlier[0].state, "done");
  // No page open: no poll.
  sockets[0].close(1000, "bye");
  assert.equal(page.pollAt(), null);
});

test("live, end to end in the Tex object: a page opens through the object and hears a note written by another caller and a poke; wipe closes it", async () => {
  const state = socketState(arrivedSql(durableSql()));
  const sockets = [];
  const store = new TexStore(state, {}, {
    dispatch: async () => ({ next: null }),
    pageDeps: {
      pair: () => {
        const server = fakeSocket();
        sockets.push(server);
        return [{}, server];
      },
      upgraded: () => ({ status: 101 }),
    },
  });
  store.ready();
  arrivedSql(state.storage.sql);
  const opened = await store.fetch(
    new Request(`https://tex-store.internal${PAGE_LIVE_PATH}`, {
      headers: { Upgrade: "websocket", "x-tex-owner": "person:ws_live", [PAGE_VIEWER_HEADER]: JSON.stringify({ deadline: Date.now() + 60_000, chat: null }) },
    }),
  );
  assert.equal(opened.status, 101);
  // The first poll is armed at once.
  assert.ok(typeof state.storage.alarm === "number");
  const env = { TEX_STORE: { idFromName: (name) => name, get: () => ({ fetch: (request) => store.fetch(request) }) } };
  // A note written through the gateway's store, as the app's editor or Tex would.
  await new R2Store(texBucket(texStoreStubFor(env))).put("notes/0199a000-0000-7000-8000-000000000010.md", "# Routine");
  assert.deepEqual(sockets[0].sent.map((frame) => frame.section), ["about", "routines", "checkins", "tiles"]);
  assert.equal(await pokeTexPage(env, { person: "ws_live" }, ["settings", "nonsense"]), true);
  assert.deepEqual(sockets[0].sent.slice(4).map((frame) => frame.section), ["settings", "tiles"]);
  await store.fetch(new Request("https://tex-store.internal/wipe", { method: "POST", headers: { "x-tex-owner": "person:ws_live", "x-tex-call": encodeURIComponent(JSON.stringify({ op: "wipe" })) } }));
  assert.equal(sockets[0].closed.code, 1000);
});

const texStoreStubFor = (env) => ({ fetch: (request) => (request.headers.set("x-tex-owner", "person:ws_live"), env.TEX_STORE.get(env.TEX_STORE.idFromName("x")).fetch(request)) });
