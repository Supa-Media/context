/**
 * THE BENCH'S OWN CONNECTION TO CONTEXT: WHERE THE SETUPS COME FROM AND
 * WHERE THE SCORES GO.
 *
 * Decided by the owner (2026-10-10): the setups and the production files are
 * what a person edits and promotes, so they live in `@context-lc ai/`, where
 * they can be read and changed in the app, and promoting is a copy within one
 * folder; the workspaces and the question lists are fixtures that change in
 * the same commit as the code, so they stay in the repository. A round's
 * scores are something a person reads and compares, so they go back to
 * `ai/results/` by themselves; the answers and the key stay the Action's
 * artifacts (big, and the key never sits beside the result). The one
 * exception is the replies note (`./replies.mjs`): a bounded few replies,
 * only where the setups differ, for Compare in the console.
 *
 * The connection is an ordinary OAuth grant of a test account that is a
 * member of `@context-lc`, made once by a person with `pnpm ai connect` and
 * kept as a client id and a refresh token. The gateway rotates the refresh
 * token on every use and revokes the grant when a retired one is presented,
 * which is the right behaviour and the one thing a runner has to plan for:
 * `signIn` writes the rotated token to a file the Action then puts back into
 * its own secret (`BENCH_RUNNER_REFRESH_TOKEN_LIVE`) before it does anything
 * else, the way the sentry worker's token broker keeps its own pair. The seed
 * from 1Password (`BENCH_RUNNER_REFRESH_TOKEN`) is only used when no live
 * token exists, and a sync from the vault must never touch the live one: it
 * would restore the retired seed and the next run would read as a replay.
 *
 * Nothing here prints a token. `connect` prints the two values once, for
 * 1Password; `signIn --show refresh-token` prints the live one for the
 * Action's secret write, and the Action masks it first.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { repliesName } from "./replies.mjs";
import { section, summaryMarkdown } from "./summary.mjs";

/** The workspace the setups and the results live in, addressed as the MCP endpoint. */
export const DEFAULT_ENDPOINT = "https://mcp.context.lc/@context-lc/mcp";
export const SETUPS_FOLDER = "ai/setups";
export const RESULTS_FOLDER = "ai/results";
/** What the product runs today: `<job>.md` and the skills it names (`src/agent/production.js`). */
export const PRODUCTION_FOLDER = "ai/production";
/** The test lists a person edits; each replaces the repository's copy of the same name. */
export const TESTS_FOLDER = "ai/tests";
/** The name the live setup runs under, so a round can always measure what people get. */
export const LIVE_SETUP = "production";
/** Read the setups, write the scores; never the private tier. */
export const RUNNER_SCOPE = "context:read context:write";
export const RUNNER_CLIENT_NAME = "Benchmark runner (GitHub Actions)";
const LOOPBACK_PATH = "/context-bench/callback";
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
/** An access token is treated as spent this long before it is. */
const EXPIRY_SKEW_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** What the runner reads from its environment. The live token wins over the seed. */
export function runnerEnv(env = process.env) {
  return {
    endpoint: env.BENCH_RUNNER_ENDPOINT || DEFAULT_ENDPOINT,
    clientId: env.BENCH_RUNNER_CLIENT_ID || null,
    refreshToken: env.BENCH_RUNNER_REFRESH_TOKEN_LIVE || env.BENCH_RUNNER_REFRESH_TOKEN || null,
    tokenFile: env.BENCH_RUNNER_TOKEN_FILE || join(env.RUNNER_TEMP || tmpdir(), "bench-runner.json"),
  };
}

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function withTimeout(fetchImpl, ms = REQUEST_TIMEOUT_MS) {
  return async (url, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The authorization server's endpoints, from the gateway's own metadata.
 * Every endpoint must be https: these are where a code and a token are sent.
 */
export async function discover(endpoint, fetchImpl = fetch) {
  const origin = new URL(endpoint).origin;
  const response = await withTimeout(fetchImpl)(`${origin}/.well-known/oauth-authorization-server`);
  if (!response.ok) throw new Error(`${origin} published no OAuth metadata (${response.status})`);
  const metadata = await response.json();
  const pick = (key) => {
    const value = metadata[key];
    if (typeof value !== "string" || !value.startsWith("https://")) throw new Error(`OAuth metadata from ${origin} has no https ${key}`);
    return value;
  };
  return {
    resource: endpoint,
    authorizationEndpoint: pick("authorization_endpoint"),
    tokenEndpoint: pick("token_endpoint"),
    registrationEndpoint: pick("registration_endpoint"),
  };
}

async function postToken(discovery, params, fetchImpl) {
  const response = await withTimeout(fetchImpl)(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await response.json().catch(() => null);
  // The code, never the prose: this is read in a job log.
  if (!response.ok || typeof body?.access_token !== "string") throw new Error(`the token request was refused (${body?.error || response.status})`);
  if (typeof body.refresh_token !== "string" || !body.refresh_token) throw new Error("the token response carried no refresh token");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Math.max(0, Number(body.expires_in) || 3600) * 1000 - EXPIRY_SKEW_MS,
  };
}

/** A fresh pair from a refresh token. The one presented is retired by this call. */
export async function refreshGrant({ endpoint, clientId, refreshToken }, fetchImpl = fetch) {
  const discovery = await discover(endpoint, fetchImpl);
  return postToken(discovery, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: endpoint }, fetchImpl);
}

async function readSaved(file) {
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    return null;
  }
}

