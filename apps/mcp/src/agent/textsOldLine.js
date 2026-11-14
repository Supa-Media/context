/**
 * The old-number check for one arriving text (node `oldLine`, `texConfig.json`), asked by the texting Worker's chat
 * object over the `TexTexts` binding before the text is queued (`apps/agent/src/oldLineStep.ts`). The node runs on
 * the gateway's graph, so its input, output and time are logged like every node's; the Worker sends any reply itself.
 * The body holds the chat id, the staff setting and two times, never a text's words.
 */

import { gatewayGraph } from "./graph/gatewayGraph.js";

/** The path the texting Worker posts to on the `TexTexts` binding. */
export const TEXTS_OLD_LINE_PATH = "/texts/old-line";

const MAX_BYTES = 4 * 1024;

/** Runs `oldLine` on the posted input and answers its output: `{ to: "redirect", answer }` or `{ to: "pass" }`. */
export async function oldLineForTexts(request, { graph = gatewayGraph() } = {}) {
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
    const run = await graph.runNode("oldLine", input, {}, "textsOldLine");
    // A node turned off in the config never runs: every text passes on.
    return Response.json(run.ran ? run.output : { to: "pass" });
  } catch (error) {
    // A body the node's inSchema refuses, or a node that failed: the Worker passes the text on to Triage.
    console.log(JSON.stringify({ event: "texts_old_line", outcome: "failed", error: error instanceof Error ? error.name : "unknown" }));
    return Response.json({ error: "node_failed" }, { status: 422 });
  }
}
