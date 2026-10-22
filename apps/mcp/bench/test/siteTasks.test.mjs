/**
 * The website golden tasks end to end (`tests/tasks.md`, questions 6 and 8):
 * a scripted model sets up a site and connects a domain through the
 * production gateway's `write_note` `site`, answered by the benchmark's site
 * (`bench/siteStub.mjs`), and adds the domain's records at the scripted
 * registrar itself. The run's record must then pass the tasks' checks, and a
 * record that published, or handed the records to the person (task 8 before
 * the hand-back rule of 2026-10-22), must fail them.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { createWorld } from "../world.mjs";
import { createWeb, parseSite } from "../sites.mjs";
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

test("connecting the domain the person owns, adding its records and booking its own check passes task 8's checks", async () => {
  const browse = (...steps) => ({ name: "browse", input: { steps } });
  const model = scripted([
    { name: "read_skill", input: { name: "website-domain" } },
    site({ action: "domain", hostname: "mayaruns.com" }),
    // The person named the registrar, not its DNS page: Tex finds it from the home page.
    browse({ do: "goto", url: "https://names.example" }, { do: "click", ref: 4 }, { do: "handoff" }),
    { text: "Sign in to names.example in the link and I'll add the records." },
    browse({ do: "read" }),
    browse({ do: "click", ref: 1 }),
    browse(
      { do: "select", ref: 1, option: "ALIAS" },
      { do: "type", ref: 2, text: "@" },
      { do: "type", ref: 3, text: "customers.context.lc" },
      { do: "click", ref: 4 },
    ),
    {
      name: "write_note",
      input: { path: "tex/routines/once/check-mayaruns.md", content: "---\nat: 2026-10-11 3:00 pm\n---\n\nAsk for mayaruns.com's domain again and text Maya whether the site is live.\n" },
    },
    { text: "The records are in at names.example. I'll check them in an hour and text you once mayaruns.com is live." },
  ]);
  // Production opens the web (`open_web: yes`), so the record value the domain
  // call gave may be typed on her registrar's page after she signed in.
  const openSetup = SETUP.replace("job: texting-assistant\n", "job: texting-assistant\nopen_web: yes\n");
  const world = await createWorld(bench, "Maya", openSetup, { gatewayFetch: model.fetch, sites: await sites(), skills: SKILLS });
  try {
    const first = await world.text("i already own mayaruns.com at names.example, can you put my site on it?");
    assert.ok(first.tools.every((call) => call.ok), JSON.stringify(first.tools) + model.results.join("\n---\n"));
    const records = model.results[1];
    assert.match(records, /domain: mayaruns\.com · waiting for the records/, records);
    assert.match(records, /- missing: type ALIAS, host @, value customers\.context\.lc/);
    assert.match(records, /- missing: type TXT, host _context, value context-verification=/);
    const second = await world.text("Done, I'm signed in");
    assert.ok(second.tools.every((call) => call.ok), JSON.stringify(second.tools) + model.results.slice(-3).join("\n---\n"));

    const record = {
      tools: [...first.tools, ...second.tools].map((call) => call.tool),
      browser: world.browser(),
      changes: world.changes(),
    };
    assert.ok(record.browser.includes("set added dns record"), record.browser.join("\n"));
    const eight = await task(8);
    assert.deepEqual(checkVerdicts(eight, record).filter((v) => !v.pass), [], "every check of task 8 passes on this record");
    // Handing her the records and asking her to text back, the task before 2026-10-22, fails it.
    const handedBack = checkVerdicts(eight, { tools: record.tools, browser: ["connect mayaruns.com"], changes: [] });
    assert.deepEqual(
      handedBack.filter((v) => !v.pass).map((v) => v.line),
      ["reach names.example/dns", "type customers.context.lc", "set added dns record", "write maya/tex/routines/once/"],
    );
  } finally {
    world.close();
  }
});

test("claude.ai's connectors page says one thing at a time, and keeps the Always allow choices", async () => {
  const web = createWeb(await sites());
  const go = async (steps, handoff = false) =>
    (await (await web.binding.fetch("https://site-shots/browse", { method: "POST", body: JSON.stringify({ provider: "browserbase", owner: "o", steps, handoff }) })).json()).page;
  const ref = (page, label) => page.elements.find((e) => e.label === label || e.label.startsWith(`${label} (now:`))?.ref;
  const CONNECTORS = "https://claude.ai/customize/connectors";
  await go([{ do: "goto", url: CONNECTORS }], true);
  web.personSignsIn();

  const fresh = await go([{ do: "read" }]);
  assert.match(fresh.text, /Context is not added yet\./);
  assert.doesNotMatch(fresh.text, /added, not connected|Context: connected/);
  assert.equal(ref(fresh, "Connect"), undefined, "nothing to connect before it is added");

  const modal = await go([{ do: "click", ref: ref(fresh, "Add custom connector") }]);
  await go([
    { do: "type", ref: ref(modal, "Name"), text: "Context" },
    { do: "type", ref: ref(modal, "Remote MCP server URL"), text: "https://mcp.context.lc/mcp" },
  ]);
  const added = await go([{ do: "click", ref: ref(modal, "Add") }]);
  assert.match(added.text, /Context: added, not connected\./);
  assert.doesNotMatch(added.text, /not added yet/, "the page no longer says it is not added");
  assert.ok(ref(added, "Connect"));

  await go([{ do: "click", ref: ref(added, "Connect") }], true);
  web.personSignsIn();
  const consent = await go([{ do: "read" }]);
  const connected = await go([{ do: "click", ref: ref(consent, "Approve") }]);
  assert.match(connected.text, /Context: connected\./);
  assert.doesNotMatch(connected.text, /not added yet|added, not connected/);
  assert.equal(ref(connected, "Connect"), undefined, "no Connect button once connected");

  await go([
    { do: "select", ref: ref(connected, "Read-only tools"), option: "Always allow" },
    { do: "select", ref: ref(connected, "Write/delete tools"), option: "Always allow" },
  ]);
  const reloaded = await go([{ do: "goto", url: CONNECTORS }]);
  assert.deepEqual(
    reloaded.elements.filter((e) => e.kind === "select").map((e) => e.label),
    ["Read-only tools (now: Always allow)", "Write/delete tools (now: Always allow)"],
  );
});
