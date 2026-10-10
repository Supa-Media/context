/**
 * The bench's connection to Context (`bench/context.mjs`): a sign-in that
 * keeps the rotated refresh token where the next run reads it, the setups
 * pulled from `ai/setups/<job>/`, and the scores note written back to
 * `ai/results/` with nothing a judge must not see.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callTool, connect, notePaths, pullSetups, publishResult, runnerEnv, scoresNote, scoresPathFor, signIn, splitNote } from "../context.mjs";

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

  await assert.rejects(pullSetups({ job: "nothing", dir, connection, fetchImpl }), /no setups in ai\/setups\/nothing\//);
  await assert.rejects(pullSetups({ job: "../x", dir, connection, fetchImpl }), /not a job name/);
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
