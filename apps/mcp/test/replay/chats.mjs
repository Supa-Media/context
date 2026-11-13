/**
 * THE REPLAY CHATS: Tex's real pipeline, driven one text at a time
 * (Dev2, 2026-11-13: "build everything except D"; docs/decisions/testing/replay-gate.md).
 *
 * A replay case is a short chat that once went wrong in production, rewritten
 * with invented people and words. It runs through the gateway's real `/agent`
 * route, its real stores and its real ledger, with a scripted model standing
 * in for Claude, so it costs nothing and runs on every pull request. Each
 * helper here plays the texting Worker's part the way production does: it
 * hands the gateway the new text, keeps the warm copy the answer hands back,
 * then posts both texts to `/agent/events` and forgets them, as `events.ts`
 * `flushEvents` does. `deploy()` drops what the Worker held in memory, as a
 * deploy or an eviction does.
 *
 * What a case checks is plain code over what the model was shown and what the
 * chat kept: no judge, no model, no spend.
 */
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "../controlPlaneStub.mjs";
import { createEgressWorld, fakeModel, keepDeskKeys, PRIVACY_MANIFEST, request, TOKEN_ROUTINE, TOKEN_TEXTS } from "../agentEgressFixtures.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "../agentModelFixture.mjs";
import { texStoreNamespace } from "../texStoreFixture.mjs";

const LINE = "sendblue:line:+15555550100";
const HOUR = 60 * 60_000;

/** What the model was shown on one request, as one string a check can match. */
export const shownIn = (body) => JSON.stringify({ system: body?.system ?? null, messages: body?.messages ?? [] });

/**
 * The control plane's fire-and-forget reports (`src/controlPlane/reporting.js`): usage counters, timings, activity and
 * change notices, sent behind the response with their failure swallowed. Nobody waits on them, and the lazy usage report
 * (`reportBoundaryUsage`) starts a macrotask after whatever made it, so it lands before or after the first model call
 * by timing alone: counting it made the budgets flicker by one between runs. `speed-budgets.mjs` checks this list
 * against that file, so a new report joins it and a call moved out of it is counted.
 */
export const BEHIND_THE_RESPONSE = new Set([
  "/gateway/usage",
  "/gateway/search-timing",
  "/gateway/search-index/progress",
  "/gateway/activity",
  "/gateway/tree",
  "/gateway/tree/touch",
  "/gateway/website",
  "/gateway/routines",
  "/gateway/forms/notify",
]);

/**
 * What one turn asked for, counted on the way out: model calls (`gateway.ai`, every one of them, the judges' and the
 * advisor's included), and the calls made before the first model call that the person waits on before anything can be
 * said: storage and control-plane requests (`fetch`) and calls to Tex's Durable Objects (`tex.calls`). Reports behind
 * the response are left out (`BEHIND_THE_RESPONSE`). `before` names each counted call, so a budget that fails says
 * which calls are new. The speed budgets (`speed-budget.json`) are over these.
 */
async function counted(tex, run) {
  const inner = globalThis.fetch;
  const calls = { model: 0, beforeModel: 0, before: [] };
  const objectsAtStart = tex.calls.length;
  let objectsAtModel = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.host.startsWith("gateway.ai")) {
      if (calls.model === 0) objectsAtModel = tex.calls.length;
      calls.model += 1;
    } else if (calls.model === 0 && !BEHIND_THE_RESPONSE.has(url.pathname)) {
      calls.before.push(`${String(init.method ?? input.method ?? "GET").toUpperCase()} ${url.host}${url.pathname}`);
    }
    return inner(input, init);
  };
  try {
    const result = await run();
    const objects = tex.calls.slice(objectsAtStart, objectsAtModel ?? tex.calls.length).map((call) => `object ${call.op}${call.key ? ` ${call.key}` : ""}`);
    calls.before.push(...objects);
    calls.beforeModel = calls.before.length;
    return { result, calls };
  } finally {
    globalThis.fetch = inner;
  }
}

/** The scripted model's step for a reply given as words, or the steps as given. */
const script = (reply) => (Array.isArray(reply) ? reply : [{ text: reply }]);

/**
 * A 1:1 chat with Tex. `text(words, reply)` is one person's text and the
 * model's scripted answer; it returns what Tex texted back and what the model
 * was shown for it.
 */
