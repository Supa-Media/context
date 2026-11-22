#!/usr/bin/env node
/**
 * Carries one Lab test chat's calls between production's Lab and a pull request's preview (Dev2, 2026-11-22: test
 * chats gain "run on PR #N's code"; it runs on that pull request's own preview, with fictional people and stand-in mail
 * and calendar, never production's data). Run by `.github/workflows/lab-preview-chat.yml`, on main, which production's
 * Lab starts when someone opens a test chat with `code: "#N"`.
 *
 * Neither side is given the other's keys:
 *  - On the preview, it signs the fictional alpha persona in with the preview deploy key CI already holds (as
 *    `agent-sign-in.mjs` does) and mints alpha a console grant there. Alpha is the preview's Tex developer
 *    (`convex-env.mjs` `PREVIEW_STAFF`, owner of its pinned `context-lc`), so the preview's own `/tex-lab/sandbox`
 *    answers it, running the pull request's code.
 *  - On production, it reaches only the test chat's mailbox (`/tex-lab/sandbox/bridge`,
 *    `packages/lab/gateway/labSandbox/preview.js`), with GitHub's signed token for this workflow on main. Production
 *    checks GitHub's signature; nothing is kept for it anywhere.
 *
 * It takes the calls waiting, hands each to the preview and its answer back, and stops when the test chat is reset,
 * after `IDLE_MS` with no call, or before the job's own time runs out; the next call then starts another run.
 *
 * This repository's Actions logs are public: it prints counts and statuses only, never a call or an answer.
 */
import { pathToFileURL } from "node:url";

export const PRODUCTION_ORIGIN = "https://mcp.context.lc";
export const AUDIENCE = "context-lab-preview";
export const IDLE_MS = 20 * 60_000;
export const LIFETIME_MS = 50 * 60_000;
/** A console grant lasts an hour; one older than this is minted again. */
const GRANT_REFRESH_MS = 40 * 60_000;
/** GitHub's signed token is asked for again after this. */
const TOKEN_REFRESH_MS = 4 * 60_000;
const CALL_TIMEOUT_MS = 60_000;

const BRIDGE_ID = /^[0-9a-f]{32}$/;
const PR = /^[1-9][0-9]{0,6}$/;

/** GitHub's signed token for this job, naming the mailbox's audience. */
export async function githubToken(env = process.env, fetchImpl = fetch) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("This job has no GitHub token to ask for (id-token: write).");
  const response = await fetchImpl(`${url}&audience=${AUDIENCE}`, { headers: { authorization: `bearer ${bearer}` } });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.value !== "string") throw new Error(`GitHub gave no signed token (${response.status}).`);
  return body.value;
}

/** Alpha signed in on the preview, and a console grant for alpha's own workspace there: the Lab's own door. */
async function previewGrantForReal({ deployment, deployKey }) {
  const [{ ConvexHttpClient }, { makeFunctionReference: ref }, { issuePersonaCode }] = await Promise.all([
    import("convex/browser"),
    import("convex/server"),
    import("./seed.mjs"),
  ]);
  const email = "alpha@supa.media";
  const client = new ConvexHttpClient(`https://${deployment}.convex.cloud`, { logger: false });
  const code = issuePersonaCode(email, { deployment, deployKey });
  const signed = await client.action(ref("auth:signIn"), { provider: "email", params: { email, code } });
  if (!signed?.tokens?.token) throw new Error("Signing alpha in on the preview failed.");
  client.setAuth(signed.tokens.token);
  const workspaces = await client.query(ref("functions/workspaces:listMyWorkspaces"), {});
  const own = (workspaces ?? []).find((w) => w.kind === "personal" && w.role === "owner" && !w.pinned);
  if (!own) throw new Error("Alpha has no personal workspace on the preview.");
  const grant = await client.action(ref("functions/agentGrant:mintConsoleGrant"), { workspaceId: own.workspaceId });
  if (typeof grant?.accessToken !== "string") throw new Error("The preview minted alpha no console grant.");
  return grant.accessToken;
}

/**
 * The loop. Everything it reaches is passed in, so a test runs it against fakes: `prod(body)` is a call to the
 * mailbox, `preview(body)` one to the preview's `/tex-lab/sandbox` (each `{ status, answer }`).
 */
