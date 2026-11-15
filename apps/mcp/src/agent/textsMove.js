/**
 * The words of one chat's move to Tex's new number (node `moveChat`, `texConfig.json`), asked by the texting Worker's
 * chat object over the `TexTexts` binding when staff move that chat (`apps/agent/src/moveChats.ts`). The node runs on
 * the gateway's graph, so its input, output and time are logged like every node's; the Worker sends the text itself.
 * The body holds the kind of chat, the new number and an archive day, never a chat's words.
 */

import { gatewayGraph } from "./graph/gatewayGraph.js";

/** The path the texting Worker posts to on the `TexTexts` binding. */
export const TEXTS_MOVE_PATH = "/texts/move";

const MAX_BYTES = 2 * 1024;

/** Runs `moveChat` on the posted input and answers its output: `{ to: "person" | "group", text }` or `{ to: "skip" }`. */
export async function moveForTexts(request, { graph = gatewayGraph() } = {}) {
  if (request.method !== "POST") return Response.json({ error: "bad_request" }, { status: 400 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
  let input;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ error: "bad_body" }, { status: 400 });
  }
  try {
    const run = await graph.runNode("moveChat", input, {}, "textsMove");
    // A node turned off in the config never runs: nothing is sent, and the move is reported as skipped.
    return Response.json(run.ran ? run.output : { to: "skip" });
  } catch (error) {
    console.log(JSON.stringify({ event: "texts_move", outcome: "failed", error: error instanceof Error ? error.name : "unknown" }));
    return Response.json({ error: "node_failed" }, { status: 422 });
  }
}
