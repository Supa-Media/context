/**
 * TEX MAKES PICTURES (owner, 2026-10-19: "I need Tex to have a decently
 * capable and cheap image generation capability").
 *
 * Two tools, because two kinds of picture are asked for:
 *
 * - **`draw_picture`: graphics.** A poster, an invite, a chart, a menu, a quote
 *   card. The model is better at these as a page than any image model is as
 *   pixels (the owner's own read), so it writes one HTML page and the
 *   screenshot Worker photographs it (`infra/site-shots/src/render.ts`).
 * - **`make_picture`: photos.** "Show me how I look in this dress." Google's
 *   Gemini 3.1 Flash-Lite Image (Nano Banana 2 Lite), about 3.4 cents a 1K
 *   picture, through the same Cloudflare AI Gateway every other model call
 *   uses, on Unified Billing, so there is no new vendor or key
 *   (`aiGateway.js`). Chosen 2026-10-19 over Seedream 5.0 Lite (same price, a
 *   new vendor), GPT Image 2 low (0.6 cents, faces drift) and FLUX.2 klein
 *   (1 cent, four references, weaker identity).
 *
 * Both hand their picture back as an image block, inside the turn's
 * `outgoingPictures` dispatcher, so it is numbered and texted like any other.
 *
 * ## What a picture may be made from
 *
 * `attachment:N` (a photo they sent with this text), `picture:N` (one a tool
 * showed this turn: `outgoingPictures` already holds it, privacy checked) and
 * `last-picture` (the last one `make_picture` made them). A drawn page may
 * also name https images, and loads only those the person wrote or a tool
 * result showed this turn: the rule `[picture https://…]` follows, for the
 * same reason. An address the model assembled could carry a note's words to
 * a stranger's server; one copied from what was read was written before the
 * turn began. The screenshot Worker enforces the list on every request the
 * page makes.
 *
 * ## The same person, edit after edit
 *
 * The image model holds nothing between calls. What keeps "now in red" the
 * same person in the same dress is handing it the last picture and the photos
 * that picture was made from, so the last one made is kept with up to two of
 * its source photos in the person's own bucket, beside the conversation
 * (`conversation.js`), and `last-picture` brings them all back. It is kept
 * only when every source was theirs (a photo they sent, or an earlier kept
 * picture): a picture from a note stays in the turn that was allowed to see it.
 */

import { aiGatewayConfig, metadataHeader } from "./aiGateway.js";
import { IMAGE_TYPES } from "./attachments.js";
import { outgoingPictures } from "./outgoingPictures.js";

export const DRAW_TOOL = "draw_picture";
export const MAKE_TOOL = "make_picture";

/** Google's model id, overridable per deployment by `AGENT_IMAGE_MODEL`. */
export const IMAGE_MODEL = "gemini-3.1-flash-lite-image";
const MODEL_ID = /^gemini-[a-z0-9.-]{1,60}$/;

/** Where the last made picture is kept: a plumbing path in the person's bucket, like the conversation. */
export const KEPT_PICTURE_PATH = ".context/agent/conversations/texts-picture.json";

export const MAX_SOURCES = 4;
const MAX_KEPT_SOURCES = 2;
const MAX_PROMPT_CHARS = 4_000;
const MAX_HTML_CHARS = 200_000;
/** Base64 one image request carries: under the model API's 20 MB inline ceiling. */
const MAX_SOURCE_CHARS = 18_000_000;
const MAX_KEPT_CHARS = 16_000_000;
const MAX_ALLOWED = 40;
const IMAGE_TIMEOUT_MS = 60_000;
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

