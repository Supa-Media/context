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
import { createEgressWorld, fakeModel, keepDeskKeys, PRIVACY_MANIFEST, request, TOKEN_TEXTS } from "../agentEgressFixtures.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "../agentModelFixture.mjs";
import { texStoreNamespace } from "../texStoreFixture.mjs";

const LINE = "sendblue:line:+15555550100";
const HOUR = 60 * 60_000;

/** What the model was shown on one request, as one string a check can match. */
export const shownIn = (body) => JSON.stringify({ system: body?.system ?? null, messages: body?.messages ?? [] });

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
      const answered = await request(world.env, TOKEN_TEXTS, "/agent", {
        question: words,
        conversation: "texts",
        covers: [theirs.id],
        chat: LINE,
        recent: [theirs],
        turn,
        ...(warm ? { warm } : {}),
      });
      if (answered.status !== 200) throw new Error(`replay: the turn for "${words}" answered ${answered.status}: ${JSON.stringify(answered.body)}`);
      warm = answered.body.warm ?? null;
      await keepDeskKeys(world, { about: false, jobs: false });
      clock += 5_000;
      const answer = String(answered.body.answer ?? "");
      const sent = event({ from: { kind: "tex" }, text: answer, turn, covers: [theirs.id], delivered: true });
      const flushed = await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [theirs, sent] });
      if (flushed.status !== 200) throw new Error(`replay: the Worker's flush answered ${flushed.status}`);
      return { answer, shown: world.model.requests.slice(before).map(shownIn).join("\n") };
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
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
  const live = (prefix) => [...team.keys()].filter((name) => name.startsWith(prefix) && !String(team.get(name)?.body ?? "").startsWith("context.logical-delete"));
  return {
    model,
    team,
    async tag(from, words, reply, said = []) {
      const before = model.requests.length;
      model.install(script(reply));
      const answered = await request(env, TOKEN_GROUP, "/agent", { question: words, group: { key, members, from, chat: said } });
      if (answered.status !== 200) throw new Error(`replay: the group turn for "${words}" answered ${answered.status}: ${JSON.stringify(answered.body)}`);
      return { answer: String(answered.body.answer ?? ""), shown: model.requests.slice(before).map(shownIn).join("\n") };
    },
    /** The workspace's notes and memory files, live ones only. */
    notes: (prefix = "") => live(prefix),
    memoryFiles: () => live(MEMORY_PREFIX),
    restore,
  };
}