/**
 * A usable sign-in for the runner: the saved one while its access token
 * lasts, else a refresh (from the saved refresh token first, then the
 * environment's), written back to the file before it is used, because a
 * rotated token that is spent and not written down is a grant lost.
 */
export async function signIn({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const runner = runnerEnv(env);
  const saved = await readSaved(runner.tokenFile);
  if (saved?.accessToken && Number(saved.expiresAt) > now() && saved.endpoint === runner.endpoint) return saved;
  const refreshToken = saved?.refreshToken || runner.refreshToken;
  if (!runner.clientId || !refreshToken) {
    throw new Error("not signed in: set BENCH_RUNNER_CLIENT_ID and BENCH_RUNNER_REFRESH_TOKEN (from `pnpm ai connect`), as environment variables only");
  }
  const pair = await refreshGrant({ endpoint: runner.endpoint, clientId: runner.clientId, refreshToken }, fetchImpl);
  const record = { endpoint: runner.endpoint, clientId: runner.clientId, ...pair };
  await mkdir(dirname(runner.tokenFile), { recursive: true });
  await writeFile(runner.tokenFile, JSON.stringify(record), { mode: 0o600 });
  return record;
}

/** One `tools/call`. Throws on a transport failure; a refusal comes back as `isError`. */
export async function callTool({ endpoint, accessToken }, name, args = {}, fetchImpl = fetch) {
  const response = await withTimeout(fetchImpl)(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error(`${name}: the gateway answered ${response.status}`);
  const body = await response.json().catch(() => null);
  if (!body || body.error) throw new Error(`${name}: ${body?.error?.message || "no answer"}`);
  const text = (body.result?.content || []).filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  return { text, isError: body.result?.isError === true };
}

/** The note paths in a `list_notes` answer. */
export function notePaths(text) {
  return text.split("\n").map((line) => line.match(/^(\S.*?\.md) \(\d+ bytes\)$/)?.[1]).filter(Boolean);
}

/** A `read_note` answer split into its header lines and the note's text. */
export function splitNote(text) {
  const at = text.indexOf("\n\n");
  const header = {};
  for (const line of (at === -1 ? text : text.slice(0, at)).split("\n")) {
    const m = line.match(/^([a-z_]+): (.*)$/);
    if (m) header[m[1]] = m[2];
  }
  return { header, content: at === -1 ? "" : text.slice(at + 2) };
}

/**
 * Everything a round of `job` reads from Context, into the bench folder,
 * replacing what was there so nothing retired in Context still runs from a
 * stale file. `about.md` is a folder's description and is never pulled.
 *
 *  - `ai/setups/<job>/*.md` into `setups/<job>/`: the setups being tried.
 *  - `ai/production/<job>.md` into `setups/<job>/production.md`: the live
 *    setup, so a round measures what people get today (decided by the owner,
 *    2026-10-16: tests run "with the latest agents and the latest skills").
 *    It wins over a setup someone named `production`.
 *  - `ai/production/skills/` into `setups/<job>/skills/`: the skills the live
 *    setup reads. A skill only in `ai/setups/<job>/skills/` is added beside
 *    them for a setup trying something new; a copy there of a live skill is
 *    ignored, because a round must never grade a stale copy as the live one.
 *  - `ai/tests/*.md` into `tests/`: each replaces the repository's test of the
 *    same name, so a test edited in the app is the one that runs. The
 *    repository's copies stay, for a run with no connection.
 */
export async function pullSetups({ job, dir, connection, fetchImpl = fetch }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(job)) throw new Error(`not a job name: ${job}`);
  const prefix = `${SETUPS_FOLDER}/${job}`;
  const listed = await listPaths(connection, prefix, fetchImpl);
  const production = await listPaths(connection, PRODUCTION_FOLDER, fetchImpl);
  const livePath = `${PRODUCTION_FOLDER}/${job}.md`;
  const live = production.includes(livePath);
  const paths = listed.filter((path) => dirname(path) === prefix && basename(path) !== "about.md" && basename(path) !== `${LIVE_SETUP}.md`);
  if (paths.length === 0 && !live) throw new Error(`no setups in ${prefix}/ or ${livePath} in Context: write one there (the production file's format) and run again`);
  const folder = join(dir, "setups", job);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const names = [];
  for (const path of paths) {
    await writeFile(join(folder, basename(path)), await readContent(connection, path, fetchImpl));
    names.push(basename(path, ".md"));
  }
  if (live) {
    await writeFile(join(folder, `${LIVE_SETUP}.md`), await readContent(connection, livePath, fetchImpl));
    names.push(LIVE_SETUP);
  }
  // The live skills first, then any skill only a setup being tried has.
  const skills = [];
  const skillSources = [
    ...production.filter((p) => dirname(p) === `${PRODUCTION_FOLDER}/skills`),
    ...listed.filter((p) => dirname(p) === `${prefix}/skills`),
  ].filter((p) => basename(p) !== "about.md");
  for (const path of skillSources) {
    const name = basename(path, ".md");
    if (skills.includes(name)) continue;
    await mkdir(join(folder, "skills"), { recursive: true });
    await writeFile(join(folder, "skills", basename(path)), await readContent(connection, path, fetchImpl));
    skills.push(name);
  }
  const tests = [];
  for (const path of (await listPaths(connection, TESTS_FOLDER, fetchImpl)).filter((p) => dirname(p) === TESTS_FOLDER && basename(p) !== "about.md")) {
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "tests", basename(path)), await readContent(connection, path, fetchImpl));
    tests.push(basename(path, ".md"));
  }
  return { folder, names, skills, tests };
}

