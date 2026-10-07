/**
 * THE LIVE WORKSPACE MAP'S FEED — what `GET /agent-activity` adds for the map:
 * agents' `create`/`edit`/`move`, each agent's reads in order, a list of
 * recent `events`, people placed on the note they have open, and the
 * console's own creates and moves.
 *
 * Every one of those is a path, and a path is the customer's data. So, as in
 * `agentActivity.test.mjs`, these checks are mostly about who is *not* told:
 *
 *  1. **A team member never sees a private path** — through people, agents,
 *     `readPaths` or `events`.
 *  2. **A heartbeat cannot report a path its caller cannot see**, nor one
 *     that is not there — and cannot tell the two apart, by answer or by the
 *     storage it costs.
 *  3. **A move with a hidden end reveals neither end.**
 *  4. **Another workspace's activity never leaks.**
 *  5. **Polling at the map's rate writes no storage.**
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines in this
 * suite.
 *
 *   `eventVisible` checks only `path` (a move's hidden end leaks)           5
 *   `peopleFromRoom` passes `path` through unfiltered                       1
 *   heartbeat skips its `canSee` (a person reports a hidden note)           2
 *   heartbeat probes the bucket only when `canSee` passed (cost oracle)     1
 *   person events counted as agents                                        1
 *   `stamp` dropped (two events in one ms; `since` loses one)               2
 *   `did=move` accepted while the source still exists                       1
 *   `did=move` skips `canSee` on the source                                 1
 *   `write_note`'s `created` hint always false (creates read as edits)      1
 */

import {
  AGENT_ACTIVITY_MAX_ANSWER_EVENTS,
  AGENT_ACTIVITY_MAX_ENTRIES_PER_CALL,
  AGENT_ACTIVITY_MAX_READ_PATHS,
  activityForCaller,
  agentActivityKey,
  recordActivity,
  recordPersonActivity,
} from "../src/agentActivity.js";
import { peopleForCaller, recordPerson } from "../src/peopleActive.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { activityRequest, callTool, createBucket, createLiveNamespace } from "./agentActivityFixtures.mjs";

const T = (name) => `cat_agentmap_${name}_`.padEnd(32, "0");
const OWNER = T("owner");
const TEAM = T("team");
const CONSOLE_OWNER = T("cowner");
const CONSOLE_TEAM = T("cteam");
const CONSOLE_READER = T("creader");
const CONSOLE_OTHER = T("cother");

const manifest = (overrides = "  1-projects/rates.md: private\n") =>
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n\n" +
  `note_overrides:\n${overrides}\`\`\`\n\n` +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const HEX = "0123456789abcdef";
const OTHER_HEX = "fedcba9876543210";

/** A bucket that counts every call, to compare what two refusals cost. */
function counted(bucket) {
  const counts = { ops: 0 };
  const wrapped = { counts };
  for (const name of ["get", "put", "delete", "list", "head"]) {
    if (typeof bucket[name] !== "function") continue;
    wrapped[name] = (...args) => {
      counts.ops += 1;
      return bucket[name](...args);
    };
  }
  wrapped.seed = (...args) => bucket.seed(...args);
  return wrapped;
}

