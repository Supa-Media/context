/**
 * A group turn's changing tool calls, one at a time across the chat's turns
 * (Dev2, 2026-11-13, one turn per text): the chat's turns run side by side
 * (`apps/agent/src/groupTurnRun.ts`), and a tool that changes something takes
 * the chat's write lock (`texStore/writeLock.js`) for the length of that one
 * call. A read never takes it.
 *
 * The lock only orders changes; it never stops one. A chat store that cannot
 * be reached, or a lock still held after `LOCK_WAIT_MS`, lets the call run as
 * it would have without it, logged. When the lock waited for another turn's
 * change, the tool's result says so, so the model rereads before it changes
 * the same thing.
 */

import { toolDefinitions } from "../tools/registry.js";
import { callTexStore, texStoreStub } from "../texStore/wire.js";

/** How long a change waits for another turn's before it runs anyway. */
export const LOCK_WAIT_MS = 20_000;
export const LOCK_POLL_MS = 250;

/** Whether a tool changes something: a known tool not marked read-only. */
export function changesSomething(name) {
  const tool = toolDefinitions().find((entry) => entry.name === name);
  return tool !== undefined && tool.annotations?.readOnlyHint !== true;
}

/** What the next turn is told about another turn's change it waited for. */
export function waitedLine(before, now) {
  const seconds = Math.max(1, Math.round((now - before.at) / 1000));
  return `Another turn in this chat just ran ${before.tool || "a change"} (${seconds}s ago). If it touched the same thing, read it again before you change it.`;
}

/**
 * `callTool` with each changing call under the chat's write lock. Only a group turn (`group.key`) has one;
 * any other turn's calls are left as they are.
 */
export function withChatWriteLock({ env, group, turn = crypto.randomUUID(), stub = group?.key ? texStoreStub(env, { chat: group.key }) : null, changes = changesSomething, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, callTool) {
  if (stub === null) return callTool;
  const call = async (op, fields) => await (await callTexStore(stub, op, { turn, ...fields })).json();
  return async (name, args) => {
    if (!changes(name)) return await callTool(name, args);
    const started = now();
    let lock = null;
    try {
      for (;;) {
        const taken = await call("write_lock", { tool: name });
        if (taken?.ok === true) {
          lock = taken;
          break;
        }
        if (now() - started >= LOCK_WAIT_MS) {
          log("timed_out", name);
          break;
        }
        await sleep(LOCK_POLL_MS);
      }
    } catch {
      log("unavailable", name);
    }
    if (lock !== null && now() - started >= LOCK_POLL_MS) log("waited", name, now() - started);
    try {
      const result = await callTool(name, args);
      return lock?.before ? withLine(result, waitedLine(lock.before, now())) : result;
    } finally {
      if (lock !== null) await call("write_unlock", {}).catch(() => {});
    }
  };
}

function withLine(result, line) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.content)) return result;
  return { ...result, content: [...result.content, { type: "text", text: line }] };
}

function log(outcome, tool, ms) {
  console.log(JSON.stringify({ event: "chat_write_lock", outcome, tool, ...(ms !== undefined ? { ms } : {}) }));
}
