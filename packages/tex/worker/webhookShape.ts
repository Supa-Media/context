/**
 * A webhook delivery this Worker does not act on, described by its shape only
 * (Dev2, 2026-11-06: capture what the providers send before designing how
 * events enter conversations; `docs/decisions/texting-assistant/provider-events.md`).
 *
 * The record names the provider, the event's type and method when they are
 * plain codes, and every key path with its value's type. Never a value: no
 * phone number, id, text or media. A key that could itself be a value (a phone
 * number or hash used as a map key) is written `*`.
 */

const SAFE_KEY = /^[a-z_][a-z0-9_]{0,40}$/i;
const MAX_DEPTH = 5;
const MAX_PATHS = 120;

/** Each key path and its value's type, sorted: `messages_updates[].id:string`. */
export function shapeOf(value: unknown): string[] {
  const paths = new Set<string>();
  const walk = (node: unknown, path: string, depth: number): void => {
    const type = node === null ? "null" : Array.isArray(node) ? "array" : typeof node;
    if (path !== "") paths.add(`${path}:${type}`);
    if (depth >= MAX_DEPTH || paths.size >= MAX_PATHS) return;
    if (Array.isArray(node)) for (const item of node.slice(0, 5)) walk(item, `${path}[]`, depth + 1);
    else if (type === "object") {
      for (const [key, item] of Object.entries(node as Record<string, unknown>).slice(0, 60)) {
        walk(item, `${path === "" ? "" : `${path}.`}${safeKey(key)}`, depth + 1);
      }
    }
  };
  walk(value, "", 0);
  return [...paths].sort().slice(0, MAX_PATHS);
}

function safeKey(key: string): string {
  return SAFE_KEY.test(key) && !/\d{5}/.test(key) ? key : "*";
}

/** A plain code (`messages`, `patch`, `DELIVERED`), or `other`; `none` when absent. */
function code(value: unknown): string {
  if (value === undefined || value === null) return "none";
  return typeof value === "string" && /^[a-z][a-z_]{0,29}$/i.test(value) ? value : "other";
}

export function logEventShape(provider: "sendblue" | "whapi", type: unknown, method: unknown, payload: unknown, outcome: string): void {
  const top = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? Object.keys(payload).map(safeKey).sort().slice(0, 20) : [];
  console.log(
    JSON.stringify({
      event: `${provider}_event_shape`,
      outcome,
      type: code(type),
      method: code(method),
      keys: top.join(":"),
      shape: shapeOf(payload),
    }),
  );
}

/** Sendblue names a delivery's kind and status in its own fields, read only as codes; answered 200 so it is not retried. */
export function logSendblueShape(payload: unknown, outcome: string): Response {
  const record = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  logEventShape("sendblue", record.message_type ?? record.type ?? record.event, record.status, payload, outcome);
  return new Response(null, { status: 200 });
}
