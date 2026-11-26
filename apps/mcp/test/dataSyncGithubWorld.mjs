/**
 * The GitHub sync suites' shared world (`dataSyncGithub.test.mjs`, `dataSyncBackground.test.mjs`): the deployment's
 * read-only GitHub App with a test key, a workspace's github/ source, GitHub answered by host (the owner's token, the
 * installation's, the repositories, the pull requests and the runs), and the install calls through the worker.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";

import { parseSheet } from "../src/sheets/csv.js";
import { noteId, send, dataObject } from "./dataSyncWorld.mjs";

export const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
export const CLIENT_ID = "Iv1.testclient";
export const CLIENT_SECRET = "client-secret-for-tests";
export const CALLBACK = "https://context.lc/data/github/callback";
export const USER_TOKEN = "ghu_userTokenForTestsOnly0000";
export const INSTALL_TOKEN = "ghs_installTokenForTestsOnly00";
export const CODE = "oneTimeCode123";
export const INSTALLATION = "77";
export const ABOUT = "data/github/about.md";
export const ABOUT_TEXT = (source = "github") => `---\nsource: ${source}\nname: "GitHub"\n---\n\nConnected by an owner.\n`;

export function withGithubApp(w) {
  Object.assign(w.env, { GH_DATA_APP_ID: "4242", GH_DATA_PRIVATE_KEY: privateKey, GH_DATA_APP_SLUG: "context-data", GH_DATA_CLIENT_ID: CLIENT_ID, GH_DATA_CLIENT_SECRET: CLIENT_SECRET, APP_ORIGIN: "https://context.lc" });
}

/** A github/ source folder with its about.md and its three empty sheets. */
export async function withSource(w, who, source = "github") {
  const ids = { about: noteId(40, who.pwid), pulls: noteId(41, who.pwid), deploys: noteId(42, who.pwid), runs: noteId(43, who.pwid) };
  who.object.store.rows.put([
    { id: `d-gh-${who.pwid}`, path: "data/github", kind: "folder", at: 10 },
    { id: `f-gh-${who.pwid}`, path: ABOUT, kind: "file", at: 11, storageKey: `notes/${ids.about}.md`, noteId: ids.about, etag: "e-g" },
    { id: `f-pr-${who.pwid}`, path: "data/github/pull-requests.csv", kind: "file", at: 12, storageKey: `files/${ids.pulls}.csv`, noteId: ids.pulls, etag: "e-pr" },
    { id: `f-dp-${who.pwid}`, path: "data/github/deploys.csv", kind: "file", at: 13, storageKey: `files/${ids.deploys}.csv`, noteId: ids.deploys, etag: "e-dp" },
    { id: `f-wr-${who.pwid}`, path: "data/github/workflow-runs.csv", kind: "file", at: 14, storageKey: `files/${ids.runs}.csv`, noteId: ids.runs, etag: "e-wr" },
  ]);
  await who.object.store.objects.put(`notes/${ids.about}.md`, ABOUT_TEXT(source));
  for (const id of [ids.pulls, ids.deploys, ids.runs]) await who.bucket.put(`files/${id}.csv`, "");
  return ids;
}

/** A pull request as GitHub answers it; a merged one's squash commit is its number's letter, 40 times (#2 → "b"…). */
export const pr = (number, opened, merged, updated = merged ?? opened) => ({ number, title: `Change ${number}`, createdAt: opened, mergedAt: merged, updatedAt: updated, additions: 10 * number, deletions: number, author: { login: "dev" }, mergeCommit: merged && number <= 26 ? { oid: String.fromCharCode(96 + number).repeat(40) } : null });

/** GitHub as it answers, recording each call's host, path and the authorization it carried. */
export const DEPLOY_RUN = { id: 7001, name: "Deploy to Production", head_branch: `prod-deploy/${"c".repeat(40)}`, run_started_at: "2026-11-25T08:30:00Z", updated_at: "2026-11-25T08:50:00Z", conclusion: "failure" };
export const CI_RUN = { id: 5001, name: "CI", head_branch: "main", run_started_at: "2026-11-25T08:00:00Z", updated_at: "2026-11-25T08:09:00Z", conclusion: "success" };
/** The deploy workflow's runs per repo: the one deploy on a prod-deploy branch for supa/app, and a 404 for supa/context. */
const DEFAULT_DEPLOY_RUNS = (repo) => (repo === "supa/app" ? [DEPLOY_RUN] : new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));

