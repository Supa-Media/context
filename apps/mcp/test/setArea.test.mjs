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

const RULES = [{ prefix: "areas", vis: "team" }, { prefix: "data", vis: "team" }, { prefix: "bots", vis: "team" }];

async function world(notes = {}) {
  const base = createMemoryStore();
  for (const [key, text] of Object.entries(notes)) await base.put(key, text);
  const store = withPrivacyAuthority(withServedTree(base), {
    rules: { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }, { prefix: "data", visibility: "team" }, { prefix: "bots", visibility: "team" }], notes: [] },
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

test("a bot gets its card in bots/<bot>/about.md beside the Areas folder, and its name on the agents list", async () => {
  const { store, props } = await world({ "areas/about.md": "---\nagents:\n  - Pipeline\n---\n\n# Areas\n", "areas/finance/about.md": FINANCE });
  const result = await run(store, { area: "areas/finance", owner: "Finance", bot: { name: "Finance", whose: "@seyi", reach: "webhook" } });
  assert.equal(result.isError, undefined, said(result));
  // Beside the Areas folder, not in it (the owner, 2026-11-25: "top level bots yes"), with no area: false note needed.
  const card = await props("bots/finance/about.md");
  assert.equal(card.holder, "Finance");
  assert.equal(card.kind, "agent");
  assert.equal(card.bot, "grok");
  assert.equal(card.belongs_to, "@seyi");
  assert.equal(card.reach, "webhook");
  assert.equal(await (await store.get("bots/about.md"))?.text?.(), undefined);
  assert.equal(await (await store.get("areas/bots/finance/about.md"))?.text?.(), undefined);
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
  const avatar = String((await props("bots/finance/about.md")).avatar);
  assert.match(avatar, /^upload-[0-9a-f]{16}\.(png|webp|jpe?g)$/);
  // The logo is a field, not an embed added under the card.
  assert.doesNotMatch(await text("bots/finance/about.md"), /!\[/);
  assert.equal((await run(store, { area: "areas/finance", bot: { name: "Finance", avatar: {} } })).isError, true);
});

test("a bot's logo line names a picture the workspace holds", async () => {
  const { store, props } = await world({ "areas/finance/about.md": FINANCE });
  await run(store, { area: "areas/finance", bot: { name: "Finance", avatar: { data: PNG } } });
  const avatar = String((await props("bots/finance/about.md")).avatar);
  // The card's leaf is the stored object's name, not a name for some other copy (Tex Quality, 2026-11-26).
  assert.notEqual(await store.get(`.context/assets/images/${avatar}`), null);
});

// A 1×1 white PNG, a different picture from PNG.
const WHITE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";

// Dev, 2026-11-27: Grok Bot's white logo vanished on a light screen; a black one would on dark.
test("a bot's dark-screen logo is stored and named on its card's avatar-dark line, beside its avatar", async () => {
  const { store, props, text } = await world({ "areas/finance/about.md": FINANCE });
  const result = await run(store, { area: "areas/finance", bot: { name: "Finance", avatar: { data: PNG }, avatar_dark: { data: WHITE_PNG } } });
  assert.equal(result.isError, undefined, said(result));
  assert.match(said(result), /with its logo/);
  const card = await props("bots/finance/about.md");
  const light = String(card.avatar);
  const dark = String(card["avatar-dark"]);
  assert.match(dark, /^upload-[0-9a-f]{16}\.(png|webp|jpe?g)$/);
  assert.notEqual(dark, light);
  assert.notEqual(await store.get(`.context/assets/images/${dark}`), null);
  assert.doesNotMatch(await text("bots/finance/about.md"), /!\[/);
  // Set alone later, the dark one leaves the light one as it was.
  await run(store, { area: "areas/finance", bot: { name: "Finance", avatar_dark: { data: PNG } } });
  const after = await props("bots/finance/about.md");
  assert.equal(String(after.avatar), light);
  assert.equal(String(after["avatar-dark"]), light);
  assert.equal((await run(store, { area: "areas/finance", bot: { name: "Finance", avatar_dark: {} } })).isError, true);
});

// Tex Quality, 2026-11-26: its card says "Tex Quality · Tex reply quality" in bots/tex-quality/.
const TQ_CARD = "---\nholder: Tex Quality · Tex reply quality\nkind: agent\nbot: claude\nbelongs_to: \"@seyi\"\nreach: webhook\n---\n";

test("a bot called by its card's full words is that card, not a second one", async () => {
  const { store, props } = await world({ "areas/about.md": "---\nagents:\n  - Tex Quality\n---\n", "areas/finance/about.md": FINANCE, "bots/tex-quality/about.md": TQ_CARD });
  const result = await run(store, { area: "areas/finance", bot: { name: "Tex Quality · Tex reply quality", avatar: { data: PNG } } });
  assert.equal(result.isError, undefined, said(result));
  assert.match(said(result), /card bots\/tex-quality\/about\.md/);
  assert.match(String((await props("bots/tex-quality/about.md")).avatar), /^upload-/);
  assert.equal(await store.get("bots/tex-quality-tex-reply-quality/about.md"), null);
  assert.deepEqual((await props("areas/about.md")).agents, ["Tex Quality"]);
});

test("a bot called by its short name keeps the words and kind its card says", async () => {
  const { store, props } = await world({ "areas/finance/about.md": FINANCE, "bots/tex-quality/about.md": TQ_CARD });
  const result = await run(store, { area: "areas/finance", bot: { name: "Tex Quality", avatar: { data: PNG } } });
  assert.equal(result.isError, undefined, said(result));
  const card = await props("bots/tex-quality/about.md");
  assert.equal(card.holder, "Tex Quality · Tex reply quality");
  assert.equal(card.bot, "claude");
  assert.match(said(result), /^- Tex Quality · Tex reply quality: /);
  // Passing a kind still changes it.
  await run(store, { area: "areas/finance", bot: { name: "Tex Quality", kind: "grok" } });
  assert.equal((await props("bots/tex-quality/about.md")).bot, "grok");
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

// Dev, 2026-11-27: "these bots say they setup their webhooks but it still shows as setup in mail". A bot set up from
// its prompt saves and tests its webhook but never passes bot.reach, so its card went on saying `reach: mail`.
test("a webhook that answers its test sets its bot's card to reach: webhook; one that fails leaves it", async () => {
  const card = "---\nholder: Getrude\nkind: agent\nbot: grok\nbelongs_to: \"@shyoh\"\nreach: mail\n---\n\n# Getrude\n\nX manager.\n";
  const { store, props, text } = await world({ "areas/finance/about.md": FINANCE, "bots/getrude/about.md": card });
  const failing = store.botHooks;
  store.botHooks = async (request) => (request.action === "test" ? { ok: false, status: 0 } : failing(request));
  await run(store, { area: "areas/finance", test_webhook: "Getrude" });
  assert.equal((await props("bots/getrude/about.md")).reach, "mail");
  store.botHooks = failing;
  const result = await run(store, { area: "areas/finance", test_webhook: "Getrude" });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await props("bots/getrude/about.md")).reach, "webhook");
  assert.match(await text("bots/getrude/about.md"), /X manager\./);
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

test("a bot's works_in lists the areas its person lets it work in, each with its cap, and null removes the list", async () => {
  // The owner, 2026-11-25: "if I attach a grokbot I can define how much of my weekly usage it can use".
  const { store, props } = await world({ "areas/finance/about.md": FINANCE });
  const set = await run(store, { area: "areas/finance", bot: { name: "Finance", whose: "@seyi", works_in: [{ area: "areas/finance", cap: 20 }, "areas/ops · 5%", { area: "areas/finance/" }] } });
  assert.equal(set.isError, undefined, said(set));
  assert.match(said(set), /working in areas\/finance · 20%, areas\/ops · 5%/);
  assert.deepEqual((await props("bots/finance/about.md")).works_in, ["areas/finance · 20%", "areas/ops · 5%"]);
  for (const works_in of [[{ area: "areas/finance", cap: 120 }], [{ area: "projects/x", cap: 5 }], "areas/finance", [{ area: "areas/finance", cap: 2.5 }]]) {
    const bad = await run(store, { area: "areas/finance", bot: { name: "Finance", works_in } });
    assert.equal(bad.isError, true, JSON.stringify(works_in));
  }
  const cleared = await run(store, { area: "areas/finance", bot: { name: "Finance", works_in: null } });
  assert.match(said(cleared), /working wherever an area names it/);
  assert.equal((await props("bots/finance/about.md")).works_in, undefined);
});

test("a card still in people/ is changed where it is", async () => {
  const { store, props } = await world({
    "areas/finance/about.md": FINANCE,
    "areas/people/about.md": "---\narea: false\n---\n",
    "areas/people/finance.md": "---\nholder: Finance\nkind: agent\nbot: grok\n---\n",
  });
  const set = await run(store, { area: "areas/finance", bot: { name: "Finance", whose: "@seyi" } });
  assert.match(said(set), /card areas\/people\/finance\.md/);
  assert.equal((await props("areas/people/finance.md")).belongs_to, "@seyi");
  assert.equal(await (await store.get("areas/bots/finance/about.md"))?.text?.(), undefined);
});

test("a card still in the Areas folder's bots/ is changed there", async () => {
  const { store, props } = await world({
    "areas/finance/about.md": FINANCE,
    "areas/bots/about.md": "---\narea: false\n---\n",
    "areas/bots/finance/about.md": "---\nholder: Finance\nkind: agent\nbot: grok\nbelongs_to: \"@seyi\"\n---\n",
  });
  const set = await run(store, { area: "areas/finance", bot: { name: "Finance", works_in: [{ area: "areas/finance", cap: 10 }] } });
  assert.match(said(set), /card areas\/bots\/finance\/about\.md/);
  assert.deepEqual((await props("areas/bots/finance/about.md")).works_in, ["areas/finance · 10%"]);
});

test("a blank owner or delegate is the field left empty, never a clear: null clears", async () => {
  // Grok fills every field it is shown, so a change to one thing arrives with owner: "" and delegate: "" beside it.
  const { store, props } = await world({ "areas/finance/about.md": FINANCE });
  const result = await run(store, { area: "areas/finance", owner: "", delegate: "", modes: ["Doer"] });
  assert.equal(result.isError, undefined, said(result));
  const now = await props("areas/finance/about.md");
  assert.equal(now.owner, "@seyi");
  assert.deepEqual(now.modes, ["Doer"]);
  const cleared = await run(store, { area: "areas/finance", owner: null });
  assert.equal(cleared.isError, undefined, said(cleared));
  assert.equal((await props("areas/finance/about.md")).owner, undefined);
});

/*
  WHOSE BOT IT IS IS NOT ANOTHER EDITOR'S TO SAY (2026-11-27). `bind_bot` binds a card to the connection the card
  names (`botBind.js`), so rewriting `belongs_to` on a card made for somebody else is taking their bot's identity:
  what the bound connection writes is signed by the bot. The bots folder is team-visible, so an editor can write the
  card; only an owner, or the person it names, says whose bot it is.

  Sabotage: the whole guard removed → "an editor does not make somebody else's bot theirs" (the card says @kim and
  bind_bot no longer refuses) and "an editor does not claim a card that is already here and names nobody" fail.
  Applied, file run, both observed failing, restored.
*/
const GROK_CARD = '---\nholder: Grok Bot\nkind: agent\nbot: grok\nbelongs_to: "@seyi"\n---\n\n# Grok Bot\n';
const bindAs = async (store) => (await import("../src/tools/notes/botBind.js")).toolBindBot(store, "team", RULES, new PrivacyOverrides(), "Grok Bot");

test("an editor does not make somebody else's bot theirs, and cannot bind it after trying", async () => {
  const { store, props } = await world({ "areas/finance/about.md": FINANCE, "bots/grok-bot/about.md": GROK_CARD });
  store.actor = { ...store.actor, role: "editor", name: "@kim" };
  const result = await run(store, { area: "areas/finance", bot: { name: "Grok Bot", whose: "@kim" } });
  assert.equal(result.isError, true, said(result));
  assert.match(said(result), /@seyi's bot/);
  assert.equal((await props("bots/grok-bot/about.md")).belongs_to, "@seyi", "the card is unchanged");
  assert.match(said(await bindAs(store)), /only their own connection binds it/);
});

test("an editor does not claim a card that is already here and names nobody", async () => {
  const unnamed = '---\nholder: Grok Bot\nkind: agent\nbot: grok\n---\n\n# Grok Bot\n';
  const { store, props } = await world({ "areas/finance/about.md": FINANCE, "bots/grok-bot/about.md": unnamed });
  store.actor = { ...store.actor, role: "editor", name: "@kim" };
  const result = await run(store, { area: "areas/finance", bot: { name: "Grok Bot", whose: "@kim" } });
  assert.equal(result.isError, true, said(result));
  assert.equal((await props("bots/grok-bot/about.md")).belongs_to, undefined);
});

test("the person a card names hands their own bot on, and an owner says whose any bot is", async () => {
  const mine = await world({ "areas/finance/about.md": FINANCE, "bots/grok-bot/about.md": GROK_CARD });
  mine.store.actor = { ...mine.store.actor, role: "editor", name: "@seyi" };
  assert.equal((await run(mine.store, { area: "areas/finance", bot: { name: "Grok Bot", whose: "@kim" } })).isError, undefined);
  assert.equal((await mine.props("bots/grok-bot/about.md")).belongs_to, "@kim");

  const owner = await world({ "areas/finance/about.md": FINANCE, "bots/grok-bot/about.md": GROK_CARD });
  owner.store.actor = { ...owner.store.actor, role: "owner", name: "@dev" };
  assert.equal((await run(owner.store, { area: "areas/finance", bot: { name: "Grok Bot", whose: "@kim" } })).isError, undefined);
  assert.equal((await owner.props("bots/grok-bot/about.md")).belongs_to, "@kim");
});

test("an editor still makes a card of its own, naming itself", async () => {
  const { store, props } = await world({ "areas/finance/about.md": FINANCE });
  store.actor = { ...store.actor, role: "editor", name: "@kim" };
  const result = await run(store, { area: "areas/finance", bot: { name: "Kim Bot", whose: "@kim" } });
  assert.equal(result.isError, undefined, said(result));
  assert.equal((await props("bots/kim-bot/about.md")).belongs_to, "@kim");
});

// Dev, 2026-11-27: four of @shyoh's bots each sent one shared orange picture as their own, and every card showed it.
test("a bot's logo that another bot's card already shows is refused, and a card saved again as it was is not", async () => {
  const { store, props } = await world({ "areas/finance/about.md": FINANCE });
  assert.equal((await run(store, { area: "areas/finance", bot: { name: "Finance", avatar: { data: PNG } } })).isError, undefined);
  const taken = await run(store, { area: "areas/finance", bot: { name: "Socials", avatar: { data: PNG } } });
  assert.equal(taken.isError, true, said(taken));
  assert.match(said(taken), /already bots\/finance's logo/);
  assert.equal((await props("bots/socials/about.md")).avatar, undefined);
  // As its dark-screen logo too.
  assert.equal((await run(store, { area: "areas/finance", bot: { name: "Socials", avatar_dark: { data: PNG } } })).isError, true);
  // Its own picture is fine, and the first bot sending its own again is too.
  assert.equal((await run(store, { area: "areas/finance", bot: { name: "Socials", avatar: { data: WHITE_PNG } } })).isError, undefined);
  assert.equal((await run(store, { area: "areas/finance", bot: { name: "Finance", avatar: { data: PNG } } })).isError, undefined);
});

// The pasted setup prompt names no area (Dev, 2026-11-27: "area assignments can change"), so a webhook alone is saved
// and tested with none; anything else still needs one.
test("a webhook is saved and tested with no area, and nothing else is", async () => {
  const { store, hookCalls } = await world({ "areas/finance/about.md": FINANCE });
  const saved = await run(store, { webhook: { bot: "Finance", address: "https://bot.example.com/hook" } });
  assert.equal(saved.isError, undefined, said(saved));
  const tested = await run(store, { test_webhook: "Finance" });
  assert.equal(tested.isError, undefined, said(tested));
  assert.deepEqual(hookCalls.map((call) => call.action), ["set", "test"]);
  const owner = await run(store, { owner: "@seyi", webhook: { bot: "Finance", address: "https://bot.example.com/hook" } });
  assert.equal(owner.isError, true);
  assert.match(said(owner), /area is the area's folder/);
});

test("a bot made an area's owner or delegate gets its mail note there at once, and an existing one is kept (Dev, 2026-11-27)", async () => {
  // Dev, 2026-11-27: "fix these PLEASE" — Capabilities' routine answers came back NOT_FOUND, since nothing had made
  // areas/<area>/mail/capabilities.md.
  const { store, text } = await world({ "areas/finance/about.md": FINANCE, "areas/ops/about.md": "---\nowner: \"@seyi\"\n---\n\n# Ops\n" });
  const owned = await run(store, { area: "areas/finance", owner: "Capabilities" });
  assert.equal(owned.isError, undefined, said(owned));
  assert.match(said(owned), /areas\/finance\/mail\/capabilities\.md: made/);
  assert.equal(await text("areas/finance/mail/capabilities.md"), "# Mail with Finance\n");
  // A delegate too; a note already there is never rewritten.
  await store.put("areas/ops/mail/beth.md", "# Mail with Ops\n\nkept\n");
  const delegated = await run(store, { area: "areas/ops", delegate: "Beth" });
  assert.equal(delegated.isError, undefined, said(delegated));
  assert.doesNotMatch(said(delegated), /mail\/beth\.md: made/);
  assert.equal(await text("areas/ops/mail/beth.md"), "# Mail with Ops\n\nkept\n");
  // Tex and people get none.
  await run(store, { area: "areas/ops", delegate: "Tex" });
  assert.equal(await text("areas/ops/mail/tex.md"), null);
});
