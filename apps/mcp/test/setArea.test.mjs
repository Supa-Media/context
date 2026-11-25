/**
 * `manage area` (`set_area`, `src/tools/notes/setArea.js`): an area's settings (its owner and its one delegate among
 * them), its one metric and its bots, changed through the MCP and Tex the way the area panel changes them (Dev2, 2026-11-25). The
 * promises: each change is the front matter the panel writes; a metric must be one the workspace has, and a wrong
 * name lists the ones it has; a bot gets its card and its name on the agents list; a webhook goes to the control
 * plane and its answer never carries the address, the header or a key.
 *
 * ## Sabotage record
 *
 * Matching the metric case-sensitively failed "a metric is matched ignoring case". Leaving the old `metric:` and
 * `target:` lines in place failed "sets the owner, modes and metric".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolSetArea, metricLine, cardSlug } from "../src/tools/notes/setArea.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { noteProperties } from "../src/lists/properties.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = [{ prefix: "areas", vis: "team" }, { prefix: "data", vis: "team" }];

async function world(notes = {}) {
  const base = createMemoryStore();
  for (const [key, text] of Object.entries(notes)) await base.put(key, text);
  const store = withPrivacyAuthority(withServedTree(base), {
    rules: { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }, { prefix: "data", visibility: "team" }], notes: [] },
    async setAccess(change) {
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  store.actor = { workspaceId: "ws-test", workspaceKind: "shared", role: "owner" };
  const served = store.treeFacts;
  store.treeFacts = async (request) =>
    request.ask === "jobs" ? { served: true, jobs: { areas: "areas", projects: "projects" }, roots: ["areas", "projects"] } : served(request);
  store.treeEntries = async () => (await base.list({})).objects;
  const hookCalls = [];
  Object.defineProperty(store, "botHookUrl", { value: "https://mcp.example.com/api/bot-hook", configurable: true });
  store.botHooks = async (request) => {
    hookCalls.push(request);
    if (request.action === "set") return { host: "bot.example.com", headerEnds: request.header ? "1234" : null, keyMade: !request.signingKey };
    if (request.action === "test") return { ok: true, status: 200 };
    if (request.action === "ticket") return { ticket: "tkt_abcdefghijklmnop0123", minutes: 10 };
    return { error: "unknown" };
  };
  const text = async (key) => (await (await base.get(key))?.text()) ?? null;
  const props = async (key) => noteProperties((await text(key)) ?? "");
  return { store, hookCalls, text, props };
}

const run = (store, args) => toolSetArea(store, "team", RULES, new PrivacyOverrides(), args);
const said = (result) => result.content.map((part) => part.text).join("\n");

const FINANCE = "---\nowner: \"@seyi\"\nmetric: Old number\ntarget: 5\n---\n\n# Finance\n\nKeeps spending in check.\n";
const METRIC = "---\nmetric: Monthly cost\nsource: stripe\n---\n\n# Monthly cost\n";

test("metricLine drops commas the way the panel does, and cardSlug names a card", () => {
  assert.equal(metricLine("Monthly cost", "under $1,200"), "Monthly cost · target under $1200");
  assert.equal(metricLine("Users, active", ""), "Users active");
  assert.equal(cardSlug("@Dev2"), "dev2");
  assert.equal(cardSlug("Finance Bot"), "finance-bot");
});

test("sets the owner, modes and metric, and takes the old metric and target lines away", async () => {
  const { store, text, props } = await world({ "areas/finance/about.md": FINANCE, "data/metrics/monthly-cost.md": METRIC });
  const result = await run(store, { area: "areas/finance", owner: "Finance", modes: ["Manager", "Doer"], metric: { name: "Monthly cost", target: "under $1,200" } });
  assert.equal(result.isError, undefined, said(result));
  const now = await props("areas/finance/about.md");
  assert.equal(now.owner, "Finance");
  assert.deepEqual(now.modes, ["Manager", "Doer"]);
  assert.deepEqual(now.metrics, ["Monthly cost · target under $1200"]);
  assert.equal(now.metric, undefined);
  assert.equal(now.target, undefined);
  assert.match(await text("areas/finance/about.md"), /Keeps spending in check\./);
});

test("a metric is matched ignoring case, and written with the workspace's own name for it", async () => {
  const { store, props } = await world({ "areas/finance/about.md": FINANCE, "data/metrics/monthly-cost.md": METRIC });
  const result = await run(store, { area: "areas/finance", metric: { name: "monthly COST" } });
  assert.equal(result.isError, undefined, said(result));
  assert.deepEqual((await props("areas/finance/about.md")).metrics, ["Monthly cost"]);
});

test("an unknown metric is refused and the answer names the metrics there are", async () => {
  const { store, text } = await world({ "areas/finance/about.md": FINANCE, "data/metrics/monthly-cost.md": METRIC });
  const before = await text("areas/finance/about.md");
  const result = await run(store, { area: "areas/finance", metric: { name: "Revenue" } });
  assert.equal(result.isError, true);
  assert.match(said(result), /no metric named "Revenue".*Monthly cost/);
  assert.equal(await text("areas/finance/about.md"), before);
});

test("modes outside Visionary, Manager and Doer are refused", async () => {
  const { store } = await world({ "areas/finance/about.md": FINANCE });
  assert.equal((await run(store, { area: "areas/finance", modes: ["Boss"] })).isError, true);
});

test("an area outside the areas folder, or one that isn't there, is refused", async () => {
  const { store } = await world({ "areas/finance/about.md": FINANCE });
  assert.equal((await run(store, { area: "projects/x", owner: "Finance" })).isError, true);
  assert.equal((await run(store, { area: "areas/nowhere", owner: "Finance" })).isError, true);
});

test("a bot gets its card in people/ and its name on the agents list", async () => {
  const { store, props } = await world({ "areas/about.md": "---\nagents:\n  - Pipeline\n---\n\n# Areas\n", "areas/finance/about.md": FINANCE });
  const result = await run(store, { area: "areas/finance", owner: "Finance", bot: { name: "Finance", whose: "@seyi", reach: "webhook" } });
  assert.equal(result.isError, undefined, said(result));
  const card = await props("areas/people/finance.md");
  assert.equal(card.holder, "Finance");
  assert.equal(card.kind, "agent");
  assert.equal(card.bot, "grok");
  assert.equal(card.belongs_to, "@seyi");
  assert.equal(card.reach, "webhook");
  assert.equal(String((await props("areas/people/about.md")).area), "false");
  assert.deepEqual((await props("areas/about.md")).agents, ["Pipeline", "Finance"]);
  // Again: no second name on the list.
  await run(store, { area: "areas/finance", bot: { name: "finance" } });
  assert.deepEqual((await props("areas/about.md")).agents, ["Pipeline", "Finance"]);
});

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("a bot's logo is stored in the workspace and named on its card's avatar line", async () => {
  const { store, props, text } = await world({ "areas/finance/about.md": FINANCE });
  const result = await run(store, { area: "areas/finance", bot: { name: "Finance", avatar: { data: PNG } } });
  assert.equal(result.isError, undefined, said(result));
  assert.match(said(result), /with its logo/);
  const avatar = String((await props("areas/people/finance.md")).avatar);
  assert.match(avatar, /^upload-[0-9a-f]{16}\.(png|webp|jpe?g)$/);
  // The logo is a field, not an embed added under the card.
  assert.doesNotMatch(await text("areas/people/finance.md"), /!\[/);
  assert.equal((await run(store, { area: "areas/finance", bot: { name: "Finance", avatar: {} } })).isError, true);
});

test("an area's one delegate is written on its about.md, and null takes it away", async () => {
  // The owner, 2026-11-25: "1 delegate per area please".
  const { store, props, text } = await world({ "areas/finance/about.md": "---\nowner: \"@seyi\"\nhelper: Old Bot\n---\n\n# Finance\n" });
  const set = await run(store, { area: "areas/finance", delegate: "Finance" });
  assert.equal(set.isError, undefined, said(set));
  assert.match(said(set), /set delegate$/m);
  const now = await props("areas/finance/about.md");
  assert.equal(now.delegate, "Finance");
  // The old helper line goes, so the note never says two things.
  assert.equal(now.helper, undefined);
  // Nothing is written on the person's card: a delegate is per area.
  assert.equal(await text("areas/people/seyi.md"), null);
  await run(store, { area: "areas/finance", delegate: null });
  assert.equal((await props("areas/finance/about.md")).delegate, undefined);
  // The old shape, one delegate for a person everywhere, is refused with the new one.
  const old = await run(store, { area: "areas/finance", delegate: { person: "@seyi", to: "Finance" } });
  assert.equal(old.isError, true);
  assert.match(said(old), /delegate: "Finance"/);
});

test("a webhook's answer never carries a secret, and a test says how the call went", async () => {
  const { store, hookCalls, text } = await world({ "areas/finance/about.md": FINANCE });
  const address = "https://bot.example.com/hook?token=s3cret-path";
  const header = "Authorization: Bearer grok-abc-1234";
  const key = `ctxbot_${"ab".repeat(32)}`;
  const result = await run(store, { area: "areas/finance", webhook: { bot: "Finance", address, header, signing_key: key }, test_webhook: "Finance" });
  assert.equal(result.isError, undefined, said(result));
  assert.deepEqual(hookCalls.map((call) => call.action), ["set", "test"]);
  assert.equal(hookCalls[0].address, address);
  assert.equal(hookCalls[0].signingKey, key);
  const answer = said(result);
  for (const secret of ["s3cret-path", "grok-abc", key, "ctxbot_ab"]) assert.ok(!answer.includes(secret), secret);
  assert.match(answer, /bot\.example\.com/);
  assert.match(answer, /test call answered \(200\)/);
  // Nothing about the webhook is written into a note.
  for (const [key_] of (await store.treeEntries()).map((entry) => [entry.key])) assert.ok(!(await text(key_)).includes("s3cret"), key_);
});

test("a webhook without a signing key says Context made one nobody can see", async () => {
  const { store } = await world({ "areas/finance/about.md": FINANCE });
  const result = await run(store, { area: "areas/finance", webhook: { bot: "Finance", address: "https://bot.example.com/hook" } });
  assert.match(said(result), /made its signing key/);
});

test("a bot that can't see its secret gets a one-time command to send the header from its shell", async () => {
  const { store, hookCalls } = await world({ "areas/finance/about.md": FINANCE });
  const result = await run(store, { area: "areas/finance", webhook: { bot: "Pipeline", address: "https://bot.example.com/hook", header_from_shell: "Authorization" } });
  assert.equal(result.isError, undefined, said(result));
  assert.deepEqual(hookCalls.at(-1), { action: "ticket", bot: "Pipeline", address: "https://bot.example.com/hook", headerName: "Authorization" });
  const answer = said(result);
  assert.match(answer, /curl -sS --fail-with-body -X PUT -H 'Authorization: Bearer tkt_abcdefghijklmnop0123' --data-binary "Bearer \$WEBHOOK_SECRET" https:\/\/mcp\.example\.com\/api\/bot-hook/);
  assert.match(answer, /test_webhook: "Pipeline"/);
  // Never both: a header typed in the call is the thing this is for avoiding.
  assert.equal((await run(store, { area: "areas/finance", webhook: { bot: "Pipeline", address: "https://bot.example.com/hook", header_from_shell: "Authorization", header: "Authorization: Bearer x" } })).isError, true);
  assert.equal((await run(store, { area: "areas/finance", webhook: { bot: "Pipeline", address: "https://bot.example.com/hook", header_from_shell: "Authorization: Bearer x" } })).isError, true);
});

test("a person is never a delegate, a bot owner has none, and helper is gone", async () => {
  // The owner, 2026-11-25: "a human shouldnt be a helper to a bot"; a person owns with a bot it delegates to, or a
  // bot owns outright.
  const { store, props } = await world({ "areas/finance/about.md": "---\nowner: \"@seyi\"\ndelegate: Finance\n---\n\n# Finance\n" });
  const person = await run(store, { area: "areas/finance", delegate: "@ana" });
  assert.equal(person.isError, true);
  assert.match(said(person), /never a delegate/);
  assert.equal((await run(store, { area: "areas/finance", helper: "Finance" })).isError, true);
  // A bot taking the area holds it outright: its delegate goes.
  assert.equal((await run(store, { area: "areas/finance", owner: "Finance" })).isError, undefined);
  const now = await props("areas/finance/about.md");
  assert.equal(now.owner, "Finance");
  assert.equal(now.delegate, undefined);
  // With the bot the owner, nobody can be named its delegate.
  const refused = await run(store, { area: "areas/finance", delegate: "Tex" });
  assert.equal(refused.isError, true);
  assert.match(said(refused), /owns areas\/finance outright/);
  // Both at once: a person owner and their bot.
  assert.equal((await run(store, { area: "areas/finance", owner: "@seyi", delegate: "Finance" })).isError, undefined);
  assert.deepEqual([(await props("areas/finance/about.md")).owner, (await props("areas/finance/about.md")).delegate], ["@seyi", "Finance"]);
});

test("nothing to change is said so", async () => {
  const { store } = await world({ "areas/finance/about.md": FINANCE });
  assert.equal((await run(store, { area: "areas/finance" })).isError, true);
});
