/**
 * Tex in a note's comments: `POST /tex/note-run` (a streamed run) and `GET /tex/note-runs` (the note's run log), and the
 * log's storage in the note's own TexChat object (`packages/tex/gateway/agent/noteRunRoute.js`,
 * `packages/tex/gateway/texChat/noteRuns.js`, `packages/tex/gateway/agent/noteRunLog.js`).
 *
 * The model is never called here: `deps.runNoteRun` stands for `agent/noteRun.js`, and `dispatchFor` for the person's own
 * tools (`ownDispatch`). The chat object's storage is an in-memory stand-in with the same four calls.
 *
 * Sabotage record (run 2026-11-20, each break reverted before the next):
 *   1. `targetOf` answered a target for any workspace id (membership check removed): the three "tenant isolation"
 *      tests and the run-log GET refusal failed, and the sandbox showed no read or run for them. Restored byte-identical.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleNoteRun, handleNoteRuns, noteRunsFull, NOTE_RUN_PATH, NOTE_RUNS_READ_PATH } from "../../../packages/tex/gateway/agent/noteRunRoute.js";
import { NOTE_RUNS_NAME_HEADER, serveNoteRuns } from "../../../packages/tex/gateway/texChat/noteRuns.js";

const NOW = 1_800_000_000_000;
const USER = "k7m2q9x4b8n3c6v1";
const OTHER_USER = "p1w8e3r5t2y7u4i9";
const ANA = {
  actorClientId: "context_console",
  workspaceKind: "personal",
  role: "owner",
  actorUserId: USER,
  workspaceId: "wsA",
  workspaceSlug: "ana",
  workspaces: [
    { workspaceId: "wsA", slug: "ana", kind: "personal", role: "owner" },
    { workspaceId: "wsT", slug: "team", kind: "shared", role: "member" },
  ],
};
const BEE = {
  ...ANA,
  actorUserId: OTHER_USER,
  workspaceId: "wsB",
  workspaceSlug: "bee",
  workspaces: [
    { workspaceId: "wsB", slug: "bee", kind: "personal", role: "owner" },
    { workspaceId: "wsT", slug: "team", kind: "shared", role: "member" },
  ],
};
const STEP = { id: "noteRun", on: true, model: "haiku-5-5" };
const NOTE = "projects/a.md";

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
    list: async ({ prefix }) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** A fake TEX_CHAT namespace: one storage per object name, answered by the chat object's own run-log function. */
function chatNamespace() {
  const storages = new Map();
  const gets = [];
  const namespace = {
    idFromName: (name) => name,
    get: (name) => {
      gets.push(name);
      if (!storages.has(name)) storages.set(name, memoryStorage());
      const storage = storages.get(name);
      return { fetch: (request) => serveNoteRuns(request, storage, { now: () => NOW }) };
    },
  };
  return { storages, gets, namespace };
}

/** The person's own read of the note: `read_note` answered with the header lines the tool writes. */
function readOk(body = "The note.", visibility = "team") {
  return { content: [{ type: "text", text: `etag: @team/n1:e1\npath: ${NOTE}\nvisibility: ${visibility}\n\n${body}` }] };
}

/** A dispatcher for the person's own tools: `read_note` gets the answer, every call is kept. */
function dispatcher(read = readOk()) {
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push({ name, args });
    if (name === "read_note") return typeof read === "function" ? read(args) : read;
    return { content: [{ type: "text", text: "" }] };
  };
  return { calls, dispatch };
}

