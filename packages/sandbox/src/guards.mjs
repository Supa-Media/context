#!/usr/bin/env node

/**
 * Guards that run in CI around a preview deploy.
 *
 *   silence [workflowPath]        the deploy workflow names no texting, SMS, email or billing secret or variable,
 *                                 and puts only allowed secret names on the preview Workers (static, before any deploy)
 *   worker-secrets <workerName>   stdin is a deployed preview Worker's `wrangler secret list --format json`: it holds
 *                                 no texting, SMS, email or billing name, and no name the workflow never puts
 *   identity --before-deploy      the Convex deploy key must be a preview's, and name no production resource
 *                                 (run before the deploy, when the preview's URL does not exist yet)
 *   identity                      the same, and the preview's Convex URL must be a preview one too
 *   agent-health <origin>         the deployed texting Worker reports no live line, and its texts simulator answers
 *
 * Every problem names a variable or a check, never the value that failed it. The subdomain is an account
 * identifier, so the agent origin is never printed either.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Texting-line secrets: a preview must never be able to send a text on a real line. Only names the
 * deploy reads belong here: Photon's are the two that scripts/deploy-photon-bridge.yml reads. The list
 * is what `silence` and `worker-secrets` refuse, and what packages/sandbox/src/convex-env.mjs removes from
 * the preview's Convex deployment.
 */
export const TEXTING_LINE_KEYS = [
  "LINQ_API_KEY",
  "LINQ_WEBHOOK_SECRET",
  "SENDBLUE_API_KEY_ID",
  "SENDBLUE_API_SECRET",
  "SENDBLUE_WEBHOOK_SECRET",
  "SENDBLUE_STATUS_URL",
  "WHAPI_TOKEN",
  "WHAPI_LINE",
  "WHAPI_WEBHOOK_SECRET",
  "PHOTON_PROJECT_ID",
  "PHOTON_PROJECT_SECRET",
  "TEX_LINE_NUMBERS",
];

/** SMS sign-in texts (Twilio), real email (Resend) and billing webhooks (Stripe). */
export const SMS_EMAIL_BILLING_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_VERIFY_SERVICE_SID",
  "TWILIO_MESSAGING_SERVICE_SID",
  "RESEND_API_KEY",
  "STRIPE_WEBHOOK_SECRET",
];

export const FORBIDDEN_PREVIEW_KEYS = [...TEXTING_LINE_KEYS, ...SMS_EMAIL_BILLING_KEYS];

/**
 * Health flags that must be false on a preview. The texting Worker reports Linq's flags as `webhook` and
 * `replies` (from LINQ_WEBHOOK_SECRET and LINQ_API_KEY); the prefixes cover the rest of each vendor's flags.
 */
export const HEALTH_FORBIDDEN_KEYS = ["webhook", "replies"];
export const HEALTH_FORBIDDEN_PREFIXES = ["linq", "sendblue", "whapi", "photon"];

function nonEmpty(value) {
  return typeof value === "string" && value !== "";
}

/** Names of the preview deny-list entries (PREVIEW_DENY_IDENTIFIERS, comma, space or newline separated). */
function denyEntries(env) {
  return (env.PREVIEW_DENY_IDENTIFIERS ?? "").split(/[\s,]+/).filter((entry) => entry !== "");
}

/** Problems when any texting, SMS, email or billing key is set. Names only. */
export function silenceProblems(env = process.env) {
  return FORBIDDEN_PREVIEW_KEYS
    .filter((key) => nonEmpty(env[key]))
    .map((key) => `${key} is set; a preview must have no texting, SMS, email or billing key`);
}

/**
 * The only secret names the preview workflow may put on a preview Worker (`wrangler secret put` or
 * `worker-secrets.mjs`). A name outside this list is refused, so a new secret needs a line here.
 */
export const PREVIEW_WORKER_SECRET_NAMES = [
  "CONTROL_PLANE_URL",
  "CONTROL_PLANE_ORIGIN",
  "GATEWAY_SECRET",
  "TRANSCRIBE_WORKER_SECRET",
  "TRANSCRIBE_WORKER_URL",
  "BRAVE_SEARCH_API_KEY",
  "GOOGLE_MAPS_KEY",
  "AI_GATEWAY_ACCOUNT_ID",
  "AI_GATEWAY_ID",
  "AI_GATEWAY_TOKEN",
  "AI_GATEWAY_KEY_ALIASES",
  "AI_KEY_USE",
  "ANTHROPIC_CREDIT_KEY",
  "AGENT_WORKER_SECRET",
  "CONVEX_ORIGIN",
];