/** The note paths under `prefix`, at any depth. A folder that is not there is empty. */
async function listPaths(connection, prefix, fetchImpl) {
  const listed = await callTool(connection, "list_notes", { prefix }, fetchImpl);
  if (listed.isError) throw new Error(`list_notes ${prefix}: ${listed.text}`);
  return notePaths(listed.text);
}

/** One note's text, ending in a newline. */
async function readContent(connection, path, fetchImpl) {
  const read = await callTool(connection, "read_note", { path }, fetchImpl);
  if (read.isError) throw new Error(`read_note ${path}: ${read.text}`);
  const { content } = splitNote(read.text);
  return content.endsWith("\n") ? content : `${content}\n`;
}

/**
 * The scores note for a result: the front matter a reader filters on, the
 * run's summary and latest scores (a search result's misses too), and where
 * the answers and the key are. Never an answer, never an id.
 */
export function scoresNote(raw, { runUrl = null, date = new Date().toISOString().slice(0, 10) } = {}) {
  const front = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const pick = (key) => front.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1] ?? null;
  const job = pick("job") ?? "unknown";
  const lines = ["---", "role: benchmark-scores", `job: ${job}`, `date: ${pick("date") ?? date}`];
  if (pick("test")) lines.push(`test: ${pick("test")}`);
  if (pick("code_commit")) lines.push(`code_commit: ${pick("code_commit")}`);
  if (pick("status")) lines.push(`status: ${pick("status")}`);
  // The live setup's row, so a list of results (admin/AI) reads it without opening the note.
  const live = liveScoreRow(raw);
  if (live) lines.push(`setup: ${live.setup}`, `score: ${live.score}`, `gates: ${live.gates}`, `good_enough: ${live.goodEnough}`);
  if (runUrl) lines.push(`run: ${runUrl}`);
  lines.push("---", "", `# ${job}, ${pick("date") ?? date}: scores`, "");
  lines.push(
    runUrl
      ? `Written by the AI Benchmark Action. The answers and the key are that run's artifacts (benchmark-result, benchmark-key): ${runUrl}`
      : "Written by `pnpm ai publish`. The answers and the key are on the machine that ran it.",
    "",
  );
  lines.push(summaryMarkdown(raw).trim());
  const misses = section(raw, "Misses");
  if (misses) lines.push("", misses);
  return `${lines.join("\n")}\n`;
}

