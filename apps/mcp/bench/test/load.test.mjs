// Tests for bench/load.mjs. The real-data tests read the example folder and skip if it is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandWorkspaces, heldBack, parsePeople, parseTest, readBenchFolder } from "../load.mjs";

const BENCH = process.env.AI_BENCH_DIR ?? "/mnt/project-files/ai-benchmarks/markdown/ai";
const skipReal = existsSync(join(BENCH, "README.md")) ? false : `example folder not found at ${BENCH}`;

const readReal = (rel) => readFile(join(BENCH, rel), "utf8");

// ---- people table ----

test("parsePeople reads the real table", { skip: skipReal }, async () => {
  const people = parsePeople(await readReal("workspaces/people.md"));
  assert.equal(people.length, 12);
  const priya = people.filter((p) => p.person === "Priya");
  assert.equal(priya.length, 6);
  const priyaWs = priya.map((p) => p.workspace);
  assert.ok(priyaWs.includes("fashion-brand"));
  assert.ok(priyaWs.includes("band"));
});

test("parsePeople marks personal workspaces", { skip: skipReal }, async () => {
  const people = parsePeople(await readReal("workspaces/people.md"));
  const mayaPersonal = people.find((p) => p.person === "Maya" && p.workspace === "maya");
  assert.deepEqual(mayaPersonal, { person: "Maya", workspace: "maya", role: "owner", personal: true });
  const mayaBrand = people.find((p) => p.person === "Maya" && p.workspace === "fashion-brand");
  assert.deepEqual(mayaBrand, { person: "Maya", workspace: "fashion-brand", role: "owner", personal: false });
});

test("parsePeople throws on a bad role and names the line", () => {
  const raw = [
    "| Person | Workspace | Role |",
    "|---|---|---|",
    "| Maya | maya (personal) | owner |",
    "| Ana | band | admin |",
  ].join("\n");
  assert.throws(() => parsePeople(raw), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /line 4/);
    assert.match(err.message, /"admin"/);
    return true;
  });
});

test("parsePeople accepts CRLF line endings", () => {
  const raw = "| Person | Workspace | Role |\r\n|---|---|---|\r\n| Sam | sam (personal) | member |\r\n";
  assert.deepEqual(parsePeople(raw), [{ person: "Sam", workspace: "sam", role: "member", personal: true }]);
});

// ---- held-back rules ----

test("heldBack on the fashion-brand privacy file", { skip: skipReal }, async () => {
  const raw = await readReal("workspaces/fashion-brand/privacy.md");
  assert.deepEqual(heldBack(raw), ["people/john.md"]);
});

test("heldBack returns [] for null and empty input", () => {
  assert.deepEqual(heldBack(null), []);
  assert.deepEqual(heldBack(""), []);
  assert.deepEqual(heldBack(undefined), []);
});

test("heldBack ignores bullets outside a Held back section", () => {
  const raw = [
    "# Privacy",
    "- notes/open.md: visible to everyone",
    "",
    "## Held back from members",
    "- people/john.md: owners only",
    "",
    "## Other rules",
    "- notes/later.md: not held back",
  ].join("\n");
  assert.deepEqual(heldBack(raw), ["people/john.md"]);
});

// ---- test files ----

test("parseTest on the real texting-assistant test", { skip: skipReal }, async () => {
  const parsed = parseTest(await readReal("tests/texting-assistant.md"));
  assert.equal(parsed.questions.length, 36);
  assert.equal(parsed.front.runs, 3);
  assert.equal(parsed.front.run_as, "Maya");
  assert.equal(parsed.front.good_enough.score, "80%");

  const q1 = parsed.questions[0];
  assert.equal(q1.n, 1);
  assert.equal(q1.text, "When's my dentist appointment?");
  assert.equal(q1.personStarts, null);

  const q2 = parsed.questions[1];
  assert.equal(q2.n, 2);
  assert.equal(q2.gate, true);
  assert.equal(q2.kind, "back-and-forth");
  assert.equal(q2.personStarts, "Push Lisbon back a month and let Ana know");
  assert.deepEqual(q2.ifAsked, [{ when: "first", say: "Yes, but say the dates aren't final" }]);
  assert.equal(q2.must.length, 3);
  assert.equal(q2.judge.length, 1);
});

