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
 *   Gemini 2.5 Flash Image (Nano Banana), about 3.9 cents a 1K picture,
 *   through the same Cloudflare AI Gateway every other model call uses, on
 *   Unified Billing, so there is no new vendor or key (`aiGateway.js`). Gemini
 *   3.1 Flash-Lite Image was chosen first (2026-10-19, over Seedream 5.0
 *   Lite, GPT Image 2 low and FLUX.2 klein), but Unified Billing does not
 *   cover it yet: Google answers 403 "unregistered callers", as Image Model
 *   Probe (`scripts/image-model-probe.mjs`) showed in production.
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
 *
 * The photos themselves are kept too: the last text that came with photos
 * keeps up to four of them, beside the picture, and `earlier-photo:N` brings
 * them back. Dev, 2026-10-19: a photo sent with "make our clothes blue" was
 * gone by "try again", one text later, and Tex asked for it again.
 */

import { aiGatewayConfig, metadataHeader } from "./aiGateway.js";
import { IMAGE_TYPES } from "./attachments.js";
import { outgoingPictures } from "./outgoingPictures.js";
import { VISUAL_DEFINITION, VISUAL_TOOL, buildVisual } from "./visuals/index.js";
import { MAP_HEIGHT, STRIP_HEIGHT, drawMap } from "./visuals/map.js";
import { downloadPhoto, downloadPhotos, fillPictures, pictureAddresses, sparesIn } from "./visuals/photos.js";
import { huntPhotos, shooterFor } from "./visuals/hunt.js";
import { storableDownload, withPagePictures } from "./visuals/pagePhotos.js";
import { fillDistances, geocoderFor } from "./visuals/distance.js";
import { PAGE_TEMPLATE, coverPictures, pageCover } from "./visuals/page.js";
import { readTexNote } from "./aboutMe.js";
import { MAX_HELD, cardCheckFor } from "./cardCheck.js";
import { deferred } from "./deferred.js";

export const DRAW_TOOL = "draw_picture";
export const MAKE_TOOL = "make_picture";

/** Google's model id, overridable per deployment by `AGENT_IMAGE_MODEL`. */
export const IMAGE_MODEL = "gemini-2.5-flash-image";
const MODEL_ID = /^gemini-[a-z0-9.-]{1,60}$/;

/** Where the last made picture is kept: a plumbing path in the person's bucket, like the conversation. */
export const KEPT_PICTURE_PATH = ".context/agent/conversations/texts-picture.json";
/** Where the photos of their last text with photos are kept, for the texts after it. */
export const KEPT_PHOTOS_PATH = ".context/agent/conversations/texts-photos.json";

export const MAX_SOURCES = 4;
const MAX_KEPT_SOURCES = 2;
const MAX_PROMPT_CHARS = 4_000;
const MAX_HTML_CHARS = 200_000;
/** A designed card with its photos in it as data: under the screenshot Worker's 15 MB. */
const MAX_CARD_CHARS = 14_000_000;
/** Base64 one image request carries: under the model API's 20 MB inline ceiling. */
const MAX_SOURCE_CHARS = 18_000_000;
const MAX_KEPT_CHARS = 16_000_000;
const MAX_ALLOWED = 40;
const IMAGE_TIMEOUT_MS = 60_000;
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

