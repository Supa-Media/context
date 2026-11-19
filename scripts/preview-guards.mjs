#!/usr/bin/env node

/**
 * Guards that run in CI around a preview deploy.
 *
 *   silence                  no texting, SMS, email or billing key may be set in the preview's environment
 *   identity                 the preview's Convex deploy key and URL must be preview ones, and name no production resource
 *   agent-health <origin>    the deployed texting Worker reports no live line, and its texts simulator answers
 *
 * Every problem names a variable or a check, never the value that failed it. The subdomain is an account
 * identifier, so the agent origin is never printed either.
 */
import { pathToFileURL } from "node:url";

/** Texting-line secrets: a preview must never be able to send a text on a real line. */
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
  "PHOTON_SECRET_KEY",
  "PHOTON_API_KEY",
  "PHOTON_WEBHOOK_SECRET",
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

/** Problems with the preview's Convex identity: a preview deploy key, a preview URL, and no production names. */
export function identityProblems(env = process.env) {
  const problems = [];
  const deployKey = env.CONVEX_DEPLOY_KEY ?? "";
  const previewUrl = env.PREVIEW_CONVEX_URL ?? "";
  if (!deployKey.startsWith("preview:")) {
    problems.push('CONVEX_DEPLOY_KEY must be a preview deploy key (it must start with "preview:")');
  }
  if (!/^https:\/\/[a-z0-9][a-z0-9-]*\.convex\.cloud$/.test(previewUrl)) {
    problems.push("PREVIEW_CONVEX_URL must be https://<name>.convex.cloud");
  }
  const values = [
    ["CONVEX_DEPLOY_KEY", deployKey],
    ["PREVIEW_CONVEX_URL", previewUrl],
  ];
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

async function main(argv) {
  const [command, origin] = argv;
  if (command === "silence") return report("silence", silenceProblems(process.env));
  if (command === "identity") return report("identity", identityProblems(process.env));
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
  process.stderr.write("usage: preview-guards.mjs silence | identity | agent-health <agentOrigin>\n");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