const REF = /^(?:(attachment|picture):(\d{1,2})|(last-picture))$/;
/** A reference where a page loads a picture: in quotes or a CSS `url()`. */
const INLINE_REF = /(["'(])\s*(attachment:\d{1,2}|picture:\d{1,2}|last-picture)\s*(["')])/g;
const ADDRESS = /https:\/\/[^\s"'()<>\\]+/g;

const DRAW_DEFINITION = {
  name: DRAW_TOOL,
  description:
    "Make a graphic: a poster, flyer, invite, card, menu, chart, quote, meme, infographic or anything mostly text, shapes and layout. " +
    "Write one complete HTML page with inline CSS (and SVG if useful) sized to exactly width x height; it is photographed and handed back as a picture to text them. " +
    'Put pictures in with src="attachment:N" (a photo they sent), "picture:N" (one a tool showed this turn), "last-picture" (the last one make_picture made), ' +
    "or an https image address you read in a tool result this turn; no other address loads. Google Fonts load; scripts don't run. " +
    "Photos of people, clothes and real scenes go to make_picture instead.",
  inputSchema: {
    type: "object",
    properties: {
      html: { type: "string", description: "The whole page: <!doctype html>, styles inline, body filling the size." },
      width: { type: "integer", minimum: 200, maximum: 2000, description: "Pixels. 1080 for a square post (the default), 1080x1920 for a story, 1200x630 for a banner." },
      height: { type: "integer", minimum: 200, maximum: 2400, description: "Pixels. Defaults to 1080." },
    },
    required: ["html"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const MAKE_DEFINITION = {
  name: MAKE_TOOL,
  description:
    "Generate or edit a photo-like picture with an image model (about 3 cents each): \"show me in this dress\", a product shot, a scene, changing a photo. " +
    "Pass from: their photos ('attachment:N'), pictures a tool showed this turn ('picture:N'), and 'last-picture' to keep editing the last one you made, " +
    "so the same person and outfit carry over. Say in the prompt which picture is which, describe the whole picture wanted, and what must stay the same.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to make or change, in full sentences." },
      from: { type: "array", items: { type: "string" }, maxItems: MAX_SOURCES, description: "Up to 4 pictures to work from, in order." },
      aspect_ratio: { type: "string", enum: ASPECTS, description: "Defaults to the first picture's shape, or square." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const say = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

function imageModel(env) {
  const configured = env?.AGENT_IMAGE_MODEL;
  return typeof configured === "string" && MODEL_ID.test(configured) ? configured : IMAGE_MODEL;
}

/** A picture as `{ mediaType, data }`, or null when it is not one the model takes. */
function asPicture(value) {
  const mediaType = value?.mediaType;
  return typeof value?.data === "string" && typeof mediaType === "string" && IMAGE_TYPES.has(mediaType) ? { mediaType, data: value.data } : null;
}

/** The kept picture, read once per turn and only when named. A broken file is no picture. */
async function readKept(store) {
  try {
    const object = await store.get(KEPT_PICTURE_PATH);
    if (!object) return null;
    const parsed = JSON.parse(await object.text());
    const made = asPicture(parsed?.made);
    if (made === null) return null;
    const sources = (Array.isArray(parsed.sources) ? parsed.sources : []).map(asPicture).filter(Boolean).slice(0, MAX_KEPT_SOURCES);
    return { made, sources };
  } catch {
    return null;
  }
}

/**
 * One texted turn's picture tools, or null when the deployment can make
 * neither. `gateway` is `aiGatewayConfig(env)`, without which there is no
 * `make_picture`. `outgoing` is the turn's `outgoingPictures`; `keep` says whether
 * this turn may write the kept picture (a texted turn that keeps its
 * conversation); `meter` reports the image model's tokens.
 */
export function pictureMaker(env, { gateway = null, attachments = [], outgoing, store, keep = false, meter = null, metadata = {}, fetchImpl = fetch } = {}) {
  const shots = typeof env?.SITE_SHOTS?.fetch === "function" ? env.SITE_SHOTS : null;
  if (typeof gateway?.base !== "string") gateway = null;
  const model = imageModel(env);
  let kept; // undefined until read

  const tools = [...(shots ? [DRAW_DEFINITION] : []), ...(gateway ? [MAKE_DEFINITION] : [])];
  if (tools.length === 0) return null;

  async function lastPicture() {
    if (kept === undefined) kept = await readKept(store);
    return kept;
  }

  /** One reference, as the pictures it stands for and whether they were the person's own. */
  async function resolve(ref) {
    const m = REF.exec(typeof ref === "string" ? ref.trim() : "");
    if (!m) return null;
    if (m[3]) {
      const last = await lastPicture();
      return last ? { pictures: [last.made, ...last.sources], theirs: true, last } : null;
    }
    const n = Number(m[2]);
    if (m[1] === "attachment") {
      const picture = asPicture(attachments[n - 1]);
      return picture ? { pictures: [picture], theirs: true } : null;
    }
    const picture = asPicture(outgoing?.picture(n));
    return picture ? { pictures: [picture], theirs: false } : null;
  }

  async function draw(args) {
    const html = typeof args?.html === "string" ? args.html : "";
    if (html.trim().length === 0) return say("Write the page as html.", true);
    if (html.length > MAX_HTML_CHARS) return say(`A page is at most ${MAX_HTML_CHARS} characters; put pictures in by reference, not as data.`, true);
    const missing = new Set();
    const inlined = new Map();
    for (const [, , ref] of html.matchAll(INLINE_REF)) {
      if (inlined.has(ref) || missing.has(ref)) continue;
      const found = await resolve(ref);
      if (found === null) missing.add(ref);
      else inlined.set(ref, `data:${found.pictures[0].mediaType};base64,${found.pictures[0].data}`);
    }
    const page = html.replace(INLINE_REF, (whole, open, ref, close) => (inlined.has(ref) ? `${open}${inlined.get(ref)}${close}` : whole));
    const addresses = [...new Set(html.match(ADDRESS) ?? [])];
    const allow = addresses.filter((address) => outgoing?.vouches(address) === true).slice(0, MAX_ALLOWED);
    const response = await shots.fetch("https://site-shots/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: page, width: args.width, height: args.height, allow }),
    });
    const body = await response.json().catch(() => null);
    if (response.status === 400) return say("That size or page could not be drawn: keep width 200-2000 and height 200-2400.", true);
    if (!response.ok || typeof body?.png !== "string") return say("The picture could not be drawn right now. Try again in a minute.", true);
    const notes = [`Drawn at ${body.width}x${body.height}.`];
    if (missing.size > 0) notes.push(`No such picture, left empty: ${[...missing].join(", ")}.`);
    const blocked = addresses.length - allow.length + (Array.isArray(body.blocked) ? body.blocked.length : 0);
    if (blocked > 0) notes.push(`${blocked} address(es) did not load: only images whose address you read this turn do.`);
    return { content: [{ type: "image", data: body.png, mimeType: "image/png" }, { type: "text", text: notes.join(" ") }] };
  }

  async function make(args) {
    const prompt = typeof args?.prompt === "string" ? args.prompt.trim().slice(0, MAX_PROMPT_CHARS) : "";
    if (prompt.length === 0) return say("Say what to make in prompt.", true);
    const refs = Array.isArray(args?.from) ? args.from.slice(0, MAX_SOURCES) : [];
    const sources = [];
    let theirs = true;
    const carried = [];
    for (const ref of refs) {
      const found = await resolve(ref);
      if (found === null) return say(`There is no ${String(ref).slice(0, 40)} to work from. Use attachment:N, picture:N or last-picture.`, true);
      theirs &&= found.theirs;
      sources.push(...found.pictures);
      // What the picture is kept with: the photos behind it, never an earlier result of them.
      if (found.theirs) carried.push(...(found.last ? found.last.sources : found.pictures));
    }
    const sent = sources.slice(0, MAX_SOURCES + MAX_KEPT_SOURCES);
    if (sent.reduce((total, picture) => total + picture.data.length, 0) > MAX_SOURCE_CHARS) {
      return say("Those pictures are too big to send together; use fewer.", true);
    }
    const aspect = ASPECTS.includes(args?.aspect_ratio) ? args.aspect_ratio : null;
    const request = {
      contents: [{ role: "user", parts: [...sent.map((p) => ({ inlineData: { mimeType: p.mediaType, data: p.data } })), { text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}) },
    };
    const answer = await callImageModel(gateway, model, request, { metadata, fetchImpl });
    await meter?.(answer.usage, answer.picture === null, `google/${model}`, false);
    if (answer.picture === null) return say(answer.reason, true);
    if (keep && theirs) await keepPicture(answer.picture, carried);
    return { content: [{ type: "image", data: answer.picture.data, mimeType: answer.picture.mediaType }, { type: "text", text: "Made." }] };
  }

  async function keepPicture(made, sources) {
    const unique = [];
    for (const source of sources) if (!unique.some((p) => p.data === source.data)) unique.push(source);
    let next = { made, sources: unique.slice(0, MAX_KEPT_SOURCES) };
    // Too big with its sources, it is kept alone: the next edit still has the picture.
    if (JSON.stringify(next).length > MAX_KEPT_CHARS) next = { made, sources: [] };
    try {
      await store.put(KEPT_PICTURE_PATH, JSON.stringify({ version: 1, ...next }));
      kept = next;
    } catch {
      // A picture not kept costs the next edit its memory, not this answer.
    }
  }

  return {
    tools,
    has: (name) => (name === DRAW_TOOL && shots !== null) || (name === MAKE_TOOL && gateway !== null),
    call: (name, args) => (name === DRAW_TOOL ? draw(args) : make(args)),
  };
}

/**
 * One `/agent` turn's pictures: what its answer may text back
 * (`outgoingPictures`) and, on a text from their phone, the tools that make
 * them. `meter` is the turn's own; the image model's spend is reported as a
 * part of the turn, not a turn of its own.
 */
export function turnPictures(env, { texted, question, attachments, store, keep, meter, workspaceId }) {
  const outgoing = outgoingPictures({ enabled: texted, question });
  const maker = texted
    ? pictureMaker(env, {
        gateway: aiGatewayConfig(env),
        attachments,
        outgoing,
        store,
        keep,
        meter: (usage, failed, model) => meter(usage, failed, model, false),
        metadata: { workspace: String(workspaceId), client: "texts" },
      })
    : null;
  return { outgoing, maker };
}

export function withPictureMaker(maker, callTool) {
  if (maker === null) return callTool;
  return (name, args) => (maker.has(name) ? maker.call(name, args) : callTool(name, args));
}

/**
 * One call to Google's image model through the AI Gateway, on Unified
 * Billing: the gateway's own token and no Google key. As in `aiGateway.js`,
 * the gateway keeps no log of it, and no error body reaches the model.
 */
export async function callImageModel(gateway, model, request, { metadata = {}, fetchImpl = fetch } = {}) {
  const usage = { input: 0, output: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${gateway.base}/google-ai-studio/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-aig-authorization": `Bearer ${gateway.token}`,
        "cf-aig-collect-log": "false",
        ...metadataHeader({ ...metadata, feature: "image" }),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    clearTimeout(timer);
    return { picture: null, usage, reason: "The image model did not answer in time. Try again." };
  }
  try {
    const body = await response.json().catch(() => null);
    usage.input = Number(body?.usageMetadata?.promptTokenCount) || 0;
    usage.output = Number(body?.usageMetadata?.candidatesTokenCount) || 0;
    if (!response.ok) {
      console.error(JSON.stringify({ event: "agent_image_failed", status: response.status }));
      return { picture: null, usage, reason: "The image model could not make that right now. Try again in a minute." };
    }
    const candidate = body?.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      const inline = part?.inlineData ?? part?.inline_data;
      const picture = asPicture({ mediaType: inline?.mimeType ?? inline?.mime_type, data: inline?.data });
      if (picture) return { picture, usage, reason: "" };
    }
    const refused = body?.promptFeedback?.blockReason || /SAFETY|PROHIBITED|BLOCK/.test(String(candidate?.finishReason ?? ""));
    return {
      picture: null,
      usage,
      reason: refused ? "The image model refused that picture under its safety rules. Say so plainly; don't retry the same ask." : "The image model answered without a picture. Try rewording the prompt.",
    };
  } finally {
    clearTimeout(timer);
  }
}
