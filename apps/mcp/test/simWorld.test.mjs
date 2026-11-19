/**
 * The simulated world a Dev test runs in (`bench/simWorld.mjs`; Dev2, 2026-11-17: "we should be mocking google
 * calendar calls and all the other tool calls it may use, modeling these apis"). A model plays the outside services
 * the fixtures have nothing for, from the chat's setting and the chat a person would see, never the test's labels.
 *
 * Sabotage: answering a scripted page from the model, dropping the memo, or showing the world the test's must lines
 * fails these.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSimWorld, worldSchema, jsonIn, simBinding, simMemo, simSystem, simulateFor, simulateServices, sitesIn } from "../bench/simWorld.mjs";
import { benchCalendar } from "../bench/calendar.mjs";
import { frontFor } from "../bench/setsFd.mjs";
import { parseTest } from "../bench/load.mjs";

const BENCH = new URL("../bench/ai", import.meta.url).pathname;

/** A model that answers each call kind with `answers[kind]`, counting what it was asked. */
function scriptedSend(answers) {
  const asked = [];
  const send = async (body) => {
    const request = JSON.parse(body);
    asked.push(request);
    const kind = /^Call: (.+)$/m.exec(request.messages[0].content)[1];
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answers[kind] ?? {}) }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  };
  return { send, asked };
}

const json = (body) => ({ method: "POST", body: JSON.stringify(body) });

test("the world sees the setting and the chat, with thinking off and its answer shape as a schema, and the same ask is answered once a run", async () => {
  const { send, asked } = scriptedSend({ "web search": { results: [{ title: "Chicago weather", url: "https://weather.example/chicago", description: "Low 48" }] } });
  const memo = simMemo();
  const setting = "Three flatmates in Chicago; Tex has the web.";
  const chat = [{ who: "John", text: "Tex what was the low last night" }];
  const one = createSimWorld({ send, setting, chat, today: "2026-07-01", person: "John", memo });
  const two = createSimWorld({ send, setting, chat, today: "2026-07-01", person: "John", memo });
  const results = await one.search("chicago low last night");
  assert.equal(results[0].url, "https://weather.example/chicago");
  assert.deepEqual(await two.search("chicago low last night"), results, "a second world of the run gets the same answer");
  assert.equal(asked.length, 1, "asked once");
  // Haiku 5.5 has no seed and temperature is omitted as Anthropic advises: the world is pinned by structure instead.
  assert.equal("temperature" in asked[0], false);
  assert.deepEqual(asked[0].thinking, { type: "disabled" });
  assert.deepEqual(asked[0].output_config, { format: { type: "json_schema", schema: worldSchema("web search") } });
  assert.match(asked[0].system, /Setting: Three flatmates in Chicago/);
  assert.match(asked[0].system, /John: Tex what was the low last night/);
  assert.match(asked[0].system, /Today is 2026-07-01/);
  assert.equal(memo.calls, 1);
});

test("a run with no model answers with nothing rather than failing", async () => {
  const world = createSimWorld({ send: null, setting: "x" });
  assert.deepEqual(await world.search("anything"), []);
  assert.deepEqual(await world.calendarDays({ date: "2026-07-03" }), { ok: true, days: [] });
  assert.equal((await world.read({ url: "https://a.example" })).body.page.title, "Page didn't load");
  assert.equal(jsonIn("no json here"), null);
});

test("the world is told to answer the literal request, and nothing exists because a request assumes it", () => {
  const system = simSystem({ setting: "s", chat: [] });
  assert.match(system, /Answer the literal request/);
  assert.match(system, /Nothing else exists just because a request assumes it/);
  assert.doesNotMatch(system, /is confirmed/, "the world never promises an action worked");
});