export function github(w, { installations = [Number(INSTALLATION)], mintStatus = 200, repos = ["supa/app", "supa/context"], trade = null, deployRuns = DEFAULT_DEPLOY_RUNS, search = () => [], mainRuns = (repo) => (repo === "supa/app" ? [CI_RUN] : []) } = {}) {
  const seen = [];
  const auth = (init) => String(new Headers(init?.headers ?? {}).get("authorization") ?? "");
  w.net.answers.set("github.com", (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ host: "github.com", path: new URL(url).pathname, auth: auth(init), body });
    if (trade !== null) return trade(body);
    // GitHub answers a refused exchange 200, with its reason in the body and no token.
    const good = body.code === CODE && body.client_id === CLIENT_ID && body.client_secret === CLIENT_SECRET && body.redirect_uri === CALLBACK;
    return Response.json(good ? { access_token: USER_TOKEN } : { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
  });
  w.net.answers.set("api.github.com", (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const call = { host: "api.github.com", path: pathname, method: init?.method ?? "GET", auth: auth(init), body: init?.body ? JSON.parse(init.body) : null, query: searchParams };
    seen.push(call);
    if (pathname === "/user/installations") return call.auth === `Bearer ${USER_TOKEN}` ? Response.json({ installations: installations.map((id) => ({ id })) }) : new Response("{}", { status: 401 });
    if (pathname.startsWith("/applications/")) return new Response(null, { status: 204 });
    const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (minting) {
      const [head, claims, signature] = call.auth.replace(/^Bearer /, "").split(".");
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${head}.${claims}`);
      const signed = verifier.verify(publicKey, Buffer.from(signature, "base64url"));
      const iss = JSON.parse(Buffer.from(claims, "base64url").toString()).iss;
      if (!signed || iss !== "4242") return new Response("{}", { status: 401 });
      if (minting[1] !== INSTALLATION || mintStatus !== 200) return new Response("{}", { status: mintStatus === 200 ? 404 : mintStatus });
      return Response.json({ token: INSTALL_TOKEN });
    }
    if (call.auth !== `Bearer ${INSTALL_TOKEN}`) return new Response("{}", { status: 401 });
    if (pathname === "/installation/repositories") return Response.json({ repositories: repos.map((full_name) => ({ full_name, default_branch: "main", private: true })) });
    if (pathname === "/graphql") {
      const { query, variables } = call.body;
      call.repo = variables.owner ? `${variables.owner}/${variables.name}` : variables.q;
      if (query.includes("pullRequests")) {
        const nodes = variables.name === "app" ? [pr(2, "2026-11-24T09:00:00Z", "2026-11-24T10:00:00Z"), pr(1, "2026-11-20T09:00:00Z", null, "2026-11-24T08:00:00Z")] : [];
        return Response.json({ data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false } } } } });
      }
      if (query.includes("deployments")) {
        const nodes = variables.name === "app"
          ? [
              { databaseId: 902, commitOid: "b".repeat(40), environment: "production", createdAt: "2026-11-24T11:00:00Z", latestStatus: { state: "SUCCESS", createdAt: "2026-11-24T11:20:00Z" } },
              { databaseId: 901, commitOid: "a".repeat(40), environment: "production", createdAt: "2026-11-24T09:30:00Z", latestStatus: { state: "SUCCESS", createdAt: "2026-11-24T09:40:00Z" } },
            ]
          : [];
        return Response.json({ data: { repository: { deployments: { nodes, pageInfo: { hasNextPage: false } } } } });
      }
      return Response.json({ data: { search: { nodes: search(variables.q), pageInfo: { hasNextPage: false } } } });
    }
    const deploying = /^\/repos\/(.+)\/actions\/workflows\/([^/]+)\/runs$/.exec(pathname);
    if (deploying) {
      const answer = deployRuns(deploying[1]);
      return answer instanceof Response ? answer : Response.json({ workflow_runs: answer });
    }
    if (/\/actions\/runs$/.test(pathname)) return Response.json({ workflow_runs: mainRuns(pathname.replace(/^\/repos\/|\/actions\/runs$/g, "")) });
    return new Response("{}", { status: 404 });
  });
  return seen;
}

export const start = (w, who, about = ABOUT, options) => send(w, who, { workspaceId: who.pwid, op: "github_start", about }, options);
export const finish = (w, who, state, extra = {}) => send(w, who, { workspaceId: who.pwid, op: "github_finish", state, code: CODE, installation: INSTALLATION, ...extra });
export const sheet = async (who, id) => parseSheet((await (await who.bucket.get(`files/${id}.csv`))?.text()) ?? "");
export const stateOf = (answer) => new URL(answer.body.url).searchParams.get("state");

/** Every console line while `work` runs, so a test can say no token reached a log. */
export async function logsOf(work) {
  const lines = [];
  const was = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...parts) => lines.push(parts.join(" "));
  try {
    return { result: await work(), lines };
  } finally {
    Object.assign(console, was);
  }
}

export async function installed(w, options) {
  withGithubApp(w);
  const ids = await withSource(w, w.alice);
  const seen = github(w, options);
  const started = await start(w, w.alice);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return { ids, seen, state: stateOf(started) };
}


/** Finishes the install and runs the first sync the way production does, on the alarm; answers that run's last. */
export async function firstRun(w, state, who = w.alice) {
  const done = await finish(w, who, state);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const object = dataObject(w, who.pwid);
  await object.instance.alarm();
  const source = Object.values(object.storage.map.get("sources")).find((one) => one.kind === "app" && one.app === "github");
  return source?.last ?? null;
}