/** The lines an NDJSON answer carries, parsed. */
async function lines(response) {
  const text = await response.text();
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

const body = (over = {}) => ({
  workspace: "@team",
  noteId: "n1",
  path: NOTE,
  thread: "t1",
  anchor: { text: "the sentence", before: "before", after: "after" },
  ask: "Is this right?",
  history: [{ who: "me", body: "hi" }],
  pending: null,
  ...over,
});

function post(json, { method = "POST", raw = null } = {}) {
  if (method === "GET") return new Request(`https://gw${NOTE_RUN_PATH}`, { method });
  return new Request(`https://gw${NOTE_RUN_PATH}`, { method, body: raw ?? JSON.stringify(json), headers: { "content-type": "application/json" } });
}

function getRuns(query, { session = ANA } = {}) {
  const params = new URLSearchParams(query);
  return new Request(`https://gw${NOTE_RUNS_READ_PATH}?${params}`, { method: "GET" });
}

/** A run that answers, with the parts the log keeps. */
function answering(extra = {}) {
  return async (args) => {
    args.onStep({ id: "read", label: "Reads the note", state: "running" });
    args.onStep({ id: "read", label: "Reads the note", state: "done", ms: 12, source: "notes", secret: "not sent" });
    return {
      outcome: "answered",
      answer: "Yes, it is.",
      replace: "The new sentence.",
      sources: [{ path: NOTE }, { path: "people/b.md" }],
      calls: [{ name: "read_note", args: { path: NOTE } }],
      model: "haiku-5-5",
      usage: { input: 10, output: 4 },
      ms: 30,
      ...extra,
    };
  };
}

/** The deps a route takes in these tests; each one replaces a module the tests do not run. */
function depsFor({ chat, dispatch, runNoteRun = answering(), node = STEP, now = () => NOW, runId = () => "nr_0123456789abcdef" } = {}) {
  return {
    runNoteRun,
    noteRunNode: () => node,
    dispatchFor: () => dispatch,
    offeredFor: async () => [],
    ledgerOf: () => null,
    controlPlane: {},
    now,
    runId,
    timeZone: "America/New_York",
  };
}

async function postRun(json, { session = ANA, env, deps, raw, method } = {}) {
  const store = {};
  return await handleNoteRun(post(json, { raw, method }), store, session, NOTE_RUN_PATH, env, null, deps);
}

async function readRuns(query, { session = ANA, env, deps } = {}) {
  return await handleNoteRuns(getRuns(query), {}, session, NOTE_RUNS_READ_PATH, env, null, deps);
}

const CORS = "access-control-allow-origin";

/** The run entries a log's storage holds: its own `name` key is not a run. */
const runsIn = (storage) => [...storage.map].filter(([key]) => key.startsWith("run:")).map(([, value]) => value);

describe("who may ask: the console's client, the owner of a personal workspace", () => {
  it("refuses another client, with the CORS header", async () => {
    const chat = chatNamespace();
    const response = await postRun(body(), { session: { ...ANA, actorClientId: "context_cli" }, env: { TEX_CHAT: chat.namespace }, deps: depsFor({ chat, dispatch: dispatcher().dispatch }) });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get(CORS), "*");
    assert.equal((await response.json()).error, "forbidden");
  });

  it("refuses a shared workspace's token and a member's, never a read", async () => {
    const chat = chatNamespace();
    const d = dispatcher();
    const env = { TEX_CHAT: chat.namespace };
    const shared = await postRun(body(), { session: { ...ANA, workspaceKind: "shared" }, env, deps: depsFor({ dispatch: d.dispatch }) });
    const member = await postRun(body(), { session: { ...ANA, role: "member" }, env, deps: depsFor({ dispatch: d.dispatch }) });
    assert.equal(shared.status, 403);
    assert.equal(member.status, 403);
    assert.equal(shared.headers.get(CORS), "*");
    assert.equal(d.calls.length, 0);
  });

  it("answers a GET on the POST route 405, with the CORS header", async () => {
    const response = await postRun(undefined, { method: "GET", env: { TEX_CHAT: chatNamespace().namespace }, deps: depsFor({ dispatch: dispatcher().dispatch }) });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get(CORS), "*");
  });

  it("refuses the run log's GET to another client or a member, and a POST to it", async () => {
    const env = { TEX_CHAT: chatNamespace().namespace };
    const deps = depsFor({ dispatch: dispatcher().dispatch });
    const other = await readRuns("workspace=%40team&noteId=n1&path=projects%2Fa.md", { session: { ...ANA, actorClientId: "context_cli" }, env, deps });
    const member = await readRuns("workspace=%40team&noteId=n1&path=projects%2Fa.md", { session: { ...ANA, role: "member" }, env, deps });
    const wrong = await handleNoteRuns(post(body()), {}, ANA, NOTE_RUNS_READ_PATH, env, null, deps);
    assert.equal(other.status, 403);
    assert.equal(member.status, 403);
    assert.equal(wrong.status, 405);
    assert.equal(other.headers.get(CORS), "*");
    assert.equal(wrong.headers.get(CORS), "*");
  });
});