test("no field of a question but the chat and its text reaches the world", () => {
  const sentinel = "LABEL-SENTINEL";
  const question = { text: "hi", earlier: [{ from: "person", text: "before" }], body: sentinel, musts: [sentinel], mustNots: [sentinel], must: sentinel, never: sentinel, labels: { fd: { must: [sentinel] } }, ifAsked: [sentinel], checks: [sentinel], want: sentinel, title: sentinel };
  const sim = simulateFor({ world: "simulated", world_setting: "s" }, question, "Remi", { memo: simMemo() });
  assert.doesNotMatch(JSON.stringify(sim) + simSystem(sim), new RegExp(sentinel));
});

test("the world is shown the chat a person sees, never the test's must lines", () => {
  const question = { text: "Tex put friday 7pm house dinner on the calendar", earlier: [{ from: "person", who: "priya", text: "friday works" }, { from: "tex", text: "Logged." }], body: "- must: the reaction is enough" };
  const sim = simulateFor({ world: "simulated", world_setting: '"Flatmates; Tex has the shared calendar."' }, question, "John", { send: null, memo: simMemo() });
  assert.equal(sim.setting, "Flatmates; Tex has the shared calendar.");
  assert.deepEqual(sim.chat, [{ who: "priya", text: "friday works" }, { who: "Tex", text: "Logged." }, { who: "John", text: "Tex put friday 7pm house dinner on the calendar" }]);
  assert.doesNotMatch(simSystem({ setting: sim.setting, chat: sim.chat }), /must|reaction is enough/);
  assert.equal(simulateFor({}, question, "John", { memo: simMemo() }), null, "only a test that asks for it");
});

test("a Dev test's front matter asks for the simulated world with its setting, and the bench reads it back", async () => {
  const setting = 'Priya, John and Kofi share a flat. The group has Tex, with "the shared calendar" and the web.';
  const front = await frontFor(BENCH, "John", { today: "2026-10-13", calendar: true, setting });
  assert.match(front, /^world: simulated$/m);
  const parsed = parseTest(`---\n${front}\n---\n\n# T\n\n## 1. hi\n\n- person texts: "hi"\n`);
  assert.equal(parsed.front.world, "simulated");
  assert.equal(simulateFor(parsed.front, { text: "hi" }, "John", { memo: simMemo() }).setting, setting);
  assert.doesNotMatch(await frontFor(BENCH, "John", { today: "2026-10-13" }), /^world: /m, "no setting, no simulated world");
});

test("a connected calendar answers from its fixture's days, and the world plays the days it has nothing for", async () => {
  const { send } = scriptedSend({ "google calendar days": { days: [{ date: "2026-07-03", events: [{ start: "19:00", end: "21:00", title: "House dinner" }] }] } });
  const sim = createSimWorld({ send, setting: "flat" });
  const flags = benchCalendar([{ date: "2026-07-01", address: "john@example.invalid", text: "### 09:00 · Gym" }], "John");
  simulateServices(sim, { flags }, { connectedCalendar: true });
  assert.equal(flags.calendarAddress, "john@example.invalid", "changes still go to their own calendar");
  assert.match((await flags.calendarDays({ date: "2026-07-01" })).days[0].text, /Gym/, "the fixture's day stays the fixture's");
  const played = await flags.calendarDays({ date: "2026-07-03" });
  assert.equal(played.days[0].address, "john@example.invalid");
  assert.match(played.days[0].text, /19:00–21:00 · House dinner/);
  // A week's read with one fixture day: the world's days fill the rest, in date order (Dev set, 2026-11-17).
  const week = await flags.calendarDays({ date: "2026-07-01", days: 7 });
  assert.deepEqual(week.days.map((day) => day.date), ["2026-07-01", "2026-07-03"]);
  assert.match(week.days[0].text, /Gym/, "the fixture's day stays the fixture's");
});

