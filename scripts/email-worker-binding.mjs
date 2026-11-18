#!/usr/bin/env node
/**
 * Prove a Worker has its required secrets bound, retrying a lagging list.
 *
 * `wrangler secret put` can report success and the secrets list can still
 * answer `(none)` a second later. Production run 44202720278 did that at
 * 23:52:59Z, one second after both puts, and the next email deploy listed
 * both names half a second after its own puts. No second production email
 * deploy overlapped that check, and staging's email deploy writes
 * `context-email-staging` and had already finished. The empty list was the
 * read arriving before the binding, so this looks again for about 30
 * seconds and then fails with the same words as the single read did.
 *
 * The email deploy asks for EMAIL_WORKER_SECRET and CONTROL_PLANE_URL, the
 * default. The transcribe deploy sets REQUIRED_SECRETS to
 * TRANSCRIBE_WORKER_SECRET (names on the command line mean the same thing).
 * Each missing name keeps its own failure text.
 *
 * Only names are printed. A row's value, the token and the account id are not.
 * Each list read aborts after 10 seconds so a hung request is retried instead
 * of waiting out the job.
 */
import { pathToFileURL } from "node:url";

const DEFAULT_REQUIRED = ["EMAIL_WORKER_SECRET", "CONTROL_PLANE_URL"];
/** Waits between reads. They add up to 30 seconds; the first read does not wait. */
export const BINDING_WAITS_MS = [2000, 4000, 8000, 16000];
/** One list read. A hung request aborts so the wait can try again. */
export const LIST_TIMEOUT_MS = 10_000;

const KIND_BY_NAME = {
  EMAIL_WORKER_SECRET: "email",
  CONTROL_PLANE_URL: "control",
  TRANSCRIBE_WORKER_SECRET: "transcribe",
};

/**
 * Names the run must see. A blank env keeps the email pair, so the email
 * workflow, which sets nothing here, does not change.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function requiredFromEnv(env = process.env) {
  const raw = env.REQUIRED_SECRETS;
  if (typeof raw !== "string" || raw.trim() === "") return [...DEFAULT_REQUIRED];
  const names = raw.split(",").map((part) => part.trim()).filter(Boolean);
  return names.length > 0 ? names : [...DEFAULT_REQUIRED];
}

/**
 * Command-line names win. Otherwise the env, otherwise the email pair.
 * @param {string[]} [argv]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function namesForRun(argv = [], env = process.env) {
  const args = argv.flatMap((arg) => String(arg).split(",")).map((part) => part.trim()).filter(Boolean);
  return args.length > 0 ? args : requiredFromEnv(env);
}

/**
 * @param {unknown} body
 * @param {string[]} [required]
 * @returns {{ ok: boolean, kind: string, missing?: string, names: string[], errors: unknown }}
 */
export function readBindings(body, required = DEFAULT_REQUIRED) {
  const payload = body && typeof body === "object" ? body : {};
  if (payload.success !== true) return { ok: false, kind: "list", names: [], errors: payload.errors ?? [] };
  const names = (Array.isArray(payload.result) ? payload.result : []).map((row) => (row && typeof row.name === "string" ? row.name : "")).filter(Boolean);
  for (const name of required) {
    if (!names.includes(name)) return { ok: false, kind: KIND_BY_NAME[name] ?? "missing", missing: name, names, errors: [] };
  }
  return { ok: true, kind: "ok", names, errors: [] };
}

/** The failure text the deploy step already used. Names only. */
export function explain(state) {
  if (state.kind === "list") return `[FAIL] could not list the Worker secrets: ${JSON.stringify(state.errors)}`;
  const bound = state.names.length ? state.names.join(", ") : "(none)";
  if (state.kind === "email") {
    return [
      "[FAIL] EMAIL_WORKER_SECRET is not bound to this Worker.",
      `       Bound secrets: ${bound}`,
      "       Without it every control-plane call is answered 401 and",
      "       every message is refused.",
    ].join("\n");
  }
  if (state.kind === "transcribe") {
    return [
      "[FAIL] TRANSCRIBE_WORKER_SECRET is not bound to this Worker.",
      `       Bound secrets: ${bound}`,
      "       Without it every transcribe call is answered 401.",
    ].join("\n");
  }
  if (state.kind === "missing") {
    return [
      `[FAIL] ${state.missing} is not bound to this Worker.`,
      `       Bound secrets: ${bound}`,
    ].join("\n");
  }
  return [
    "[FAIL] CONTROL_PLANE_URL is not bound to this Worker AS A SECRET.",
    `       Bound secrets: ${bound}`,
    "       If the Worker still carries it as a plaintext VAR from a",
    "       deploy predating the move to wrangler secrets, the secret",
    "       could not be created: \"Binding name ... already in use\"",
    "       [code: 10053]. The deploy step drops that var, which is why",
    "       it runs before the secret sync. Without this value the",
    "       Worker cannot reach the control plane, and every message is",
    "       left to the runtime to retry.",
  ].join("\n");
}

/** The success line for this name set. The email line stays the one the step printed. */
export function readyLine(required = DEFAULT_REQUIRED) {
  const emailPair = required.length === DEFAULT_REQUIRED.length && required.every((name, index) => name === DEFAULT_REQUIRED[index]);
  if (emailPair) return "[ok] EMAIL_WORKER_SECRET and CONTROL_PLANE_URL are bound as secrets.";
  if (required.length === 1 && required[0] === "TRANSCRIBE_WORKER_SECRET") return "[ok] TRANSCRIBE_WORKER_SECRET is bound.";
  const joined = required.join(", ");
  return `[ok] ${joined} ${required.length === 1 ? "is" : "are"} bound.`;
}

/**
 * Read until every required name is bound, or the waits run out.
 * @param {{ request: () => Promise<unknown>, sleep: (ms: number) => Promise<void>, now: () => number, budgetMs?: number, waits?: number[], required?: string[], log?: (line: string) => void }} options
 */
export async function waitForBindings({ request, sleep, now, budgetMs = 30_000, waits = BINDING_WAITS_MS, required = DEFAULT_REQUIRED, log = () => {} }) {
  const start = now();
  let state = readBindings(null, required);
  for (let attempt = 0; ; attempt++) {
    try {
      state = readBindings(await request(), required);
    } catch {
      state = { ok: false, kind: "list", names: [], errors: [{ message: "the secrets list did not answer" }] };
    }
    if (state.ok) return { ...state, attempts: attempt + 1 };
    const wait = waits[attempt];
    const left = budgetMs - (now() - start);
    if (wait === undefined || left <= 0) return { ...state, attempts: attempt + 1 };
    const pause = Math.min(wait, left);
    log(`Binding list not ready (attempt ${attempt + 1}, ${state.names.join(", ") || "(none)"}); looking again in ${Math.round(pause / 1000)}s.`);
    await sleep(pause);
  }
}

/**
 * One secrets-list read. The signal aborts a hung request so the caller can retry.
 * @param {{ url: string, token: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 */
export function secretsRequest({ url, token, timeoutMs = LIST_TIMEOUT_MS, fetchImpl = fetch }) {
  return async () => {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await response.json();
  };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const worker = process.env.WORKER_NAME;
  const required = namesForRun(process.argv.slice(2), process.env);
  if (!token || !account || !worker) {
    console.error("[FAIL] CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and WORKER_NAME are required to list bindings.");
    process.exit(1);
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets`;
  const state = await waitForBindings({
    request: secretsRequest({ url, token }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
    required,
  });
  if (!state.ok) {
    console.error(explain(state));
    process.exit(1);
  }
  console.log(readyLine(required));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
