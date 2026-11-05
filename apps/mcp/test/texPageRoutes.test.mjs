/**
 * The Tex page's routes (`src/http/texPage/`), end to end through the worker
 * with the control plane's contract, the texting Worker's RPC faked, and the
 * real Tex objects.
 *
 * What everything here serves: **a person sees and changes only their own
 * chats.** Only the Context app's client, only their own handle, only a group
 * they are in, and a group they are not in looks exactly like one that does
 * not exist.
 *
 * ## Sabotage record (2026-11-02)
 *  1. `chatOf` taking any 64-hex key as a group → "bob cannot open alice's
 *     group" fails.
 *  2. The console-client check removed from `checkViewer` → "an MCP client
 *     holding alice's grant is refused" fails.
 *  3. `actOwned` always true → "a routine id from outside the chat is refused
 *     before any note is touched" fails.
 *
 * Fake names, ids, numbers and tokens only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { ticketNamespace, ticketProtocols } from "./liveTicketFixture.mjs";
import { createControlPlaneStub, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";
import { handleTexPageLive } from "../src/http/texPage/live.js";
import { PAGE_VIEWER_HEADER } from "../src/texStore/pageLive.js";
import { actOwned } from "../src/http/texPage/serve.js";

const tok = (name) => `cat_texpage_${name}_`.padEnd(40, "0");
const T = { alice: tok("alice"), bob: tok("bob"), aliceMcp: tok("alicemcp") };
const GROUP = "c".repeat(64);
const BOBS_GROUP = "d".repeat(64);
const ALICE_PHONE = "+15555550101";

const BINDING = {
  provider: "s3",
  status: "active",
  endpoint: "https://s3.texpage.test",
  region: "auto",
  bucket: "tenant-texpage",
  accessKeyId: "AKIAEXAMPLEEXAMPLEAB",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAB",
  forcePathStyle: true,
  capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
};

/** What the control plane answers `/gateway/tex/page` with, per token: each person's own chats only. */
const PAGES = {
  [T.alice]: {
    status: "ok",
    userId: "user_a1x",
    workspaceId: "ws_alice",
    handle: "alice",
    phone: ALICE_PHONE,
    timeZone: "America/New_York",
    instructions: "Be friendly.\nKeep answers short.",
    picks: [{ id: "emoji_none", label: "No emoji" }],
    routines: [{ workspaceId: "ws_alice", slug: null, path: "tex/routines/daily/brief.md", paused: false, nextRunAt: Date.now() + 3_600_000, unit: "day", every: 1 }],
    chats: [{ key: GROUP, name: "Team Night", people: 3, peopleNames: ["You", "ada", "cy"], homeWords: null, homeWorkspaceId: null, homeSlug: null, muted: false, engagement: "attentive", instructions: null, sponsor: "alice", routines: [] }],
  },
  [T.bob]: { status: "ok", userId: "user_b2y", workspaceId: "ws_bob", handle: "bob", phone: null, timeZone: null, instructions: null, picks: [], routines: [], chats: [{ key: BOBS_GROUP, name: "Bob Things", people: 2, peopleNames: ["You", "eve"], homeWords: null, homeSlug: null, engagement: null, instructions: null, sponsor: null, routines: [] }] },
};

