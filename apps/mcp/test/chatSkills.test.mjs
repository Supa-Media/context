/**
 * A GROUP CHAT KEEPS LEARNED SKILLS IN ITS HOME, AS A PERSON'S TEX KEEPS tex/skills/ (the owner, 2026-11-01 and
 * 2026-11-02: the people in a chat are inside it; `src/agent/chatSkills.js`).
 *
 * ## Sabotage record
 *
 *   `withChatSkills` without the `outside()` check → "a turn that read a page writes no skill" fails
 *   `touchesChatSkills` by raw prefix → "however it is spelled" fails
 *   `markChatWords` setting `outside` → "the chat's own words are not outside" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chatSkillsFolder, chatSkillsPrompt, openChatSkills, touchesChatSkills, withChatSkills } from "../src/agent/chatSkills.js";
import { homePrompt } from "../src/agent/chatHome.js";
import { markChatWords, markUntrusted, newLedger, recordRead } from "../src/privacy/egress.js";

const FOLDER = "tex/groups/orbit-lamp-river";
const SKILL = (name, when = "they want the hours totalled") => `---\nname: ${name}\nwhen: ${when}\nupdated: 2026-11-02\n---\n\n1. Read the sheet.\n2. Total by client.\n`;

function fakeHome(notes = {}) {
  const files = new Map(Object.entries(notes));
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_notes") {
      const lines = [...files.keys()].filter((key) => key.startsWith(args.prefix)).sort();
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    if (name === "read_note") {
      if (!files.has(args.path)) return { isError: true, content: [{ type: "text", text: "not found" }] };
      return { content: [{ type: "text", text: `etag: e-${args.path}\n\n${files.get(args.path)}` }] };
    }
    return { isError: true, content: [{ type: "text", text: "unexpected" }] };
  };
  return { home: { folder: FOLDER, dispatch }, files, calls };
}

const ok = { content: [{ type: "text", text: "written" }] };

test("the home keeps its skills by the name a person's Tex folder gives them", () => {
  assert.equal(chatSkillsFolder({ folder: FOLDER }), `${FOLDER}/skills`);
});

test("a path under the home's skills is seen however it is spelled, and nothing beside it", () => {
  const home = { folder: FOLDER };
  for (const path of [`${FOLDER}/skills/a.md`, `/${FOLDER}//skills/./a.md`, `TEX/Groups/orbit-lamp-river/Skills/a.md`, `@context-lc/${FOLDER}/skills`, `${FOLDER}/skills`]) {
    assert.equal(touchesChatSkills(home, path), true, path);
  }
  for (const path of [`${FOLDER}/skillset/a.md`, "tex/groups/orbit-lamp/skills/a.md", `${FOLDER}/jobs.md`, "tex/skills/a.md"]) {
    assert.equal(touchesChatSkills(home, path), false, path);
  }
});

test("the turn is told of the chat's skills, read from its home, and reads one there", async () => {
  const { home } = fakeHome({ [`${FOLDER}/skills/total-hours.md`]: SKILL("total-hours"), [`${FOLDER}/jobs.md`]: "- [x](@a/x.md)\n" });
  const learned = await openChatSkills({ home });
  assert.deepEqual(learned.index.map((entry) => entry.name), ["total-hours"]);
  assert.match(learned.tools[0].description, /this chat's folder, tex\/groups\/orbit-lamp-river\/skills\//);
  const read = await withChatSkills({ home }, learned, async () => ok, { outside: () => false })("read_learned_skill", { name: "total-hours" });
  assert.match(read.content[0].text, /Total by client/);
  assert.deepEqual([...learned.used], ["total-hours"]);
});

test("a chat with no home has no skills, and its calls pass as they are", async () => {
  assert.equal(await openChatSkills({}), null);
  const callTool = async () => ok;
  assert.equal(withChatSkills({}, null, callTool, { outside: () => true }), callTool);
  assert.equal(chatSkillsPrompt({}), "");
});

test("a skill is written in the home by the person's Tex's rules", async () => {
  const { home } = fakeHome();
  const passed = [];
  const call = withChatSkills({ home }, null, async (name, args) => (passed.push({ name, args }), ok), { outside: () => false });
  const path = `${FOLDER}/skills/total-hours.md`;
  assert.equal((await call("write_note", { context: "@context-lc", path, content: SKILL("total-hours") })).isError, undefined);
  assert.equal(passed.length, 1);
  const wrongName = await call("write_note", { context: "@context-lc", path, content: SKILL("other") });
  assert.match(wrongName.content[0].text, /name in the front matter must be the file's/);
  const nested = await call("write_note", { context: "@context-lc", path: `${FOLDER}/skills/deep/x.md`, content: SKILL("x") });
  assert.match(nested.content[0].text, /A skill is one note at tex\/groups\/orbit-lamp-river\/skills\/<name>\.md/);
  for (const name of ["append_note", "move_note", "archive_note"]) {
    const refused = await call(name, { context: "@context-lc", path, source: path, destination: "notes/x.md" });
    assert.equal(refused.isError, true, name);
  }
  assert.equal(passed.length, 1, "only the one good write reached the store");
  // Anything else passes untouched.
  await call("write_note", { context: "@context-lc", path: `${FOLDER}/jobs.md`, content: "- none\n" });
  assert.equal(passed.length, 2);
});

test("a turn that read a page writes no skill", async () => {
  const { home } = fakeHome();
  let reached = false;
  const call = withChatSkills({ home }, null, async () => ((reached = true), ok), { outside: () => true });
  const refused = await call("write_note", { context: "@context-lc", path: `${FOLDER}/skills/total-hours.md`, content: SKILL("total-hours") });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /outside this chat/);
  assert.equal(reached, false);
});

test("the chat's own words are not outside it; a page, a mail or a file is", () => {
  const chat = newLedger();
  markChatWords(chat);
  assert.equal(chat.untrusted, true, "its sends stay held");
  assert.equal(chat.outside, false);
  const page = newLedger();
  markChatWords(page);
  markUntrusted(page);
  assert.equal(page.outside, true);
  const mail = newLedger();
  recordRead(mail, { name: "read_contact", args: {}, result: ok });
  assert.equal(mail.untrusted && mail.outside, true);
});

test("the home's words tell the turn where its skills go", () => {
  const { home } = fakeHome();
  const words = homePrompt({ home });
  assert.match(words, /Skills\. After a hard job here/);
  assert.match(words, /tex\/groups\/orbit-lamp-river\/skills\/<name>\.md/);
});