/** Static check of the deploy workflow text. Names only, never values. */
export function workflowSilenceProblems(text) {
  const forbidden = new Set(FORBIDDEN_PREVIEW_KEYS);
  const allowed = new Set(PREVIEW_WORKER_SECRET_NAMES);
  const problems = new Set();
  const lines = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
  const body = lines.join("\n");

  for (const match of body.matchAll(/\b(secrets|vars)\.([A-Za-z0-9_]+)/g)) {
    const [, word, name] = match;
    if (forbidden.has(name)) problems.add(`deploy-preview.yml reads ${word}.${name}; a preview must never receive a texting, SMS, email or billing key`);
  }
  for (const line of lines) {
    const mapping = /^\s+([A-Za-z0-9_]+):/.exec(line);
    if (mapping && forbidden.has(mapping[1])) {
      problems.add(`deploy-preview.yml maps ${mapping[1]} into an environment; a preview must never receive a texting, SMS, email or billing key`);
    }
  }
  for (const match of body.matchAll(/wrangler\s+secret\s+put\s+([A-Za-z0-9_]+)/g)) {
    if (!allowed.has(match[1])) problems.add(`deploy-preview.yml puts ${match[1]} on a preview Worker, which the preview workflow never puts`);
  }
  for (const match of body.matchAll(/convex\s+env\s+set\s+([A-Za-z0-9_]+)/g)) {
    if (!allowed.has(match[1])) problems.add(`deploy-preview.yml sets ${match[1]} on the Convex deployment, which the preview workflow never sets`);
  }
  let workerSecretsLines = 0;
  for (const line of lines) {
    const at = line.search(/\bscripts\/worker-secrets\.mjs\b/);
    if (at === -1) continue;
    workerSecretsLines += 1;
    // Stop at a pipe; drop the line-continuation backslash so it is not read as a name.
    const args = line.slice(at).split("|")[0].replace(/\\\s*$/, "");
    const tokens = args.split(/\s+/).slice(1).filter((token) => token !== "");
    for (const raw of tokens) {
      const unquoted = raw.replace(/^['"]+|['"]+$/g, "").replace(/^[?!]/, "");
      const target = unquoted.split("=")[0];
      if (target !== "" && !allowed.has(target)) {
        problems.add(`deploy-preview.yml passes ${target} to worker-secrets.mjs, which the preview workflow never puts`);
      }
    }
  }
  if (workerSecretsLines === 0 && /wrangler\s+secret\s+bulk/.test(body)) {
    problems.add("deploy-preview.yml runs wrangler secret bulk without a scripts/worker-secrets.mjs line to feed it");
  }
  // wrangler appends -<env> to --name on secret commands, so --env with --name sends the secret to another Worker.
  // Continuations are joined first, so a command split over lines is read whole.
  for (const logical of lines.join("\n").replace(/\\\n/g, " ").split("\n")) {
    const at = logical.search(/wrangler\s+secret\b/);
    if (at === -1) continue;
    const command = logical.slice(at).split(/[|;]|&&/)[0];
    if (/--env\b/.test(command) && /--name\b/.test(command)) {
      problems.add('deploy-preview.yml runs "wrangler secret" with both --env and --name; wrangler appends -<env> to the name, so the secret lands on another Worker');
    }
  }
  return [...problems];
}

/**
 * Problems in one deployed preview Worker's secret list (stdout of `wrangler secret list --format json`).
 * Wrangler may print lines around the JSON array, so the array is the text from the first `[` to the last `]`.
 */
export function workerSecretListProblems(worker, listText) {
  const forbidden = new Set(FORBIDDEN_PREVIEW_KEYS);
  const allowed = new Set(PREVIEW_WORKER_SECRET_NAMES);
  const start = listText.indexOf("[");
  const end = listText.lastIndexOf("]");
  let entries = null;
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(listText.slice(start, end + 1));
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      entries = null;
    }
  }
  if (entries === null) return [`${worker}: the secret list could not be read`];
  const problems = new Set();
  for (const entry of entries) {
    const name = entry !== null && typeof entry === "object" ? entry.name : undefined;
    if (typeof name !== "string") continue;
    if (forbidden.has(name)) problems.add(`${worker} has ${name} set; a preview must have no texting, SMS, email or billing key`);
    else if (!allowed.has(name)) problems.add(`${worker} has ${name} set, which the preview workflow never puts`);
  }
  return [...problems];
}

/**
 * Problems with the preview's Convex identity: a preview deploy key, no production names and, unless
 * `beforeDeploy`, a preview URL too. Before the deploy there is no URL yet (the deploy creates the
 * deployment), so checking it then would fail every run; the URL is checked after the deploy.
 */
