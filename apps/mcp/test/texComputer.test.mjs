/**
 * `/tex/computer` (`src/http/texComputer.js`): the person's own view of Tex's
 * browser, end to end through the worker with the control plane's contract.
 *
 * The one property everything here serves: **person A can never see or drive
 * person B's browser.** The browser is found by `browserOwner(env, userId)`,
 * made from the user the token resolves to; these prove that tag is never
 * anyone else's, that a handle naming someone else is refused before the
 * screenshot Worker is asked anything, and that only the Context app's own
 * client may ask at all.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-10-11):
 *  1. The owner tag made from `body.handle` instead of `session.actorUserId`
 *     → "alice's console sees alice's browser, by her tag" and "bob's token
 *       never reaches alice's browser, whatever handle it names" fail.
 *  2. The handle check removed → "a handle that is not the caller's own is
 *     refused before the browser is asked" and "a member of somebody else's
 *     personal workspace is not its owner" fail.
 *  3. The console-client check removed → "an MCP client holding alice's grant
 *     is refused" fails.
 *  4. The typed text added to the log line → "typed text and frames never
 *     reach a log" fails.
 *  5. `frameFrom` returning the Worker's body as is → "a frame is passed on
 *     field by field" fails.
 *  6. `actionFrom` spreading `raw` for the pointer actions → "the pointer
 *     actions are forwarded by their named fields only" fails.
 *  7. `frameFrom` passing `scale` through unread → "a scale that is not a
 *     sane number is left out" fails.
 *
 * Fake names, ids and tokens only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { browserOwner } from "../src/agent/browserProviders.js";

const tok = (name) => `cat_texview_${name}_`.padEnd(40, "0");
const T = {
  alice: tok("alice"),
  aliceViaShared: tok("aliceshared"),
  bob: tok("bob"),
  bobInAlices: tok("bobinalices"),
  aliceMcp: tok("alicemcp"),
};
const TYPED = "hunter2-correct-horse";
const FRAME = "FRAMEDATA0123456789==";

const BINDING = {
  provider: "s3",
  status: "active",
  endpoint: "https://s3.texview.test",
  region: "auto",
  bucket: "tenant-texview",
  accessKeyId: "AKIAEXAMPLEEXAMPLEAB",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAB",
  forcePathStyle: true,
  capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
};

let scaleAnswer = 0.6;
const frameScale = () => scaleAnswer;

async function setUp({ siteShots = true, scale = 0.6 } = {}) {
  scaleAnswer = scale;
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  controlPlane.addWorkspace("ws_alice", "alice", BINDING);
  controlPlane.addWorkspace("ws_bob", "bob", BINDING);
  controlPlane.addWorkspace("ws_crew", "crew", BINDING, { kind: "shared" });
  const all = ["context:read", "context:write", "context:private"];
  const grant = (accessToken, workspaceId, userId, clientId = "context_console", extra = {}) =>
    controlPlane.addGrant({ accessToken, workspaceId, role: "owner", scopes: all, clientId, userId, ...extra });
  await grant(T.alice, "ws_alice", "user_a1x");
  await grant(T.aliceViaShared, "ws_crew", "user_a1x", "context_console", {
    role: "editor",
    alsoMemberOf: [{ workspaceId: "ws_alice", role: "owner" }],
  });
  await grant(T.bob, "ws_bob", "user_b2y");
  // Bob, invited into Alice's personal workspace as an editor: a member, never its owner.
  await grant(T.bobInAlices, "ws_bob", "user_b2y", "context_console", { alsoMemberOf: [{ workspaceId: "ws_alice", role: "editor" }] });
  await grant(T.aliceMcp, "ws_alice", "user_a1x", "mcp_client_alice");

  const requests = [];
  const SITE_SHOTS = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      requests.push({ path: new URL(url).pathname, body });
      if (new URL(url).pathname === "/browse/close") return Response.json({ closed: true });
      return Response.json({
        running: true,
        url: "https://chatgpt.com/auth/login",
        title: "Log in",
        width: 1280,
        height: 860,
        scale: frameScale(),
        frame: FRAME,
        // Never for the app: a field the Worker might add for some other reason.
        session: "bb-session-SECRET",
      });
    },
  };
  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    APP_ORIGIN: "https://app.context.test",
    ...(siteShots ? { SITE_SHOTS } : {}),
  };
  return { env, requests, restore };
}

async function ask(world, path, { token, body = {}, method = "POST", url = null } = {}) {
  const { ctx } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(url ?? `https://mcp.context.test${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    world.env,
    ctx,
  );
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (a 405 has no body).
  }
  return { status: response.status, body: parsed };
}

test("alice's console sees alice's browser, by her tag", async () => {
  const world = await setUp();
  try {
    const answer = await ask(world, "/tex/computer", { token: T.alice, body: { handle: "alice" } });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.running, true);
    assert.equal(answer.body.frame, FRAME);
    assert.equal(world.requests.length, 1);
    assert.equal(world.requests[0].path, "/view/frame");
    assert.equal(world.requests[0].body.owner, await browserOwner(world.env, "user_a1x"));
    // `@Alice` is the same handle.
    const at = await ask(world, "/tex/computer", { token: T.alice, body: { handle: "@Alice" } });
    assert.equal(at.status, 200);
    // A console grant minted for another of her workspaces is still her.
    const viaShared = await ask(world, "/tex/computer", { token: T.aliceViaShared, body: { handle: "alice" } });
    assert.equal(viaShared.status, 200);
    assert.equal(world.requests.at(-1).body.owner, await browserOwner(world.env, "user_a1x"));
  } finally {
    world.restore();
  }
});

test("a frame is passed on field by field", async () => {
  const world = await setUp();
  try {
    const answer = await ask(world, "/tex/computer", { token: T.alice, body: { handle: "alice" } });
    assert.deepEqual(Object.keys(answer.body).sort(), ["frame", "height", "running", "scale", "title", "url", "width"]);
    assert.equal(answer.body.scale, 0.6);
    assert.ok(!JSON.stringify(answer.body).includes("SECRET"));
  } finally {
    world.restore();
  }
});

test("a handle that is not the caller's own is refused before the browser is asked", async () => {
  const world = await setUp();
  try {
    for (const handle of ["bob", "crew", "", "alice2", "ALICE ", null]) {
      const answer = await ask(world, "/tex/computer", { token: T.alice, body: { handle } });
      assert.equal(answer.status, 403, `handle ${JSON.stringify(handle)}`);
      assert.equal(answer.body.error, "not_yours");
    }
    const input = await ask(world, "/tex/computer/input", { token: T.alice, body: { handle: "bob", action: { kind: "type", text: TYPED } } });
    assert.equal(input.status, 403);
    const stop = await ask(world, "/tex/computer/stop", { token: T.alice, body: { handle: "bob" } });
    assert.equal(stop.status, 403);
    assert.deepEqual(world.requests, []);
  } finally {
    world.restore();
  }
});

test("bob's token never reaches alice's browser, whatever handle it names", async () => {
  const world = await setUp();
  try {
    const aliceTag = await browserOwner(world.env, "user_a1x");
    assert.equal((await ask(world, "/tex/computer", { token: T.bob, body: { handle: "alice" } })).status, 403);
    assert.equal((await ask(world, "/tex/computer/input", { token: T.bob, body: { handle: "alice", action: { kind: "tap", x: 1, y: 1 } } })).status, 403);
    assert.equal((await ask(world, "/tex/computer/stop", { token: T.bob, body: { handle: "alice" } })).status, 403);
    assert.deepEqual(world.requests, []);
    const own = await ask(world, "/tex/computer", { token: T.bob, body: { handle: "bob" } });
    assert.equal(own.status, 200);
    assert.equal(world.requests[0].body.owner, await browserOwner(world.env, "user_b2y"));
    assert.notEqual(world.requests[0].body.owner, aliceTag);
  } finally {
    world.restore();
  }
});

test("a member of somebody else's personal workspace is not its owner", async () => {
  const world = await setUp();
  try {
    const answer = await ask(world, "/tex/computer", { token: T.bobInAlices, body: { handle: "alice" } });
    assert.equal(answer.status, 403);
    assert.deepEqual(world.requests, []);
  } finally {
    world.restore();
  }
});

test("an MCP client holding alice's grant is refused", async () => {
  const world = await setUp();
  try {
    for (const path of ["/tex/computer", "/tex/computer/input", "/tex/computer/stop"]) {
      const answer = await ask(world, path, { token: T.aliceMcp, body: { handle: "alice", action: { kind: "back" } } });
      assert.equal(answer.status, 403, path);
    }
    assert.deepEqual(world.requests, []);
  } finally {
    world.restore();
  }
});

test("signed out, a bad token, or a token in the path is refused", async () => {
  const world = await setUp();
  try {
    assert.equal((await ask(world, "/tex/computer", { body: { handle: "alice" } })).status, 401);
    assert.equal((await ask(world, "/tex/computer", { token: tok("nobody"), body: { handle: "alice" } })).status, 401);
    const inPath = await ask(world, null, { url: `https://mcp.context.test/t/${T.alice}/tex/computer`, body: { handle: "alice" } });
    assert.equal(inPath.status, 401);
    assert.equal((await ask(world, "/tex/computer", { token: T.alice, method: "GET" })).status, 405);
    assert.deepEqual(world.requests, []);
  } finally {
    world.restore();
  }
});

test("an action is forwarded by its named fields only, and a malformed one is refused", async () => {
  const world = await setUp();
  try {
    const typed = await ask(world, "/tex/computer/input", {
      token: T.alice,
      body: { handle: "alice", action: { kind: "type", text: TYPED, owner: "f".repeat(64), url: "https://evil.example/" } },
    });
    assert.equal(typed.status, 200);
    assert.deepEqual(world.requests[0], {
      path: "/view/input",
      body: { owner: await browserOwner(world.env, "user_a1x"), action: { kind: "type", text: TYPED } },
    });
    for (const action of [null, { kind: "goto", url: "https://example.com/" }, { kind: "evaluate" }, "tap"]) {
      assert.equal((await ask(world, "/tex/computer/input", { token: T.alice, body: { handle: "alice", action } })).status, 400);
    }
    assert.equal(world.requests.length, 1);
  } finally {
    world.restore();
  }
});

test("the pointer actions are forwarded by their named fields only", async () => {
  const world = await setUp();
  try {
    const owner = await browserOwner(world.env, "user_a1x");
    const extra = { owner: "f".repeat(64), url: "https://evil.example/", expression: "alert(1)" };
    const actions = [
      [{ kind: "tap", x: 10, y: 20, button: "left", ...extra }, { kind: "tap", x: 10, y: 20, button: "left" }],
      [{ kind: "tap", x: 10, y: 20, ...extra }, { kind: "tap", x: 10, y: 20 }],
      [{ kind: "move", x: 30.5, y: 40, button: "left", ...extra }, { kind: "move", x: 30.5, y: 40 }],
      [{ kind: "scroll", x: 50, y: 60, dx: -5, dy: 300, ...extra }, { kind: "scroll", x: 50, y: 60, dx: -5, dy: 300 }],
      [{ kind: "scroll", dy: 300, ...extra }, { kind: "scroll", dy: 300 }],
    ];
    for (const [sent] of actions) {
      assert.equal((await ask(world, "/tex/computer/input", { token: T.alice, body: { handle: "alice", action: sent } })).status, 200);
    }
    assert.deepEqual(
      world.requests.map((r) => r.body),
      actions.map(([, forwarded]) => ({ owner, action: forwarded })),
    );
  } finally {
    world.restore();
  }
});

test("a scale that is not a sane number is left out", async () => {
  for (const scale of ["0.6", -1, 0, 99, null]) {
    const world = await setUp({ scale });
    try {
      const answer = await ask(world, "/tex/computer", { token: T.alice, body: { handle: "alice" } });
      assert.equal(answer.status, 200);
      assert.equal("scale" in answer.body, false, String(scale));
    } finally {
      world.restore();
    }
  }
});

test("stop releases the caller's own browser", async () => {
  const world = await setUp();
  try {
    const answer = await ask(world, "/tex/computer/stop", { token: T.alice, body: { handle: "alice" } });
    assert.deepEqual(answer.body, { closed: true });
    assert.deepEqual(world.requests, [
      { path: "/browse/close", body: { provider: "browserbase", owner: await browserOwner(world.env, "user_a1x") } },
    ]);
  } finally {
    world.restore();
  }
});

test("typed text and frames never reach a log", async () => {
  const world = await setUp();
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const level of Object.keys(original)) console[level] = (...args) => lines.push(args.map(String).join(" "));
  try {
    await ask(world, "/tex/computer/input", { token: T.alice, body: { handle: "alice", action: { kind: "type", text: TYPED } } });
    await ask(world, "/tex/computer", { token: T.alice, body: { handle: "alice" } });
    await ask(world, "/tex/computer", { token: T.bob, body: { handle: "alice" } });
  } finally {
    Object.assign(console, original);
    world.restore();
  }
  const all = lines.join("\n");
  assert.ok(lines.some((line) => line.includes('"event":"tex_computer"')), "the route logs its outcome");
  assert.ok(!all.includes(TYPED));
  assert.ok(!all.includes(FRAME));
  assert.ok(!all.includes("chatgpt.com"));
});

test("with no screenshot Worker, nothing is running", async () => {
  const world = await setUp({ siteShots: false });
  try {
    const answer = await ask(world, "/tex/computer", { token: T.alice, body: { handle: "alice" } });
    assert.deepEqual(answer.body, { running: false });
  } finally {
    world.restore();
  }
});
