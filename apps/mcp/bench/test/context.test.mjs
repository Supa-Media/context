/**
 * The bench's connection to Context (`bench/context.mjs`): a sign-in that
 * keeps the rotated refresh token where the next run reads it, the setups
 * pulled from `ai/setups/<job>/`, and the scores note written back to
 * `ai/results/` with nothing a judge must not see.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callTool, connect, liveScoreRow, notePaths, publishSetup, pullSetups, publishResult, runnerEnv, scoresNote, scoresPathFor, signIn, splitNote } from "../context.mjs";

const ENDPOINT = "https://mcp.context.test/@context-lc/mcp";

/**
 * A gateway on a fake fetch: metadata, a token endpoint that rotates, and the
 * three tools the bench uses. `notes` is what list_notes and read_note serve;
 * `written` collects write_note calls; `refreshes` the tokens presented.
 */
function fakeGateway({ notes = {} } = {}) {
  const state = { refreshes: [], written: [], registered: [], serial: 0 };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === "/.well-known/oauth-authorization-server") {
      return json({
        authorization_endpoint: "https://mcp.context.test/oauth/authorize",
        token_endpoint: "https://mcp.context.test/oauth/token",
        registration_endpoint: "https://mcp.context.test/oauth/register",
      });
    }
    if (pathname === "/oauth/register") {
      state.registered.push(JSON.parse(init.body));
      return json({ client_id: "client_bench_0001" }, 201);
    }
    if (pathname === "/oauth/token") {
      const params = new URLSearchParams(init.body);
      if (params.get("grant_type") === "refresh_token") {
        state.refreshes.push(params.get("refresh_token"));
        if (params.get("refresh_token") === "crt_retired") return json({ error: "invalid_grant" }, 400);
      } else if (params.get("grant_type") !== "authorization_code" || !params.get("code_verifier")) {
        return json({ error: "invalid_request" }, 400);
      }
      state.serial += 1;
      return json({ access_token: `cat_${state.serial}`, refresh_token: `crt_${state.serial}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (pathname === "/@context-lc/mcp") {
      if (init.headers.Authorization !== "Bearer cat_1") return new Response("", { status: 401 });
      const { params } = JSON.parse(init.body);
      const answer = (text, isError = false) => json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], isError } });
      if (params.name === "list_notes") {
        const lines = Object.keys(notes)
          .filter((path) => path.startsWith(`${params.arguments.prefix}/`))
          .sort()
          .map((path) => `${path} (${notes[path].length} bytes)`);
        return answer(lines.join("\n") || "(no visible notes under that prefix)");
      }
      if (params.name === "read_note") {
        const text = notes[params.arguments.path];
        if (text === undefined) return answer("not found", true);
        return answer(`etag: e-1\npath: ${params.arguments.path}\nvisibility: team\n\n${text}`);
      }
      if (params.name === "write_note") {
        // Like the gateway: replacing a note needs the etag read from it.
        if (notes[params.arguments.path] !== undefined && params.arguments.expected_etag !== "e-1") {
          return answer("conflict: a collaboratively edited note already exists; re-read it and include expected_etag to update it", true);
        }
        state.written.push(params.arguments);
        return answer(`saved ${params.arguments.path}`);
      }
      return answer(`no tool ${params.name}`, true);
    }
    return new Response("", { status: 404 });
  };
  return { fetchImpl, state };
}

async function tokenFile() {
  return join(await mkdtemp(join(tmpdir(), "bench-runner-")), "runner.json");
}

test("the live refresh token wins over the seed, and the file lands in the runner's temp", () => {
  const both = runnerEnv({ BENCH_RUNNER_REFRESH_TOKEN: "crt_seed", BENCH_RUNNER_REFRESH_TOKEN_LIVE: "crt_live", RUNNER_TEMP: "/runner/tmp" });
  assert.equal(both.refreshToken, "crt_live");
  assert.equal(both.tokenFile, join("/runner/tmp", "bench-runner.json"));
  assert.equal(runnerEnv({ BENCH_RUNNER_REFRESH_TOKEN: "crt_seed" }).refreshToken, "crt_seed");
  assert.equal(runnerEnv({}).endpoint, "https://mcp.context.lc/@context-lc/mcp");
});

test("signIn refreshes once, writes the rotated pair down first, and reuses it while it lasts", async () => {
  const { fetchImpl, state } = fakeGateway();
  const file = await tokenFile();
  const env = { BENCH_RUNNER_ENDPOINT: ENDPOINT, BENCH_RUNNER_CLIENT_ID: "client_bench_0001", BENCH_RUNNER_REFRESH_TOKEN: "crt_seed", BENCH_RUNNER_TOKEN_FILE: file };
  const first = await signIn({ env, fetchImpl });
  assert.equal(first.accessToken, "cat_1");
  assert.equal(first.refreshToken, "crt_1", "the rotated token is what the record holds");
  assert.deepEqual(state.refreshes, ["crt_seed"]);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.refreshToken, "crt_1", "written to the file before anything used it");
  assert.equal((await stat(file)).mode & 0o777, 0o600, "the file is the runner's alone");

  const again = await signIn({ env, fetchImpl });
  assert.equal(again.accessToken, "cat_1", "an unexpired sign-in is reused, not refreshed");
  assert.deepEqual(state.refreshes, ["crt_seed"]);

  // Expired: the file's own rotated token is what is presented, never the seed again.
  const later = await signIn({ env, fetchImpl, now: () => Date.now() + 2 * 3600 * 1000 });
  assert.equal(later.accessToken, "cat_2");
  assert.deepEqual(state.refreshes, ["crt_seed", "crt_1"]);
});

test("signIn says what is missing, and relays a refusal as its code", async () => {
  const { fetchImpl } = fakeGateway();
  const file = await tokenFile();
  await assert.rejects(signIn({ env: { BENCH_RUNNER_TOKEN_FILE: file }, fetchImpl }), /BENCH_RUNNER_CLIENT_ID and BENCH_RUNNER_REFRESH_TOKEN/);
  await assert.rejects(
    signIn({ env: { BENCH_RUNNER_ENDPOINT: ENDPOINT, BENCH_RUNNER_CLIENT_ID: "client_bench_0001", BENCH_RUNNER_REFRESH_TOKEN: "crt_retired", BENCH_RUNNER_TOKEN_FILE: file }, fetchImpl }),
    (error) => /refused \(invalid_grant\)/.test(error.message) && !/crt_/.test(error.message),
  );
});

test("a list_notes answer yields paths and a read_note answer splits into header and text", () => {
  assert.deepEqual(notePaths("ai/setups/search/a.md (12 bytes)\nai/setups/search/b.md (3 bytes)\n(no visible notes under that prefix)"), ["ai/setups/search/a.md", "ai/setups/search/b.md"]);
  const { header, content } = splitNote("etag: e-1\npath: ai/x.md\nvisibility: team\n\n---\njob: search\n---\n\nBody\n");
  assert.equal(header.etag, "e-1");
  assert.equal(header.visibility, "team");
  assert.equal(content, "---\njob: search\n---\n\nBody\n");
});

test("pullSetups replaces setups/<job>/ with the notes in Context, skipping the folder's about note", async () => {
  const notes = {
    "ai/setups/search/about.md": "What search setups are.\n",
    "ai/setups/search/everywhere.md": "---\njob: search\nsearch:\n  everywhere: true\n---\n\nEvery workspace.\n",
    "ai/setups/search/one.md": "---\njob: search\n---\n\nOne workspace.",
    "ai/setups/search/old/kept.md": "---\njob: search\n---\n\nNot directly under the folder.\n",
    "ai/setups/texting-assistant/guide.md": "---\njob: texting-assistant\n---\n\nAnother job.\n",
  };
  const { fetchImpl } = fakeGateway({ notes });
  const dir = await mkdtemp(join(tmpdir(), "bench-pull-"));
  await writeFile(join(dir, "stale.md"), "x");
  const connection = { endpoint: ENDPOINT, accessToken: "cat_1" };
  const pulled = await pullSetups({ job: "search", dir, connection, fetchImpl });
  assert.deepEqual(pulled.names, ["everywhere", "one"]);
  assert.deepEqual((await readdir(join(dir, "setups", "search"))).sort(), ["everywhere.md", "one.md"]);
  assert.equal(await readFile(join(dir, "setups", "search", "one.md"), "utf8"), "---\njob: search\n---\n\nOne workspace.\n", "a note gets its final newline");

  // A second pull after a setup is retired in Context leaves no stale file behind.
  delete notes["ai/setups/search/one.md"];
  await pullSetups({ job: "search", dir, connection, fetchImpl });
  assert.deepEqual(await readdir(join(dir, "setups", "search")), ["everywhere.md"]);

  await assert.rejects(pullSetups({ job: "nothing", dir, connection, fetchImpl }), /no setups in ai\/setups\/nothing\/ or ai\/production\/nothing\.md/);
  await assert.rejects(pullSetups({ job: "../x", dir, connection, fetchImpl }), /not a job name/);
});

test("pullSetups brings the job's skills folder too, and nothing deeper", async () => {
  const notes = {
    "ai/setups/texting-assistant/guide.md": "---\njob: texting-assistant\n---\n\nGuide.\n",
    "ai/setups/texting-assistant/skills/about.md": "What skills are.\n",
    "ai/setups/texting-assistant/skills/connect-chatgpt.md": "Open chatgpt.com/plugins.",
    "ai/setups/texting-assistant/skills/old/retired.md": "Not a skill.\n",
  };
  const { fetchImpl } = fakeGateway({ notes });
  const dir = await mkdtemp(join(tmpdir(), "bench-pull-skills-"));
  const connection = { endpoint: ENDPOINT, accessToken: "cat_1" };
  const pulled = await pullSetups({ job: "texting-assistant", dir, connection, fetchImpl });
  assert.deepEqual(pulled.names, ["guide"]);
  assert.deepEqual(pulled.skills, ["connect-chatgpt"]);
  assert.deepEqual(await readdir(join(dir, "setups", "texting-assistant", "skills")), ["connect-chatgpt.md"]);
  assert.equal(await readFile(join(dir, "setups", "texting-assistant", "skills", "connect-chatgpt.md"), "utf8"), "Open chatgpt.com/plugins.\n");
});

test("pullSetups runs the live setup as production, beside the setups being tried", async () => {
  const notes = {
    "ai/production/texting-assistant.md": "---\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nLive.\n",
    "ai/production/app-assistant.md": "---\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nAnother job.\n",
    "ai/setups/texting-assistant/guide.md": "---\njob: texting-assistant\n---\n\nGuide.\n",
    "ai/setups/texting-assistant/production.md": "---\njob: texting-assistant\n---\n\nAn old copy someone named production.\n",
  };
  const { fetchImpl } = fakeGateway({ notes });
  const dir = await mkdtemp(join(tmpdir(), "bench-pull-live-"));
  const connection = { endpoint: ENDPOINT, accessToken: "cat_1" };
  const pulled = await pullSetups({ job: "texting-assistant", dir, connection, fetchImpl });
  assert.deepEqual(pulled.names, ["guide", "production"]);
  assert.equal(await readFile(join(dir, "setups", "texting-assistant", "production.md"), "utf8"), notes["ai/production/texting-assistant.md"], "the live file wins over a setup of the same name");

  // A job with only a live setup still runs; one with neither is refused.
  delete notes["ai/setups/texting-assistant/guide.md"];
  delete notes["ai/setups/texting-assistant/production.md"];
  assert.deepEqual((await pullSetups({ job: "texting-assistant", dir, connection, fetchImpl })).names, ["production"]);
});

test("pullSetups takes the live skills over a setup's copy, and keeps a skill only a setup has", async () => {
  const notes = {
    "ai/production/texting-assistant.md": "---\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nLive.\n",
    "ai/production/skills/about.md": "What skills are.\n",
    "ai/production/skills/connect-chatgpt.md": "Live: open chatgpt.com/plugins.\n",
    "ai/setups/texting-assistant/guide.md": "---\njob: texting-assistant\n---\n\nGuide.\n",
    "ai/setups/texting-assistant/skills/connect-chatgpt.md": "Stale copy.\n",
    "ai/setups/texting-assistant/skills/draft-only.md": "New skill being tried.\n",
  };
  const { fetchImpl } = fakeGateway({ notes });
  const dir = await mkdtemp(join(tmpdir(), "bench-pull-live-skills-"));
  const pulled = await pullSetups({ job: "texting-assistant", dir, connection: { endpoint: ENDPOINT, accessToken: "cat_1" }, fetchImpl });
  assert.deepEqual(pulled.skills, ["connect-chatgpt", "draft-only"]);
  const skills = join(dir, "setups", "texting-assistant", "skills");
  assert.equal(await readFile(join(skills, "connect-chatgpt.md"), "utf8"), "Live: open chatgpt.com/plugins.\n");
  assert.equal(await readFile(join(skills, "draft-only.md"), "utf8"), "New skill being tried.\n");
});

test("pullSetups puts the tests edited in Context over the repository's copies", async () => {
  const notes = {
    "ai/setups/search/one.md": "---\njob: search\n---\n\nOne.\n",
    "ai/tests/about.md": "What tests are.\n",
    "ai/tests/core.md": "---\njob: texting-assistant\n---\n\n# Core, edited in the app\n",
    "ai/tests/old/retired.md": "Not a test list.\n",
  };
  const { fetchImpl } = fakeGateway({ notes });
  const dir = await mkdtemp(join(tmpdir(), "bench-pull-tests-"));
  await mkdir(join(dir, "tests"), { recursive: true });
  await writeFile(join(dir, "tests", "core.md"), "the repository's copy\n");
  await writeFile(join(dir, "tests", "search.md"), "only in the repository\n");
  const pulled = await pullSetups({ job: "search", dir, connection: { endpoint: ENDPOINT, accessToken: "cat_1" }, fetchImpl });
  assert.deepEqual(pulled.tests, ["core"]);
  assert.equal(await readFile(join(dir, "tests", "core.md"), "utf8"), notes["ai/tests/core.md"]);
  assert.equal(await readFile(join(dir, "tests", "search.md"), "utf8"), "only in the repository\n", "a test not in Context is left as it is");
  assert.deepEqual((await readdir(join(dir, "tests"))).sort(), ["core.md", "search.md"]);
});

const SCORED = [
  "---",
  "job: texting-assistant",
  "date: 2026-10-10",
  "code_commit: abc1234",
  "status: scored",
  "---",
  "",
  "# texting-assistant run",
  "",
  "## Summary",
  "",
  "| Setup | Model | Answers |",
  "| --- | --- | --- |",
  "| haiku | anthropic/claude-haiku-5-5 | 2 |",
  "",
  "## Answers",
  "",
  "### acorn-boot-linen-lagoon",
  "",
  "person: the secret question",
  "",
  "## Scored by anthropic/claude-haiku-5-5, 2026-10-10",
  "",
  "| setup | score |",
  "| --- | --- |",
  "| haiku | 67.9% |",
  "",
].join("\n");

test("the scores note carries the summary, the scores and the run, never an answer or an id", () => {
  const note = scoresNote(SCORED, { runUrl: "https://github.example/actions/runs/1" });
  assert.match(note, /^---\nrole: benchmark-scores\njob: texting-assistant\ndate: 2026-10-10\ncode_commit: abc1234\nstatus: scored\nrun: https:\/\/github.example\/actions\/runs\/1\n---\n/);
  assert.match(note, /\| haiku \| 67\.9% \|/);
  assert.match(note, /\| haiku \| anthropic\/claude-haiku-5-5 \| 2 \|/);
  assert.match(note, /benchmark-result, benchmark-key/);
  assert.doesNotMatch(note, /acorn-boot-linen-lagoon|secret question/);
  assert.equal(scoresPathFor("/tmp/x/2026-10-10 texting-assistant gh-12.md"), "ai/results/2026-10-10 texting-assistant gh-12 scores.md");
});

test("the scores note heads with the live setup's score, so a list of results can show it", () => {
  const raw = [
    "---",
    "job: texting-assistant",
    "test: core",
    "date: 2026-10-16",
    "status: scored",
    "---",
    "",
    "## Scored by claude-haiku-5-5, 2026-10-16",
    "",
    "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| guide | 100.0% | passed | 9 of 9 (100.0%) | $0.0100 | 5.0 s | 1.0 | 0 | yes |",
    "| production | 93.3% | failed (q5) | 8 of 9 (88.9%) | $0.0177 | 6.6 s | 1.2 | 0 | no |",
    "",
  ].join("\n");
  const note = scoresNote(raw);
  assert.match(note, /\ntest: core\n/);
  assert.match(note, /\nsetup: production\nscore: 93\.3%\ngates: failed \(q5\)\ngood_enough: no\n---/);
  // Without the live setup, the first row stands in; before scoring, nothing does.
  assert.match(scoresNote(raw.replace("| production |", "| other |")), /\nsetup: guide\nscore: 100\.0%\ngates: passed\ngood_enough: yes\n/);
  assert.doesNotMatch(scoresNote(SCORED.replace(/## Scored by[\s\S]*$/, "")), /\nscore:/);
});

test("the live row is read from the first table, so a case-by-case table below it is never a setup", () => {
  const head = ["---", "job: texting-assistant", "date: 2026-10-16", "status: scored", "---", "", "## Scored by claude-haiku-5-5, 2026-10-16", ""];
  const cases = ["### Case by case", "", "| case | guide | production |", "| --- | --- | --- |", "| 1. When's my dentist appointment? | 3 of 3 | 2 of 3 |", ""];
  // An empty setup table: the case row must not stand in for it.
  assert.equal(liveScoreRow([...head, "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |", "", ...cases].join("\n")), null);
  // With a setup table: its production row, and the case table's rows never read as setups.
  const scored = [...head, "| setup | score | gates | judge lines | price | speed | texts | errors | good enough |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |", "| guide | 100.0% | passed | 9 of 9 (100.0%) | $0.0100 | 5.0 s | 1.0 | 0 | yes |", "| production | 66.7% | failed (q1) | 8 of 9 (88.9%) | $0.0177 | 6.6 s | 1.2 | 0 | no |", "", ...cases].join("\n");
  assert.deepEqual(liveScoreRow(scored), { setup: "production", score: "66.7%", gates: "failed (q1)", goodEnough: "no" });
  // The published note carries the whole section, case table included, and still heads with the live row.
  const note = scoresNote(scored);
  assert.match(note, /\nsetup: production\nscore: 66\.7%\n/);
  assert.match(note, /### Case by case\n\n\| case \| guide \| production \|\n/);
  assert.match(note, /\| 1\. When's my dentist appointment\? \| 3 of 3 \| 2 of 3 \|/);
});

test("a search result's scores note keeps its misses", () => {
  const search = ["---", "job: search", "date: 2026-10-10", "status: scored", "---", "", "## Summary", "", "| Setup | Found |", "| --- | --- |", "| everywhere | 100% |", "", "## Misses", "", "### everywhere: 1 missed", "", "- 7. who left", "", "## Answers", "", "### 1. q", "", "hit list", ""].join("\n");
  const note = scoresNote(search);
  assert.match(note, /## Misses\n\n### everywhere: 1 missed/);
  assert.doesNotMatch(note, /hit list/);
});

test("publishResult writes the scores note beside the results in Context", async () => {
  const { fetchImpl, state } = fakeGateway();
  const dir = await mkdtemp(join(tmpdir(), "bench-publish-"));
  const result = join(dir, "2026-10-10 texting-assistant gh-3.md");
  await writeFile(result, SCORED);
  const path = await publishResult({ result, runUrl: "https://github.example/actions/runs/3", connection: { endpoint: ENDPOINT, accessToken: "cat_1" }, fetchImpl });
  assert.equal(path, "ai/results/2026-10-10 texting-assistant gh-3 scores.md");
  assert.equal(state.written.length, 1);
  assert.equal(state.written[0].path, path);
  assert.match(state.written[0].content, /run: https:\/\/github.example\/actions\/runs\/3/);
  assert.match(state.written[0].summary, /gh-3/);
});

test("publishResult replaces a scores note already there, as a re-judged run does", async () => {
  const path = "ai/results/2026-10-10 texting-assistant gh-3 scores.md";
  const { fetchImpl, state } = fakeGateway({ notes: { [path]: "---\nrole: benchmark-scores\n---\n\nthe first judging\n" } });
  const dir = await mkdtemp(join(tmpdir(), "bench-publish-"));
  const result = join(dir, "2026-10-10 texting-assistant gh-3.md");
  await writeFile(result, SCORED);
  assert.equal(await publishResult({ result, runUrl: null, connection: { endpoint: ENDPOINT, accessToken: "cat_1" }, fetchImpl }), path);
  assert.equal(state.written.length, 1);
  assert.equal(state.written[0].expected_etag, "e-1");
});

test("publishResult also writes the replies note score left beside the result", async () => {
  const { fetchImpl, state } = fakeGateway();
  const dir = await mkdtemp(join(tmpdir(), "bench-publish-"));
  const result = join(dir, "2026-10-10 texting-assistant gh-3.md");
  await writeFile(result, SCORED);
  await writeFile(join(dir, "2026-10-10 texting-assistant gh-3 replies.md"), "---\nrole: benchmark-replies\n---\n\n## 1. q\n");
  await publishResult({ result, runUrl: null, connection: { endpoint: ENDPOINT, accessToken: "cat_1" }, fetchImpl });
  assert.deepEqual(state.written.map((item) => item.path), ["ai/results/2026-10-10 texting-assistant gh-3 scores.md", "ai/results/2026-10-10 texting-assistant gh-3 replies.md"]);
  assert.match(state.written[1].content, /role: benchmark-replies/);
});

test("callTool throws on a transport failure and returns a refusal as isError", async () => {
  const { fetchImpl } = fakeGateway();
  await assert.rejects(callTool({ endpoint: ENDPOINT, accessToken: "cat_wrong" }, "list_notes", {}, fetchImpl), /answered 401/);
  const refused = await callTool({ endpoint: ENDPOINT, accessToken: "cat_1" }, "read_note", { path: "ai/none.md" }, fetchImpl);
  assert.equal(refused.isError, true);
});

test("connect registers a public client for the runner's scope, checks the state, and prints the two values once", async () => {
  const { fetchImpl, state } = fakeGateway();
  const printed = [];
  let sent = null;
  const listen = async () => ({
    redirectUri: "http://127.0.0.1:4242/context-bench/callback",
    waitForCode: async () => {
      const url = new URL(printed.find((line) => line.includes("https://mcp.context.test/oauth/authorize")).match(/https:\/\/\S+/)[0]);
      sent = url;
      return { code: "code-1", state: url.searchParams.get("state") };
    },
    close() {},
  });
  const { clientId } = await connect({ endpoint: ENDPOINT, fetchImpl, log: (line) => printed.push(line), listen });
  assert.equal(clientId, "client_bench_0001");
  assert.equal(state.registered[0].token_endpoint_auth_method, "none");
  assert.equal(state.registered[0].scope, "context:read context:write", "never the private tier");
  assert.equal(sent.searchParams.get("code_challenge_method"), "S256");
  assert.equal(sent.searchParams.get("resource"), ENDPOINT, "the grant is for the workspace the setups live in");
  const output = printed.join("\n");
  assert.match(output, /BENCH_RUNNER_CLIENT_ID=client_bench_0001/);
  assert.match(output, /BENCH_RUNNER_REFRESH_TOKEN=crt_1/);
  assert.doesNotMatch(output, /cat_1/, "the access token is dropped, never printed");

  const wrongState = async () => ({ ...(await listen()), waitForCode: async () => ({ code: "code-2", state: "forged" }) });
  await assert.rejects(connect({ endpoint: ENDPOINT, fetchImpl, log: () => {}, listen: wrongState }), /another state/);
});

test("an improver's draft is written as a new setup beside live, and never over one already there", async () => {
  const { fetchImpl, state } = fakeGateway({ notes: { "ai/setups/texting-assistant/taken.md": "---\n---\nmine\n" } });
  const connection = { endpoint: ENDPOINT, accessToken: "cat_1" };
  const dir = await mkdtemp(join(tmpdir(), "bench-draft-"));
  const file = join(dir, "draft.md");
  await writeFile(file, "---\njob: texting-assistant\n---\ndraft\n");
  assert.equal(await publishSetup({ job: "texting-assistant", name: "give-the-place", file, connection, fetchImpl }), "ai/setups/texting-assistant/give-the-place.md");
  assert.equal(state.written.length, 1);
  assert.equal(state.written[0].expected_etag, undefined);
  assert.match(state.written[0].content, /draft/);
  await assert.rejects(publishSetup({ job: "texting-assistant", name: "taken", file, connection, fetchImpl }), /already in Context/);
  await assert.rejects(publishSetup({ job: "texting-assistant", name: "production", file, connection, fetchImpl }), /not a setup to write/);
  await assert.rejects(publishSetup({ job: "texting-assistant", name: "../production", file, connection, fetchImpl }), /not a setup to write/);
  assert.equal(state.written.length, 1);
});
