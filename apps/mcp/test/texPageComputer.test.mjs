/**
 * A group chat's "Tex's computer" on its Tex page (`src/http/texPage/browser.js`;
 * the owner, 2026-11-02: a group's page has the shape of one's own). The tile
 * says whether the chat's own browser is open, and `/tex/computer` with
 * `chat` shows and drives that browser, for a chat the caller is in now.
 *
 * What everything here serves: **a group's browser is reached only through a
 * chat the control plane says the caller is in**, its tag made from that chat
 * and the people hash its inbox keeps, never from the request; a chat the
 * caller is not in is refused as one that names nothing.
 *
 * ## Sabotage record (2026-11-02)
 *  1. `chatBrowserOwner` tagging any key the request names without `chatOf`
 *     → "bob cannot reach alice's group browser" fails.
 *  2. `groupTagOf` dropping the people hash (tagging by the key alone) →
 *     "a group's page and frame use the chat's own browser tag" fails.
 *  3. `computerOf` back to the person's own browser on a group page →
 *     "a group's page and frame use the chat's own browser tag" fails.
 *  4. (2026-11-04) `computerOf` asking `/view/frame` again (a screenshot per
 *     page load) → the same test fails on the path.
 *
 * Fake names, ids, numbers and tokens only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";
import { browserOwner, groupBrowserOwner } from "../src/agent/browserProviders.js";
import { forgetChatPeople } from "../src/http/texPage/browser.js";

const tok = (name) => `cat_texpc_${name}_`.padEnd(40, "0");
const T = { alice: tok("alice"), bob: tok("bob") };
const GROUP = "c".repeat(64);
const PEOPLE = "e".repeat(64);
const BINDING = {
  provider: "s3",
  status: "active",
  endpoint: "https://s3.texpc.test",
  region: "auto",
  bucket: "tenant-texpc",
  accessKeyId: "AKIAEXAMPLEEXAMPLEAB",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAB",
  forcePathStyle: true,
  capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
};
const chat = (key, name) => ({ key, name, people: 3, peopleNames: ["You", "ada", "cy"], homeWords: null, homeSlug: null, engagement: null, style: {}, sponsor: null, routines: [] });
const PAGES = {
  [T.alice]: { status: "ok", userId: "user_a1x", workspaceId: "ws_alice", handle: "alice", phone: null, timeZone: null, style: {}, routines: [], chats: [chat(GROUP, "Team Night")] },
  [T.bob]: { status: "ok", userId: "user_b2y", workspaceId: "ws_bob", handle: "bob", phone: null, timeZone: null, style: {}, routines: [], chats: [] },
};

async function setUp() {
  forgetChatPeople();
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  controlPlane.addWorkspace("ws_alice", "alice", BINDING);
  controlPlane.addWorkspace("ws_bob", "bob", BINDING);
  const all = ["context:read", "context:write", "context:private"];
  for (const [token, ws, user] of [[T.alice, "ws_alice", "user_a1x"], [T.bob, "ws_bob", "user_b2y"]]) {
    await controlPlane.addGrant({ accessToken: token, workspaceId: ws, role: "owner", scopes: all, clientId: "context_console", userId: user });
  }
  const stubbed = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === `${CONTROL_PLANE_ORIGIN}/gateway/tex/page`) return Response.json(PAGES[JSON.parse(init.body).accessToken] ?? { status: "refused" });
    return stubbed(input, init);
  };
  const shots = [];
  const SITE_SHOTS = {
    async fetch(url, init) {
      const path = new URL(url).pathname;
      shots.push({ path, body: JSON.parse(init.body) });
      if (path === "/view/status") return Response.json({ running: true, url: "https://resy.com/login" });
      return Response.json({ running: true, url: "https://resy.com/login", title: "Log in", width: 1280, height: 860, frame: "FRAME==" });
    },
  };
  const asked = [];
  const TEXTING = {
    async pageJobs({ chat: which }) {
      asked.push(which);
      return which.groupKey === GROUP ? { now: Date.now(), jobs: [], people: PEOPLE } : { now: Date.now(), jobs: [] };
    },
  };
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, APP_ORIGIN: "https://app.context.test", SITE_SHOTS, TEXTING };
  return { env, shots, asked, restore: () => ((globalThis.fetch = stubbed), restore()) };
}

async function ask(world, path, token, body) {
  const { ctx } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    world.env,
    ctx,
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("a group's page and frame use the chat's own browser tag, never the person's", async () => {
  const world = await setUp();
  try {
    const groupTag = await groupBrowserOwner(world.env, { key: GROUP, members: PEOPLE });
    const ownTag = await browserOwner(world.env, "user_a1x");
    assert.notEqual(groupTag, ownTag);

    const page = await ask(world, "/tex/page", T.alice, { handle: "alice", chat: GROUP, sections: ["tiles"] });
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.tiles.computer, { running: true, url: "https://resy.com/login" });
    assert.equal(world.shots.at(-1).body.owner, groupTag);
    // The tile only asks whether the browser is open: no picture is taken to draw the page.
    assert.equal(world.shots.at(-1).path, "/view/status");

    const frame = await ask(world, "/tex/computer", T.alice, { handle: "alice", chat: GROUP });
    assert.equal(frame.status, 200);
    assert.equal(frame.body.running, true);
    assert.equal(world.shots.at(-1).body.owner, groupTag);

    const input = await ask(world, "/tex/computer/input", T.alice, { handle: "alice", chat: GROUP, action: { kind: "tap", x: 1, y: 1 } });
    assert.equal(input.status, 200);
    assert.equal(world.shots.at(-1).body.owner, groupTag);

    // "Just you" still shows the person's own.
    await ask(world, "/tex/computer", T.alice, { handle: "alice", chat: "me" });
    assert.equal(world.shots.at(-1).body.owner, ownTag);
    await ask(world, "/tex/computer", T.alice, { handle: "alice" });
    assert.equal(world.shots.at(-1).body.owner, ownTag);
  } finally {
    world.restore();
  }
});

test("bob cannot reach alice's group browser: refused as a chat that names nothing", async () => {
  const world = await setUp();
  try {
    for (const path of ["/tex/computer", "/tex/computer/input", "/tex/computer/stop"]) {
      const answer = await ask(world, path, T.bob, { handle: "bob", chat: GROUP, action: { kind: "tap", x: 1, y: 1 } });
      assert.equal(answer.status, 404, path);
      assert.equal(answer.body.error, "not_found");
    }
    const nothing = await ask(world, "/tex/computer", T.bob, { handle: "bob", chat: "f".repeat(64) });
    assert.deepEqual(nothing, { status: 404, body: { error: "not_found", error_description: "There is no such chat." } });
    assert.equal(world.shots.length, 0, "no browser was asked anything");
    assert.equal(world.asked.length, 0, "the Worker was never asked about a chat bob is not in");
  } finally {
    world.restore();
  }
});

test("a group with no turn yet has no browser to show", async () => {
  const world = await setUp();
  world.env.TEXTING.pageJobs = async () => ({ now: Date.now(), jobs: [] });
  try {
    const frame = await ask(world, "/tex/computer", T.alice, { handle: "alice", chat: GROUP });
    assert.deepEqual(frame.body, { running: false });
    const page = await ask(world, "/tex/page", T.alice, { handle: "alice", chat: GROUP, sections: ["tiles"] });
    assert.deepEqual(page.body.tiles.computer, { running: false });
    assert.equal(world.shots.length, 0);
  } finally {
    world.restore();
  }
});