async function setUp() {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  controlPlane.addWorkspace("ws_alice", "alice", BINDING);
  controlPlane.addWorkspace("ws_bob", "bob", BINDING);
  const all = ["context:read", "context:write", "context:private"];
  const grant = (accessToken, workspaceId, userId, clientId = "context_console") => controlPlane.addGrant({ accessToken, workspaceId, role: "owner", scopes: all, clientId, userId });
  await grant(T.alice, "ws_alice", "user_a1x");
  await grant(T.bob, "ws_bob", "user_b2y");
  await grant(T.aliceMcp, "ws_alice", "user_a1x", "mcp_client_alice");
  // The two page calls, on the stub's own transport.
  const settings = [];
  const stubbed = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === `${CONTROL_PLANE_ORIGIN}/gateway/tex/page` || url === `${CONTROL_PLANE_ORIGIN}/gateway/tex/page/settings`) {
      const body = JSON.parse(init.body);
      const page = PAGES[body.accessToken];
      if (url.endsWith("/settings")) {
        settings.push(body);
        const known = page && (body.chat === "me" || page.chats.some((chat) => chat.key === body.chat));
        return Response.json(known ? { status: "done", ...(body.values.pick ? { instructions: `${body.values.pick} line.` } : {}) } : { status: "not_found" });
      }
      return Response.json(page ?? { status: "refused" });
    }
    return stubbed(input, init);
  };
  const texting = { jobsAsked: [], steered: [] };
  const now = Date.now();
  const TEXTING = {
    async pageJobs({ chat }) {
      texting.jobsAsked.push(chat);
      if (chat.phone !== ALICE_PHONE && chat.groupKey !== GROUP) return { now, jobs: [] };
      return {
        now,
        jobs: [
          { id: "job1", title: "Book dinner Friday", state: "waiting", status: "Needs your sign-in code", startedAt: now - 120_000, steps: [{ at: now - 60_000, text: "Opened resy.com" }] },
          { id: "job2", title: "Research maritime.sh", state: "running", startedAt: now - 60_000, steps: [{ at: now - 30_000, text: "Opened maritime.sh", failed: true, why: "The page took too long" }] },
          { id: "job0", title: "Compare florists", state: "done", startedAt: now - 3_600_000, finishedAt: now - 3_000_000, steps: [], result: "Saved a comparison page" },
        ],
      };
    },
    async pageSteer(call) {
      texting.steered.push(call);
      return { taken: call.chat.phone === ALICE_PHONE && call.id === "job2" };
    },
  };
  const tex = texStoreNamespace();
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: tex.namespace, GATEWAY_SECRET, APP_ORIGIN: "https://app.context.test", TEXTING };
  return { env, tex, texting, settings, controlPlane, restore: () => ((globalThis.fetch = stubbed), restore()) };
}

async function ask(world, path, { token, body = {} } = {}) {
  const { ctx } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    world.env,
    ctx,
  );
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

test("alice's overview: her chats, her jobs in three slots, and and the parts the chat's log will fill answered empty", async () => {
  const world = await setUp();
  try {
    const answer = await ask(world, "/tex/page", { token: T.alice, body: { handle: "alice", chat: "me", sections: ["chats", "chat", "status", "thinking", "thinkingToday", "minions", "earlier", "earlierWeek", "behind"] } });
    assert.equal(answer.status, 200, answer.text);
    assert.deepEqual(answer.body.chats.map((chat) => chat.key), ["me", GROUP]);
    assert.equal(answer.body.chat.name, "Just you");
    assert.deepEqual(world.texting.jobsAsked.at(-1), { phone: ALICE_PHONE });
    assert.deepEqual(answer.body.status, { jobs: 2, needsYou: 1 });
    assert.deepEqual(answer.body.minions.map((slot) => slot.job?.id ?? null), ["job1", "job2", null]);
    assert.equal(answer.body.minions[1].job.failedSteps, 1);
    assert.equal(answer.body.minions[0].job.needs, "Needs your sign-in code");
    // Until the chat's log provides its views, these are empty, never an error.
    assert.deepEqual(answer.body.thinking, []);
    assert.equal(answer.body.thinkingToday, 0);
    assert.deepEqual(answer.body.behind.mailcheck, { today: 0, waiting: 0 });
    assert.equal(answer.body.earlierWeek, 1);
    // The group's page reads the group's own object and inbox, never hers.
    const group = await ask(world, "/tex/page", { token: T.alice, body: { handle: "alice", chat: GROUP, sections: ["chat", "thinking", "minions"] } });
    assert.equal(group.status, 200);
    assert.equal(group.body.chat.people, 3);
    assert.deepEqual(group.body.thinking, []);
    assert.deepEqual(world.texting.jobsAsked.at(-1), { groupKey: GROUP });
  } finally {
    world.restore();
  }
});

test("bob cannot open alice's group, and is told exactly what a key that names nothing is told", async () => {
  const world = await setUp();
  try {
    const hers = await ask(world, "/tex/page", { token: T.bob, body: { handle: "bob", chat: GROUP } });
    const nothing = await ask(world, "/tex/page", { token: T.bob, body: { handle: "bob", chat: "e".repeat(64) } });
    assert.equal(hers.status, 404);
    assert.equal(hers.text, nothing.text);
    assert.equal(world.texting.jobsAsked.length, 0);
    // Nor steer one of its jobs.
    const steer = await ask(world, "/tex/page/act", { token: T.bob, body: { handle: "bob", chat: GROUP, action: { type: "stop", job: "job2" } } });
    assert.equal(steer.status, 404);
    assert.equal(world.texting.steered.length, 0);
  } finally {
    world.restore();
  }
});

