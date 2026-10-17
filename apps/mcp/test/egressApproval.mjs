/**
 * An MCP client whose person says yes, at once, to whatever is held for them.
 *
 * Since the owner removed the widening gate (2026-10-17), the only calls held
 * are the ones nobody can take back: an email, a calendar change, a handle
 * claim. Much of this suite was written while every widening was held, and
 * calls tools through `approving`, which runs the call and, only when it was
 * held, approves it from the person's console and calls again — the path a
 * held call takes in the product. For any call that is not held it is just
 * the call. What is held, and who may answer, is `agentEgress.test.mjs`.
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
  if (!(await releaseNewest(env, consoleToken, origin, call))) return first;
  return await once();
}