test("parseTest reads an as: line", { skip: skipReal }, async () => {
  const parsed = parseTest(await readReal("tests/texting-assistant.md"));
  const q12 = parsed.questions.find((q) => q.n === 12);
  assert.equal(q12.as, "John");
  assert.equal(parsed.questions[0].as, null);
});

test("parseTest on the held-back test", { skip: skipReal }, async () => {
  const parsed = parseTest(await readReal("tests/texting-assistant-held-back.md"));
  assert.equal(parsed.questions.length, 12);
  assert.equal(parsed.questions[11].as, "Priya");
  assert.equal(parsed.questions[10].as, "John");
  assert.equal(parsed.questions[11].personStarts, "Tell Owen I'll call him when he visits in December");
});

test("parseTest without front matter defaults runs to 3", () => {
  const parsed = parseTest("## 1. Hi there\n\n- kind: lookup\n- must: say hi\n");
  assert.deepEqual(parsed.front, { runs: 3 });
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].text, "Hi there");
  assert.equal(parsed.questions[0].kind, "lookup");
  assert.deepEqual(parsed.questions[0].must, ["say hi"]);
  assert.deepEqual(parsed.questions[0].mustNot, []);
  assert.equal(parsed.questions[0].gate, false);
});

test("parseTest reads runs as an integer", () => {
  const parsed = parseTest("---\njob: x\nruns: 5\n---\n\n## 1. Q\n");
  assert.equal(parsed.front.runs, 5);
  assert.equal(parsed.front.job, "x");
});

test("parseTest handles CRLF the same as LF", () => {
  const lf = "---\nrun_as: Maya\n---\n\n## 1. Q\n\n- as: John\n- must not: x\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(parseTest(crlf), parseTest(lf));
  assert.equal(parseTest(crlf).questions[0].as, "John");
});

test("parseTest ignores text before the first numbered heading", () => {
  const raw = "intro\n- must: not a question\n## Notes\n- must: also not\n## 1. Real one\n- must: yes\n";
  const parsed = parseTest(raw);
  assert.equal(parsed.questions.length, 1);
  assert.deepEqual(parsed.questions[0].must, ["yes"]);
});

test("parseTest rejects a non-integer runs value", () => {
  assert.throws(() => parseTest("---\nruns: many\n---\n## 1. Q\n"), /runs/);
});

// ---- whole folder ----

test("readBenchFolder on the real folder", { skip: skipReal }, async () => {
  const bench = await readBenchFolder(BENCH);
  assert.equal(bench.dir, BENCH);
  assert.ok(bench.readme.length > 0);
  assert.equal(bench.people.length, 12);

  const brand = bench.workspaces["fashion-brand"];
  assert.ok(brand, "fashion-brand workspace is loaded");
  assert.ok("people/john.md" in brand.files, "people/john.md is a note");
  assert.ok(!("privacy.md" in brand.files), "privacy.md is parsed, not returned as a note");
  assert.deepEqual(brand.heldBack, ["people/john.md"]);

  assert.ok("health/dentist.md" in bench.workspaces.maya.files);
  assert.deepEqual(bench.workspaces.maya.heldBack, []);

  assert.deepEqual(Object.keys(bench.tests).sort(), ["texting-assistant", "texting-assistant-held-back"]);
  assert.equal(bench.tests["texting-assistant"].questions.length, 36);
  assert.equal(bench.tests["texting-assistant-held-back"].questions.length, 12);
  assert.equal(typeof bench.tests["texting-assistant"].raw, "string");
});

