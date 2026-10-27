/**
 * Tex in a group chat (`src/agent/groupTurn.js`): a group turn reaches the
 * one shared workspace its grant names, writes notes as a person's own text does,
 * has none of the tagger's own tools, and remembers the chat by its people.
 *
 * Sabotage these and a test here fails:
 *
 *  1. The route offering a group turn the texting write tools → "a group
 *     turn is offered note writes but none of the tagger's own tools".
 *  2. `groupWriteTools` narrowing a text's writes → "a group turn changes
 *     notes as a text does".
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
    controlPlane,
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
  // No handle is nobody's own account (an invited person's tag, 2026-10-27): marked so it releases and sends nothing as anyone.
  assert.deepEqual(groupOf({ group: chat({ from: "Not A Handle!" }) }), { key: KEY, members: MEMBERS, from: "", people: [], chat: [], guestTagger: true });
  // A chat line names a handle or nobody, never a number, and a line that isn't one is left out.
  const said = groupOf({ group: chat({ chat: [{ from: "+15555550100", text: "hi" }, { text: 7 }, { from: "bo", text: "  friday?  " }] }) });
  assert.deepEqual(said.chat, [{ from: "", text: "hi" }, { from: "bo", text: "friday?" }]);
  const long = groupOf({ group: chat({ chat: Array.from({ length: 30 }, (_, i) => ({ from: "bo", text: `${i}`.padEnd(4_000, ".") })) }) });
  assert.ok(long.chat.reduce((sum, line) => sum + line.text.length, 0) <= MAX_CHAT_CHARS, "a tag brings a bounded chat");
  assert.ok(long.chat.at(-1).text.startsWith("29"), "the newest of it");
});

test("a group turn is offered note writes but none of the tagger's own tools", async () => {
  world.model.install([{ text: "The opener." }]);
  const { status, body } = await ask(TOKEN_GROUP, { question: "what's on the setlist?", group: chat(), timeZone: "UTC" });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.answer, "The opener.");
  const sent = world.model.requests[0];
  const shown = JSON.stringify(sent.tools);
  // Named either way the turn could be shown them: a tool of its own, or a six-tools action (`- name:`).
  // Email, calendar and the web are a group turn's (agentGroupActions.test.mjs); these never are.
  // Pictures are a group's too (2026-10-23); progress texts are, when the Worker streams (`agentGroupActions.test.mjs`).
  for (const missing of ["delegate", "text_progress", "propose_note", "search_email", "read_email", "progress", "mail_agent"]) {
    assert.ok(!shown.includes(`"${missing}"`) && !shown.includes(`- ${missing}:`), `${missing} is not a group turn's`);
  }
  assert.ok(!toolNames(sent).includes("earlier_texts"), "a group turn has no texts of its own");
  assert.ok(shown.includes("make_picture"), "it can make a picture, as a text can");
  assert.match(JSON.stringify(sent.tools), /chat: reads this group chat's earlier messages/, "but it can read back its own chat");
  const system = JSON.stringify(sent.system);
  assert.match(system, /GROUP CHAT/);
  assert.match(system, /@ada tagged you/);
  assert.match(system, /@band/);
  // The texts conversation, the transcript and the tagger's own tex/ notes are untouched: only the chat's own note.
  assert.deepEqual(live(world.team, ".context/agent/conversations/"), []);
  assert.deepEqual(live(world.own, ".context/"), []);
  assert.deepEqual(live(world.team, "tex/").filter((key) => !key.startsWith("tex/groups/chat-")), []);
});

test("a group turn changes notes as a text does: edit by etag, make, move and archive (the owner, 2026-10-23)", async () => {
  world.model.install([
    {
      toolCalls: [
        { name: "write_note", args: { path: "1-projects/friday.md", content: "# Friday\n\nLoad in at 6.\n" } },
        { name: "read_note", args: { path: "1-projects/setlist.md" } },
      ],
    },
    (request) => {
      const etag = /etag: (\S+)/.exec(toolResults(request).at(-1))?.[1];
      assert.ok(etag, "the read gives the etag to change it by");
      return {
        toolCalls: [
          { name: "write_note", args: { path: "1-projects/setlist.md", content: "# Setlist\n\n- Opener\n- Closer\n", expected_etag: etag } },
          { name: "move_note", args: { source: "1-projects/friday.md", destination: "1-projects/gigs/friday.md" } },
        ],
      };
    },
    { text: "Done." },
  ]);
  const { status, body } = await ask(TOKEN_GROUP, { question: "save friday's load-in, add a closer, and file friday under gigs", group: chat() });
  assert.equal(status, 200, JSON.stringify(body));
  const [changed, moved] = toolResults(world.model.requests[2]).slice(-2);
  assert.match(changed, /written: 1-projects\/setlist\.md/, changed);
  assert.doesNotMatch(moved, /isn't available|can't be passed/, moved);
  assert.equal(bodyAt(world.team, "1-projects/setlist.md"), "# Setlist\n\n- Opener\n- Closer\n", "the note it read is changed");
  assert.match(bodyAt(world.team, "1-projects/gigs/friday.md") ?? "", /Load in at 6/);
});

test("the next tag knows which note the last one wrote, so it never disowns it (the group chat of 2026-10-23)", async () => {
  const people = chat({ members: "d".repeat(64) });
  world.model.install([
    { toolCalls: [{ name: "write_note", args: { path: "1-projects/image-reading.md", content: "# Read pictures in groups\n" } }] },
    { text: "Saved it in 1-projects." },
    { text: "It's there." },
  ]);
  await ask(TOKEN_GROUP, { question: "add a feature request for reading pictures", group: people });
  await ask(TOKEN_GROUP, { question: "did you actually save it?", group: people });
  const system = JSON.stringify(world.model.requests.at(-1).system);
  assert.match(system, /you used write_note\. Notes you wrote or changed: 1-projects\/image-reading\.md/, system);
  assert.match(system, /fetch it by that exact path/);
});

const folderShares = () =>
  world.controlPlane.calls
    .filter((entry) => entry.path === "/gateway/privacy" && entry.body?.op === "setAccess" && entry.body?.kind === "folder")
    .map((entry) => `${entry.body.path}: ${entry.body.base}`);

test("the chat's memory is a note in tex/groups/ that people can read and fix (the owner, 2026-10-23)", async () => {
  const people = chat({ members: "e".repeat(64) });
  world.model.install([{ text: "Noted: the gig is Friday." }]);
  await ask(TOKEN_GROUP, { question: "the gig is friday", group: people });
  // Nobody had to make the folder: the first note shared tex/groups/ (never tex/) with the workspace.
  assert.deepEqual(folderShares(), ["tex/groups: team"]);
  const [path] = [...world.team.keys()].filter((key) => key.startsWith("tex/groups/chat-"));
  assert.ok(path, "the chat's note was written");
  const note = bodyAt(world.team, path);
  assert.match(note, /# Tex's memory of this group chat/);
  assert.match(note, /@ada: the gig is friday\n\n\*\*Tex:\*\* Noted: the gig is Friday\./);
  assert.doesNotMatch(path, /e{12}|a{12}/, "named by a hash, never the chat's key");

  // Somebody fixes it, here through the same writes the app's editor makes.
  world.model.install([
    { toolCalls: [{ name: "read_note", args: { path } }] },
    (request) => {
      const read = toolResults(request).at(-1);
      const etag = /etag: (\S+)/.exec(read)?.[1];
      const body = read.slice(read.indexOf("\n\n") + 2).replace("the gig is friday", "the gig is saturday").replace("the gig is Friday", "the gig is Saturday");
      return { toolCalls: [{ name: "write_note", args: { path, content: body, expected_etag: etag } }] };
    },
    { text: "Fixed." },
    { text: "Saturday, like the note says." },
  ]);
  await ask(TOKEN_GROUP, { question: "fix your memory: it's saturday", group: chat({ members: "9".repeat(64) }) });
  await ask(TOKEN_GROUP, { question: "when's the gig?", group: people });
  const remembered = JSON.stringify(world.model.requests.at(-1).messages);
  assert.match(remembered, /the gig is saturday/);
  assert.doesNotMatch(remembered, /the gig is friday/, "the fix is what Tex goes by");
  assert.match(bodyAt(world.team, path), /the gig is saturday[\s\S]*Saturday, like the note says\./, "and the next exchange is added to the fixed note");
});

test("a tagger who can't write still has the chat's memory, and an untouched note never hides it", async () => {
  const people = chat({ members: "f".repeat(64) });
  world.model.install([{ text: "Noted: Friday." }, { text: "Load-in is 6." }, { text: "Friday at 6." }]);
  await ask(TOKEN_GROUP, { question: "the gig is friday", group: people });
  await ask(TOKEN_GROUP_READER, { question: "load-in is at 6", group: people });
  await ask(TOKEN_GROUP, { question: "when's the gig?", group: people });
  const remembered = JSON.stringify(world.model.requests.at(-1).messages);
  assert.match(remembered, /the gig is friday/);
  assert.match(remembered, /load-in is at 6/, "the read-only tagger's exchange is kept though the note couldn't take it");
});

test("a tex/ folder someone made private is never shared for the chat's note, and the memory still works", async (t) => {
  const people = chat({ members: "d".repeat(64) });
  const manifest = world.team.get("privacy.md");
  world.team.set("privacy.md", { body: manifest.body.replace("1-projects: team", "1-projects: team\n  tex: private"), etag: "t0-tex-private" });
  t.after(() => world.team.set("privacy.md", manifest));
  world.model.install([{ text: "Noted: Friday." }, { text: "Friday." }]);
  await ask(TOKEN_GROUP, { question: "the gig is friday", group: people });
  await ask(TOKEN_GROUP, { question: "when's the gig?", group: people });
  assert.deepEqual(folderShares(), [], "the owner's private tex/ is left as they set it");
  assert.deepEqual([...world.team.keys()].filter((key) => key.startsWith("tex/groups/")), []);
  assert.match(JSON.stringify(world.model.requests.at(-1).messages), /the gig is friday/, "kept in the hidden file instead");
});

test("a member who can't write never shares tex/groups/", async () => {
  const people = chat({ members: "b".repeat(64), from: "bo" });
  world.model.install([{ text: "Noted." }, { text: "6." }]);
  await ask(TOKEN_GROUP_READER, { question: "load-in is at 6", group: people });
  assert.deepEqual([...world.team.keys()].filter((key) => key.startsWith("tex/groups/")), []);
  const tried = folderShares().length;
  // The control plane refused the read-only grant, so the folder was still unset when an editor came.
  await ask(TOKEN_GROUP, { question: "when's load-in?", group: chat({ members: "b".repeat(64) }) });
  assert.equal(folderShares().length, tried + 1, "the editor found tex/groups/ unshared and shared it");
  assert.equal([...world.team.keys()].filter((key) => key.startsWith("tex/groups/")).length, 1);
});

test("a stale etag changes nothing, and routines and hidden paths are refused in a group", async () => {
  world.model.install([
    {
      toolCalls: [
        { name: "write_note", args: { path: "1-projects/setlist.md", content: "# Setlist\n\nstale\n", expected_etag: "not-the-etag" } },
        { name: "remember", args: { fact: "Closer is Hey Jude", kind: "stated", note: "1-projects/setlist.md", replaces: "Opener" } },
        { name: "write_note", args: { path: "tex/routines/daily/nag.md", content: "Nag them." } },
        { name: "write_note", args: { path: ".context/agent/groups/x.json", content: "{}" } },
      ],
    },
    { text: "Done." },
  ]);
  const { status } = await ask(TOKEN_GROUP, { question: "the closer is hey jude, not the opener", group: chat() });
  assert.equal(status, 200);
  const [stale, replaced, routine, hidden] = toolResults(world.model.requests[1]);
  assert.match(stale, /conflict|changed|etag|precondition/i, stale);
  assert.doesNotMatch(replaced, /can't be passed|isn't available/, replaced);
  assert.match(routine, /can't be set from a group chat/);
  assert.match(hidden, /can't be used/);
  assert.match(bodyAt(world.team, "1-projects/setlist.md"), /Closer is Hey Jude/);
  assert.deepEqual(live(world.team, "tex/").filter((key) => !key.startsWith("tex/groups/chat-")), [], "no routine was written");
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
  // A text's writes, as offered by the grant, then the tagger's own email and calendar.
  assert.deepEqual(
    groupWriteTools([{ name: "set_visibility", inputSchema: {} }, { name: "read_note", inputSchema: {}, annotations: { readOnlyHint: true } }]).map((tool) => tool.name),
    ["set_visibility", "send_email", "calendar_event"],
  );
  assert.equal((await groupAwareCallTool(callTool, groupWriteTools([]))("write_note", { path: "1-projects/y.md", content: "y" })).isError, true);
});

test("a note read in a group comes back with its app link, which everyone in the chat can open", async () => {
  // The group chat of 2026-10-21: "Tex, can you send a share link for the read me" got "I can't make a share link here".
  world.env.APP_ORIGIN = "https://app.example";
  try {
    world.model.install([{ toolCalls: [{ name: "fetch", args: { id: "1-projects/setlist.md" } }] }, { text: "https://app.example/note/@band/1-projects/setlist.md" }]);
    await ask(TOKEN_GROUP, { question: "Tex send the link to the setlist", group: chat() });
    const request = world.model.requests.at(-1);
    const [read] = toolResults(request);
    assert.match(read, /link: https:\/\/app\.example\/note\/@band\/1-projects\/setlist\.md/);
    assert.match(JSON.stringify(world.model.requests.at(-2).system ?? world.model.requests.at(-2).messages), /opens in the Context app for everyone in this chat/);
  } finally {
    delete world.env.APP_ORIGIN;
  }
});

test("a streamed group turn texts its progress to the chat, as a text does (2026-10-23)", async () => {
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "progress", args: { text: "Reading the page now." } } }] }, { text: "Done." }]);
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN_GROUP}`, "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ question: "Tex research this link", group: chat() }),
    }),
    world.env,
    ctx,
  );
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  await settle();
  assert.deepEqual(lines.filter((line) => line.progress).map((line) => line.progress), ["Reading the page now."]);
  assert.equal(lines.at(-1).body?.answer ?? lines.at(-1).answer, "Done.", JSON.stringify(lines.at(-1)));
});

/*
  2026-10-24: `tex/groups/` is shared with the workspace only when nothing is
  filed there yet, so a note somebody put there themselves is never widened by
  Tex's first chat. That check listed the bucket by path prefix, and a note's
  bytes live at `notes/<noteId>.md` with its folder in a row, so it found
  nothing however much was in the folder. It reads the tree instead.
*/
test("a note already filed in tex/groups/ stops Tex sharing the folder", async () => {
  const { shareGroupNotesFolder } = await import("../src/agent/groupMemoryNote.js");
  const { PRE_PARSED_RULES, PrivacyOverrides } = await import("../src/privacy/engine.js");
  const held = { rules: [], overrides: new PrivacyOverrides() };
  const holding = (paths) => {
    const shared = [];
    return {
      shared,
      get: async () => ({ etag: "e1", [PRE_PARSED_RULES]: held }),
      // The bucket keys a note by its id, so no key carries the folder's path.
      list: async () => ({ objects: [] }),
      treeManifest: async () => ({ served: true, cursor: null, entries: paths.map((path) => ({ path })) }),
      rowAccess: { setTier: async (path, tier) => (shared.push(`${path}: ${tier}`), { ok: true }) },
    };
  };

  const empty = holding([]);
  assert.equal(await shareGroupNotesFolder(empty), true, "an empty folder is Tex's to share");
  assert.deepEqual(empty.shared, ["tex/groups: team"]);

  const filed = holding(["tex/groups/what ada wrote.md"]);
  assert.equal(await shareGroupNotesFolder(filed), false);
  assert.deepEqual(filed.shared, [], "somebody's own note in the folder is never widened to the workspace");

  const unreachable = holding([]);
  delete unreachable.treeManifest;
  assert.equal(await shareGroupNotesFolder(unreachable), false, "a tree that cannot answer shares nothing");
  assert.deepEqual(unreachable.shared, []);
});

