/**
 * Warm the model's cache for a chat (node `warm`, `graph/nodes/warm.js`; Dev2, 2026-11-20), asked by the texting
 * Worker's chat object over the `TexTexts` binding when the person reads Tex's text (`apps/agent/src/warmStep.ts`), and
 * by the app when they open the chat or start typing. The body names the chat's home and why: `{ person, cause }` for a
 * person's 1:1, `{ chat, cause }` for a group chat by its key. Nothing in it is the person's words.
 *
 * Answers the node's output, or `{ when: ["skip"], why: "off" }` while no config wires the node (it is on the shelf).
 */
import { gatewayGraph } from "./graph/gatewayGraph.js";
import { ledgerFor, ledgerWriter, ONE_TO_ONE_CHAT } from "./ledger.js";
import { texConfigOf } from "./texConfig.js";
import { WARM_NODE, warmWired } from "./warmPrefix.js";

/** The path the texting Worker posts to on the `TexTexts` binding. */
export const TEXTS_WARM_PATH = "/texts/warm";

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GROUP_KEY = /^[0-9a-f]{64}$/;
const CAUSES = new Set(["read", "open", "typing"]);

/** The chat's home and its ledger's chat from the body, or null. */
export function warmPlace(body) {
  if (typeof body?.person === "string" && WORKSPACE_ID.test(body.person)) return { owner: { person: body.person }, chat: ONE_TO_ONE_CHAT };
  if (typeof body?.chat === "string" && GROUP_KEY.test(body.chat)) return { owner: { chat: body.chat }, chat: body.chat };
  return null;
}

/** Runs node `warm` for one chat's home, `cause` why: its output, or a skip saying the node is off. Never throws. */
export async function warmChat(env, place, cause, { graph = null, config = texConfigOf(env) } = {}) {
  if (!warmWired(config)) return { when: ["skip"], why: "off" };
  try {
    // Logged in the chat's own ledger like every node's run, so the Lab's Replay shows it as its own run.
    const writer = ledgerWriter(ledgerFor(env, place.owner), place.chat);
    const run = await (graph ?? gatewayGraph({ env, writer, config })).runNode(WARM_NODE, { owner: place.owner, chat: place.chat, cause }, { env }, "textsWarm");
    await writer?.flush();
    return run.ran ? run.output : { when: ["skip"], why: "off" };
  } catch {
    return { when: ["skip"], why: "failed" };
  }
}

export async function warmForTexts(request, env, { graph = null } = {}) {
  if (request.method !== "POST") return Response.json({ error: "bad_request" }, { status: 400 });
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return Response.json({ error: "bad_body" }, { status: 400 });
  }
  const place = warmPlace(body);
  if (place === null || !CAUSES.has(body?.cause)) return Response.json({ error: "bad_body" }, { status: 400 });
  return Response.json(await warmChat(env, place, body.cause, { graph }));
}