describe("validation: refused before anything is read", () => {
  const cases = [
    ["not JSON", { raw: "{nope" }],
    ["not an object", { raw: "[]" }],
    ["an empty ask", { json: body({ ask: "   " }) }],
    ["an ask over 4000 characters", { json: body({ ask: "a".repeat(4001) }) }],
    ["a path over 512", { json: body({ path: "p".repeat(513) }) }],
    ["an anchor text over 20000", { json: body({ anchor: { text: "a".repeat(20_001), before: "", after: "" } }) }],
    ["an anchor before over 400", { json: body({ anchor: { text: "", before: "b".repeat(401), after: "" } }) }],
    ["21 history items", { json: body({ history: Array.from({ length: 21 }, () => ({ who: "me", body: "x" })) }) }],
    ["a history body over 4000", { json: body({ history: [{ who: "me", body: "b".repeat(4001) }] }) }],
    ["pending over 20000", { json: body({ pending: "p".repeat(20_001) }) }],
    ["a thread over 128", { json: body({ thread: "t".repeat(129) }) }],
    ["no workspace", { json: body({ workspace: undefined }) }],
    ["a noteId with a space", { json: body({ noteId: "n 1" }) }],
  ];
  for (const [name, { json, raw }] of cases) {
    it(`refuses ${name} with 400 and JSON error`, async () => {
      const d = dispatcher();
      const response = await postRun(json, { raw, env: { TEX_CHAT: chatNamespace().namespace }, deps: depsFor({ dispatch: d.dispatch }) });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("content-type").split(";")[0], "application/json");
      assert.equal(typeof (await response.json()).error, "string");
      assert.equal(d.calls.length, 0);
    });
  }
});

describe("tenant isolation: a workspace the person is not in is refused and never read", () => {
  it("answers 403 for a workspace id the person does not belong to, and reads nothing", async () => {
    const chat = chatNamespace();
    const d = dispatcher();
    let ran = 0;
    const deps = depsFor({ dispatch: d.dispatch, runNoteRun: async () => ((ran += 1), { outcome: "answered", answer: "x" }) });
    const response = await postRun(body({ workspace: "wsSomeoneElses" }), { env: { TEX_CHAT: chat.namespace }, deps });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get(CORS), "*");
    assert.equal(d.calls.length, 0, "no read");
    assert.equal(ran, 0, "no run");
    assert.equal(chat.gets.length, 0, "no log object touched");
  });

  it("answers 403 for an @name the person does not reach, the same as an unknown id", async () => {
    const d = dispatcher();
    const response = await postRun(body({ workspace: "@stranger" }), { env: { TEX_CHAT: chatNamespace().namespace }, deps: depsFor({ dispatch: d.dispatch }) });
    assert.equal(response.status, 403);
    assert.equal(d.calls.length, 0);
  });

  it("refuses the run log's GET for a workspace the person is not in, and touches no log", async () => {
    const chat = chatNamespace();
    const d = dispatcher();
    const response = await readRuns("workspace=wsSomeoneElses&noteId=n1&path=projects%2Fa.md", { env: { TEX_CHAT: chat.namespace }, deps: depsFor({ dispatch: d.dispatch }) });
    assert.equal(response.status, 403);
    assert.equal(d.calls.length, 0);
    assert.equal(chat.gets.length, 0);
  });
});