test("readBenchFolder throws when a person names a missing workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-load-"));
  try {
    await writeFile(join(dir, "README.md"), "# Bench\n");
    await mkdir(join(dir, "workspaces"));
    await writeFile(
      join(dir, "workspaces", "people.md"),
      "| Person | Workspace | Role |\n|---|---|---|\n| Ghost | ghost-town | member |\n",
    );
    await mkdir(join(dir, "tests"));
    await assert.rejects(readBenchFolder(dir), /ghost-town/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readBenchFolder reads nested notes with forward-slash paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-load-"));
  try {
    await writeFile(join(dir, "README.md"), "# Bench\n");
    await mkdir(join(dir, "workspaces", "ws", "a", "b"), { recursive: true });
    await writeFile(join(dir, "workspaces", "people.md"), "| Person | Workspace | Role |\n|---|---|---|\n| Al | ws | owner |\n");
    await writeFile(join(dir, "workspaces", "ws", "a", "b", "deep.md"), "deep\n");
    await writeFile(join(dir, "workspaces", "ws", "a", "skip.txt"), "no\n");
    await writeFile(join(dir, "workspaces", "ws", "privacy-rules.md"), "Held back:\n- a/b/deep.md: owners only\n");
    await mkdir(join(dir, "tests"));
    const bench = await readBenchFolder(dir);
    assert.deepEqual(Object.keys(bench.workspaces.ws.files), ["a/b/deep.md"]);
    assert.deepEqual(bench.workspaces.ws.heldBack, ["a/b/deep.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- fluff files ----

const PEOPLE_HEADER = "| Person | Workspace | Role |\n|---|---|---|\n";
const TEMPLATE = "---\ntitle: Standup\n---\n\nStandup {n} on {date}, about {word}.\n";
const FLUFF = "---\ncount: 3\nseed: 1\nfrom: meetings\nname: meeting-{n}.md\n---\n";

/** A benchmark folder in a temp dir, from relative path -> text. Defaults give a valid folder. */
async function benchTree(files) {
  const dir = await mkdtemp(join(tmpdir(), "bench-fluff-"));
  const all = { "README.md": "# Bench\n", "workspaces/people.md": PEOPLE_HEADER, "tests/placeholder.md": "", ...files };
  for (const [rel, text] of Object.entries(all)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const WS_ROW = "| Ana | ws (personal) | owner |\n";

test("fluff.md is read as a fluff file and never served as a note", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/meetings/fluff.md": FLUFF,
    "workspaces/ws/meetings/real.md": "real\n",
    "workspaces/ws/fluff.md": "---\ncount: 1\nseed: 2\nfrom: meetings\nname: root-{n}.md\n---\n",
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    const bench = await readBenchFolder(dir);
    assert.deepEqual(Object.keys(bench.workspaces.ws.files), ["meetings/real.md"]);
    assert.deepEqual(
      bench.workspaces.ws.fluff.map((f) => [f.dir, f.fluff.count, f.fluff.name]),
      [
        ["", 1, "root-{n}.md"],
        ["meetings", 3, "meeting-{n}.md"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("_bank holds the templates and is not a workspace", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/real.md": "real\n",
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
    "workspaces/_bank/meetings/notes.txt": "not a template\n",
  });
  try {
    const bench = await readBenchFolder(dir);
    assert.deepEqual(Object.keys(bench.workspaces), ["ws"]);
    assert.deepEqual(bench.bank, { meetings: { "standup.md": TEMPLATE } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("people.md cannot name _bank as a workspace", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + "| Ghost | _bank | member |\n",
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    await assert.rejects(readBenchFolder(dir), /_bank.*not a workspace/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fluff file naming a missing template folder is refused, and says where", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/meetings/fluff.md": FLUFF.replace("from: meetings", "from: nope"),
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    await assert.rejects(readBenchFolder(dir), /workspaces\/ws\/meetings\/fluff\.md.*_bank\/nope\//);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a template folder name is looked up as a folder, not as an object property", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/meetings/fluff.md": FLUFF.replace("from: meetings", "from: constructor"),
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    await assert.rejects(readBenchFolder(dir), /_bank\/constructor\/ does not exist/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed fluff file is refused with its path and line", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/meetings/fluff.md": FLUFF.replace("count: 3", "count: 50001"),
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    await assert.rejects(readBenchFolder(dir), /workspaces\/ws\/meetings\/fluff\.md line 2: count 50001 is over the 50,000 limit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expandWorkspaces adds the generated notes and leaves the loaded bench as it was", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/meetings/fluff.md": FLUFF,
    "workspaces/ws/meetings/real.md": "real\n",
    "workspaces/ws/plain.md": "plain\n",
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    const bench = await readBenchFolder(dir);
    const expanded = expandWorkspaces(bench);
    const files = expanded.workspaces.ws.files;
    assert.deepEqual(expanded.workspaces.ws.generated, ["meetings/meeting-1.md", "meetings/meeting-2.md", "meetings/meeting-3.md"]);
    assert.deepEqual(Object.keys(files).sort(), ["meetings/meeting-1.md", "meetings/meeting-2.md", "meetings/meeting-3.md", "meetings/real.md", "plain.md"]);
    assert.match(files["meetings/meeting-1.md"], /^---\nupdated: 2026-01-01\ntitle: Standup\n---\n\nStandup 1 on 2026-01-01, about [a-z]+\.\n$/);
    assert.ok(!("meetings/fluff.md" in files), "fluff.md is not a note");
    assert.deepEqual(Object.keys(bench.workspaces.ws.files), ["meetings/real.md", "plain.md"], "the loaded bench is not changed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expandWorkspaces writes the same notes every time", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/meetings/fluff.md": "---\ncount: 30\nseed: 5\nfrom: meetings\nname: meeting-{date}.md\ndates: 2026-01-05 to 2026-10-01\n---\n",
    "workspaces/ws/meetings/real.md": "real\n",
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    const bench = await readBenchFolder(dir);
    assert.equal(JSON.stringify(expandWorkspaces(bench).workspaces), JSON.stringify(expandWorkspaces(bench).workspaces));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("expandWorkspaces refuses a generated note that would overwrite a hand-written one", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/meetings/fluff.md": FLUFF,
    "workspaces/ws/meetings/meeting-2.md": "mine\n",
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    const bench = await readBenchFolder(dir);
    assert.throws(() => expandWorkspaces(bench), /meetings\/meeting-2\.md would overwrite a hand-written note/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a distractor copy of a held-back note is held back too", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/privacy.md": "Held back from members\n- people/john.md: owners only\n",
    "workspaces/ws/people/john.md": "John's pay\n",
    "workspaces/ws/people/fluff.md": "---\ncount: 1\nseed: 1\nfrom: meetings\nname: m-{n}.md\n---\n\n## Distractors\n\n- older copy of john.md as john-old.md dated 2026-03-02\n",
    "workspaces/_bank/meetings/standup.md": TEMPLATE,
  });
  try {
    const expanded = expandWorkspaces(await readBenchFolder(dir));
    assert.ok("people/john-old.md" in expanded.workspaces.ws.files);
    assert.deepEqual(expanded.workspaces.ws.heldBack, ["people/john.md", "people/john-old.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a workspace with no fluff expands to itself", async () => {
  const dir = await benchTree({
    "workspaces/people.md": PEOPLE_HEADER + WS_ROW,
    "workspaces/ws/real.md": "real\n",
  });
  try {
    const expanded = expandWorkspaces(await readBenchFolder(dir));
    assert.deepEqual(expanded.workspaces.ws.files, { "real.md": "real\n" });
    assert.deepEqual(expanded.workspaces.ws.generated, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
