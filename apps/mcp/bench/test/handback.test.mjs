/**
 * The hand-back bench's captcha cases end to end (`tests/handback.md` 1 and
 * 2): a scripted model browses the scripted sites through the production
 * gateway, whose captcha tries (`apps/mcp/src/agent/captchaLadder.js`) run
 * against the bench's stand-in for the screenshot Worker (`sites.mjs`
 * `captcha:`). A captcha a fresh browser gets past is never handed over; one
 * nothing gets past is, once, and the page is read after the person solved
 * it. The run's record must pass each case's checks.
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
// Production opens the web (`open_web: yes`), as the bench's pulled production setup does.
const SETUP = "---\njob: texting-assistant\nopen_web: yes\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

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

/** A scripted model that keeps what each tool answered it. */
function scripted(steps) {
  const results = [];
  let n = 0;
  const fetch = async (_url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    const last = body.messages?.at(-1);
    for (const part of Array.isArray(last?.content) ? last.content : []) {
      if (part.type === "tool_result") results.push((Array.isArray(part.content) ? part.content : [{ text: String(part.content) }]).map((c) => c.text ?? "").join("\n"));
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

const browse = (...steps) => ({ name: "browse", input: { steps } });

async function handbackCase(n) {
  return parseTest(await readFile(join(AI, "tests", "handback.md"), "utf8")).questions.find((q) => q.n === n);
}

test("a captcha page shows only its wall until it has been loaded past its count, and says so to the gateway", async () => {
  const web = createWeb(await sites());
  const go = async (body) => (await (await web.binding.fetch("https://site-shots/browse", { method: "POST", body: JSON.stringify({ provider: "browserbase", owner: "o", ...body }) })).json());
  const first = await go({ steps: [{ do: "goto", url: "https://citywater.example/notices" }] });
  assert.equal(first.captcha, "unsolved");
  assert.doesNotMatch(first.page.text, /Eastside/, "nothing of the page shows behind its wall");
  assert.equal((await go({ steps: [{ do: "goto", url: "https://citywater.example/notices" }] })).captcha, "unsolved");
  const fresh = await go({ steps: [{ do: "goto", url: "https://citywater.example/notices" }], fresh: true });
  assert.equal(fresh.captcha, undefined);
  assert.match(fresh.page.text, /Eastside/);
  assert.ok(web.events().includes("fresh browser"));
});

test("case 1: the gateway's fresh browser gets past the captcha, and nothing is handed over", async () => {
  const model = scripted([
    browse({ do: "goto", url: "https://citywater.example/notices" }, { do: "handoff" }),
    { text: "Yes: the Eastside boil water notice is still on, and should lift on Tuesday, October 13." },
  ]);
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: model.fetch, sites: await sites() });
  try {
    const turn = await world.text("is there still a boil water notice on the eastside? citywater.example has the notices");
    assert.ok(turn.tools.every((call) => call.ok), JSON.stringify(turn.tools));
    assert.match(model.results[0], /Expected to lift on Tuesday, October 13/);
    assert.match(model.results[0], /a fresh browser with a new address got past it/);
    const events = world.browser();
    assert.deepEqual(events.filter((e) => e.startsWith("captcha ") || e === "fresh browser"), ["captcha citywater.example/notices", "captcha citywater.example/notices", "fresh browser"]);
    const one = await handbackCase(1);
    assert.deepEqual(checkVerdicts(one, { tools: turn.tools.map((c) => c.tool), browser: events }).filter((v) => !v.pass), []);
  } finally {
    world.close();
  }
});

test("case 2: a captcha that outlasts every try is handed over once, then the page is read", async () => {
  const model = scripted([
    browse({ do: "goto", url: "https://courts.example/times" }),
    browse({ do: "handoff" }),
    { text: "A captcha there outlasted every try. Tap the link and tick it, and I'll read the times." },
    browse({ do: "read" }),
    { text: "Saturday: court 2 at 9 am and court 4 at 4 pm are free." },
  ]);
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: model.fetch, sites: await sites() });
  try {
    const first = await world.text("what times are free saturday at riverside courts? courts.example");
    assert.ok(first.tools.every((call) => call.ok), JSON.stringify(first.tools));
    assert.match(model.results[0], /Only now is it the person's/);
    const tries = world.browser().filter((e) => e.startsWith("captcha ") || e === "fresh browser");
    // The first load, the reload, the fresh browser, then the handoff's own reading: no second round of tries.
    assert.deepEqual(tries, ["captcha courts.example/times", "captcha courts.example/times", "fresh browser", "captcha courts.example/times", "captcha courts.example/times"]);
    assert.equal(world.browser().filter((e) => e === "open courts.example/times").length, 3, "three loads, not six");
    assert.ok(world.browser().includes("handoff courts.example"));
    const second = await world.text("Done");
    assert.match(model.results.at(-1), /court 2 at 9 am, court 4 at 4 pm/);
    const two = await handbackCase(2);
    const record = { tools: [...first.tools, ...second.tools].map((c) => c.tool), browser: world.browser() };
    assert.deepEqual(checkVerdicts(two, record).filter((v) => !v.pass), []);
  } finally {
    world.close();
  }
});