const REF = /^(?:(attachment|picture|earlier-photo):(\d{1,2})|(last-picture))$/;
/** A reference where a page loads a picture: in quotes or a CSS `url()`. */
const INLINE_REF = /(["'(])\s*(attachment:\d{1,2}|picture:\d{1,2}|earlier-photo:\d{1,2}|last-picture)\s*(["')])/g;
/** Where a card names a photo the gateway downloaded (`./visuals/photos.js`), as built by `kit.js` `photoUrl`. */
const CARD_PHOTO = /card-photo:(\d{1,2})(?=')/g;
const ADDRESS = /https:\/\/[^\s"'()<>\\]+/g;
/** Google Fonts, which the screenshot Worker always loads: never counted as an address that did not. */
const FONT_ADDRESS = /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//;

const DRAW_DEFINITION = {
  name: DRAW_TOOL,
  description:
    "Make a graphic: a poster, flyer, invite, card, menu, chart, quote, meme, infographic or anything mostly text, shapes and layout. " +
    "Write one complete HTML page with inline CSS (and SVG if useful) sized to exactly width x height; it is photographed and handed back as a picture to text them. " +
    'Put pictures in with src="attachment:N" (a photo they sent), "picture:N" (one a tool showed this turn), "earlier-photo:N" (one they sent in an earlier text), "last-picture" (the last one make_picture made), ' +
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
    "Generate or edit a photo-like picture with an image model (about 4 cents each): \"show me in this dress\", a product shot, a scene, changing a photo. " +
    "Pass from: their photos ('attachment:N' with this text, 'earlier-photo:N' from their last text with photos, so \"try again\" needs no resend), " +
    "pictures a tool showed this turn ('picture:N'), and 'last-picture' to keep editing the last one you made, " +
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

/** The photos of their last text with photos, newest text only. A broken file is none. */
async function readPhotos(store) {
  try {
    const object = await store.get(KEPT_PHOTOS_PATH);
    if (!object) return [];
    const parsed = JSON.parse(await object.text());
    return (Array.isArray(parsed?.photos) ? parsed.photos : []).map(asPicture).filter(Boolean).slice(0, MAX_SOURCES);
  } catch {
    return [];
  }
}

/** Keep this text's photos for the texts after it. Not kept costs a later edit a resend, never this answer. */
export async function keepPhotos(store, attachments) {
  const photos = [];
  let size = 0;
  for (const photo of attachments.map(asPicture).filter(Boolean).slice(0, MAX_SOURCES)) {
    if (size + photo.data.length > MAX_KEPT_CHARS) break;
    size += photo.data.length;
    photos.push(photo);
  }
  if (photos.length === 0) return;
  try {
    await store.put(KEPT_PHOTOS_PATH, JSON.stringify({ version: 1, photos }));
  } catch {
    // As above.
  }
}

/**
 * One texted turn's picture tools, or null when the deployment can make
 * neither. `gateway` is `aiGatewayConfig(env)`, without which there is no
 * `make_picture`. `outgoing` is the turn's `outgoingPictures`; `keep` says whether
 * this turn may write the kept picture (a texted turn that keeps its
 * conversation); `meter` reports the image model's tokens.
 */
export function pictureMaker(env, { gateway = null, attachments = [], outgoing, store, keep = false, meter = null, metadata = {}, fetchImpl = fetch, mapGeocode = null, keepCover = null, check = null } = {}) {
  const shots = typeof env?.SITE_SHOTS?.fetch === "function" ? env.SITE_SHOTS : null;
  if (typeof gateway?.base !== "string") gateway = null;
  const model = imageModel(env);
  let web = null; // the turn's search_web, set by `useWeb`
  let kept; // undefined until read
  let earlier; // likewise

  const tools = [...(shots ? [VISUAL_DEFINITION, DRAW_DEFINITION] : []), ...(gateway ? [MAKE_DEFINITION] : [])];
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
    if (m[1] === "earlier-photo") {
      // A text with photos of its own names them as attachment:N; its kept copy is those same photos.
      if (earlier === undefined) earlier = attachments.some((a) => asPicture(a)) ? [] : await readPhotos(store);
      const picture = earlier[n - 1] ?? null;
      return picture ? { pictures: [picture], theirs: true } : null;
    }
    if (m[1] === "attachment") {
      const picture = asPicture(attachments[n - 1]);
      return picture ? { pictures: [picture], theirs: true } : null;
    }
    const picture = asPicture(outgoing?.picture(n));
    return picture ? { pictures: [picture], theirs: false } : null;
  }

  async function draw(args, { card = false } = {}) {
    const html = typeof args?.html === "string" ? args.html : "";
    if (html.trim().length === 0) return say("Write the page as html.", true);
    if (html.length > (card ? MAX_CARD_CHARS : MAX_HTML_CHARS)) return say(`A page is at most ${MAX_HTML_CHARS} characters; put pictures in by reference, not as data.`, true);
    const missing = new Set();
    const inlined = new Map();
    for (const [, , ref] of html.matchAll(INLINE_REF)) {
      if (inlined.has(ref) || missing.has(ref)) continue;
      const found = await resolve(ref);
      if (found === null) missing.add(ref);
      else inlined.set(ref, `data:${found.pictures[0].mediaType};base64,${found.pictures[0].data}`);
    }
    const page = html.replace(INLINE_REF, (whole, open, ref, close) => (inlined.has(ref) ? `${open}${inlined.get(ref)}${close}` : whole));
    const addresses = [...new Set(html.match(ADDRESS) ?? [])].filter((address) => !FONT_ADDRESS.test(address));
    const allow = addresses.filter((address) => outgoing?.vouches(address) === true).slice(0, MAX_ALLOWED);
    const response = await shots.fetch("https://site-shots/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A card may be cut to what it holds (`./visuals/kit.js` `fit`); a page the model wrote keeps the size it asked for.
      body: JSON.stringify({ html: page, width: args.width, height: args.height, allow, ...(card && args.fit === true ? { fit: true } : {}) }),
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

  /** A designed card (`./visuals/index.js`): the page is built here from the model's data, then drawn like any other. */
  async function visual(args, callTool) {
    // A page's cover is drawn from the note, read as this turn may read it (`./visuals/page.js`).
    if (args?.template === PAGE_TEMPLATE) {
      const path = typeof args?.data?.path === "string" ? args.data.path.trim() : "";
      const text = path && typeof callTool === "function" ? await readTexNote(callTool, path) : "";
      // Its photos, each read through the page's own note as this turn may read it, and drawn in as bytes.
      const images = new Map();
      for (const src of coverPictures(text)) {
        const read = await Promise.resolve(callTool("read_image", { note: path, image: src })).catch(() => null);
        const part = read?.isError ? null : read?.content?.find((item) => item.type === "image");
        if (part?.data) images.set(src, `data:${part.mimeType};base64,${part.data}`);
      }
      const cover = pageCover(path, text, args?.theme, images);
      if (cover.error) return say(cover.error, true);
      const drawn = await draw(cover, { card: true });
      // Kept for the page's link card (`/gateway/page-cover`); a page in another context is not this turn's to keep.
      const png = drawn.isError ? null : drawn.content?.find((part) => part.type === "image")?.data;
      if (png && typeof keepCover === "function" && !path.startsWith("@")) await keepCover(path, png).catch(() => false);
      return drawn;
    }
    // Photos and logos the model left out, from the pages this turn read; then every one downloaded here (`./visuals/photos.js`).
    const { data: pictured, filled } = fillPictures(args?.template, args?.data, outgoing?.read?.() ?? "");
    // And how far each place is from where they start, measured here, never guessed (`./visuals/distance.js`).
    const find = mapGeocode ?? geocoderFor(fetchImpl, { key: env?.GOOGLE_MAPS_KEY });
    const { data, note: measured } = await fillDistances(args?.template, pictured, (address) => outgoing?.locates?.(address) === true, fetchImpl, { find });
    const read = pictureAddresses(data).filter((address) => outgoing?.vouches(address) === true);
    const photos = [...(await downloadPhotos(read, fetchImpl, sparesIn(outgoing?.read?.() ?? "")))];
    const got = new Set(photos.map(([address]) => address));
    // Every option still without a picture is searched for, else its page photographed (`./visuals/hunt.js`).
    const hunt = await huntPhotos(args?.template, data, { shown: (address) => got.has(address), web, download: (address) => downloadPhoto(address, fetchImpl), shoot: shooterFor(shots), read: () => outgoing?.read?.() ?? "" });
    photos.push(...hunt.pictures);
    const tokens = new Map(photos.map(([address], i) => [address, `card-photo:${i + 1}`]));
    // The map is drawn from the card's addresses after its photos, its pictures numbered after theirs (`./visuals/map.js`).
    const drawnMap = await drawMap(args?.template, data, { key: env?.GOOGLE_MAPS_KEY, geocode: find, locates: (address) => outgoing?.locates?.(address) === true, fetchImpl, offset: photos.length, height: args?.template === "places" ? STRIP_HEIGHT : MAP_HEIGHT });
    if (drawnMap.refuse) return say(drawnMap.reason, true);
    photos.push(...(drawnMap.pictures ?? []));
    const built = buildVisual({ ...args, data: hunt.data }, { canLoad: (address) => tokens.has(address), photos: tokens, map: drawnMap.map });
    if (built.error) return say(built.error, true);
    const html = built.html.replace(CARD_PHOTO, (whole, n) => photos[Number(n) - 1]?.[1] ?? whole);
    const drawn = await draw({ ...built, html }, { card: true });
    if (drawn.isError) return drawn;
    const notes = [];
    if (filled.length > 0) notes.push(`Photos or logos added from the pages you read for: ${filled.join(", ")}.`);
    if (measured) notes.push(measured);
    if (drawnMap.reason) notes.push(drawnMap.reason);
    if (hunt.searched.length > 0) notes.push(`Photos found by a picture search for: ${hunt.searched.join(", ")}.`);
    if (hunt.screenshots.length > 0) notes.push(`Screenshots of their own pages for: ${hunt.screenshots.join(", ")}.`);
    if (hunt.missing.length > 0) notes.push(`No picture found yet for: ${hunt.missing.join(", ")}. Open each one's own page or a review with photos in your browser, pass a photo you read, and draw again: a comparison shows every thing.`);
    else if (built.dropped) notes.push(`${built.dropped} photo(s) left off the card: only pictures read this turn that download go on it, so open each place's own page (its read lists photos and a logo), or search_web with pictures: true for its name, and draw again.`);
    if (notes.length === 0) return drawn;
    return { ...drawn, content: drawn.content.map((part) => (part.type === "text" ? { ...part, text: `${part.text} ${notes.join(" ")}` } : part)) };
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
      if (found === null) return say(`There is no ${String(ref).slice(0, 40)} to work from. Use attachment:N, earlier-photo:N, picture:N or last-picture.`, true);
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

  /**
   * A page write with its options' missing pictures put in first; the write's own answer, told what was added.
   * Refused with them, it is written again as the writer sent it: a picture found for it never costs the save.
   */
  async function pageWrite(args, callTool) {
    const shoot = shooterFor(shots, { timeoutMs: 10_000 });
    const download = storableDownload((address, headers) => downloadPhoto(address, fetchImpl, { headers }), shoot);
    const { args: pictured, found } = await withPagePictures(args, { web, download, shoot, read: () => outgoing?.read?.() ?? "" });
    const result = await callTool("write_note", pictured);
    if (found.length > 0 && result?.isError === true) return callTool("write_note", args);
    if (found.length === 0 || result?.isError || !Array.isArray(result?.content)) return result;
    return { ...result, content: [...result.content, { type: "text", text: `Pictures found and added to the page for: ${found.join(", ")}.` }] };
  }

  let held = 0;
  /**
   * Every picture is looked at before the turn may send it (`./cardCheck.js`):
   * one the check would not send comes back as its critique, without the
   * picture, so it is redrawn or answered in words. After `MAX_HELD` the
   * critique rides along with the picture instead, so a turn always ends.
   */
  async function looked(name, args, result) {
    const image = Array.isArray(result?.content) ? result.content.find((part) => part?.type === "image") : null;
    if (typeof check !== "function" || result?.isError || !image) return result;
    const verdict = await check({ tool: name, template: typeof args?.template === "string" ? args.template : "", picture: { data: image.data, mediaType: image.mimeType } });
    if (verdict === null || verdict.send) return result;
    if (held < MAX_HELD) {
      held += 1;
      return say(`Not sent: you looked at this picture before sending it and it doesn't pass: ${verdict.critique} Fix that and draw it again, or answer in words without a picture.`, true);
    }
    return { ...result, content: [...result.content, { type: "text", text: `Looked at before sending: ${verdict.critique} If you send it, say what it lacks in a few words.` }] };
  }

  return {
    tools,
    /** The turn's web tools, once open, for hunting a card's missing pictures (`./visuals/hunt.js`). */
    useWeb: (call) => void (web = typeof call === "function" ? call : null),
    // A page's write passes through too, so its options get the pictures a card's do (`./visuals/pagePhotos.js`).
    has: (name) => ((name === DRAW_TOOL || name === VISUAL_TOOL) && shots !== null) || (name === MAKE_TOOL && gateway !== null) || (name === "write_note" && (web !== null || shots !== null)),
    call: async (name, args, callTool) => (name === "write_note" ? pageWrite(args, callTool) : looked(name, args, await (name === DRAW_TOOL ? draw(args) : name === VISUAL_TOOL ? visual(args, callTool) : make(args)))),
  };
}

/**
 * One `/agent` turn's pictures: what its answer may text back
 * (`outgoingPictures`) and, on a text from their phone, the tools that make
 * them. `meter` is the turn's own; the image model's spend is reported as a
 * part of the turn, not a turn of its own.
 */
export async function turnPictures(env, { texted, question, attachments, store, keep, meter, workspaceId, keepCover = null }) {
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
        keepCover,
        // Every picture is looked at before it may go (owner, 2026-10-27: "always look at a card before sending it").
        check: env?.CARD_CHECK === "off" ? null : cardCheckFor({ question, config: aiGatewayConfig(env), metadata: { workspace: String(workspaceId), client: "texts" } }),
      })
    : null;
  // Kept whatever this turn does, so a later "try again" has them: beside the model, not before it
  // (2.4 s of a turn, 2026-10-31). Nothing this turn reads them: `earlier-photo:N` is [] when photos came with it.
  if (maker !== null && keep) await deferred(store, keepPhotos(store, attachments));
  return { outgoing, maker };
}

const DRAWN_REF = /^picture:(\d{1,2})$/;

/**
 * write_note `images[].data: "picture:N"` becomes the bytes of picture N, when
 * this turn drew or made it (`outgoing.made`), so the card Tex texted is the
 * card in the note it writes, without the model repeating a picture's bytes.
 * Any other picture is refused by name: one read out of a note stays there.
 */
export function withDrawnImages(outgoing, callTool) {
  if (typeof outgoing?.made !== "function") return callTool;
  return (name, args) => {
    if (name !== "write_note" || !Array.isArray(args?.images)) return callTool(name, args);
    const refused = [];
    const images = args.images.map((image) => {
      const ref = typeof image?.data === "string" ? DRAWN_REF.exec(image.data.trim()) : null;
      if (!ref) return image;
      const picture = outgoing.made(Number(ref[1]));
      if (picture === null) {
        refused.push(image.data.trim());
        return image;
      }
      return { ...image, data: `data:${picture.mediaType};base64,${picture.data}` };
    });
    if (refused.length > 0) return say(`${refused.join(", ")}: only a picture you drew or made this turn can be kept by its number. Nothing was saved.`, true);
    return callTool(name, { ...args, images });
  };
}

export function withPictureMaker(maker, callTool) {
  if (maker === null) return callTool;
  return (name, args) => (maker.has(name) ? maker.call(name, args, callTool) : callTool(name, args));
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
