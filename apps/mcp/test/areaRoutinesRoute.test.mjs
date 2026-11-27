/**
 * `POST /files/area-routines` (`src/http/areaRoutinesRoute.js`): the app's area panel reads how each routine last
 * ran and each bot's week, through the workspace object at the session's own clearance. The Context app only, and
 * only for the session's own workspace, checked before any object is asked.
 *
 * ## Sabotage record
 *
 * Dropping the workspace check fails "another workspace's id is refused before any object is asked". Dropping the
 * client check fails "an AI client is refused".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AREA_ROUTINES_PATH, handleAreaRoutines } from "../src/http/areaRoutinesRoute.js";
import { APP_ROUTES } from "../src/http/appRoutes.js";

const STATE = { week: "2026-11-23", routines: [{ path: "areas/finance/routines/daily/check.md", area: "areas/finance", nextAt: 1, lastAt: null, outcome: null, bot: null, answeredAt: null }], usage: [{ bot: "finance", area: "areas/finance", used: 4 }], checks: [{ bot: "finance", at: 2 }], inbox: [{ bot: "finance", count: 1 }] };
const session = (over = {}) => ({ actorClientId: "context_console", workspaceId: "ws-a", role: "member", ...over });
const post = (body) => new Request(`https://mcp.example.com/@acme${AREA_ROUTINES_PATH}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
function store(state = STATE, ran = "sent") {
  const asked = [];
  const runs = [];
  return { asked, runs, objectBots: { state: async () => (asked.push(1), state), runNow: async (path) => (runs.push(path), ran) } };
}

test("the app reads the workspace object's state for its own workspace", async () => {
  const s = store();
  const response = await handleAreaRoutines(post({ workspaceId: "ws-a" }), s, session());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { served: true, ...STATE });
  assert.equal(APP_ROUTES.get(AREA_ROUTINES_PATH), handleAreaRoutines);
});

test("another workspace's id is refused before any object is asked", async () => {
  const s = store();
  const response = await handleAreaRoutines(post({ workspaceId: "ws-b" }), s, session());
  assert.equal(response.status, 409);
  assert.equal(s.asked.length, 0);
});

test("an AI client is refused", async () => {
  const s = store();
  const response = await handleAreaRoutines(post({ workspaceId: "ws-a" }), s, session({ actorClientId: "some-ai" }));
  assert.equal(response.status, 403);
  assert.equal(s.asked.length, 0);
});

test("a GET, a body with other keys or no id, and an object that can't answer", async () => {
  assert.equal((await handleAreaRoutines(new Request("https://x/files/area-routines"), store(), session())).status, 405);
  for (const body of [{ workspaceId: "ws-a", path: "x" }, {}, "not json", { workspaceId: 3 }]) {
    assert.equal((await handleAreaRoutines(post(body), store(), session())).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await (await handleAreaRoutines(post({ workspaceId: "ws-a" }), store(null), session())).json(), { served: false });
  assert.deepEqual(await (await handleAreaRoutines(post({ workspaceId: "ws-a" }), {}, session())).json(), { served: false });
});

test("Run now sends one routine for a session that may write, and answers its outcome with the state after", async () => {
  const s = store();
  const path = "areas/finance/routines/daily/check.md";
  const response = await handleAreaRoutines(post({ workspaceId: "ws-a", run: path }), s, session({ scopes: ["context:read", "context:write"] }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { served: true, ...STATE, ran: "sent" });
  assert.deepEqual(s.runs, [path]);
});

test("Run now is refused for a reader, and for another workspace, before anything is sent", async () => {
  const s = store();
  const reader = await handleAreaRoutines(post({ workspaceId: "ws-a", run: "areas/finance/routines/daily/check.md" }), s, session({ scopes: ["context:read"] }));
  assert.equal(reader.status, 403);
  const other = await handleAreaRoutines(post({ workspaceId: "ws-b", run: "areas/finance/routines/daily/check.md" }), s, session({ scopes: ["context:read", "context:write"] }));
  assert.equal(other.status, 409);
  assert.deepEqual(s.runs, []);
});
