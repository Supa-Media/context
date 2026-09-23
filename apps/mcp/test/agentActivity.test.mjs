/**
 * WHAT AGENTS ARE READING AND WRITING — `src/agentActivity.js`, the `/activity`
 * half of `src/presenceRoom.js`, and the `GET /agent-activity` route.
 *
 * The feature is a dot on a row in somebody's file tree. What makes it
 * security-sensitive is that the log behind it holds every path any agent
 * touched in a workspace, private ones included, and hands it to whoever asks.
 * So these checks are mostly about who is *not* told:
 *
 *  1. **A team member is never shown a private path**, and never shown an
 *     agent whose only work was on private notes. An agent listed with nothing
 *     next to it would still say somebody is working on something hidden.
 *  2. **One workspace's log is never another's.** The key is the session's
 *     workspace, never anything in the URL.
 *  3. **The console is not an agent.** A person opening a note in the app must
 *     not appear in their own tree as a robot reading it.
 *  4. **Nothing is stored.** The log is memory in one object and must never
 *     reach Durable Object storage, which would be a second durable copy of
 *     the customer's file names.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines in this
 * suite.
 *
 *   `canSee` dropped from the route (every path to every caller)           2
 *   filter moved after aggregation (counts and names leak)                 5
 *   console exclusion dropped from `recordAgentActivity`                   1
 *   log keyed by a workspace named in the query string                     1
 *   `recordActivity` writes the log to `state.storage` as well             1
 *   seated-client check dropped from `committedAgent`                      1
 *   `/agent-activity` dropped from `isTransportPath` (no origin check)     1
 *   `agent-activity` dropped from RESERVED_FIRST_SEGMENTS (read as a slug) 10
 */

import worker, { PresenceRoom as GatewayPresenceRoom } from "../src/index.js";
import { PresenceRoom } from "../src/presenceRoom.js";
import {
  AGENT_ACTIVITY_MAX_EVENTS,
  AGENT_ACTIVITY_WINDOW_MS,
  activityForCaller,
  agentActivityKey,
  pruneActivity,
  recordActivity,
} from "../src/agentActivity.js";
import { roomKey } from "../src/presence.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const OWNER_TOKEN = `cat_agentact_owner_${"0".repeat(14)}`;
const TEAM_TOKEN = `cat_agentact_team_${"0".repeat(15)}`;
const CONSOLE_TOKEN = `cat_agentact_cnsl_${"0".repeat(15)}`;
const OTHER_TOKEN = `cat_agentact_other_${"0".repeat(14)}`;

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n\n" +
  "note_overrides:\n  1-projects/rates.md: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const HEX = "0123456789abcdef";

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

/** A Durable Object runtime with no sockets, whose storage records every write. */
function fakeRuntime() {
  const stored = new Map();
  return {
    stored,
    state: {
      acceptWebSocket() {},
      getWebSockets: () => [],
      storage: {
        async get(key) {
          return stored.get(key);
        },
        async put(entries) {
          for (const [key, value] of Object.entries(entries)) stored.set(key, value);
        },
        async list() {
          return new Map();
        },
        async delete() {},
        async deleteAll() {
          stored.clear();
        },
        async setAlarm() {},
        async getAlarm() {
          return null;
        },
      },
    },
  };
}

/**
 * A namespace that really runs the room object, one instance per name.
 *
 * The note-room checks elsewhere stub the namespace and read what the route
 * *sent*. Here the answer depends on what an earlier call recorded, so the
 * object has to exist and remember between requests, as the runtime's does.
 */
function createLiveNamespace() {
  const instances = new Map();
  const runtimes = new Map();
  const calls = [];
  return {
    calls,
    runtimes,
    idFromName(name) {
      return { name, toString: () => name };
    },
    get(id) {
      if (!instances.has(id.name)) {
        const runtime = fakeRuntime();
        runtimes.set(id.name, runtime);
        instances.set(id.name, new PresenceRoom(runtime.state, {}));
      }
      const room = instances.get(id.name);
      return {
        async fetch(request, init) {
          const asRequest = request instanceof Request ? request : new Request(request, init);
          const body = asRequest.method === "POST" ? await asRequest.clone().text() : null;
          calls.push({ name: id.name, url: asRequest.url, method: asRequest.method, body });
          return room.fetch(asRequest);
        },
      };
    },
  };
}