test("only alice's own handle, and only the Context app's client", async () => {
  const world = await setUp();
  try {
    const other = await ask(world, "/tex/page", { token: T.bob, body: { handle: "alice", chat: "me" } });
    assert.equal(other.status, 403);
    assert.equal(other.body.error, "not_yours");
    const mcp = await ask(world, "/tex/page", { token: T.aliceMcp, body: { handle: "alice", chat: "me" } });
    assert.equal(mcp.status, 403);
    assert.equal(mcp.body.error, "forbidden");
    const none = await ask(world, "/tex/page", { body: { handle: "alice", chat: "me" } });
    assert.equal(none.status, 401);
    assert.equal(world.texting.jobsAsked.length, 0);
  } finally {
    world.restore();
  }
});

test("job page, list and acts: a stop reaches her inbox's job; settings go to the control plane for her own chat", async () => {
  const world = await setUp();
  try {
    const job = await ask(world, "/tex/page/job", { token: T.alice, body: { handle: "alice", chat: "me", id: "job2" } });
    assert.equal(job.status, 200);
    assert.equal(job.body.job.steps[0].why, "The page took too long");
    assert.equal(job.body.job.slot, 2);
    const missing = await ask(world, "/tex/page/job", { token: T.alice, body: { handle: "alice", chat: "me", id: "nope" } });
    assert.equal(missing.status, 404);
    const stop = await ask(world, "/tex/page/act", { token: T.alice, body: { handle: "alice", chat: "me", action: { type: "stop", job: "job2" } } });
    assert.deepEqual(stop.body, { ok: true });
    assert.deepEqual(world.texting.steered.at(-1), { chat: { phone: ALICE_PHONE }, id: "job2", stop: true });
    const settings = await ask(world, "/tex/page/act", { token: T.alice, body: { handle: "alice", chat: "me", action: { type: "settings", values: { pick: "emoji_none" } } } });
    assert.deepEqual(settings.body, { ok: true });
    assert.deepEqual(world.settings.at(-1), { accessToken: T.alice, chat: "me", values: { pick: "emoji_none" } });
    // A group's settings are not the person's.
    const crossed = await ask(world, "/tex/page/act", { token: T.alice, body: { handle: "alice", chat: "me", action: { type: "group.settings", values: { answers: "every" } } } });
    assert.deepEqual(crossed.body, { ok: false, error: "invalid" });
    const values = await ask(world, "/tex/page/list", { token: T.alice, body: { handle: "alice", chat: "me", kind: "settings" } });
    // Their own words and the quick picks, no dials (Dev2, 2026-11-01).
    assert.equal(values.body.instructions, "Be friendly.\nKeep answers short.");
    assert.deepEqual(values.body.picks, [{ id: "emoji_none", label: "No emoji" }]);
    assert.equal(values.body.values, undefined);
    const group = await ask(world, "/tex/page/list", { token: T.alice, body: { handle: "alice", chat: GROUP, kind: "settings" } });
    assert.deepEqual(group.body.values, { answers: "named" });
    assert.equal(group.body.instructions, "");
    assert.equal(group.body.approver, "alice");
    const jobs = await ask(world, "/tex/page/list", { token: T.alice, body: { handle: "alice", chat: "me", kind: "jobs" } });
    assert.deepEqual(jobs.body.items.map((item) => item.id), ["job2", "job1", "job0"]);
    const bad = await ask(world, "/tex/page/list", { token: T.alice, body: { handle: "alice", chat: "me", kind: "secrets" } });
    assert.equal(bad.status, 400);
  } finally {
    world.restore();
  }
});