export async function carry({ pr, prod, preview, now = Date.now, log = console.log, idleMs = IDLE_MS, lifetimeMs = LIFETIME_MS }) {
  const started = now();
  let lastCall = now();
  let carried = 0;
  const inFlight = new Set();
  while (true) {
    if (now() - lastCall > idleMs) {
      log(`No call for ${Math.round(idleMs / 60_000)} minutes: stopping (the next call starts another run).`);
      break;
    }
    if (now() - started > lifetimeMs) {
      log("This run's time is up: stopping (the next call starts another run).");
      break;
    }
    const taken = await prod({ op: "take", waitMs: 20_000 });
    if (taken.status !== 200) {
      log(`The mailbox answered ${taken.status}: stopping.`);
      if (taken.status === 403 || taken.status === 400) process.exitCode = 1;
      break;
    }
    const said = taken.answer ?? {};
    if (said.stop) {
      log("The test chat was reset: stopping.");
      break;
    }
    if (said.refused) {
      log("Another run holds this test chat: stopping.");
      break;
    }
    if (said.pr !== pr) {
      log("The mailbox names another pull request: stopping.");
      process.exitCode = 1;
      break;
    }
    const calls = Array.isArray(said.calls) ? said.calls : [];
    if (calls.length === 0) continue;
    lastCall = now();
    for (const call of calls) {
      // Each call answered on its own, so a long one (a text's run card) never holds up a quick one (a `get`).
      const work = (async () => {
        const answered = await preview(call.body).catch(() => ({ status: 502, answer: { error: "The preview could not be reached." } }));
        await prod({ op: "answer", n: call.n, status: answered.status, answer: answered.answer }).catch(() => null);
        carried += 1;
        if (carried % 20 === 0) log(`${carried} calls carried.`);
      })();
      inFlight.add(work);
      work.finally(() => inFlight.delete(work));
    }
  }
  await Promise.allSettled([...inFlight]);
  log(`${carried} calls carried in all.`);
  return carried;
}

/** CI: the whole run, from the workflow's environment. */
export async function main(env = process.env, { fetchImpl = fetch, previewGrant = previewGrantForReal, find, log = console.log } = {}) {
  const pr = String(env.PR ?? "");
  if (!PR.test(pr)) throw new Error("PR must be a pull request number.");
  const bridge = String(env.BRIDGE ?? "");
  if (!BRIDGE_ID.test(bridge)) throw new Error("BRIDGE must be a test chat's mailbox id.");
  const gateway = new URL(String(env.PREVIEW_GATEWAY_ORIGIN ?? ""));
  if (gateway.protocol !== "https:" || !gateway.hostname.startsWith(`context-mcp-pr${pr}.`) || !gateway.hostname.endsWith(".workers.dev")) {
    throw new Error("PREVIEW_GATEWAY_ORIGIN must be this pull request's preview gateway.");
  }
  const deployKey = env.CONVEX_DEPLOY_KEY;
  if (typeof deployKey !== "string" || !deployKey.startsWith("preview:")) throw new Error("CONVEX_DEPLOY_KEY must be a preview deploy key.");
  const findPreview = find ?? (await import("./teardown.mjs")).findConvexPreview;
  const deployment = await findPreview(deployKey, `pr${pr}`, { fetchImpl });
  if (deployment === null) throw new Error(`Pull request #${pr} has no preview deployment.`);

  let grant = { token: await previewGrant({ deployment, deployKey }), at: Date.now() };
  log(`Signed alpha in on preview pr${pr}.`);
  let signed = { token: null, at: 0 };
  const prodOrigin = String(env.PRODUCTION_ORIGIN ?? PRODUCTION_ORIGIN);

  const post = async (url, token, body) => {
    const response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    return { status: response.status, answer: await response.json().catch(() => null) };
  };
  const prod = async (body) => {
    if (signed.token === null || Date.now() - signed.at > TOKEN_REFRESH_MS) signed = { token: await githubToken(env, fetchImpl), at: Date.now() };
    return await post(`${prodOrigin}/tex-lab/sandbox/bridge`, signed.token, { ...body, bridge });
  };
  const preview = async (body) => {
    if (Date.now() - grant.at > GRANT_REFRESH_MS) grant = { token: await previewGrant({ deployment, deployKey }), at: Date.now() };
    return await post(`${gateway.origin}/tex-lab/sandbox`, grant.token, body);
  };
  return await carry({ pr: Number(pr), prod, preview, log });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`::error::${String(error?.message ?? error).slice(0, 300)}`);
    process.exit(1);
  });
}
