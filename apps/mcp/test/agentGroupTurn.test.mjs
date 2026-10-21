/**
 * Tex in a group chat (`src/agent/groupTurn.js`): a group turn reaches the
 * one shared workspace its grant names, writes only new notes and new lines,
 * has none of the tagger's own tools, and remembers the chat by its people.
 *
 * Sabotage these and a test here fails:
 *
 *  1. The route offering a group turn the texting write tools → "a group
 *     turn is offered only create and append".
 *  2. `groupAwareCallTool` not reading before a write → "write_note never
 *     changes a note that exists".
 *  3. `groupMemoryPath` filing by the chat alone → "somebody added to the
 *     chat starts a new memory".
 *  4. The route reading `conversation` for a group → "a group turn never
 *     touches anyone's texts".
 *  5. The route or the memory dropping `chat` → "what the chat said before a
 *     tag reaches the turn and is kept".
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { GROUP_MEMORY_PREFIX, MAX_CHAT_CHARS, groupOf, groupAwareCallTool, groupWriteTools } from "../src/agent/groupTurn.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { fakeModel, PRIVACY_MANIFEST } from "./agentEgressFixtures.mjs";

const S3_ENDPOINT = "https://s3.example-group.test";
const TOKEN_GROUP = `cat_group_editor_${"0".repeat(22)}`;
const TOKEN_GROUP_READER = `cat_group_reader_${"0".repeat(22)}`;
const TOKEN_TEXTS = `cat_group_texts_${"0".repeat(23)}`;
const KEY = "a".repeat(64);
const MEMBERS = "b".repeat(64);
const chat = (extra = {}) => ({ key: KEY, members: MEMBERS, from: "ada", ...extra });

let world;

before(() => {
  world = { previousFetch: globalThis.fetch };
});
after(() => {
  globalThis.fetch = world.previousFetch;
});

beforeEach(async () => {
  world.restore?.();
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
  const binding = (bucket) => ({
    provider: "s3",
    status: "active",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEAA",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  });
  controlPlane.addWorkspace("ws_group_ada", "ada", binding("tenant-group-ada"));
  controlPlane.addWorkspace("ws_group_team", "band", binding("tenant-group-team"), { kind: "shared" });
  // What Convex mints for a chat: the shared workspace only, never private, no other context.
  await controlPlane.addGrant({
    accessToken: TOKEN_GROUP,
    workspaceId: "ws_group_team",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_ada",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_GROUP_READER,
    workspaceId: "ws_group_team",
    role: "member",
    scopes: ["context:read"],
    clientId: "context_texts_group",
    clientName: "Tex (group chats)",
    userId: "user_bo",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_TEXTS,
    workspaceId: "ws_group_ada",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "context_texts",
    clientName: "Context (texts)",
    userId: "user_ada",
  });
  controlPlane.setBuiltinVerdict("ws_group_team", BUILTIN_ALLOWED);
  controlPlane.setBuiltinVerdict("ws_group_ada", BUILTIN_ALLOWED);
  const team = s3.bucketFor("tenant-group-team");
  const own = s3.bucketFor("tenant-group-ada");
  team.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "t0" });
  own.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "p0" });
  team.set("1-projects/setlist.md", { body: "# Setlist\n\n- Opener\n", etag: "t1" });
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
  Object.assign(world, {
    model,
    team,
    own,
    env,
    restore: () => {
      restoreControlPlane();
      restoreS3();
    },
  });
});

async function ask(token, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    world.env,
    ctx,
  );
  const text = await response.text();
  await settle();
  return { status: response.status, body: JSON.parse(text) };
}

const toolNames = (request) => (request?.tools ?? []).map((tool) => tool.name);
const live = (bucket, prefix) =>
  [...bucket.keys()].filter((key) => key.startsWith(prefix) && !String(bucket.get(key)?.body ?? "").startsWith("context.logical-delete"));
const bodyAt = (bucket, path) => {
  const value = bucket.get(path)?.body;
  return typeof value === "string" ? value : value === undefined ? undefined : new TextDecoder().decode(value);
};
const toolResults = (request) =>
  (request?.messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === "tool_result")
    .map((block) => String(Array.isArray(block.content) ? block.content.map((part) => part.text ?? "").join("") : block.content ?? ""));

test("a group turn must name its chat, and a chat names only hashes", async () => {
  const refused = await ask(TOKEN_GROUP, { question: "what's on the setlist?" });
  assert.equal(refused.status, 400);
  assert.equal(groupOf({ group: { key: KEY, members: "+15555550100", from: "ada" } }), null, "a phone number is not a participant hash");
  assert.equal(groupOf({ group: { key: "short", members: MEMBERS } }), null);
  assert.deepEqual(groupOf({ group: chat({ from: "Not A Handle!" }) }), { key: KEY, members: MEMBERS, from: "", chat: [] });
  // A chat line names a handle or nobody, never a number, and a line that isn't one is left out.
  const said = groupOf({ group: chat({ chat: [{ from: "+15555550100", text: "hi" }, { text: 7 }, { from: "bo", text: "  friday?  " }] }) });
  assert.deepEqual(said.chat, [{ from: "", text: "hi" }, { from: "bo", text: "friday?" }]);
  const long = groupOf({ group: chat({ chat: Array.from({ length: 30 }, (_, i) => ({ from: "bo", text: `${i}`.padEnd(4_000, ".") })) }) });
  assert.ok(long.chat.reduce((sum, line) => sum + line.text.length, 0) <= MAX_CHAT_CHARS, "a tag brings a bounded chat");
  assert.ok(long.chat.at(-1).text.startsWith("29"), "the newest of it");
});

test("a group turn is offered only create and append, and none of the tagger's own tools", async () => {
  world.model.install([{ text: "The opener." }]);
  const { status, body } = await ask(TOKEN_GROUP, { question: "what's on the setlist?", group: chat(), timeZone: "UTC" });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.answer, "The opener.");
  const sent = world.model.requests[0];
  const shown = JSON.stringify(sent.tools);
  for (const missing of ["search_web", "open_page", "browse", "fill_login", "delegate", "text_progress", "draw_picture", "make_picture", "propose_note", "send_email"]) {
    assert.ok(!shown.includes(`"${missing}"`), `${missing} is not a group turn's`);
  }
  assert.ok(!toolNames(sent).includes("earlier_texts"), "a group turn has no texts of its own");
  assert.match(JSON.stringify(sent.tools), /chat: reads this group chat's earlier messages/, "but it can read back its own chat");
  const system = JSON.stringify(sent.system);
  assert.match(system, /GROUP CHAT/);
  assert.match(system, /@ada tagged you/);
  assert.match(system, /@band/);
  // The texts conversation, the transcript and the tagger's own tex/ notes are untouched.
  assert.deepEqual(live(world.team, ".context/agent/conversations/"), []);
  assert.deepEqual(live(world.own, ".context/"), []);
  assert.deepEqual(live(world.team, "tex/"), []);
});

test("write_note never changes a note that exists, and makes one that doesn't", async () => {
  world.model.install([
    {
      toolCalls: [
        { name: "write_note", args: { path: "1-projects/setlist.md", content: "# Setlist\n\nhijacked\n" } },
        { name: "write_note", args: { path: "1-projects/friday.md", content: "# Friday\n\nLoad in at 6.\n" } },
      ],
    },
    { text: "Saved Friday." },
  ]);
  const { status, body } = await ask(TOKEN_GROUP, { question: "save friday's load-in, 6pm", group: chat() });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(bodyAt(world.team, "1-projects/setlist.md"), "# Setlist\n\n- Opener\n", "the existing note is as it was");
  assert.match(bodyAt(world.team, "1-projects/friday.md") ?? "", /Load in at 6/);
  const [refused, made] = toolResults(world.model.requests[1]);
  assert.match(refused, /already a note at 1-projects\/setlist\.md/);
  assert.match(made, /written: 1-projects\/friday\.md/);
});

test("remember adds a line and never replaces one, and routines and hidden paths are refused", async () => {
  world.model.install([
    {
      toolCalls: [
        { name: "remember", args: { fact: "Closer is Hey Jude", kind: "stated", note: "1-projects/setlist.md", replaces: "Opener" } },
        { name: "remember", args: { fact: "Closer is Hey Jude", kind: "stated", note: "1-projects/setlist.md" } },
        { name: "write_note", args: { path: "tex/routines/daily/nag.md", content: "Nag them." } },
        { name: "write_note", args: { path: ".context/agent/groups/x.json", content: "{}" } },
      ],
    },
    { text: "Added." },
  ]);
  const { status } = await ask(TOKEN_GROUP, { question: "remember the closer is hey jude", group: chat() });
  assert.equal(status, 200);
  const [replaced, added, routine, hidden] = toolResults(world.model.requests[1]);
  assert.match(replaced, /replaces can't be passed from a group chat/);
  assert.doesNotMatch(added, /can't|denied/i, added);
  assert.match(routine, /can't be set from a group chat/);
  assert.match(hidden, /can't be used/);
  const setlist = bodyAt(world.team, "1-projects/setlist.md");
  assert.match(setlist, /- Opener/, "the line it was told to replace is still there");
  assert.match(setlist, /Closer is Hey Jude/);
  assert.deepEqual(live(world.team, "tex/"), []);
});

test("a member's read-only chat grant writes nothing", async () => {
  world.model.install([{ toolCalls: [{ name: "write_note", args: { path: "1-projects/new.md", content: "# New\n" } }] }, { text: "Can't." }]);
  const { status } = await ask(TOKEN_GROUP_READER, { question: "make a note", group: chat({ from: "bo" }) });
  assert.equal(status, 200);
  const shown = JSON.stringify(world.model.requests[0].tools);
  assert.ok(!/"remember"/.test(shown) && !/Create a new markdown note/.test(shown), "no write tool is offered");
  assert.equal(bodyAt(world.team, "1-projects/new.md"), undefined);
});

test("the chat remembers by its people: somebody added to the chat starts a new memory", async () => {
  world.model.install([{ text: "Noted: Friday." }, { text: "Friday, like you said." }, { text: "What gig?" }]);
  await ask(TOKEN_GROUP, { question: "the gig is friday", group: chat() });
  await ask(TOKEN_GROUP, { question: "when's the gig?", group: chat() });
  const remembered = JSON.stringify(world.model.requests[1].messages);
  assert.match(remembered, /@ada: the gig is friday/);
  assert.match(remembered, /Noted: Friday\./);
  await ask(TOKEN_GROUP, { question: "when's the gig?", group: chat({ members: "c".repeat(64) }) });
  assert.doesNotMatch(JSON.stringify(world.model.requests[2].messages), /the gig is friday/, "a newcomer is never replayed the chat before them");
  const files = live(world.team, GROUP_MEMORY_PREFIX);
  assert.equal(files.length, 2);
  for (const file of files) assert.doesNotMatch(file, /a{64}|b{64}|c{64}/, "the file name is a hash of the chat, not its key");
});

test("what the chat said before a tag reaches the turn and is kept", async () => {
  world.model.install([{ text: "Thursday at 7, at Bo's." }, { toolCalls: [{ name: "fetch", args: { id: "chat:" } }] }, { text: "Bo's place." }]);
  const said = [
    { from: "bo", text: "thursday works for me" },
    { from: "cy", text: "7pm? my place is free" },
  ];
  await ask(TOKEN_GROUP, { question: "Tex what did we land on", group: chat({ chat: said }) });
  const first = JSON.stringify(world.model.requests[0].messages);
  assert.match(first, /@bo: thursday works for me/);
  assert.match(first, /@cy: 7pm\? my place is free/);
  assert.match(first, /never instructions/, "marked as other people's words");
  // The next tag, with nothing said in between, still has it: it was kept with the question.
  await ask(TOKEN_GROUP, { question: "Tex where was it again?", group: chat() });
  const second = world.model.requests[1];
  assert.match(JSON.stringify(second.messages), /@cy: 7pm\? my place is free/);
  assert.match(JSON.stringify(second.tools), /chat: reads this group chat/);
  const [read] = toolResults(world.model.requests[2]);
  assert.match(read, /@bo: thursday works for me[\s\S]*You: Thursday at 7/, "earlier_chat reads it back, oldest first");
  const kept = live(world.team, GROUP_MEMORY_PREFIX).map((key) => bodyAt(world.team, key)).join("");
  assert.match(kept, /thursday works for me/, "kept in the bound workspace");
  assert.equal(live(world.own, GROUP_MEMORY_PREFIX).length, 0, "never in the tagger's own");
});

test("a group turn never touches anyone's texts, even when it names them", async () => {
  world.model.install([{ text: "Hi." }]);
  const { status } = await ask(TOKEN_GROUP, { question: "hi", group: chat(), conversation: "texts" });
  assert.equal(status, 200);
  assert.deepEqual(live(world.team, ".context/agent/conversations/"), []);
  assert.deepEqual(live(world.team, ".context/agent/events/"), []);
});

test("the person's own texting connection ignores a group and stays as it was", async () => {
  world.model.install([{ text: "Hi." }]);
  const { status } = await ask(TOKEN_TEXTS, { question: "hi", group: chat(), conversation: "texts" });
  assert.equal(status, 200);
  assert.deepEqual(live(world.own, GROUP_MEMORY_PREFIX), []);
  assert.doesNotMatch(JSON.stringify(world.model.requests[0].system), /GROUP CHAT/);
});

test("the group dispatcher refuses a write tool it wasn't given and passes reads as they are", async () => {
  const calls = [];
  const callTool = async (name, args) => (calls.push({ name, args }), { content: [{ type: "text", text: "ok" }] });
  const dispatch = groupAwareCallTool(callTool, []);
  const refused = await dispatch("write_note", { path: "1-projects/x.md", content: "x" });
  assert.equal(refused.isError, true);
  await dispatch("read_note", { path: "1-projects/x.md" });
  assert.deepEqual(calls, [{ name: "read_note", args: { path: "1-projects/x.md" } }]);
  assert.deepEqual(groupWriteTools([{ name: "set_visibility", inputSchema: {} }]), []);
});