test("a routine id from outside the chat is refused before any note is touched", async () => {
  const world = await setUp();
  try {
    const answer = await ask(world, "/tex/page/act", { token: T.alice, body: { handle: "alice", chat: "me", action: { type: "routine.remove", id: ":tex/routines/daily/someone-elses.md" } } });
    assert.deepEqual(answer.body, { ok: false, error: "not_found" });
    const groups = await ask(world, "/tex/page/act", { token: T.alice, body: { handle: "alice", chat: GROUP, action: { type: "routine.toggle", id: ":tex/routines/daily/brief.md", on: false } } });
    assert.deepEqual(groups.body, { ok: false, error: "not_found" });
    // The rule itself: a routine or check-in is the chat's only when its rows name it.
    const me = { routines: [{ slug: null, path: "tex/routines/daily/brief.md" }] };
    assert.equal(actOwned(me, { type: "routine.toggle", id: ":tex/routines/daily/brief.md" }), true);
    assert.equal(actOwned(me, { type: "routine.toggle", id: ":tex/routines/daily/other.md" }), false);
    assert.equal(actOwned(me, { type: "checkin.cancel", id: "crew:tex/routines/daily/brief.md" }), false);
    assert.equal(actOwned(me, { type: "checkin.add", when: "2026-11-03 09:00", what: "x" }), true);
  } finally {
    world.restore();
  }
});

test("the live socket: no token is refused; alice's goes to her chat's own Tex object with a viewer the gateway wrote", async () => {
  const world = await setUp();
  try {
    const opened = [];
    const env = {
      ...world.env,
      LIVE_TICKET: ticketNamespace(),
      TEX_STORE: {
        idFromName: (name) => ({ name }),
        get: (id) => ({
          fetch: async (request) => {
            opened.push({ name: id.name, path: new URL(request.url).pathname, viewer: JSON.parse(request.headers.get(PAGE_VIEWER_HEADER)), sneaky: request.headers.get("x-sneaky") });
            return { status: 101, headers: new Headers(), webSocket: { fake: true } };
          },
        }),
      },
    };
    // The page's socket opens on a one-use ticket, as the app sends (`src/live/ticket.js`).
    const socket = async (token, query) =>
      new Request(`https://mcp.context.test/tex/page/live?${query}`, {
        headers: { Upgrade: "websocket", "x-sneaky": "1", ...(token ? { "Sec-WebSocket-Protocol": await ticketProtocols(env, { token, socket: "/tex/page/live", protocol: "context.tex-page" }) } : {}) },
      });
    const deps = { upgraded: (headers, webSocket) => ({ status: 101, headers, webSocket }) };
    const refused = await handleTexPageLive(await socket(null, "handle=alice&chat=me"), env, { slug: null, pathToken: null, origin: "https://mcp.context.test" }, deps);
    assert.equal(refused.status, 401);
    const answer = await handleTexPageLive(await socket(T.alice, `handle=alice&chat=${GROUP}`), env, { slug: null, pathToken: null, origin: "https://mcp.context.test" }, deps);
    assert.equal(answer.status, 101);
    assert.equal(answer.headers.get("Sec-WebSocket-Protocol"), "context.tex-page");
    assert.equal(opened.length, 1);
    assert.match(opened[0].name, new RegExp(`chat:${GROUP}$`));
    assert.equal(opened[0].path, "/page-live");
    assert.deepEqual(opened[0].viewer.chat, { groupKey: GROUP });
    assert.ok(opened[0].viewer.deadline <= Date.now() + 5 * 60 * 1000);
    assert.equal(opened[0].sneaky, null);
    // Bob, naming alice's group: refused as a missing one, nothing opened.
    const bob = await handleTexPageLive(await socket(T.bob, `handle=bob&chat=${GROUP}`), env, { slug: null, pathToken: null, origin: "https://mcp.context.test" }, deps);
    assert.equal(bob.status, 404);
    assert.equal(opened.length, 1);
    // A token offered as a subprotocol is no token.
    const asToken = new Request(`https://mcp.context.test/tex/page/live?handle=alice&chat=me`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `context.tex-page, context.token.${T.alice}` } });
    assert.equal((await handleTexPageLive(asToken, env, { slug: null, pathToken: null, origin: "https://mcp.context.test" }, deps)).status, 401);
  } finally {
    world.restore();
  }
});