export async function runAgentMapChecks(check) {
  /* ========================= the pure module ============================ */

  const now = 2_000_000_000;
  const actor = { id: HEX, owner: HEX, name: "Somebody's Claude" };

  {
    const log = [];
    check(
      "a move without an origin is refused",
      recordActivity(log, { entries: [{ kind: "move", path: "b.md" }], actor }, now) === false,
    );
    check(
      "a move onto itself is refused",
      recordActivity(log, { entries: [{ kind: "move", path: "b.md", from: "b.md" }], actor }, now) === false,
    );
    const many = Array.from({ length: AGENT_ACTIVITY_MAX_ENTRIES_PER_CALL + 1 }, (_, i) => ({
      kind: "read",
      path: `n${i}.md`,
    }));
    check("one call cannot add more than its ceiling", recordActivity(log, { entries: many, actor }, now) === false);
    check(
      "one malformed entry refuses the whole call",
      recordActivity(log, { entries: [{ kind: "read", path: "a.md" }, { kind: "peek", path: "b.md" }], actor }, now) ===
        false && log.length === 0,
    );
    recordActivity(log, { path: "old.md", kind: "write", actor }, now);
    check("an older gateway's `write` is kept as an edit", log[0]?.kind === "edit");
    recordActivity(log, { entries: [{ kind: "read", path: "a.md" }, { kind: "read", path: "b.md" }], actor }, now);
    check(
      "two events in one millisecond get distinct, increasing times",
      log.length === 3 && log[0].at < log[1].at && log[1].at < log[2].at,
    );
    const newest = activityForCaller(log, now, () => true, null, { since: log[1].at });
    check(
      "`since` returns exactly the events after it",
      newest.events.length === 1 && newest.events[0].path === "b.md" &&
        // ...and only narrows events, never the tree's marks or the agents.
        newest.marks.length === 3 && newest.agents.length === 1,
    );
  }

  {
    const log = [];
    const other = { id: OTHER_HEX, owner: OTHER_HEX, name: "Owner's Claude" };
    const hidden = (path) => path.startsWith("private/");
    recordActivity(log, { entries: [{ kind: "move", from: "private/a.md", path: "team/a.md" }], actor: other }, now);
    recordActivity(log, { entries: [{ kind: "move", from: "team/b.md", path: "private/b.md" }], actor: other }, now);
    recordActivity(log, { entries: [{ kind: "move", from: "team/c.md", path: "team/sub/c.md" }], actor }, now);
    const answer = activityForCaller(log, now, (path) => !hidden(path), null);
    check(
      "a move with either end hidden is dropped from events, marks and agents",
      !JSON.stringify(answer).includes("/a.md") && !JSON.stringify(answer).includes("/b.md") &&
        answer.agents.length === 1 && answer.agents[0].id === `a:${HEX}`,
    );
    const move = answer.events[0];
    check(
      "a move with both ends visible carries from and to",
      answer.events.length === 1 && move.kind === "move" && move.from === "team/c.md" &&
        move.to === "team/sub/c.md" && move.path === "team/sub/c.md" && move.actor.kind === "agent",
    );
    check(
      "the tree still reads a move as a write on the destination",
      answer.marks.length === 1 && answer.marks[0].kind === "write" && answer.marks[0].path === "team/sub/c.md" &&
        answer.agents[0].kind === "write" && answer.agents[0].doing === "move" &&
        answer.agents[0].from === "team/c.md" && answer.agents[0].writes === 1,
    );
  }

  {
    const log = [];
    const reads = (paths) => recordActivity(log, { entries: paths.map((path) => ({ kind: "read", path })), actor }, now);
    reads(["a.md", "a.md", "secret.md", "b.md", "a.md"]);
    recordActivity(log, { entries: [{ kind: "create", path: "c.md" }], actor }, now);
    const answer = activityForCaller(log, now, (path) => path !== "secret.md", null);
    check(
      "an agent's reads come in order, oldest first, hidden ones absent and repeats collapsed",
      JSON.stringify(answer.agents[0].readPaths) === JSON.stringify(["a.md", "b.md", "a.md"]),
    );
    check(
      "a create is told apart from an edit, and is still a write to the tree",
      answer.agents[0].doing === "create" && answer.agents[0].kind === "write" &&
        answer.events.at(-1).kind === "create" && answer.agents[0].reads === 2,
    );
    reads(Array.from({ length: AGENT_ACTIVITY_MAX_READ_PATHS + 5 }, (_, i) => `r${i}.md`));
    const capped = activityForCaller(log, now, () => true, null).agents[0].readPaths;
    check(
      "the reading list keeps the newest few, still oldest first",
      capped.length === AGENT_ACTIVITY_MAX_READ_PATHS && capped.at(-1) === `r${AGENT_ACTIVITY_MAX_READ_PATHS + 4}.md` &&
        capped[0] === "r5.md",
    );
    for (let i = 0; i < 2; i += 1) {
      reads(Array.from({ length: AGENT_ACTIVITY_MAX_ENTRIES_PER_CALL }, (_, j) => `x${i}-${j}.md`));
    }
    const events = activityForCaller(log, now, () => true, null).events;
    check(
      "an answer carries at most its ceiling of events, newest last",
      events.length === AGENT_ACTIVITY_MAX_ANSWER_EVENTS && events.at(-1).path === "x1-199.md",
    );
  }

  {
    const log = [];
    const person = { key: HEX, name: "@jo" };
    check(
      "a person cannot announce a read or an edit, only what the console finished",
      !recordPersonActivity(log, person, { kind: "read", path: "a.md" }, now) &&
        !recordPersonActivity(log, person, { kind: "edit", path: "a.md" }, now),
    );
    check(
      "a person whose key is not a digest announces nothing",
      !recordPersonActivity(log, { key: "p:me", name: "x" }, { kind: "create", path: "a.md" }, now),
    );
    recordPersonActivity(log, person, { kind: "create", path: "a.md" }, now);
    check(
      "the same announcement twice is one event",
      !recordPersonActivity(log, person, { kind: "create", path: "a.md" }, now) && log.length === 1,
    );
    const answer = activityForCaller(log, now, () => true, null);
    check(
      "a person's own action is in the map's events and never counted as an agent",
      answer.events.length === 1 && answer.events[0].actor.kind === "person" &&
        answer.events[0].actor.id === `p:${HEX}` && answer.marks.length === 0 && answer.agents.length === 0,
    );
  }

  {
    const roster = new Map();
    recordPerson(roster, { key: HEX, name: "@jo", note: { path: "a.md", doing: "edit" } }, now);
    const placed = peopleForCaller(roster, now, HEX).people[0];
    recordPerson(roster, { key: HEX, name: "@jo", note: { path: "a.md", doing: "type" } }, now + 1);
    const odd = peopleForCaller(roster, now + 1, HEX).people[0];
    recordPerson(roster, { key: HEX, name: "@jo" }, now + 2);
    const cleared = peopleForCaller(roster, now + 2, HEX).people[0];
    check(
      "a person is placed on the note their console says, and an ask without one clears it",
      placed.path === "a.md" && placed.doing === "edit" && odd.doing === "read" &&
        cleared.path === null && cleared.doing === null,
    );
  }

  /* ============================== the route ============================= */

  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = counted(createBucket());
    const otherBucket = createBucket();
    const binding = {
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
      provider: "r2-binding",
    };
    controlPlane.addWorkspace("ws_agentmap", "agentmaptest", { ...binding, bindingName: "MAP_BUCKET" });
    controlPlane.addWorkspace("ws_agentmapother", "agentmapother", { ...binding, bindingName: "MAP_OTHER" });
    const grant = (accessToken, workspaceId, role, scopes, clientId, userId) =>
      controlPlane.addGrant({ accessToken, workspaceId, role, scopes, clientId, clientName: "Claude", userId });
    const all = ["context:read", "context:write", "context:private"];
    const team = ["context:read", "context:write"];
    await grant(OWNER, "ws_agentmap", "owner", all, "mcp_client_agentmap_owner", "user_agentmap_owner");
    await grant(TEAM, "ws_agentmap", "editor", team, "mcp_client_agentmap_team", "user_agentmap_team");
    await grant(CONSOLE_OWNER, "ws_agentmap", "owner", all, "context_console", "user_agentmap_owner");
    await grant(CONSOLE_TEAM, "ws_agentmap", "editor", team, "context_console", "user_agentmap_team");
    await grant(CONSOLE_READER, "ws_agentmap", "member", ["context:read"], "context_console", "user_agentmap_reader");
    await grant(CONSOLE_OTHER, "ws_agentmapother", "owner", all, "context_console", "user_agentmap_other");

    bucket.seed("privacy.md", manifest());
    bucket.seed("index.md", "# front page");
    bucket.seed("1-projects/roadmap.md", "the roadmap");
    bucket.seed("1-projects/rates.md", "RATESECRET");
    bucket.seed("1-projects/plan.md", "a plan that will be made private");
    bucket.seed("1-projects/tidy.md", "a note that moves within the team folder");
    bucket.seed("private/draft.md", "a private draft that moves into the open");
    otherBucket.seed("privacy.md", manifest());
    otherBucket.seed("1-projects/elsewhere.md", "another workspace's note");

    const rooms = createLiveNamespace();
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "MAP_BUCKET,MAP_OTHER",
      MAP_BUCKET: bucket,
      MAP_OTHER: otherBucket,
      PRESENCE_ROOM: rooms,
    };
    const ask = async (token, params = {}) =>
      (await activityRequest(env, token, { query: `?${new URLSearchParams(params)}` })).body ?? {};

    // The team agent reads two notes in order, creates one, edits one and
    // moves one inside the team folder.
    await callTool(env, TEAM, "read_note", { path: "index.md" });
    const roadmap = await callTool(env, TEAM, "read_note", { path: "1-projects/roadmap.md" });
    await callTool(env, TEAM, "read_note", { path: "1-projects/rates.md" }); // refused: records nothing
    await callTool(env, TEAM, "write_note", { path: "1-projects/fresh.md", content: "a new note\n" });
    await callTool(env, TEAM, "write_note", {
      path: "1-projects/roadmap.md",
      content: "the roadmap\n\nand one more line\n",
      expected_etag: roadmap.match(/^etag: (\S+)/m)?.[1],
    });
    const tidied = await callTool(env, TEAM, "move_note", {
      source: "1-projects/tidy.md",
      destination: "1-projects/done/tidy.md",
    });
    bucket.seed("1-projects/done/diagram.png", "not a note");
    const folded = await callTool(env, TEAM, "move_folder", {
      source: "1-projects/done",
      destination: "1-projects/finished",
    });
    // The owner's agent reads the private note and moves notes across the
    // boundary in both directions.
    await callTool(env, OWNER, "read_note", { path: "1-projects/rates.md" });
    const hidden = await callTool(env, OWNER, "move_note", {
      source: "1-projects/plan.md",
      destination: "private/plan.md",
    });
    const opened = await callTool(env, OWNER, "move_note", {
      source: "private/draft.md",
      destination: "1-projects/draft.md",
    });
    // The move left the destination narrowed to private; the owner then
    // publishes it, so its new path is team-visible and its old one is not.
    bucket.seed("privacy.md", manifest());
    check(
      "the moves this suite relies on succeeded",
      tidied.startsWith("moved:") && hidden.startsWith("moved:") && opened.startsWith("moved:") &&
        folded.startsWith("moved folder:"),
    );

    const teamView = await ask(CONSOLE_TEAM);
    const ownerView = await ask(CONSOLE_OWNER);
    const teamJson = JSON.stringify(teamView);
    const teamAgent = teamView.agents?.find((agent) => agent.name === "Claude" && agent.self);
    check(
      "a create and an edit by an agent arrive as such",
      teamView.events?.some((e) => e.kind === "create" && e.path === "1-projects/fresh.md") &&
        teamView.events.some((e) => e.kind === "edit" && e.path === "1-projects/roadmap.md"),
    );
    check(
      "a move inside what the caller can see arrives with both ends, after it succeeded",
      teamView.events.some(
        (e) => e.kind === "move" && e.from === "1-projects/tidy.md" && e.to === "1-projects/done/tidy.md" &&
          e.actor.kind === "agent",
      ),
    );
    check(
      "a folder move arrives as one move per note in it, and only the notes",
      teamView.events.some(
        (e) => e.kind === "move" && e.from === "1-projects/done/tidy.md" && e.to === "1-projects/finished/tidy.md",
      ) && !teamJson.includes("diagram.png"),
    );
    check(
      "an agent's reads arrive in the order it made them",
      JSON.stringify(teamAgent?.readPaths) === JSON.stringify(["index.md", "1-projects/roadmap.md"]),
    );
    check(
      "a team member never sees a private path, in any part of the answer",
      !teamJson.includes("rates") && !teamJson.includes("private/"),
    );
    check(
      "a move with a hidden end reveals neither end",
      !teamJson.includes("plan.md") && !teamJson.includes("draft.md"),
    );
    check(
      "the owner sees the private read and both moves across the boundary",
      ownerView.agents.some((agent) => agent.readPaths.includes("1-projects/rates.md")) &&
        ownerView.events.some((e) => e.kind === "move" && e.to === "private/plan.md") &&
        ownerView.events.some((e) => e.kind === "move" && e.from === "private/draft.md"),
    );
    check(
      "the tree's fields keep their two kinds",
      [...teamView.marks, ...teamView.agents].every((entry) => entry.kind === "read" || entry.kind === "write") &&
        teamView.agents.every((agent) => Number.isInteger(agent.reads) && Number.isInteger(agent.writes)),
    );

    // ---- people on notes ----
    await ask(CONSOLE_OWNER, { note: "1-projects/rates.md", doing: "edit" });
    await ask(CONSOLE_TEAM, { note: "1-projects/roadmap.md", doing: "edit" });
    const ownerSees = (await ask(CONSOLE_OWNER, { note: "1-projects/rates.md", doing: "edit" })).people ?? [];
    const teamSees = (await ask(CONSOLE_TEAM, { note: "1-projects/roadmap.md", doing: "edit" })).people ?? [];
    check(
      "the owner is placed on the private note they are editing, for themselves",
      ownerSees.some((p) => p.self && p.path === "1-projects/rates.md" && p.doing === "edit"),
    );
    check(
      "...and is listed with no note for a teammate who cannot see it",
      teamSees.some((p) => !p.self && p.path === null && p.doing === null) &&
        !JSON.stringify(teamSees).includes("rates"),
    );
    check(
      "a teammate on a team note is placed there for the owner",
      ownerSees.some((p) => !p.self && p.path === "1-projects/roadmap.md" && p.doing === "edit"),
    );

    const injected = [];
    for (const note of ["1-projects/rates.md", "1-projects/nowhere.md", ".context/forwarding.md", "../index.md"]) {
      await ask(CONSOLE_TEAM, { note });
      injected.push((await ask(CONSOLE_OWNER)).people.filter((p) => !p.self).map((p) => p.path));
    }
    check(
      "a heartbeat cannot place anybody on a note its caller cannot see, or that is not there, or plumbing",
      injected.every((paths) => paths.every((path) => path === null)),
    );

    // The probe: a hidden note and a missing one must be indistinguishable to
    // the caller, by answer and by what the bucket was asked.
    const probe = async (note) => {
      const before = bucket.counts.ops;
      const body = await ask(CONSOLE_TEAM, { note });
      const self = body.people.find((p) => p.self);
      return { ops: bucket.counts.ops - before, self: JSON.stringify({ path: self?.path, doing: self?.doing }) };
    };
    const held = await probe("1-projects/rates.md");
    const missing = await probe("1-projects/nothing-here.md");
    check(
      "a hidden note and a missing one answer alike and cost alike",
      held.self === missing.self && held.ops === missing.ops,
    );

    await ask(CONSOLE_READER, { note: "1-projects/roadmap.md", doing: "edit" });
    check(
      "a reader who cannot write is shown reading, not editing",
      (await ask(CONSOLE_OWNER)).people.some((p) => p.path === "1-projects/roadmap.md" && p.doing === "read" && !p.self),
    );
    const before = (await ask(CONSOLE_OWNER)).peopleCount;
    await ask(TEAM, { note: "1-projects/roadmap.md", doing: "edit" });
    check("a tool cannot place itself as a person", (await ask(CONSOLE_OWNER)).peopleCount === before);

    // ---- the console's own creates and moves ----
    const personEvents = async (token) =>
      ((await ask(token)).events ?? []).filter((e) => e.actor.kind === "person");
    bucket.seed("1-projects/renamed.md", "moved by a person in the console");
    await ask(CONSOLE_TEAM, { did: "move", from: "1-projects/was-here.md", to: "1-projects/renamed.md" });
    bucket.seed("1-projects/made.md", "created by a person in the console");
    await ask(CONSOLE_TEAM, { did: "create", path: "1-projects/made.md" });
    const announced = await personEvents(CONSOLE_OWNER);
    check(
      "a console's finished move and create reach the map as that person's",
      announced.some((e) => e.kind === "move" && e.from === "1-projects/was-here.md" && e.to === "1-projects/renamed.md") &&
        announced.some((e) => e.kind === "create" && e.path === "1-projects/made.md"),
    );
    const count = announced.length;
    await ask(CONSOLE_TEAM, { did: "move", from: "1-projects/roadmap.md", to: "1-projects/renamed.md" });
    await ask(CONSOLE_TEAM, { did: "move", from: "1-projects/gone.md", to: "1-projects/rates.md" });
    await ask(CONSOLE_TEAM, { did: "move", from: "private/plan-old.md", to: "1-projects/renamed.md" });
    await ask(CONSOLE_TEAM, { did: "create", path: "1-projects/rates.md" });
    await ask(CONSOLE_TEAM, { did: "create", path: "1-projects/never-made.md" });
    await ask(CONSOLE_READER, { did: "create", path: "1-projects/made.md" });
    await ask(TEAM, { did: "create", path: "1-projects/roadmap.md" });
    check(
      "a move whose source still exists, or with a hidden end, a create of a hidden or missing note, " +
        "and any announcement from a reader or a tool, are all ignored",
      (await personEvents(CONSOLE_OWNER)).length === count,
    );
    await ask(CONSOLE_OWNER, { did: "create", path: "1-projects/rates.md" });
    check(
      "the owner's announcement about a private note is never shown to a teammate",
      (await personEvents(CONSOLE_OWNER)).some((e) => e.path === "1-projects/rates.md") &&
        !JSON.stringify(await ask(CONSOLE_TEAM)).includes("rates"),
    );

    // ---- another workspace ----
    await ask(CONSOLE_OTHER, { note: "1-projects/elsewhere.md" });
    const elsewhere = await ask(CONSOLE_OTHER);
    check(
      "another workspace sees none of this one's events, and this one none of its people",
      elsewhere.events.length === 0 && elsewhere.agents.length === 0 &&
        !JSON.stringify(await ask(CONSOLE_OWNER)).includes("elsewhere"),
    );

    // ---- the map's polling rate ----
    const latest = (await ask(CONSOLE_TEAM)).events.at(-1)?.at;
    const quiet = await ask(CONSOLE_TEAM, { since: String(latest) });
    check(
      "`since` returns nothing new when nothing happened, and keeps the rest of the answer",
      quiet.events.length === 0 && quiet.marks.length > 0 && quiet.agents.length > 0,
    );
    for (let i = 0; i < 40; i += 1) {
      await ask(CONSOLE_TEAM, { since: String(latest), note: "1-projects/roadmap.md", doing: "read" });
    }
    check(
      "polling at the map's rate never writes Durable Object storage",
      rooms.runtimes.get(agentActivityKey("ws_agentmap"))?.stored.size === 0,
    );
    check(
      "a malformed `since` is ignored rather than refused",
      (await ask(CONSOLE_TEAM, { since: "soon" })).events.length > 0,
    );
  } finally {
    restore();
  }
}