/**
 * From the latest "## Scored by" table: the `production` setup's row, or the
 * first row when the round did not run the live setup. `null` before scoring.
 */
export function liveScoreRow(raw) {
  const at = raw.lastIndexOf("\n## Scored by ");
  if (at === -1) return null;
  // The first table only: the case-by-case table below it has case rows, not setup rows.
  const rows = [];
  let inTable = false;
  for (const line of raw.slice(at).split("\n")) {
    if (!line.startsWith("| ")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    if (line.startsWith("| setup ") || line.startsWith("| ---")) continue;
    rows.push(line.slice(2, -2).split(" | ").map((cell) => cell.trim()));
  }
  const row = rows.find((cells) => cells[0] === LIVE_SETUP) ?? rows[0];
  if (!row || row.length < 3) return null;
  const clean = (value) => String(value ?? "").replace(/[^\w %.(),-]/g, "").trim();
  return { setup: clean(row[0]), score: clean(row[1]), gates: clean(row[2]), goodEnough: clean(row[8] ?? "") || "unknown" };
}

/** Where a result's scores note goes: beside the results, named after the result. */
export function scoresPathFor(resultFile) {
  return `${RESULTS_FOLDER}/${basename(resultFile, ".md")} scores.md`;
}

/** Write a result's scores note into `ai/results/` in Context. */
export async function publishResult({ result, runUrl = null, connection, fetchImpl = fetch }) {
  const raw = await readFile(result, "utf8");
  const path = scoresPathFor(result);
  // A re-judged run (`judge_run_id`) writes the same scores note again, and
  // the gateway replaces a note only for the etag read from it.
  const existing = await callTool(connection, "read_note", { path }, fetchImpl);
  const etag = existing.isError ? null : (splitNote(existing.text).header.etag ?? null);
  const written = await callTool(
    connection,
    "write_note",
    {
      path,
      content: scoresNote(raw, { runUrl }),
      summary: `benchmark scores for ${basename(result, ".md")}`,
      ...(etag ? { expected_etag: etag } : {}),
    },
    fetchImpl,
  );
  if (written.isError) throw new Error(`write_note ${path}: ${written.text}`);
  await publishReplies({ result, connection, fetchImpl });
  return path;
}

/** Where a result's replies note goes in Context: beside its scores note. */
export function repliesPathFor(resultFile) {
  return `${RESULTS_FOLDER}/${repliesName(basename(resultFile, ".md"))}`;
}

/** The replies note `score` wrote beside the result, when the setups differed anywhere. */
async function publishReplies({ result, connection, fetchImpl }) {
  let text;
  try {
    text = await readFile(join(dirname(result), repliesName(basename(result, ".md"))), "utf8");
  } catch {
    return null;
  }
  const path = repliesPathFor(result);
  const existing = await callTool(connection, "read_note", { path }, fetchImpl);
  const etag = existing.isError ? null : (splitNote(existing.text).header.etag ?? null);
  const written = await callTool(
    connection,
    "write_note",
    { path, content: text, summary: `benchmark replies for ${basename(result, ".md")}`, ...(etag ? { expected_etag: etag } : {}) },
    fetchImpl,
  );
  if (written.isError) throw new Error(`write_note ${path}: ${written.text}`);
  return path;
}

/* ----------------------------- connect, once ----------------------------- */

function listenForCode({ timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const server = createServer();
  return new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      let settle;
      const result = new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
      result.catch(() => {});
      const timer = setTimeout(() => {
        settle.reject(new Error("timed out waiting for the browser to come back"));
        server.close();
      }, timeoutMs);
      timer.unref?.();
      server.on("request", (request, response) => {
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== LOOPBACK_PATH) {
          response.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        response.writeHead(200, { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>Context</title><body style="font:15px system-ui;padding:3rem;max-width:32rem">` +
            (error ? `<h1>Not connected</h1><p>The sign-in was refused. You can close this tab.</p>` : `<h1>Benchmark runner connected</h1><p>You can close this tab and return to your terminal.</p>`) +
            `</body>`,
        );
        clearTimeout(timer);
        server.close();
        if (error) settle.reject(new Error(`authorization failed: ${error.replace(/[^a-z_]/g, "")}`));
        else settle.resolve({ code: url.searchParams.get("code") || "", state: url.searchParams.get("state") || "" });
      });
      resolveListening({ redirectUri: `http://127.0.0.1:${port}${LOOPBACK_PATH}`, waitForCode: () => result, close: () => server.close() });
    });
  });
}

/**
 * Register the runner as its own public OAuth client and complete the
 * consent once, over a loopback redirect, signed in as the test account.
 * Prints the two values 1Password keeps, and nothing else that is a secret.
 */
export async function connect({ endpoint = DEFAULT_ENDPOINT, fetchImpl = fetch, log = console.log, listen = listenForCode } = {}) {
  const discovery = await discover(endpoint, fetchImpl);
  const listener = await listen();
  try {
    const registration = await withTimeout(fetchImpl)(discovery.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: RUNNER_CLIENT_NAME,
        redirect_uris: [`http://127.0.0.1${LOOPBACK_PATH}`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: RUNNER_SCOPE,
      }),
    });
    if (!registration.ok) throw new Error(`client registration was refused (${registration.status})`);
    const { client_id: clientId } = await registration.json();
    if (typeof clientId !== "string" || !clientId) throw new Error("client registration returned no client_id");

    const verifier = base64Url(randomBytes(64));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(24));
    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", listener.redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", RUNNER_SCOPE);
    url.searchParams.set("resource", endpoint);
    log(`Open this in a browser signed in as the test account, and approve ${RUNNER_CLIENT_NAME} for the workspace:\n\n  ${url.href}\n`);

    const { code, state: returned } = await listener.waitForCode();
    if (returned !== state) throw new Error("the browser came back with another state; start again");
    const pair = await postToken(
      discovery,
      { grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier, redirect_uri: listener.redirectUri, resource: endpoint },
      fetchImpl,
    );
    log(
      [
        "Connected. Put these two in 1Password as the production environment's secrets, and nowhere else: never in a note, a chat, a commit or a log.",
        "",
        `BENCH_RUNNER_CLIENT_ID=${clientId}`,
        `BENCH_RUNNER_REFRESH_TOKEN=${pair.refreshToken}`,
        "",
        "Then run Sync Secrets. The first benchmark run spends this refresh token and keeps the rotated one in BENCH_RUNNER_REFRESH_TOKEN_LIVE by itself.",
      ].join("\n"),
    );
    return { clientId };
  } finally {
    listener.close();
  }
}