async function callTool(env, token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx,
  );
  const body = await response.json();
  await settle();
  return body?.result?.content?.[0]?.text ?? "";
}

async function activityRequest(env, token, { query = "", method = "GET", headers = {} } = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test/agent-activity${query}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function runAgentActivityChecks(check) {
  /* ========================= the pure module ============================ */

  const now = 1_000_000_000;
  const actor = { id: HEX, name: "Somebody's Claude" };

  check(
    "an event with an unknown kind is refused",
    recordActivity([], { path: "a.md", kind: "writing", actor }, now) === false,
  );
  check(
    "an event whose agent id is not a digest is refused",
    // The id becomes a member id in somebody else's sidebar. A free-form
    // string there is a name a client chose for itself.
    recordActivity([], { path: "a.md", kind: "read", actor: { id: "a:pick-me", name: "x" } }, now) === false,
  );
  check(
    "an event with no path is refused",
    recordActivity([], { path: "", kind: "read", actor }, now) === false,
  );
  {
    const log = [];
    recordActivity(log, { path: "a.md", kind: "read", actor: { id: HEX, name: "Bad‮name\n" } }, now);
    check(
      "an agent's name is cleaned before anybody is shown it",
      log[0]?.name === "Badname" && log[0]?.id === `a:${HEX}`,
    );
  }
  {
    const log = [];
    recordActivity(log, { path: "old.md", kind: "read", actor }, now - AGENT_ACTIVITY_WINDOW_MS - 1);
    recordActivity(log, { path: "new.md", kind: "read", actor }, now);
    check(
      "an event older than the window is dropped",
      log.length === 1 && log[0].path === "new.md",
    );
  }
  {
    const log = [];
    for (let i = 0; i < AGENT_ACTIVITY_MAX_EVENTS + 5; i += 1) {
      recordActivity(log, { path: `n${i}.md`, kind: "read", actor }, now);
    }
    check(
      "the log keeps at most its ceiling, oldest going first",
      log.length === AGENT_ACTIVITY_MAX_EVENTS && log[0].path === "n5.md",
    );
    check("pruning an empty log is harmless", pruneActivity([], now).length === 0);
  }
  {
    const log = [];
    const other = { id: "fedcba9876543210", name: "Private worker" };
    recordActivity(log, { path: "1-projects/plan.md", kind: "read", actor }, now - 3);
    recordActivity(log, { path: "1-projects/plan.md", kind: "write", actor }, now - 2);
    recordActivity(log, { path: "1-projects/plan.md", kind: "read", actor }, now - 1);
    recordActivity(log, { path: "secret.md", kind: "write", actor }, now);
    recordActivity(log, { path: "secret.md", kind: "read", actor: other }, now);
    const answer = activityForCaller(log, now, (path) => path !== "secret.md");
    check(
      "a write outranks a later read on the same row",
      answer.marks.length === 1 && answer.marks[0].kind === "write",
    );
    check(
      "a path the caller cannot see is not in the answer",
      answer.marks.every((mark) => mark.path !== "secret.md") &&
        answer.agents.every((agent) => agent.path !== "secret.md"),
    );
    check(
      "an agent whose only work was hidden is not listed at all",
      // Listed with nothing next to it, it would still say somebody is
      // working on something the caller cannot see.
      answer.agents.length === 1 && answer.agents[0].id === `a:${HEX}`,
    );
    check(
      "counts are of visible notes only",
      answer.agents[0].writes === 1 && answer.agents[0].reads === 1,
    );
  }

  check(
    "an activity key can never be a note room's key",
    // `roomKey` percent-encodes the workspace id, so a colon never survives
    // into its first segment.
    agentActivityKey("ws_a") !== roomKey("ws_a", "") &&
      !roomKey("activity:ws_a", "x.md").startsWith("activity:") &&
      agentActivityKey("ws/a") !== agentActivityKey("ws") ,
  );

  /* ======================= the room, in memory only ====================== */

  {
    const runtime = fakeRuntime();
    const room = new PresenceRoom(runtime.state, {});
    const recorded = await room.fetch(
      new Request("https://presence.invalid/activity", {
        method: "POST",
        body: JSON.stringify({ path: "1-projects/plan.md", kind: "write", actor }),
      }),
    );
    const read = await room.fetch(new Request("https://presence.invalid/activity"));
    const events = (await read.json()).events;
    check(
      "the room records an event and hands it back",
      (await recorded.json()).recorded === true && events.length === 1 && events[0].path === "1-projects/plan.md",
    );
    check(
      "...and never writes a path to Durable Object storage",
      runtime.stored.size === 0,
    );
    const refused = await room.fetch(
      new Request("https://presence.invalid/activity", { method: "POST", body: "{not json" }),
    );
    check("a malformed record is refused, not thrown", refused.status === 400);
  }

  /* ================== the committed notice names the agent ================ */

  {
    const socket = {
      readyState: 1,
      sent: [],
      send(text) {
        this.sent.push(JSON.parse(text));
      },
      attachment: { id: "m1", clientKey: "1111111111111111", collaborationVersion: 2 },
      deserializeAttachment() {
        return this.attachment;
      },
    };
    const runtime = fakeRuntime();
    runtime.state.getWebSockets = () => [socket];
    const room = new PresenceRoom(runtime.state, {});
    const commit = (body) =>
      room.fetch(
        new Request("https://presence.invalid/committed", { method: "POST", body: JSON.stringify(body) }),
      );

    await commit({ documentId: "doc", etag: "c2.doc.1", actor });
    const named = socket.sent.at(-1);
    check(
      "a committed write from a tool names the agent to every v2 member",
      named?.t === "committed" && named.agent?.id === `a:${HEX}` &&
        named.agent.name === "Somebody's Claude" && /^#[0-9a-f]{6}$/i.test(named.agent.color),
    );
    check(
      "...and still carries no text or update bytes",
      !("text" in named) && !("update" in named),
    );

    await commit({ documentId: "doc", etag: "c2.doc.2", actor: { id: "1111111111111111", name: "Me" } });
    check(
      "a write from a client already seated here is somebody saving, not an agent",
      socket.sent.at(-1)?.etag === "c2.doc.2" && !("agent" in socket.sent.at(-1)),
    );

    await commit({ documentId: "doc", etag: "c2.doc.3", actor: { id: "a:pick-me", name: "x" } });
    check(
      "an actor id that is not a digest names nobody",
      socket.sent.at(-1)?.etag === "c2.doc.3" && !("agent" in socket.sent.at(-1)),
    );
  }

  /* ============================== the route ============================= */

  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const otherBucket = createBucket();
    const binding = {
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
      provider: "r2-binding",
    };
    controlPlane.addWorkspace("ws_agentact", "agentacttest", { ...binding, bindingName: "ACT_BUCKET" });
    controlPlane.addWorkspace("ws_agentother", "agentothertest", { ...binding, bindingName: "OTHER_BUCKET" });
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_agentact",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_agentact_owner",
      clientName: "Owner's Claude",
      userId: "user_agentact_owner",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_agentact",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_agentact_team",
      clientName: "Team Codex",
      userId: "user_agentact_team",
    });
    await controlPlane.addGrant({
      accessToken: CONSOLE_TOKEN,
      workspaceId: "ws_agentact",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "context_console",
      userId: "user_agentact_owner",
    });
    await controlPlane.addGrant({
      accessToken: OTHER_TOKEN,
      workspaceId: "ws_agentother",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_agentact_other",
      userId: "user_agentact_other",
    });

    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# front page");
    bucket.seed("1-projects/roadmap.md", "the roadmap");
    bucket.seed("1-projects/rates.md", "RATESECRET what we charge");
    bucket.seed("1-projects/console-only.md", "opened in the app");
    otherBucket.seed("privacy.md", MANIFEST);

    const rooms = createLiveNamespace();
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "ACT_BUCKET,OTHER_BUCKET",
      ACT_BUCKET: bucket,
      OTHER_BUCKET: otherBucket,
      PRESENCE_ROOM: rooms,
    };

    // The team agent reads the roadmap and writes it; the owner's agent reads
    // the private rates note; the console opens a note of its own.
    const teamRead = await callTool(env, TEAM_TOKEN, "read_note", { path: "1-projects/roadmap.md" });
    await callTool(env, TEAM_TOKEN, "write_note", {
      path: "1-projects/roadmap.md",
      content: "the roadmap\n\nand a line an agent added\n",
      expected_etag: teamRead.match(/^etag: (\S+)/)?.[1],
    });
    await callTool(env, OWNER_TOKEN, "read_note", { path: "1-projects/rates.md" });
    await callTool(env, CONSOLE_TOKEN, "read_note", { path: "1-projects/console-only.md" });
    // A refused read records nothing: "not found" must cost the same either way.
    await callTool(env, TEAM_TOKEN, "read_note", { path: "1-projects/rates.md" });

    const answered = (response) => ({
      ...response,
      body: { marks: response.body?.marks ?? [], agents: response.body?.agents ?? [] },
    });
    const team = answered(await activityRequest(env, TEAM_TOKEN));
    const owner = answered(await activityRequest(env, OWNER_TOKEN));
    check("the route answers a team member", team.status === 200);
    check(
      "a team member sees the note an agent wrote, marked as written",
      team.body.marks.some((mark) => mark.path === "1-projects/roadmap.md" && mark.kind === "write"),
    );
    check(
      "a team member is never shown a private path",
      !JSON.stringify(team.body).includes("rates"),
    );
    check(
      "...nor the agent whose only work was on it",
      team.body.agents.every((agent) => agent.name !== "Owner's Claude"),
    );
    check(
      "the owner sees the private read, and whose it was",
      owner.body.marks.some((mark) => mark.path === "1-projects/rates.md" && mark.kind === "read") &&
        owner.body.agents.some((agent) => agent.name === "Owner's Claude"),
    );
    check(
      "the console opening a note is not an agent reading it",
      !JSON.stringify(owner.body).includes("console-only"),
    );
    check(
      "an agent is named by its client, as the note room names it",
      team.body.agents.some((agent) => agent.name === "Team Codex" && agent.id.startsWith("a:")),
    );

    const other = await activityRequest(env, OTHER_TOKEN);
    check(
      "another workspace's token sees none of this workspace's activity",
      other.status === 200 && other.body.marks.length === 0 && other.body.agents.length === 0,
    );
    const steered = await activityRequest(env, OTHER_TOKEN, { query: "?workspace=ws_agentact&workspaceId=ws_agentact" });
    check(
      "a workspace named in the query string does not move the log",
      steered.body?.marks?.length === 0,
    );
    check(
      "the log is keyed by the session's workspace",
      rooms.calls.some((call) => call.name === agentActivityKey("ws_agentact")) &&
        rooms.calls.every((call) => call.name !== agentActivityKey("ws_agentother") || call.method === "GET"),
    );

    const committed = rooms.calls.find(
      (call) => call.name === roomKey("ws_agentact", "1-projects/roadmap.md") && call.url.endsWith("/committed"),
    );
    check(
      "a tool's committed write tells the note room which agent made it",
      (() => {
        const body = JSON.parse(committed?.body ?? "null");
        return typeof body?.actor?.id === "string" && body.actor.name === "Team Codex";
      })(),
    );

    const anonymous = await activityRequest(env, null);
    check("an unauthenticated request is refused", anonymous.status === 401);
    const posted = await activityRequest(env, TEAM_TOKEN, { method: "POST" });
    check("a non-GET request is refused", posted.status === 405);
    const foreign = await activityRequest(env, TEAM_TOKEN, { headers: { Origin: "https://evil.test" } });
    check("a request from an unlisted browser origin is refused", foreign.status === 403);
    const { PRESENCE_ROOM: _unbound, ...unbound } = env;
    const off = await activityRequest(unbound, TEAM_TOKEN);
    check("a deployment with no presence binding answers 501", off.status === 501);

    // The production class is the one the worker exports; it must be the room.
    check(
      "the worker exports the room class this route relies on",
      GatewayPresenceRoom.prototype.committedAgent === PresenceRoom.prototype.committedAgent,
    );
  } finally {
    restore();
  }
}