describe("the note: read through the person's own access", () => {
  it("answers 503 while the node is not wired, and reads nothing", async () => {
    const d = dispatcher();
    const response = await postRun(body(), { env: { TEX_CHAT: chatNamespace().namespace }, deps: depsFor({ dispatch: d.dispatch, node: null }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "Tex in notes isn't on yet.");
    assert.equal(response.headers.get(CORS), "*");
    assert.equal(d.calls.length, 0);
  });

  it("answers 503 with the config as it is (no noteRun step) and no injected node", async () => {
    const response = await postRun(body(), { env: { TEX_CHAT: chatNamespace().namespace }, deps: { ...depsFor({ dispatch: dispatcher().dispatch }), noteRunNode: undefined } });
    assert.equal(response.status, 503);
  });

  it("answers 404 for a note the person cannot read, and never calls the run", async () => {
    let ran = 0;
    const d = dispatcher({ isError: true, content: [{ type: "text", text: "not found" }] });
    const deps = depsFor({ dispatch: d.dispatch, runNoteRun: async () => ((ran += 1), { outcome: "answered", answer: "x" }) });
    const response = await postRun(body(), { env: { TEX_CHAT: chatNamespace().namespace }, deps });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "That note can't be read.");
    assert.equal(response.headers.get(CORS), "*");
    assert.equal(ran, 0);
  });

  it("answers 404 for a moved note, the same as a missing one", async () => {
    const d = dispatcher({ content: [{ type: "text", text: `moved_from: ${NOTE}\netag: e\npath: x.md\n\nbody` }] });
    const response = await postRun(body(), { env: { TEX_CHAT: chatNamespace().namespace }, deps: depsFor({ dispatch: d.dispatch }) });
    assert.equal(response.status, 404);
  });

  it("reads the note with no context for the person's own workspace, and with @name for another", async () => {
    const own = dispatcher();
    await postRun(body({ workspace: "@ana" }), { env: { TEX_CHAT: chatNamespace().namespace }, deps: depsFor({ dispatch: own.dispatch }) });
    assert.deepEqual(own.calls[0], { name: "read_note", args: { path: NOTE } });
    const shared = dispatcher();
    await postRun(body({ workspace: "wsT" }), { env: { TEX_CHAT: chatNamespace().namespace }, deps: depsFor({ dispatch: shared.dispatch }) });
    assert.deepEqual(shared.calls[0], { name: "read_note", args: { path: NOTE, context: "@team" } });
  });
});

describe("the run log's key", () => {
  it("is the note's id from its placed etag, never the id the client sent", async () => {
    const chat = chatNamespace();
    const d = dispatcher();
    const response = await postRun(body({ noteId: "someOtherNote" }), { env: { TEX_CHAT: chat.namespace }, deps: depsFor({ dispatch: d.dispatch, runNoteRun: answering() }) });
    await lines(response);
    assert.deepEqual([...chat.storages.keys()], ["noteruns:wsT:n1"]);
  });

  it("is a hash of the path for a note whose etag names no id, and the console's empty noteId is taken", async () => {
    const chat = chatNamespace();
    const bare = { content: [{ type: "text", text: `etag: e1\npath: ${NOTE}\nvisibility: team\n\nThe note.` }] };
    const d = dispatcher(bare);
    const response = await postRun(body({ noteId: "" }), { env: { TEX_CHAT: chat.namespace }, deps: depsFor({ dispatch: d.dispatch, runNoteRun: answering() }) });
    assert.equal(response.status, 200);
    await lines(response);
    const keys = [...chat.storages.keys()];
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^noteruns:wsT:p[0-9a-f]{32}$/);
  });
});