export async function oneToOne() {
  const world = await createEgressWorld();
  let warm = null;
  let seq = 0;
  let turns = 0;
  let clock = Date.now() - 2 * HOUR;
  const event = (fields) => ({ id: `${clock}-${String(++seq).padStart(6, "0")}`, at: clock, chat: LINE, from: { kind: "person" }, kind: "text", text: "", ...fields });
  return {
    world,
    async text(words, reply) {
      clock += 60_000;
      const theirs = event({ text: words });
      const turn = `turn-replay-${String(++turns).padStart(4, "0")}`;
      const before = world.model.requests.length;
      world.model.install(script(reply));
      const { result: answered, calls } = await counted(world.tex, () =>
        request(world.env, TOKEN_TEXTS, "/agent", {
          question: words,
          conversation: "texts",
          covers: [theirs.id],
          chat: LINE,
          recent: [theirs],
          turn,
          ...(warm ? { warm } : {}),
        }),
      );
      if (answered.status !== 200) throw new Error(`replay: the turn for "${words}" answered ${answered.status}: ${JSON.stringify(answered.body)}`);
      warm = answered.body.warm ?? null;
      await keepDeskKeys(world, { about: false, jobs: false });
      clock += 5_000;
      const answer = String(answered.body.answer ?? "");
      const sent = event({ from: { kind: "tex" }, text: answer, turn, covers: [theirs.id], delivered: true });
      const flushed = await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [theirs, sent] });
      if (flushed.status !== 200) throw new Error(`replay: the Worker's flush answered ${flushed.status}`);
      return { answer, calls, shown: world.model.requests.slice(before).map(shownIn).join("\n") };
    },
    /** A routine (a check-in or a daily brief) firing in this chat: no text named, Tex decides what to say. */
    async routine(path, reply) {
      clock += 60_000;
      const before = world.model.requests.length;
      world.model.install(script(reply));
      const ran = await request(world.env, TOKEN_ROUTINE, "/agent", { routine: { path } });
      if (ran.status !== 200) throw new Error(`replay: the routine ${path} answered ${ran.status}: ${JSON.stringify(ran.body)}`);
      return { answer: String(ran.body.answer ?? ""), shown: world.model.requests.slice(before).map(shownIn).join("\n") };
    },
    /** One part of a background job started from this chat: `job` as the Worker hands it (title, brief, attempt, followUps). */
    async jobPart(words, job, reply) {
      clock += 60_000;
      const before = world.model.requests.length;
      world.model.install(script(reply));
      const ran = await request(world.env, TOKEN_TEXTS, "/agent", { question: words, conversation: "texts", job });
      if (ran.status !== 200) throw new Error(`replay: the job part ${job.title} answered ${ran.status}: ${JSON.stringify(ran.body)}`);
      return { answer: String(ran.body.answer ?? ""), shown: world.model.requests.slice(before).map(shownIn).join("\n") };
    },
    /** A deploy or an eviction: the Worker forgets its warm copy, and the next turn reads cold. */
    deploy() {
      warm = null;
    },
    /** Time passing between texts. */
    wait(ms) {
      clock += ms;
    },
    restore: () => world.restore(),
  };
}

const S3_ENDPOINT = "https://s3.example-replay.test";
const TOKEN_GROUP = `cat_replay_group_${"0".repeat(22)}`;
const MEMORY_PREFIX = ".context/agent/groups/";

/**
 * A group chat Tex was added to, bound to one shared workspace. `tag(from,
 * words, reply, said)` is a text that reached Tex, with `said` the chatter the
 * Worker held since the last one, as `{ from, text }`.
 */
export async function groupChat({ key = "a".repeat(64), members = "b".repeat(64) } = {}) {
  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  controlPlane.serveTreesFrom(null, { s3 });
  const model = fakeModel();
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) return model.handle(url, init);
    return withStubs(input, init);
  };
  const restore = () => {
    globalThis.fetch = previousFetch;
    restoreControlPlane();
    restoreS3();
  };
  const binding = {
    provider: "s3",
    status: "active",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tenant-replay-team",
    accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  };
  controlPlane.addWorkspace("ws_replay_team", "replay-band", binding, { kind: "shared" });
  await controlPlane.addGrant({
    accessToken: TOKEN_GROUP,
    workspaceId: "ws_replay_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_ada",
  });
  controlPlane.setBuiltinVerdict("ws_replay_team", BUILTIN_ALLOWED);
  const team = s3.bucketFor("tenant-replay-team");
  team.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "t0" });
  const tex = texStoreNamespace();
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: tex.namespace, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
  const live = (prefix) => [...team.keys()].filter((name) => name.startsWith(prefix) && !String(team.get(name)?.body ?? "").startsWith("context.logical-delete"));
  return {
    model,
    team,
    async tag(from, words, reply, said = [], { tagged = false } = {}) {
      const before = model.requests.length;
      model.install(script(reply));
      const { result: answered, calls } = await counted(tex, () => request(env, TOKEN_GROUP, "/agent", { question: words, group: { key, members, from, chat: said, ...(tagged ? { tagged: true } : {}) } }));
      if (answered.status !== 200) throw new Error(`replay: the group turn for "${words}" answered ${answered.status}: ${JSON.stringify(answered.body)}`);
      return { answer: String(answered.body.answer ?? ""), calls, shown: model.requests.slice(before).map(shownIn).join("\n"), requests: model.requests.slice(before) };
    },
    /** The workspace's notes and memory files, live ones only. */
    notes: (prefix = "") => live(prefix),
    memoryFiles: () => live(MEMORY_PREFIX),
    restore,
  };
}