/* ------------------------------- commands -------------------------------- */

/** `pnpm ai signin [--show refresh-token]`: sign in to the file; `--show` prints one stored value. */
export async function signInCommand(options) {
  const record = await signIn({ env: process.env });
  if (options.show === "refresh-token") process.stdout.write(`${record.refreshToken}\n`);
  else if (options.show) throw new Error("--show takes refresh-token");
  else process.stderr.write("signed in as the benchmark runner\n");
}

/** `pnpm ai pull <job> [--dir <folder>]`: the job's setups from Context into the bench folder. */
export async function pullCommand(options, dir) {
  if (!options.job) throw new Error("usage: pnpm ai pull <job> [--dir <benchmarks folder>]");
  const connection = await signIn({ env: process.env });
  const { folder, names, skills, tests } = await pullSetups({ job: options.job, dir, connection });
  process.stderr.write(`pulled ${names.length} setup${names.length === 1 ? "" : "s"} into ${folder}: ${names.join(", ")}\n`);
  if (skills.length) process.stderr.write(`pulled ${skills.length} skill${skills.length === 1 ? "" : "s"}: ${skills.join(", ")}\n`);
  if (tests.length) process.stderr.write(`pulled ${tests.length} test${tests.length === 1 ? "" : "s"}: ${tests.join(", ")}\n`);
}

/** `pnpm ai publish <result file> [--run-url <url>]`: the result's scores note into Context. */
export async function publishCommand(options) {
  if (!options.job) throw new Error("usage: pnpm ai publish <result file> [--run-url <url>]");
  const connection = await signIn({ env: process.env });
  const path = await publishResult({ result: options.job, runUrl: options["run-url"] ?? null, connection });
  process.stderr.write(`wrote ${path} in Context\n`);
}

/**
 * `pnpm ai connect [--endpoint <url>]`: the one-time consent, by a person.
 * Written to stderr: `run.mjs` silences console.log unless `--verbose`, and
 * the URL to open and the two values to keep are the whole point of this.
 */
export async function connectCommand(options) {
  await connect({ endpoint: options.endpoint || DEFAULT_ENDPOINT, log: (text) => process.stderr.write(`${text}\n`) });
}
