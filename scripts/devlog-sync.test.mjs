/**
 * The sync copies only what the owner already published, only as a draft
 * release, once per week, and speaks on Discord only when both gates are
 * set. A promise on the page stops it before anything is written.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in
 * this file.
 *
 *   `main` skipping `devlogPromiseProblems`                                1
 *   `decideRelease` updating a release the owner already published         2
 *   `decideDiscord` ignoring the DEVLOG_DISCORD variable                   2
 *   `renderDiscordMessage` clipping without the 2,000 cap                  1
 *   the sync workflow's `if: vars.DEVLOG_SYNC == 'on'` removed             1
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEVLOG_EXPLORING_DISCLAIMER, parseDevlog } from "../packages/shared/src/devlog.ts";
import {
  decideDiscord,
  decideRelease,
  parseSyncMarker,
  releasePayload,
  renderDiscordMessage,
  renderReleaseBody,
  weekDigest,
} from "./devlog-copy.mjs";
import { main } from "./devlog-sync.mjs";

const PAGE = (exploring = "- looking at: a calendar view", shipped = "- search that finds the note you meant") => `# devlog

### week 12
*september 28 to october 4, 2026*

#### shipped
${shipped}

#### in progress
- sharing a folder by link

#### exploring
*${DEVLOG_EXPLORING_DISCLAIMER}*
${exploring}

#### declined

### week 11
- the old single list
`;
const weekOf = (markdown = PAGE()) => parseDevlog(markdown)[0];
const WEBHOOK = "https://discord.com/api/webhooks/123/fake-token";

test("the GitHub copy has sentence-case sections, leaves empty ones out, and records its source", () => {
  const week = weekOf();
  const body = renderReleaseBody(week, { revision: "rev-1" });
  assert.equal(
    body.split("<!--")[0],
    [
      "### Shipped",
      "",
      "- search that finds the note you meant",
      "",
      "### In progress",
      "",
      "- sharing a folder by link",
      "",
      "### Exploring",
      "",
      "*Ideas, not promises. Some of these won't happen.*",
      "",
      "- looking at: a calendar view",
      "",
      "The full devlog is at https://context.lc/devlog.",
      "",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(body, /Declined/);
  assert.deepEqual(parseSyncMarker(body), {
    week: 12,
    revision: "rev-1",
    digest: weekDigest(week),
    discordMessageId: null,
  });
  const payload = releasePayload(week, { revision: "rev-1" });
  assert.equal(payload.name, "Week 12 · September 28 to October 4, 2026");
  assert.equal(payload.tag_name, "devlog-week-12");
  assert.equal(payload.draft, true);
});

test("one release per week: unchanged is a no-op, changed is an update, published is the owner's", () => {
  const week = weekOf();
  const ours = (overrides = {}) => ({
    id: 7,
    tag_name: "devlog-week-12",
    draft: true,
    body: renderReleaseBody(week, { revision: "rev-1", discordMessageId: "555" }),
    ...overrides,
  });
  const other = { id: 3, tag_name: "devlog-week-11", draft: false, body: "" };

  assert.equal(decideRelease([other], week).action, "create");
  const same = decideRelease([other, ours()], week);
  assert.equal(same.action, "none");
  assert.equal(same.marker.discordMessageId, "555");

  const changed = weekOf(PAGE("- looking at: a map of notes"));
  const update = decideRelease([ours()], changed);
  assert.equal(update.action, "update");
  assert.equal(update.release.id, 7);

  assert.equal(decideRelease([ours({ draft: false })], changed).action, "published");
  assert.equal(decideRelease([ours({ draft: false })], week).action, "published");
  // Found by its marker even if the tag was renamed, so a second is never made.
  assert.equal(decideRelease([ours({ tag_name: "renamed" })], changed).action, "update");
});

test("Discord speaks only with both gates, posts once, then edits", () => {
  const base = { webhook: WEBHOOK, flag: "on", releaseAction: "create", messageId: null };
  assert.equal(decideDiscord(base), "post");
  assert.equal(decideDiscord({ ...base, webhook: "" }), "off");
  assert.equal(decideDiscord({ ...base, flag: undefined }), "off");
  assert.equal(decideDiscord({ ...base, flag: "true" }), "off");
  assert.equal(decideDiscord({ ...base, releaseAction: "none" }), "post");
  assert.equal(decideDiscord({ ...base, releaseAction: "update", messageId: "555" }), "patch");
  assert.equal(decideDiscord({ ...base, releaseAction: "none", messageId: "555" }), "none");
  assert.equal(decideDiscord({ ...base, releaseAction: "published", messageId: null }), "none");
});

test("the Discord text is short, links the week, and keeps the disclaimer", () => {
  const shipped = Array.from({ length: 8 }, (_, index) => `- thing ${index + 1}`).join("\n");
  const text = renderDiscordMessage(weekOf(PAGE("- looking at: a calendar view", shipped)));
  assert.equal(
    text,
    [
      "**devlog · week 12** (september 28 to october 4, 2026)",
      "shipped",
      "• thing 1",
      "• thing 2",
      "• thing 3",
      "• thing 4",
      "• thing 5",
      "3 more on the devlog",
      "• in progress: sharing a folder by link",
      "• exploring (ideas, not promises. some of these won't happen.): looking at: a calendar view",
      "full week: https://context.lc/devlog",
    ].join("\n"),
  );
});

test("the Discord text stays under 2,000 characters however long the week is", () => {
  const long = (prefix) =>
    Array.from({ length: 40 }, (_, index) => `- ${prefix} ${index} ${"word ".repeat(80)}`).join("\n");
  const week = weekOf(PAGE(long("looking at:"), long("shipped")));
  week.sections.inProgress = Array.from({ length: 60 }, () => "x".repeat(400));
  week.sections.declined = Array.from({ length: 60 }, () => "y".repeat(400));
  const text = renderDiscordMessage(week);
  assert.ok(text.length < 2000, `${text.length} characters`);
  assert.ok(text.includes(`(${DEVLOG_EXPLORING_DISCLAIMER})`));
  assert.ok(text.endsWith("full week: https://context.lc/devlog"));
  assert.match(text, /more on the devlog/);
});

// -------------------------------------------------------------- main

function fakeServices({ page = PAGE(), releases = [], discordId = "999" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method, body });
    if (String(url).endsWith("/api/action")) {
      return new Response(
        JSON.stringify({
          status: "success",
          value: { revision: "rev-1", pages: [{ path: "devlog.md", routePath: "/devlog", title: "devlog", markdown: page }] },
        }),
      );
    }
    if (String(url).startsWith("https://discord.com/")) return new Response(JSON.stringify({ id: discordId }));
    if (method === "GET") return new Response(JSON.stringify(releases));
    return new Response(JSON.stringify({ id: 7, ...body }));
  };
  return { calls, fetchImpl };
}
const env = (overrides = {}) => ({
  GITHUB_REPOSITORY: "example/context",
  GH_TOKEN: "fake-token",
  DEVLOG_CONVEX_URL: "https://convex.example",
  ...overrides,
});
const writes = (calls) => calls.filter((call) => call.method !== "GET" && !call.url.endsWith("/api/action"));

test("a promise on the page stops the sync before anything is written", async () => {
  const { calls, fetchImpl } = fakeServices({ page: PAGE("- looking at: sharing, coming next week") });
  await assert.rejects(
    main({ env: env({ DEVLOG_DISCORD: "on", DEVLOG_DISCORD_WEBHOOK: WEBHOOK }), fetchImpl, log: () => {} }),
    /page problems; nothing was copied[\s\S]*reads like a promise/,
  );
  assert.deepEqual(writes(calls), []);
  assert.equal(calls.length, 1, "only the page was read");
});

test("a missing Convex URL fails clearly", async () => {
  const { fetchImpl } = fakeServices();
  await assert.rejects(main({ env: env({ DEVLOG_CONVEX_URL: "" }), fetchImpl, log: () => {} }), /DEVLOG_CONVEX_URL is not set/);
});

test("the first run creates a draft and posts once; the next run changes nothing", async () => {
  const first = fakeServices();
  const result = await main({
    env: env({ DEVLOG_DISCORD: "on", DEVLOG_DISCORD_WEBHOOK: WEBHOOK }),
    fetchImpl: first.fetchImpl,
    log: () => {},
  });
  assert.deepEqual(result, { release: "create", discord: "post" });
  const [create, post, record] = writes(first.calls);
  assert.equal(create.method, "POST");
  assert.equal(create.body.draft, true);
  assert.equal(post.url, `${WEBHOOK}?wait=true`);
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
  assert.equal(record.method, "PATCH");
  assert.equal(record.body.draft, true);
  assert.equal(parseSyncMarker(record.body.body).discordMessageId, "999");

  const stored = { id: 7, tag_name: record.body.tag_name, draft: true, body: record.body.body };
  const again = fakeServices({ releases: [stored] });
  const second = await main({
    env: env({ DEVLOG_DISCORD: "on", DEVLOG_DISCORD_WEBHOOK: WEBHOOK }),
    fetchImpl: again.fetchImpl,
    log: () => {},
  });
  assert.deepEqual(second, { release: "none", discord: "none" });
  assert.deepEqual(writes(again.calls), []);

  const edited = fakeServices({ page: PAGE("- looking at: a map of notes"), releases: [stored] });
  const third = await main({
    env: env({ DEVLOG_DISCORD: "on", DEVLOG_DISCORD_WEBHOOK: WEBHOOK }),
    fetchImpl: edited.fetchImpl,
    log: () => {},
  });
  assert.deepEqual(third, { release: "update", discord: "patch" });
  const [update, patch] = writes(edited.calls);
  assert.equal(update.url, "https://api.github.com/repos/example/context/releases/7");
  assert.equal(parseSyncMarker(update.body.body).discordMessageId, "999");
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url, `${WEBHOOK}/messages/999`);
});

test("a published release is left alone, and Discord stays quiet without its variable", async () => {
  const published = { id: 7, tag_name: "devlog-week-12", draft: false, body: "the owner's words" };
  const handedOff = fakeServices({ releases: [published] });
  const result = await main({
    env: env({ DEVLOG_DISCORD: "on", DEVLOG_DISCORD_WEBHOOK: WEBHOOK }),
    fetchImpl: handedOff.fetchImpl,
    log: () => {},
  });
  assert.deepEqual(result, { release: "published", discord: "none" });
  assert.deepEqual(writes(handedOff.calls), []);

  const quiet = fakeServices();
  assert.deepEqual(
    await main({ env: env({ DEVLOG_DISCORD_WEBHOOK: WEBHOOK }), fetchImpl: quiet.fetchImpl, log: () => {} }),
    { release: "create", discord: "off" },
  );
  assert.ok(writes(quiet.calls).every((call) => call.url.startsWith("https://api.github.com/")));
});

// ---------------------------------------------------------- workflows

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

test("the sync workflow is off until the owner turns it on, and can only write drafts", () => {
  const sync = workflow("devlog-sync.yml");
  assert.match(sync, /\n    if: \$\{\{ vars\.DEVLOG_SYNC == 'on' \}\}\n/);
  assert.match(sync, /permissions:\n  contents: write\n\n/);
  assert.match(sync, /schedule:\n    - cron: "\d+ \* \* \* \*"/);
  assert.match(sync, /workflow_dispatch:/);
  assert.match(
    sync,
    /DEVLOG_DISCORD_WEBHOOK: \$\{\{ vars\.DEVLOG_DISCORD == 'on' && secrets\.DEVLOG_DISCORD_WEBHOOK \|\| '' \}\}/,
  );
});

test("no devlog workflow or script can create a published release", () => {
  for (const name of ["devlog-sync.yml", "devlog-draft.yml", "release-communication-evidence.yml"]) {
    const text = workflow(name);
    for (const line of text.split("\n").filter((entry) => /gh\s+release\s+create/.test(entry))) {
      assert.match(line, /--draft/, `${name}: ${line}`);
    }
    assert.doesNotMatch(text, /draft:\s*false|--draft=false/, name);
  }
  for (const name of ["devlog-sync.mjs", "devlog-copy.mjs", "devlog-draft.mjs"]) {
    const code = readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(code, /\bdraft:\s*(?!true\b)\S|make_latest/, name);
  }
});