// The chat's history file (`src/http/texPage/ledger.js`; owner, 2026-11-02): the ledger raw with filters, and what Tex sees.
test("alice reads her chat's history file raw, by kind and by day, and what Tex sees", async () => {
  const world = await setUp();
  try {
    const { ledgerFor, eventEntry, toolEntry, wordsEntry } = await import("../src/agent/ledger.js");
    const ledger = ledgerFor(world.env, { person: "ws_alice" });
    const at = Date.UTC(2026, 9, 30, 16, 0, 0); // Oct 30, noon in New York
    const asked = { id: `${at}-000001`, at, chat: "c", from: { kind: "person", name: "alice" }, kind: "text", text: "find me a dentist" };
    const answered = { id: `${at + 9000}-000002`, at: at + 9000, chat: "c", from: { kind: "tex" }, kind: "text", text: "Dr Lee, Thursday 3pm.", turn: "turnAlice1", covers: [asked.id], delivered: true };
    await ledger.append("texts", [
      eventEntry(asked),
      wordsEntry("thinking", "they want a dentist", { turn: "turnAlice1", at: at + 1000 }),
      toolEntry({ name: "web_search", args: { query: "dentist" }, ok: true, ms: 40, result: "Dr Lee" }, { ownSlug: "alice", turn: "turnAlice1", at: at + 2000 }),
      eventEntry(answered),
      wordsEntry("reply", "Dr Lee, Thursday 3pm.", { turn: "turnAlice1", clean: true, at: at + 9500 }),
    ]);
    const raw = await ask(world, "/tex/page/ledger", { token: T.alice, body: { handle: "alice", chat: "me", view: "raw" } });
    assert.equal(raw.status, 200, raw.text);
    assert.equal(raw.body.manifest.schema, "tex-ledger");
    assert.deepEqual(raw.body.entries.map((entry) => entry.kind), ["text", "thinking", "tool", "text", "reply"]);
    assert.equal(raw.body.entries[2].result, "Dr Lee", "raw is everything kept");
    const thinking = await ask(world, "/tex/page/ledger", { token: T.alice, body: { handle: "alice", chat: "me", view: "raw", kinds: ["thinking"] } });
    assert.deepEqual(thinking.body.entries.map((entry) => entry.text), ["they want a dentist"]);
    const otherDay = await ask(world, "/tex/page/ledger", { token: T.alice, body: { handle: "alice", chat: "me", view: "raw", day: "2026-10-31" } });
    assert.deepEqual(otherDay.body.entries, []);
    const thatDay = await ask(world, "/tex/page/ledger", { token: T.alice, body: { handle: "alice", chat: "me", view: "raw", day: "2026-10-30" } });
    assert.equal(thatDay.body.entries.length, 5);
    const sees = await ask(world, "/tex/page/ledger", { token: T.alice, body: { handle: "alice", chat: "me", view: "sees" } });
    assert.equal(sees.status, 200, sees.text);
    assert.match(sees.body.text, /@alice: find me a dentist/);
    assert.match(sees.body.text, /You: Dr Lee, Thursday 3pm\.\n\s+\(used: web_search\)/);
    assert.ok(!sees.body.text.includes("they want a dentist"), "Tex is not shown its earlier thinking");
    assert.equal(sees.body.settings.thinking, false);
    // Bob can't read it, and his own group's history is his group's alone.
    const bob = await ask(world, "/tex/page/ledger", { token: T.bob, body: { handle: "bob", chat: GROUP, view: "raw" } });
    assert.equal(bob.status, 404);
    const bobs = await ask(world, "/tex/page/ledger", { token: T.bob, body: { handle: "bob", chat: BOBS_GROUP, view: "raw" } });
    assert.deepEqual(bobs.body.entries, []);
  } finally {
    world.restore();
  }
});

test("the picker names a group's home, so the app can open its history file as that chat's history", async () => {
  const { pickerOf } = await import("../src/http/texPage/page.js");
  const picker = pickerOf({
    chats: [
      { key: GROUP, name: "Team Night", people: 3, homeWords: "blue-lake-fox", homeSlug: "team-night" },
      { key: BOBS_GROUP, name: "No Home", people: 2, homeWords: null, homeSlug: null },
    ],
  });
  assert.deepEqual(picker[0], { key: "me", name: "Just you" });
  assert.deepEqual(picker[1], { key: GROUP, name: "Team Night", people: 3, home: { context: "@team-night", folder: "tex/groups/blue-lake-fox" } });
  assert.deepEqual(picker[2], { key: BOBS_GROUP, name: "No Home", people: 2 });
});
