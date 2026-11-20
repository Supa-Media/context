/**
 * Tex's computer node, `computer` (on the node shelf until a Lab draft wires `tools -> computer`;
 * `../../texComputerSandbox.js`, `infra/tex-computer`). One call to the chat's own Linux computer: run a command, read,
 * write or list a file in its work folder, or stop it. No model: it asks the `TEX_COMPUTER` service and hands back the
 * answer in its schema's fields. Never throws: a missing binding or a failed call is `{ ok: false, error }`.
 */
const OWNER = /^[0-9a-f]{64}$/;
const OPS = new Set(["run", "read", "write", "list", "stop"]);
/** The longest one call may take: the command's own limit plus a wake. */
export const COMPUTER_CALL_MS = 150_000;

const OUT = ["ok", "error", "exitCode", "stdout", "stderr", "timedOut", "started", "text", "binary", "bytes", "entries", "folder", "more", "stopped", "woke", "ms"];

/** Only the fields the node's schema names, with the right types. */
export function computerOut(value, ms) {
  const out = { ok: value?.ok === true, ms: Number.isFinite(value?.ms) ? value.ms : ms };
  for (const key of OUT) {
    if (key === "ok" || key === "ms" || value?.[key] === undefined || value?.[key] === null) continue;
    out[key] = value[key];
  }
  if (out.ok !== true && typeof out.error !== "string" && !Number.isFinite(out.exitCode) && out.timedOut !== true) out.error = "the computer did not answer";
  return out;
}

export async function computerNode(input, io) {
  const started = Date.now();
  const env = io?.ctx?.env ?? io?.ctx?.turn?.env ?? null;
  const service = env?.TEX_COMPUTER;
  if (!service || typeof service.fetch !== "function") return { ok: false, error: "this deployment has no computer for Tex. Use the browser or ask them instead.", ms: 0 };
  const { op, owner, ...rest } = input ?? {};
  if (!OPS.has(op) || typeof owner !== "string" || !OWNER.test(owner)) return { ok: false, error: "not a call this computer takes. Use run, read, write, list or stop, then try again.", ms: 0 };
  const timer = new AbortController();
  const stop = setTimeout(() => timer.abort(), COMPUTER_CALL_MS);
  try {
    const response = await service.fetch(`https://tex-computer/computer/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, ...rest }),
      signal: timer.signal,
    });
    const value = await response.json().catch(() => null);
    return computerOut(value ?? { ok: false, error: `the computer answered ${response.status}. Wait a moment, then try again.` }, Date.now() - started);
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "the computer took too long. Use a shorter command, then try again." : "the computer could not be reached. Wait a moment, then try again.", ms: Date.now() - started };
  } finally {
    clearTimeout(stop);
  }
}