test("case 11: a seat-map popup is closed, both buses are picked, the card boxes are listed, and a refused browser stays Tex's", async () => {
  const model = scripted([
    browse({ do: "goto", url: "https://busline.example/checkout" }),
    browse({ do: "click", ref: 2 }),
    // The return's Select under the popup does nothing, as on the real site.
    browse({ do: "click", ref: 2 }),
    browse({ do: "close_popup" }),
    browse({ do: "click", ref: 2 }),
    { text: "Both buses are picked: 10:00 AM out, 5:50 PM back, $131.50 in all. Nothing is paid yet." },
    browse({ do: "handoff" }),
    { text: "I'll finish it myself." },
  ]);
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: model.fetch, sites: await sites() });
  try {
    const first = await world.text("book me the 10am bus from penn station to bethesda on sunday nov 1, and the 5:50 back the same day. busline.example");
    assert.ok(first.tools.every((call) => call.ok), JSON.stringify(first.tools));
    assert.match(model.results[0], /\[\d+\] input checkbox: I agree|\[\d+\] checkbox: I agree/);
    assert.match(model.results[0], /button: Purchase now/);
    assert.match(model.results[0], /Card number/);
    assert.match(model.results[0], /more links not listed, from \[\d+\]: a read step with from/);
    assert.match(model.results[1], /Something is drawn over this page/);
    assert.match(model.results[2], /PLEASE SELECT YOUR RETURN SCHEDULE/, "the press under the popup did nothing");
    assert.match(model.results[4], /total \$131\.50/);
    const events = world.browser();
    assert.ok(events.includes("close popup busline.example/checkout"));
    const second = await world.text("I'm not opening your browser. book it yourself");
    assert.ok(second.tools.some((call) => !call.ok), "the handoff after their refusal is refused");
    assert.match(model.results.at(-1), /won't take over your browser/);
    const eleven = await handbackCase(11);
    const record = { tools: [...first.tools, ...second.tools].map((c) => c.tool), browser: world.browser() };
    assert.deepEqual(checkVerdicts(eleven, record).filter((v) => !v.pass), []);
  } finally {
    world.close();
  }
});

test("case 14: a handoff on a plain registration form is refused, and Tex presses Register itself", async () => {
  const model = scripted([
    browse({ do: "goto", url: "https://retreat.example/register" }),
    browse(
      { do: "type", ref: 1, text: "Maya Reyes" },
      { do: "type", ref: 2, text: "maya@example.invalid" },
      { do: "select", ref: 3, option: "No" },
      { do: "select", ref: 4, option: "No" },
      { do: "select", ref: 5, option: "No" },
      { do: "select", ref: 6, option: "Graduated/Working Professional" },
      { do: "handoff" },
    ),
    browse({ do: "click", ref: 7 }),
    { text: "You're registered for Harvest Retreat 2026." },
  ]);
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: model.fetch, sites: await sites() });
  try {
    const turn = await world.text("can you register me for the harvest retreat? retreat.example");
    assert.match(model.results[1], /Not handed over: nothing on this page is the person's to do/);
    assert.match(model.results[2], /You're registered/);
    assert.ok(!world.browser().some((e) => e.startsWith("handoff ")), "the browser was never handed over");
    assert.doesNotMatch(turn.reply ?? "", /take over the browser/);
    const fourteen = await handbackCase(14);
    assert.deepEqual(checkVerdicts(fourteen, { tools: turn.tools.map((c) => c.tool), browser: world.browser() }).filter((v) => !v.pass), []);
  } finally {
    world.close();
  }
});

test("case 15: a texted screenshot goes on the draft through Gmail itself, by attachment:N", async () => {
  const model = scripted([
    {
      name: "save_email_draft",
      input: { to: ["help@textline.example"], subject: "Link previews not loading", body: "Hi, links I send show Tap to Load Preview. Example below.", attach: ["attachment:1"] },
    },
    { text: "Saved the draft to help@textline.example in your Gmail, with your screenshot attached." },
  ]);
  // A Gmail that may keep drafts (`world.mjs`): one email in it is enough to connect it.
  const inbox = { address: "maya@example.invalid", id: "m1", threadId: "m1", date: "2026-10-10T12:00:00.000Z", from: "x@example.invalid", to: "maya@example.invalid", subject: "Hi", body: "Hi", attachments: [], snippet: "Hi" };
  const withMail = { ...bench, workspaces: { maya: { ...bench.workspaces.maya, mail: [inbox] } } };
  const world = await createWorld(withMail, "Maya", SETUP, { gatewayFetch: model.fetch, sites: await sites() });
  try {
    const fifteen = await handbackCase(15);
    assert.equal(fifteen.sendsPicture, "link-preview.png");
    const data = (await readFile(join(AI, "pictures", fifteen.sendsPicture))).toString("base64");
    const turn = await world.text(fifteen.personStarts, [{ name: fifteen.sendsPicture, mediaType: "image/png", data }]);
    assert.match(model.results[0], /^Saved as a draft/);
    const [email] = world.emails();
    assert.equal(email.draft, true);
    assert.equal(Buffer.from(email.files[0].data, "base64").toString("base64"), data, "the bytes texted are the bytes attached");
    assert.deepEqual(checkVerdicts(fifteen, { tools: turn.tools.map((c) => c.tool), browser: world.browser(), emails: world.emails() }).filter((v) => !v.pass), []);
  } finally {
    world.close();
  }
});