// Tex Devs, 2026-10-26: "redo the diagram" got "the only graphic I made was the Reason Network one".
// The chat's memory kept the words and never the card, so the next turn could not see it.
test("a card sent in a group is kept in the chat's memory with what it showed", async () => {
  const CARD = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
  const SITE_SHOTS = { async fetch(url, init) { const body = JSON.parse(init.body); return new Response(JSON.stringify({ png: CARD, width: body.width, height: body.height, blocked: [] })); } };
  world.model.install([
    { toolCalls: [{ name: "send", args: { action: "draw_visual", args: { template: "places", data: { title: "Budget picks", items: [{ name: "The Eleanor", cuisine: "Bowling bar" }] } } } }] },
    { text: "Here's the night out." },
  ]);
  const env = world.env;
  world.env = { ...env, SITE_SHOTS };
  try {
    const { status, body } = await ask(TOKEN_GROUP, { question: "plan a night out", group: chat() });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.pictures?.length, 1, "the card goes");
  } finally {
    world.env = env;
  }
  const memory = [...world.team.keys()].filter((key) => key.includes("groups")).map((key) => bodyAt(world.team, key) ?? "").join("\n");
  assert.match(memory, /Sent a picture with this answer: 1\. Budget picks — 1\. The Eleanor \(Bowling bar\)/);
});
