#!/usr/bin/env node
/**
 * Prove `context-email` has its two secrets bound, retrying a lagging list.
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
 * Only names are printed. A row's value, the token and the account id are not.
 */
import { pathToFileURL } from "node:url";

const REQUIRED = ["EMAIL_WORKER_SECRET", "CONTROL_PLANE_URL"];
/** Waits between reads. They add up to 30 seconds; the first read does not wait. */
export const BINDING_WAITS_MS = [2000, 4000, 8000, 16000];

/**
 * @param {unknown} body
 * @returns {{ ok: boolean, kind: "ok" | "list" | "email" | "control", names: string[], errors: unknown }}
 */
export function readBindings(body) {
  const payload = body && typeof body === "object" ? body : {};
  if (payload.success !== true) return { ok: false, kind: "list", names: [], errors: payload.errors ?? [] };
  const names = (Array.isArray(payload.result) ? payload.result : []).map((row) => (row && typeof row.name === "string" ? row.name : "")).filter(Boolean);
  if (!names.includes(REQUIRED[0])) return { ok: false, kind: "email", names, errors: [] };
  if (!names.includes(REQUIRED[1])) return { ok: false, kind: "control", names, errors: [] };
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

/**
 * Read until both names are bound, or the waits run out.
 * @param {{ request: () => Promise<unknown>, sleep: (ms: number) => Promise<void>, now: () => number, budgetMs?: number, waits?: number[], log?: (line: string) => void }} options
 */
export async function waitForBindings({ request, sleep, now, budgetMs = 30_000, waits = BINDING_WAITS_MS, log = () => {} }) {
  const start = now();
  let state = readBindings(null);
  for (let attempt = 0; ; attempt++) {
    try {
      state = readBindings(await request());
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

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const worker = process.env.WORKER_NAME;
  if (!token || !account || !worker) {
    console.error("[FAIL] CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and WORKER_NAME are required to list bindings.");
    process.exit(1);
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets`;
  const state = await waitForBindings({
    request: async () => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return await response.json();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
  if (!state.ok) {
    console.error(explain(state));
    process.exit(1);
  }
  console.log("[ok] EMAIL_WORKER_SECRET and CONTROL_PLANE_URL are bound as secrets.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
