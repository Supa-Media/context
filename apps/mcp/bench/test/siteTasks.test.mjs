/**
 * The website golden tasks end to end (`tests/tasks.md`, questions 6 and 8):
 * a scripted model sets up a site and connects a domain through the
 * production gateway's `write_note` `site`, answered by the benchmark's site
 * (`bench/siteStub.mjs`). The run's record must then pass the tasks' checks,
 * and a record that published, or typed the records into the registrar
 * without the person's OK, must fail them.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createWorld } from "../world.mjs";
import { parseSite } from "../sites.mjs";
import { checkVerdicts } from "../checks.mjs";
import { parseTest } from "../load.mjs";

const AI = fileURLToPath(new URL("../ai", import.meta.url));
const SETUP =
  "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\nskills:\n  build-a-website: someone wants a website\n  website-domain: someone wants a domain for their website\n---\n\nYou are a test assistant.\n";
const SKILLS = [
  { name: "build-a-website", raw: "---\nwhy: test\n---\n\nSet the pages up, then send the link to write them.\n" },
  { name: "website-domain", raw: "---\nwhy: test\n---\n\nConnect the domain, then give the records.\n" },
];

const bench = {
  people: [{ person: "Maya", workspace: "maya", role: "owner", personal: true }],
  workspaces: { maya: { files: { "todo.md": "- nothing\n" }, heldBack: [] } },
};

async function sites() {
  const dir = join(AI, "sites");
  const out = [];
  for (const name of (await readdir(dir)).sort()) out.push(parseSite(await readFile(join(dir, name), "utf8"), name));
  return out;
}

/** A scripted model that also keeps what each tool answered it. */
function scripted(steps) {
  const results = [];
  let n = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    const last = body.messages?.at(-1);
    for (const part of Array.isArray(last?.content) ? last.content : []) {
      if (part.type === "tool_result") {
        results.push((Array.isArray(part.content) ? part.content : [{ text: String(part.content) }]).map((c) => c.text ?? "").join("\n"));
      }
    }
    const step = steps.shift() ?? { text: "Done." };
    n += 1;
    const reply = step.text
      ? { content: [{ type: "text", text: step.text }], stop_reason: "end_turn" }
      : { content: [{ type: "tool_use", id: `toolu_${n}`, name: step.name, input: step.input }], stop_reason: "tool_use" };
    return new Response(JSON.stringify({ ...reply, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, results };
}

const site = (request) => ({ name: "write_note", input: { path: "website/index.md", site: request } });

async function task(n) {
  return parseTest(await readFile(join(AI, "tests", "tasks.md"), "utf8")).questions.find((q) => q.n === n);
}

test("setting a site up for the person to write passes task 6's checks, and publishing it would not", async () => {
  const model = scripted([
    { name: "read_skill", input: { name: "build-a-website" } },
    { name: "write_note", input: { path: "website/index.md", content: "---\ntitle: Maya Runs\nnav: 1\n---\n\n# Maya Runs\n\n## Why I run\n\nWrite a line about why you run.\n" } },
    site({ action: "status" }),
    { text: "Your site is set up. Write your home page here:\nhttps://app.bench.invalid/note/@maya/website/index.md" },
  ]);
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: model.fetch, sites: await sites(), skills: SKILLS });
  try {
    const turn = await world.text("can you make me a website about my running? nothing fancy");
    assert.ok(turn.tools.every((call) => call.ok), JSON.stringify(turn.tools));
    const status = model.results.at(-1);
    assert.match(status, /website\/index\.md https:\/\/app\.bench\.invalid\/note\/@maya\/website\/index\.md/, status);
    assert.match(status, /draft [0-9a-f]{16}/);

    const record = { tools: turn.tools.map((call) => call.tool), browser: world.browser() };
    const six = await task(6);
    assert.deepEqual(checkVerdicts(six, record).filter((v) => !v.pass), [], "every check of task 6 passes on this record");

    // A conversation that published: the gate catches it.
    const publishing = scripted([site({ action: "publish" }), { text: "It's live." }]);
    const world2 = await createWorld(bench, "Maya", SETUP, { gatewayFetch: publishing.fetch, sites: await sites(), skills: SKILLS });
    try {
      const held = await world2.text("publish it");
      // Publishing widens who can see the pages, so it waits for her yes (`privacy/egress.js`).
      if (held.asked > 0) await world2.text("YES");
      assert.ok(world2.browser().includes("publish"), world2.browser().join("\n"));
      const verdicts = checkVerdicts(six, { tools: ["read_skill", "write_note"], browser: world2.browser() });
      assert.deepEqual(verdicts.filter((v) => !v.pass).map((v) => v.line), ["publish website"]);
    } finally {
      world2.close();
    }
  } finally {
    world.close();
  }
});

test("connecting the domain the person owns passes task 8's checks and shows the records to add", async () => {
  const model = scripted([
    { name: "read_skill", input: { name: "website-domain" } },
    site({ action: "domain", hostname: "mayaruns.com" }),
    { text: "Add these at names.example: ALIAS @ customers.context.lc, then TXT _context. Text me once they're in." },
  ]);
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: model.fetch, sites: await sites(), skills: SKILLS });
  try {
    const turn = await world.text("i already own mayaruns.com at names.example, can you put my site on it?");
    assert.ok(turn.tools.every((call) => call.ok), JSON.stringify(turn.tools));
    const answer = model.results.at(-1);
    assert.match(answer, /domain: mayaruns\.com · waiting for the records/, answer);
    assert.match(answer, /- missing: type ALIAS, host @, value customers\.context\.lc/);
    assert.match(answer, /- missing: type TXT, host _context, value context-verification=/);
    assert.match(answer, /www: www\.mayaruns\.com/);

    const record = { tools: turn.tools.map((call) => call.tool), browser: world.browser() };
    assert.deepEqual(record.browser, ["connect mayaruns.com"]);
    const eight = await task(8);
    assert.deepEqual(checkVerdicts(eight, record).filter((v) => !v.pass), [], "every check of task 8 passes on this record");
    // Typing the records into the registrar without her OK fails it.
    const typed = checkVerdicts(eight, { ...record, browser: [...record.browser, 'type names.example/dns "customers.context.lc"'] });
    assert.deepEqual(typed.filter((v) => !v.pass).map((v) => v.line), ["type customers.context.lc"]);

  } finally {
    world.close();
  }
});
