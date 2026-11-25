/**
 * A kept sticker looked at once (node `stickerLook`, `graph/nodes/stickerLook.js`; Dev2, 2026-11-25), asked by the
 * texting Worker's chat object over the `TexTexts` binding when a group chat keeps a sticker it has no words for
 * (`packages/tex/worker/stickerLook.ts`). The body: `{ chat, sticker, mediaType, data }`, the group's ledger key, the
 * sticker's id and its picture (base64, already a type the model reads). The run is logged in the chat's ledger like any
 * node's, its id and the words it gave, never the picture.
 *
 * Answers the node's output, or `{ when: ["skip"], why: "off" }` while no config wires the node (it is on the shelf).
 */
import { gatewayGraph } from "./graph/gatewayGraph.js";
import { STICKER_LOOK_NODE } from "./graph/nodes/stickerLook.js";
import { ledgerFor, ledgerWriter } from "./ledger.js";
import { texConfigOf } from "./texConfig.js";

/** The path the texting Worker posts to on the `TexTexts` binding. */
export const TEXTS_STICKER_PATH = "/texts/sticker-look";

const GROUP_KEY = /^[0-9a-f]{64}$/;
const STICKER_ID = /^s[0-9a-z]{6}$/;
const MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** A picture the model takes (5 MB) in base64, with room for the JSON around it. */
const MAX_BODY_CHARS = 7_000_000;

/** Whether the config runs node `stickerLook`: only then is a sticker looked at. */
export function stickerLookWired(config) {
  return Array.isArray(config?.nodes) && config.nodes.some((node) => node?.id === STICKER_LOOK_NODE && node.on !== false);
}

/** The body's chat, sticker and picture, or null for anything else. */
export function stickerAsk(body) {
  if (typeof body?.chat !== "string" || !GROUP_KEY.test(body.chat)) return null;
  if (typeof body.sticker !== "string" || !STICKER_ID.test(body.sticker)) return null;
  if (!MEDIA.has(body.mediaType) || typeof body.data !== "string" || body.data === "" || !/^[A-Za-z0-9+/=]+$/.test(body.data)) return null;
  return { chat: body.chat, sticker: body.sticker, picture: { mediaType: body.mediaType, data: body.data } };
}

/** Runs node `stickerLook` for one sticker of one chat: its output, or a skip saying why. Never throws. */
export async function lookForChat(env, ask, { graph = null, config = texConfigOf(env) } = {}) {
  if (!stickerLookWired(config)) return { when: ["skip"], why: "off" };
  try {
    const writer = ledgerWriter(ledgerFor(env, { chat: ask.chat }), ask.chat);
    const run = await (graph ?? gatewayGraph({ env, writer, config })).runNode(STICKER_LOOK_NODE, { sticker: ask.sticker }, { env, picture: ask.picture }, "textsSticker");
    await writer?.flush();
    return run.ran ? run.output : { when: ["skip"], why: "off" };
  } catch {
    return { when: ["skip"], why: "failed" };
  }
}

export async function stickerLookForTexts(request, env, { graph = null } = {}) {
  if (request.method !== "POST") return Response.json({ error: "bad_request" }, { status: 400 });
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return Response.json({ error: "too_big" }, { status: 413 });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "bad_body" }, { status: 400 });
  }
  const ask = stickerAsk(body);
  if (ask === null) return Response.json({ error: "bad_body" }, { status: 400 });
  return Response.json(await lookForChat(env, ask, { graph }));
}
