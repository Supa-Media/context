/**
 * The scripted web golden tasks run on (`bench/sites.mjs`) and the checks
 * read from its record (`bench/checks.mjs`). The site files under
 * `bench/ai/sites/` are parsed too, so a broken one fails here, not mid-run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LIVE_VIEW_ORIGIN, createWeb, parseSite } from "../sites.mjs";
import { checkVerdicts, readCheck } from "../checks.mjs";
import { readBenchFolder } from "../load.mjs";

const SHOP = `---
site: shop.example
sign_in: https://shop.example/login
search: shop, socks
---

## https://shop.example/
title: Shop
text: Welcome.
- link: Account -> https://shop.example/account

## https://shop.example/login
title: Sign in
- textbox: Email
- button: Sign in

## https://shop.example/account
title: Account
signed in only
text: Your orders.
text (subscribed): You get the newsletter.
- textbox: Nickname
- select: Size (S, M, L)
- checkbox: I agree
- button: Save -> https://shop.example/saved [needs Nickname, Size = M, I agree] [sets subscribed]
- button (subscribed): Unsubscribe -> https://shop.example/account
`;

async function post(web, path, body) {
  const response = await web.binding.fetch(`https://site-shots${path}`, { method: "POST", body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("every site file in the bench folder parses", async () => {
  const bench = await readBenchFolder(fileURLToPath(new URL("../ai", import.meta.url)));
  assert.ok(bench.sites.length >= 5);
  for (const site of bench.sites) assert.ok(site.pages.size > 0, site.host);
});

test("parseSite refuses a sign-in page that is not one of the site's pages, and an element with no label", () => {
  assert.throws(() => parseSite(SHOP.replace("sign_in: https://shop.example/login", "sign_in: https://shop.example/nope")), /sign_in/);
  assert.throws(() => parseSite(`${SHOP}- button: -> https://shop.example/\n`), /label/);
  assert.throws(() => parseSite(`${SHOP}- select: Colour\n`), /options/);
});

test("a signed-out browser lands on the sign-in page, and a handoff signs the person in and takes it back", async () => {
  const web = createWeb([parseSite(SHOP)]);
  const opened = await post(web, "/browse", { provider: "browserbase", owner: "owner-1", steps: [{ do: "goto", url: "https://shop.example/account" }] });
  assert.equal(opened.body.page.url, "https://shop.example/login");
  const handed = await post(web, "/browse", { provider: "browserbase", owner: "owner-1", steps: [{ do: "read" }], handoff: true });
  assert.equal(handed.body.liveUrl, `${LIVE_VIEW_ORIGIN}/${handed.body.session}`);
  assert.equal(handed.body.session, opened.body.session, "the person's browser outlives the question");
  web.personSignsIn();
  const after = await post(web, "/browse", { provider: "browserbase", owner: "owner-1", steps: [{ do: "read" }] });
  assert.equal(after.body.page.url, "https://shop.example/account");
  assert.deepEqual(web.events(), ["open shop.example/login", "handoff shop.example", "signed in shop.example", "open shop.example/account"]);
});

test("no handoff, no sign-in: the person never signs in on their own", async () => {
  const web = createWeb([parseSite(SHOP)]);
  await post(web, "/browse", { provider: "browserbase", owner: "o", steps: [{ do: "goto", url: "https://shop.example/account" }] });
  web.personSignsIn();
  const again = await post(web, "/browse", { provider: "browserbase", owner: "o", steps: [{ do: "read" }] });
  assert.equal(again.body.page.url, "https://shop.example/login");
});

test("a button goes nowhere until what it needs is filled, then sets its flag and shows what the flag shows", async () => {
  const web = createWeb([parseSite(SHOP)]);
  const go = (steps) => post(web, "/browse", { provider: "browserbase", owner: "o", steps });
  await go([{ do: "goto", url: "https://shop.example/login" }, { do: "handoff" }]);
  await go([{ do: "goto", url: "https://shop.example/login" }]);
  await post(web, "/browse", { provider: "browserbase", owner: "o", steps: [{ do: "read" }], handoff: true });
  web.personSignsIn();
  await go([{ do: "goto", url: "https://shop.example/account" }]);
  const refs = Object.fromEntries((await go([{ do: "read" }])).body.page.elements.map((e) => [e.label.replace(/ \(now: .*\)$/, ""), e.ref]));
  assert.equal(refs.Unsubscribe, undefined, "an element behind an unset flag is not shown");
  const short = await go([{ do: "type", ref: refs.Nickname, text: "Mo" }, { do: "click", ref: refs.Save }]);
  assert.match(short.body.page.text, /Fill in: Size \(M\), I agree\./);
  assert.equal(short.body.page.url, "https://shop.example/account");
  const done = await go([{ do: "select", ref: refs.Size, option: "m" }, { do: "click", ref: refs["I agree"] }, { do: "click", ref: refs.Save }]);
  assert.equal(done.body.page.url, "https://shop.example/saved");
  const back = await go([{ do: "goto", url: "https://shop.example/account" }]);
  assert.match(back.body.page.text, /You get the newsletter/);
  assert.ok(back.body.page.elements.some((e) => e.label === "Unsubscribe"));
  assert.ok(web.events().includes("set subscribed"));
  assert.ok(web.events().includes('select shop.example/account "Size: M"'));
});

const SWITCH = `---
site: switch.example
---

## https://switch.example/
title: Switch
text (!on): It is off.
text (on, !locked): It is on.
text (on, locked): It is on and locked.
- button (!on): Turn on -> https://switch.example/ [sets on]
- button (on, !locked): Lock -> https://switch.example/ [sets locked]
- select (on): Speed (Slow, Fast)
`;

test("(!flag) shows only while the flag is unset, and (a, !b) needs all of them", async () => {
  const web = createWeb([parseSite(SWITCH)]);
  const go = async (steps) => (await post(web, "/browse", { provider: "browserbase", owner: "o", steps })).body.page;
  const labels = (page) => page.elements.map((e) => e.label);
  const off = await go([{ do: "goto", url: "https://switch.example/" }]);
  assert.equal(off.text, "It is off.");
  assert.deepEqual(labels(off), ["Turn on"]);
  const on = await go([{ do: "click", ref: 1 }]);
  assert.equal(on.text, "It is on.");
  assert.deepEqual(labels(on), ["Lock", "Speed (now: Slow)"]);
  const locked = await go([{ do: "click", ref: 1 }]);
  assert.equal(locked.text, "It is on and locked.");
  assert.deepEqual(labels(locked), ["Speed (now: Slow)"]);
  assert.throws(() => parseSite(SWITCH.replace("(on, locked)", "(on, )")), /empty flag/);
});

test("a select's choice survives the page being loaded again", async () => {
  const web = createWeb([parseSite(SWITCH)]);
  const go = async (steps) => (await post(web, "/browse", { provider: "browserbase", owner: "o", steps })).body.page;
  await go([{ do: "goto", url: "https://switch.example/" }, { do: "click", ref: 1 }]);
  await go([{ do: "select", ref: 2, option: "Fast" }]);
  const reloaded = await go([{ do: "goto", url: "https://switch.example/" }]);
  assert.ok(reloaded.elements.some((e) => e.label === "Speed (now: Fast)"), JSON.stringify(reloaded.elements));
  const back = await go([{ do: "goto", url: "https://switch.example/" }, { do: "back" }]);
  assert.ok(back.elements.some((e) => e.label === "Speed (now: Fast)"), "and after going back");
});

test("a click that changes the page leaves the rest of the steps for the next call", async () => {
  const web = createWeb([parseSite(SHOP)]);
  const result = await post(web, "/browse", { provider: "browserbase", owner: "o", steps: [{ do: "goto", url: "https://shop.example/" }, { do: "click", ref: 1 }, { do: "type", ref: 1, text: "x" }] });
  assert.equal(result.body.ran.length, 3);
  assert.match(result.body.ran[2].reason, /steps after this one were not run/);
});

test("typing is refused off the sites the gateway allowed, and the vault's fill step is not in this world", async () => {
  const web = createWeb([parseSite(SHOP)]);
  const result = await post(web, "/browse", {
    provider: "browserbase",
    owner: "o",
    steps: [{ do: "goto", url: "https://shop.example/login" }, { do: "type", ref: 1, text: "a", onlyOn: ["other.example"] }, { do: "fill", ref: 1, value: "x", origin: "https://shop.example", field: "username" }],
  });
  assert.deepEqual(result.body.ran.map((r) => r.ok), [true, false, false]);
});

test("open_page reads signed out, and a search lists the sites it names", async () => {
  const web = createWeb([parseSite(SHOP)]);
  const read = await post(web, "/read", { url: "https://shop.example/account" });
  assert.equal(read.body.page.url, "https://shop.example/login");
  assert.equal(web.search("wool socks").length, 3);
  assert.equal(web.search("flights").length, 0);
});

test("checks grade the run's record: calls, pages, handoffs, typing, choices and flags", () => {
  const lines = [
    "- must call: read_skill",
    "- must not call: vault_add_link",
    "- must reach: shop.example/account",
    "- must hand off: shop.example",
    "- must type: https://mcp.context.lc/mcp",
    "- must choose: Size: M",
    "- must set: subscribed",
    "- must not set: started booking",
  ];
  const question = { checks: lines.map(readCheck) };
  assert.ok(question.checks.every(Boolean));
  assert.equal(readCheck("- must: say hello"), null, "a judge line is not a check");
  const answer = {
    tools: ["read_skill", "browse (held for OK)", "vault_list (failed)"],
    browser: ["open shop.example/account", "handoff shop.example", 'type shop.example/new "https://mcp.context.lc/mcp"', 'select shop.example/account "Size: M"', "set subscribed"],
  };
  assert.deepEqual(checkVerdicts(question, answer).map((v) => v.pass), [true, true, true, true, true, true, true, true]);
  const nothing = checkVerdicts(question, { tools: ["vault_add_link", "read_skill (failed)"], browser: ["set started booking"] });
  assert.deepEqual(nothing.map((v) => v.pass), [false, false, false, false, false, false, false, false]);
  assert.deepEqual(nothing.map((v) => v.kind), ["must", "must not", "must", "must", "must", "must", "must", "must not"]);
});