describe("a streamed run", () => {
  it("streams steps, the answer, the edit and done, as NDJSON, and logs the run", async () => {
    const chat = chatNamespace();
    const d = dispatcher(readOk("Body of the note.", "team"));
    let seen = null;
    const deps = depsFor({ dispatch: d.dispatch, runNoteRun: async (args) => ((seen = args), (await answering()(args))) });
    const response = await postRun(body(), { env: { TEX_CHAT: chat.namespace }, deps });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type").split(";")[0], "application/x-ndjson");
    assert.equal(response.headers.get(CORS), "*");
    const out = await lines(response);
    assert.deepEqual(out.map((line) => line.type), ["step", "step", "answer", "edit", "done"]);
    assert.deepEqual(out[0], { type: "step", id: "read", label: "Reads the note", state: "running" });
    assert.deepEqual(out[1], { type: "step", id: "read", label: "Reads the note", state: "done", ms: 12, source: "notes" }, "a step carries its id, label, state, time and source only");
    assert.deepEqual(out[2], { type: "answer", text: "Yes, it is." });
    assert.deepEqual(out[3], { type: "edit", replace: "The new sentence." });
    assert.equal(out[4].runId, "nr_0123456789abcdef");
    assert.deepEqual(out[4].sources, [{ path: NOTE }, { path: "people/b.md" }]);
    assert.equal(seen.path, NOTE);
    assert.equal(seen.noteText, "Body of the note.");
    assert.equal(seen.audience, "the team it is shared with", "the visibility the read gave, as a phrase");
    assert.equal(seen.ask, "Is this right?");
    assert.equal(seen.anchor.text, "the sentence");
    assert.equal(seen.node.id, "noteRun");
    assert.equal(typeof seen.onStep, "function");
    // The log: one run in the note's own object, with its calls and usage, and the words only as far as the caps.
    const stored = runsIn(chat.storages.get("noteruns:wsT:n1"));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].runId, "nr_0123456789abcdef");
    assert.equal(stored[0].userId, USER);
    assert.equal(stored[0].who, "@ana");
    assert.equal(stored[0].replaced, true);
    assert.equal(stored[0].out, "Yes, it is.");
    assert.equal(stored[0].calls.length, 1);
    assert.deepEqual(stored[0].usage, { input: 10, output: 4 });
  });

  it("omits the edit line when there is no replacement", async () => {
    const d = dispatcher();
    const response = await postRun(body(), { env: { TEX_CHAT: chatNamespace().namespace }, deps: depsFor({ dispatch: d.dispatch, runNoteRun: answering({ replace: null }) }) });
    const out = await lines(response);
    assert.equal(out.some((line) => line.type === "edit"), false);
    assert.equal(out.at(-1).type, "done");
  });

  it("streams today's limit as the one error line, and logs nothing", async () => {
    const chat = chatNamespace();
    const d = dispatcher();
    const response = await postRun(body(), { env: { TEX_CHAT: chat.namespace }, deps: depsFor({ dispatch: d.dispatch, runNoteRun: async () => ({ outcome: "daily_limit" }) }) });
    const out = await lines(response);
    assert.deepEqual(out, [{ type: "error", message: "That's today's limit for Tex. Try again tomorrow." }]);
    assert.equal(chat.storages.size, 0, "a run that did not answer is not logged");
  });

  it("streams the general error line for any other outcome, and for a run that throws", async () => {
    const d = dispatcher();
    const env = { TEX_CHAT: chatNamespace().namespace };
    const general = "Tex can't take that just now. Try again in a moment.";
    const none = await lines(await postRun(body(), { env, deps: depsFor({ dispatch: d.dispatch, runNoteRun: async () => ({ outcome: "no_provider" }) }) }));
    const thrown = await lines(await postRun(body(), { env, deps: depsFor({ dispatch: d.dispatch, runNoteRun: async () => { throw new Error("model down"); } }) }));
    assert.deepEqual(none, [{ type: "error", message: general }]);
    assert.deepEqual(thrown, [{ type: "error", message: general }]);
  });
});

