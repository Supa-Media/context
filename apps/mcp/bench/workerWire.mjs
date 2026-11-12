/** How the bench talks to the gateway as the texting Worker does (`apps/agent/src`): a streamed answer read, and the chat's events posted. */

import worker from "../src/index.js";
import { createWorkerCtx } from "../test/workerCtx.mjs";

/** The line the bench's person texts on, as the texting Worker names a chat (`apps/agent/src/events.ts`). */
const BENCH_CHAT = "sendblue:line:+15555550100";

/**
 * Read a streamed `/agent` answer the way the texting Worker does
 * (`apps/agent/src/clients.ts` `askAgentStreaming`): each `{"progress"}` line
 * is a text sent, ticks are skipped, and the last `{status, body}` line is the
 * turn's own answer. A reply that is not a stream (refused before the turn
 * ran) is read as plain JSON; a stream with no final line is a failed turn.
 */
export async function readStream(response) {
  if (!(response.headers.get("content-type") ?? "").includes("application/x-ndjson")) {
    return { response, body: await response.json().catch(() => null), progress: [] };
  }
  const progress = [];
  const text = await response.text();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed?.progress === "string" && parsed.progress.trim()) progress.push(parsed.progress.trim());
    else if (typeof parsed?.status === "number") return { response: { status: parsed.status }, body: parsed.body ?? null, progress };
  }
  return { response: { status: 502 }, body: { error: "stream ended with no answer" }, progress };
}

/**
 * The chat's events as the texting Worker posts them (`/agent/events`): their
 * texts and Tex's. `textedEvent(text)` is one of theirs with a turn of its
 * own; `postEvents(events)` posts them, a turn kept only on Tex's.
 */
export function workerEvents({ env, token, group = null }) {
  let texted = 0;
  // In a group (`world.mjs` `group`), the chat is the group's key and each text names its sender by handle and hash.
  const chat = group?.key ?? BENCH_CHAT;
  const textedEvent = (text, sender = null) => {
    const at = Date.now();
    texted += 1;
    return { id: `${String(at).padStart(13, "0")}-${String(texted).padStart(6, "0")}`, at, chat, from: { kind: "person", ...(sender ? { name: sender.handle, who: sender.who } : {}) }, kind: "text", text: String(text).slice(0, 3_000), turn: `bench-turn-${String(texted).padStart(6, "0")}` };
  };
  const postEvents = async (events) => {
    const { ctx, settle } = createWorkerCtx();
    const posted = await worker.fetch(
      new Request("https://mcp.bench.invalid/agent/events", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ conversation: group ? { group: group.key } : "texts", events: events.map(({ turn, ...event }) => (event.from.kind === "tex" ? { ...event, turn } : event)) }) }),
      env,
      ctx,
    );
    await posted.text();
    await settle();
  };
  return { textedEvent, postEvents };
}