export function identityProblems(env = process.env, { beforeDeploy = false } = {}) {
  const problems = [];
  const deployKey = env.CONVEX_DEPLOY_KEY ?? "";
  const previewUrl = env.PREVIEW_CONVEX_URL ?? "";
  if (!deployKey.startsWith("preview:")) {
    problems.push('CONVEX_DEPLOY_KEY must be a preview deploy key (it must start with "preview:")');
  }
  if (!beforeDeploy && !/^https:\/\/[a-z0-9][a-z0-9-]*\.convex\.cloud$/.test(previewUrl)) {
    problems.push("PREVIEW_CONVEX_URL must be https://<name>.convex.cloud");
  }
  const values = [["CONVEX_DEPLOY_KEY", deployKey]];
  if (!beforeDeploy) values.push(["PREVIEW_CONVEX_URL", previewUrl]);
  for (const [name, value] of values) {
    if (denyEntries(env).some((entry) => value.includes(entry))) {
      problems.push(`${name} names a production deployment or resource (PREVIEW_DENY_IDENTIFIERS)`);
    }
    if (nonEmpty(env.STAGING_CONVEX_DEPLOYMENT) && value.includes(env.STAGING_CONVEX_DEPLOYMENT)) {
      problems.push(`${name} names the staging Convex deployment`);
    }
  }
  return problems;
}

function isForbiddenHealthKey(key) {
  const lower = key.toLowerCase();
  return HEALTH_FORBIDDEN_KEYS.includes(key) || HEALTH_FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Problems in the texting Worker's /health JSON: any live-line flag that is true. The health answer holds
 * booleans for presence only, so a true flag means that secret is set on this Worker.
 */
export function healthProblems(health) {
  if (health === null || typeof health !== "object" || Array.isArray(health)) {
    return ["/health did not answer a JSON object"];
  }
  const problems = [];
  const walk = (value) => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (child === true && isForbiddenHealthKey(key)) {
        problems.push(`/health reports ${key} as on; a preview must have no live line`);
      }
      walk(child);
    }
  };
  walk(health);
  return problems;
}

/**
 * The agent Worker's checks: /health reports no live line, and /texts-simulator answers 200, so the
 * simulator is on and a made-up phone is the only way to text it. `fetchImpl` is injectable for tests.
 */
export async function agentHealthProblems(origin, fetchImpl = fetch) {
  let base;
  try {
    base = new URL(origin);
  } catch {
    return ["the agent origin is not a URL"];
  }
  if (base.protocol !== "https:") return ["the agent origin is not https"];
  const problems = [];
  let health;
  try {
    const response = await fetchImpl(new URL("/health", base));
    if (response.status !== 200) {
      problems.push(`/health answered ${response.status}, expected 200`);
    } else {
      health = await response.json();
    }
  } catch {
    problems.push("/health could not be read as JSON");
  }
  if (health !== undefined) problems.push(...healthProblems(health));
  try {
    const simulator = await fetchImpl(new URL("/texts-simulator", base));
    if (simulator.status !== 200) problems.push(`/texts-simulator answered ${simulator.status}, expected 200`);
  } catch {
    problems.push("/texts-simulator could not be reached");
  }
  return problems;
}

function report(name, problems) {
  for (const problem of problems) process.stderr.write(`${name}: ${problem}\n`);
  if (problems.length === 0) process.stdout.write(`${name}: ok\n`);
  return problems.length === 0 ? 0 : 1;
}

const DEPLOY_WORKFLOW = new URL("../../../.github/workflows/deploy-preview.yml", import.meta.url);

/** Reads all of stdin as text. */
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv) {
  const [command, origin] = argv;
  if (command === "silence") {
    let text;
    try {
      text = readFileSync(origin ?? DEPLOY_WORKFLOW, "utf8");
    } catch {
      return report("silence", ["the deploy workflow file could not be read"]);
    }
    return report("silence", workflowSilenceProblems(text));
  }
  if (command === "worker-secrets" && typeof origin === "string") {
    return report("worker-secrets", workerSecretListProblems(origin, await readStdin()));
  }
  if (command === "identity" && origin === undefined) return report("identity", identityProblems(process.env));
  if (command === "identity" && origin === "--before-deploy") {
    return report("identity", identityProblems(process.env, { beforeDeploy: true }));
  }
  if (command === "agent-health" && typeof origin === "string") {
    // The Worker can take a minute to answer after deploy, so retry /health a few times before failing.
    let problems = [];
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      problems = await agentHealthProblems(origin);
      if (!problems.some((problem) => problem.startsWith("/health answered"))) break;
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
    return report("agent-health", problems);
  }
  process.stderr.write("usage: guards.mjs silence [workflowPath] | worker-secrets <workerName> | identity [--before-deploy] | agent-health <agentOrigin>\n");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