describe("the run log: GET shows the note's runs, filtered for whoever reads them", () => {
  it("lists the newest run first; another viewer sees only the note's own source, and no calls or usage", async () => {
    const chat = chatNamespace();
    const env = { TEX_CHAT: chat.namespace };
    const owner = dispatcher();
    await lines(await postRun(body(), { env, deps: depsFor({ dispatch: owner.dispatch }) }));
    const bee = dispatcher();
    const listed = await readRuns("workspace=%40team&noteId=n1&path=projects%2Fa.md", { session: BEE, env, deps: depsFor({ dispatch: bee.dispatch }) });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get(CORS), "*");
    const { runs } = await listed.json();
    assert.equal(runs.length, 1);
    assert.deepEqual(Object.keys(runs[0]).sort(), ["ask", "at", "out", "private", "runId", "sources", "who"]);
    assert.equal(runs[0].who, "@ana");
    assert.equal(runs[0].ask, "Is this right?");
    assert.equal(runs[0].out, "Yes, it is.");
    assert.deepEqual(runs[0].sources, [{ path: NOTE }], "only the note's own path, for a viewer who did not ask");
    assert.equal(runs[0].private, false);
  });

  it("shows the asker every source, and says private when one is not this note", async () => {
    const chat = chatNamespace();
    const env = { TEX_CHAT: chat.namespace };
    await lines(await postRun(body(), { env, deps: depsFor({ dispatch: dispatcher().dispatch }) }));
    const { runs } = await (await readRuns("workspace=%40team&noteId=n1&path=projects%2Fa.md", { env, deps: depsFor({ dispatch: dispatcher().dispatch }) })).json();
    assert.deepEqual(runs[0].sources, [{ path: NOTE }, { path: "people/b.md" }]);
    assert.equal(runs[0].private, true);
  });

  it("gives private false when every source is the note", async () => {
    const env = { TEX_CHAT: chatNamespace().namespace };
    await lines(await postRun(body(), { env, deps: depsFor({ dispatch: dispatcher().dispatch, runNoteRun: answering({ sources: [{ path: NOTE }] }) }) }));
    const { runs } = await (await readRuns("workspace=%40team&noteId=n1&path=projects%2Fa.md", { env, deps: depsFor({ dispatch: dispatcher().dispatch }) })).json();
    assert.equal(runs[0].private, false, "the asker's own run whose sources are all the note is not private");
  });

  it("does not list a run that did not answer", async () => {
    const env = { TEX_CHAT: chatNamespace().namespace };
    await lines(await postRun(body(), { env, deps: depsFor({ dispatch: dispatcher().dispatch, runNoteRun: async () => ({ outcome: "failed" }) }) }));
    const { runs } = await (await readRuns("workspace=%40team&noteId=n1&path=projects%2Fa.md", { env, deps: depsFor({ dispatch: dispatcher().dispatch }) })).json();
    assert.deepEqual(runs, []);
  });

  it("refuses a read the viewer cannot make, with 404 and nothing listed", async () => {
    const env = { TEX_CHAT: chatNamespace().namespace };
    const response = await readRuns("workspace=%40team&noteId=n1&path=projects%2Fa.md", { env, deps: depsFor({ dispatch: dispatcher({ isError: true, content: [] }).dispatch }) });
    assert.equal(response.status, 404);
  });
});

describe("the route is registered beside the app's chat", () => {
  it("answers the two paths through the app routes, GET and POST alike", async () => {
    const { APP_ROUTES } = await import("../src/http/appRoutes.js");
    assert.equal(APP_ROUTES.get(NOTE_RUN_PATH), handleNoteRun);
    assert.equal(APP_ROUTES.get(NOTE_RUNS_READ_PATH), handleNoteRuns);
  });
});

describe("tex_dev's note_runs: a note's runs in full, for a note the caller can read", () => {
  it("answers every entry with its calls, usage, model and time, and nothing for a note it cannot read", async () => {
    const env = { TEX_CHAT: chatNamespace().namespace };
    await lines(await postRun(body(), { env, deps: depsFor({ dispatch: dispatcher().dispatch }) }));
    const full = await noteRunsFull({ env, store: {}, session: ANA, args: { workspace: "@team", noteId: "n1", path: NOTE } }, { dispatchFor: () => dispatcher().dispatch });
    assert.equal(full.runs.length, 1);
    assert.equal(full.runs[0].calls.length, 1);
    assert.deepEqual(full.runs[0].usage, { input: 10, output: 4 });
    assert.equal(full.runs[0].model, "haiku-5-5");
    assert.equal(typeof full.runs[0].ms, "number");
    const hidden = await noteRunsFull({ env, store: {}, session: ANA, args: { workspace: "@team", noteId: "n1", path: NOTE } }, { dispatchFor: () => dispatcher({ isError: true, content: [] }).dispatch });
    assert.equal(hidden.error, "That note can't be read.");
    assert.equal(hidden.runs, undefined);
  });

  it("refuses a workspace the caller is not in, and reads nothing", async () => {
    const d = dispatcher();
    const answer = await noteRunsFull({ env: { TEX_CHAT: chatNamespace().namespace }, store: {}, session: ANA, args: { workspace: "wsSomeoneElses", noteId: "n1", path: NOTE } }, { dispatchFor: () => d.dispatch });
    assert.ok(answer.error);
    assert.equal(d.calls.length, 0);
  });
});