test("Gmail answers with the fixture's mail first and the world's after it, each readable", async () => {
  const { send } = scriptedSend({
    "gmail search": { results: [{ id: "w1", date: "2026-10-01T10:00:00Z", from: "Ines <ines@wedding.example>", to: "remi@example.invalid", subject: "Wedding site login", snippet: "password: ..." }] },
    "gmail read": { body: "Hi Remi, the wedding site is paulo-and-ines.example, password lisbon24." },
  });
  const sim = createSimWorld({ send, setting: "Tex has Gmail" });
  const flags = { mailboxes: [{ address: "remi@example.invalid", folder: "0-inbox/email" }], mailResults: (q) => (q === "dentist" ? [{ id: "d1", address: "remi@example.invalid" }] : []), mailMessage: () => null };
  simulateServices(sim, { flags });
  assert.deepEqual((await flags.mailResults("dentist")).map((r) => r.id), ["d1", "w1"], "the fixture's own mail first, and a fixture hit no longer hides the world's");
  const [found] = await flags.mailResults("wedding login");
  assert.equal(found.subject, "Wedding site login");
  assert.equal(found.address, "remi@example.invalid", "in the person's own inbox");
  const read = await flags.mailMessage({ address: "remi@example.invalid", id: "w1" });
  assert.match(read.body, /password lisbon24/);
  assert.equal(await flags.mailMessage({ id: "never-listed" }), null, "only a message a search listed exists");
});

test("a person with no mailbox gets one only when the chat's setting gives Tex their email", async () => {
  const sim = createSimWorld({ send: null, setting: "Tex has Gmail", person: "Remi" });
  const flags = {};
  simulateServices(sim, { flags }, { connectMail: true });
  assert.deepEqual(flags.mailboxes, [{ address: "remi@gmail.example", folder: "0-inbox/email" }]);
  const none = {};
  simulateServices(sim, { flags: none }, { connectMail: false });
  assert.equal(none.mailboxes, undefined);
  assert.equal(none.mailResults, undefined);
});

test("a scripted site's page stays scripted; any other page and browser is the world's", async () => {
  const { send, asked } = scriptedSend({ "browser page": { ran: [{ ok: true }, { ok: false, reason: "Seat 12A is taken" }], url: "https://www.flytap.example/manage", title: "Manage booking", text: "TP 237 delayed 50 min", elements: [{ kind: "button", label: "Check in" }] } });
  const sim = createSimWorld({ send, setting: "trip" });
  const web = {
    binding: {
      async fetch(url, init) {
        const body = JSON.parse(init.body);
        if (new URL(url).pathname === "/read") return body.url === "https://chatgpt.com/" ? new Response(JSON.stringify({ page: { title: "ChatGPT" } })) : new Response("{}", { status: 502 });
        return new Response(JSON.stringify({ page: { title: "Page not found" } }));
      },
    },
  };
  const binding = simBinding(sim, web);
  assert.equal((await (await binding.fetch("https://s/read", json({ url: "https://chatgpt.com/" }))).json()).page.title, "ChatGPT");
  assert.equal(asked.length, 0, "the scripted page is never the model's");
  const read = await (await binding.fetch("https://s/read", json({ url: "https://www.flytap.example/manage" }))).json();
  assert.match(read.page.text, /delayed 50 min/);
  const browsed = await (await binding.fetch("https://s/browse", json({ provider: "browserbase", owner: "o1", steps: [{ do: "goto", url: "https://www.flytap.example/manage" }, { do: "click", ref: 1 }, { do: "click", ref: 1 }] }))).json();
  assert.equal(browsed.page.elements[0].ref, 1);
  assert.deepEqual(browsed.ran, [
    { do: "goto", ok: true },
    { do: "click", ok: false, reason: "Seat 12A is taken" },
    { do: "click", ok: false, reason: "the page did not respond" },
  ], "a step succeeds only when the site took it");
});

test("a simulated world keeps only real hosts of the scripted web, so a made-up site never answers its searches", () => {
  const sites = [{ host: "harborair.example" }, { host: "context.lc" }];
  assert.deepEqual(sitesIn(sites, {}).map((site) => site.host), ["context.lc"]);
  assert.deepEqual(sitesIn(sites, null).map((site) => site.host), ["harborair.example", "context.lc"], "a golden task keeps its sites");
});
