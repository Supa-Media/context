/**
 * An MCP client whose person says yes, at once, to whatever the egress gate
 * holds.
 *
 * The gate (`src/privacy/egress.js`, decided 2026-10-09) holds every call from
 * an MCP client that would widen who can see something — a link, a publish, a
 * visibility change, a move into a wider folder or another workspace — until
 * the person approves it from a first-party surface. Most of this suite
 * exercises what those tools *do* once they run, and was written when an MCP
 * client's call ran at once; it still tests exactly that, through a helper
 * that approves on the person's behalf from the console and calls again, which
 * is the path a held call takes in the product. The gate itself, and what it
 * refuses, is `agentEgress.test.mjs` and `egress.test.mjs`; nothing here
 * weakens it, because the console grant these helpers approve with is the
 * same first-party grant the app holds.
 */
import worker from "../src/index.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { callKey } from "../src/tools/approvals.js";

/** Whether a tool result is the gate holding the call. */
export function isHeld(result) {
  if (result?.isError !== true) return false;
  const text = result?.content?.[0]?.text;
  return typeof text === "string" && /^Not done: this would /.test(text);
}

/**
 * Approve the approval waiting for exactly this call (or, with no call named,
 * the newest) for this console grant's person; true when one was.
 */
export async function releaseNewest(env, consoleToken, origin = "https://mcp.context.test", call = null) {
  const listing = createWorkerCtx();
  const list = await worker.fetch(
    new Request(`${origin}/approvals`, { headers: { Authorization: `Bearer ${consoleToken}` } }),
    env,
    listing.ctx,
  );
  const body = await list.json().catch(() => null);
  await listing.settle();
  const wanted = call === null ? null : callKey(call.name, call.args);
  const newest =
    wanted === null
      ? body?.approvals?.[0]
      : body?.approvals?.find((row) => callKey(row.tool, row.args) === wanted);
  if (!newest) return false;
  const answering = createWorkerCtx();
  const answer = await worker.fetch(
    new Request(`${origin}/approvals`, {
      method: "POST",
      headers: { Authorization: `Bearer ${consoleToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: newest.id, action: "approve" }),
    }),
    env,
    answering.ctx,
  );
  await answer.text();
  await answering.settle();
  return answer.status === 200;
}

/**
 * Run `once()` — a function returning the raw tool result — and, when the
 * gate held it, approve as the person and run it again, which hands back what
 * the person released. `consoleToken` is the person's own console grant on
 * the workspace the client connected to; without one, the held result is
 * returned as it was.
 */
export async function approving(once, { env, consoleToken, origin, call = null }) {
  const first = await once();
  if (!isHeld(first) || !consoleToken) return first;
  const released = await releaseNewest(env, consoleToken, origin, call);
  if (process.env.EGRESS_TRACE) console.log("EGRESS_TRACE held:", JSON.stringify(call), "released:", released);
  if (!released) return first;
  const again = await once();
  if (process.env.EGRESS_TRACE) console.log("EGRESS_TRACE again:", JSON.stringify(again).slice(0, 300));
  return again;
}
