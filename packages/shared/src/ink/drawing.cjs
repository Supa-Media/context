/**
 * A page's drawing: the picture Tex draws for a page that has none, in its own
 * ink (owner, 2026-11-03: "whenever Tex makes pages, ... generate an image
 * representing the page if there is no image already in the page, it should
 * be in tex style"; then "Tex draws it in ink", and "use the more calm
 * version of tex ... most people won't be generating images involving Tex").
 *
 * The model draws the page's topic as a small SVG scene, on a 1200 x 900
 * canvas, with plain shapes. Nothing it writes reaches the picture as it
 * wrote it: `readScene` reads the markup into shapes and numbers, refusing
 * anything it does not know, and `drawingSvg` writes a new picture from them.
 * So no address, script, style or unknown attribute can ride along into the
 * page the screenshot Worker draws. What makes it Tex's is added here, never
 * left to the model:
 *
 *  - **One ink**: every stroke is Tex blue on the page's own paper (the
 *    page's background, so the drawing sits on the page with no panel),
 *    periwinkle on the dark page, through the app's brush (`#rough`, the
 *    filter `apps/mobile/features/chaos/RoughInk.web.tsx` draws Tex with).
 *  - **One hatch**: a fill is `none`, `ink`, `paper` or `hatch`, and every
 *    hatch is the same lines at the same spacing.
 *  - **The calm Tex**, the # with googly eyes, legs and a wave, from the app's
 *    own geometry (`./texFigure.cjs`), wherever the scene puts a `<tex>`, or
 *    at its foot when it names none.
 *
 * The drawing is a 1200 x 1000 picture: the scene scaled into a safe area that
 * keeps clear of the phone's round buttons and the crop of a cover.
 * Decision: `docs/decisions/app-and-console/page-drawings.md`.
 */

const { figureParts, CX } = require("./texFigure.cjs");

/** The canvas the model draws on. */
const SCENE_WIDTH = 1200;
const SCENE_HEIGHT = 900;
/** The picture it becomes. */
const DRAWING_WIDTH = 1200;
const DRAWING_HEIGHT = 1000;
/** Where the scene sits in the picture: scaled, with margins every crop keeps. */
const SAFE = { x: 120, y: 150, scale: 0.8 };

/** Most a scene may be, before it is read. */
const MAX_SCENE_CHARS = 30_000;
const MAX_SHAPES = 400;
const MAX_DEPTH = 6;
const MAX_TEXT_CHARS = 40;
const MAX_POINTS = 400;
const MAX_PATH_CHARS = 6_000;

/** The page's paper and Tex's ink, light and dark (`../pages/css.cjs`, `texColors`). */
const INKS = {
  light: { paper: "#FFFDF9", ink: "#2A45CF", eye: "#FBF7EE", grain: "0 0 0 0 0.35  0 0 0 0 0.28  0 0 0 0 0.18  0 0 0 0.035 0" },
  dark: { paper: "#191715", ink: "#8A9BF2", eye: "#F4F0E8", grain: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.02 0" },
};

/** Calm: the # with its eyes. Its limbs are drawn in a drawing, where the app's calm Tex has let them fade. */
const CALM = 6;
/** Tex's height in the scene, when it does not say. */
const TEX_SIZE = 240;
/** Where Tex stands when the scene names no `<tex>`: at its foot, on the right. */
const TEX_DEFAULT = { x: 1060, y: 860, size: TEX_SIZE, flip: true };

/** The elements a scene may use, and the attributes each reads. */
const COMMON = ["transform", "fill", "stroke", "stroke-width", "opacity", "stroke-dasharray"];
const SHAPES = {
  g: [],
  path: ["d"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  rect: ["x", "y", "width", "height", "rx"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  text: ["x", "y", "font-size", "text-anchor", "font-weight"],
  tex: ["x", "y", "size", "flip"],
};
const NUMBER_ATTRS = new Set(["x", "y", "x1", "y1", "x2", "y2", "width", "height", "rx", "ry", "cx", "cy", "r", "size", "stroke-width", "opacity", "font-size"]);
const FILLS = new Set(["none", "ink", "paper", "hatch"]);

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?$/i;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
const TRANSFORM = /^\s*(?:(?:translate|rotate|scale)\(\s*-?[\d.]+(?:[\s,]+-?[\d.]+){0,2}\s*\)\s*)+$/;
const TAG = /<\s*(\/?)\s*([A-Za-z][\w-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)\s*>/y;
const ATTR = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const fail = (error) => ({ shapes: null, tex: null, error });
const num = (value) => (NUMBER.test(value) ? Number(value) : NaN);
const fmt = (n) => String(Math.round(n * 100) / 100);
const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (text) => String(text).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** One attribute's value as the drawing may use it, or `undefined` to drop it, or an Error for one that cannot be read. */
function readAttr(tag, name, raw) {
  const value = unesc(raw).trim();
  if (NUMBER_ATTRS.has(name)) {
    const n = num(value.replace(/px$/i, ""));
    if (!Number.isFinite(n) || Math.abs(n) > 5000) return new Error(`<${tag} ${name}="${value.slice(0, 20)}">: a number, please`);
    if (name === "stroke-width") return Math.min(40, Math.max(0.5, n));
    if (name === "opacity") return Math.min(1, Math.max(0, n));
    if (name === "font-size") return Math.min(140, Math.max(10, n));
    if (name === "size") return Math.min(600, Math.max(80, n));
    return n;
  }
  switch (name) {
    case "d":
      if (value.length > MAX_PATH_CHARS || !PATH_DATA.test(value)) return new Error(`<path d>: only path commands and numbers, at most ${MAX_PATH_CHARS} characters`);
      return value.replace(/\s+/g, " ");
    case "points": {
      const list = value.split(/[\s,]+/).filter(Boolean).map(num);
      if (list.length < 4 || list.length % 2 === 1 || list.length > MAX_POINTS * 2 || list.some((n) => !Number.isFinite(n) || Math.abs(n) > 5000)) return new Error(`<${tag} points>: pairs of numbers`);
      return list;
    }
    case "transform":
      if (!TRANSFORM.test(value)) return new Error(`<${tag} transform>: translate, rotate or scale only`);
      return value.replace(/\s+/g, " ").trim();
    case "fill":
      // A colour the model names is ink: the drawing has one colour.
      return FILLS.has(value) ? value : value === "" ? undefined : /^(?:#|rgb|hsl|[a-z]+$)/i.test(value) ? "ink" : undefined;
    case "stroke":
      return value === "none" ? "none" : "ink";
    case "stroke-dasharray": {
      const list = value.split(/[\s,]+/).filter(Boolean).map(num);
      if (list.length === 0 || list.length > 6 || list.some((n) => !Number.isFinite(n) || n < 0 || n > 200)) return undefined;
      return list;
    }
    case "text-anchor":
      return ["start", "middle", "end"].includes(value) ? value : undefined;
    case "font-weight":
      return ["400", "500", "600", "700", "bold", "normal"].includes(value) ? (value === "bold" ? "700" : value === "normal" ? "400" : value) : undefined;
    case "flip":
      return value === "true" || value === "1" || value === "yes";
    default:
      return undefined;
  }
}

/**
 * The model's scene, read into shapes, or `{ error }` naming what to fix.
 * An outer `<svg>` is let through and ignored; comments are dropped; every
 * other element must be one of `SHAPES`, and only the attributes each reads
 * survive. Text only inside `<text>`, at most `MAX_TEXT_CHARS`.
 */
function readScene(markup) {
  if (typeof markup !== "string" || markup.trim() === "") return fail("Draw the scene as SVG shapes on a 1200 x 900 canvas.");
  if (markup.length > MAX_SCENE_CHARS) return fail(`A scene is at most ${MAX_SCENE_CHARS} characters: draw fewer, simpler shapes.`);
  const source = markup.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[\s\S]*?\?>/g, "");
  const root = { tag: "g", attrs: {}, children: [] };
  const stack = [root];
  let tex = null;
  let count = 0;
  let at = 0;
  while (at < source.length) {
    const lt = source.indexOf("<", at);
    const textEnd = lt === -1 ? source.length : lt;
    const between = source.slice(at, textEnd);
    if (between.trim() !== "") {
      const top = stack[stack.length - 1];
      if (top.tag !== "text") return fail(`Words go inside <text>: "${between.trim().slice(0, 30)}"`);
      top.text = (top.text ?? "") + unesc(between).replace(/\s+/g, " ");
      if (top.text.trim().length > MAX_TEXT_CHARS) return fail(`A <text> is at most ${MAX_TEXT_CHARS} characters: a word or a number, not a sentence.`);
    }
    if (lt === -1) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(source);
    if (!m) return fail(`Could not read the scene near: ${source.slice(lt, lt + 40)}`);
    at = TAG.lastIndex;
    const [, closing, rawTag, rawAttrs, selfClosing] = m;
    const tag = rawTag.toLowerCase();
    if (tag === "svg") continue;
    if (!Object.hasOwn(SHAPES, tag)) return fail(`<${rawTag}> is not drawn: use ${Object.keys(SHAPES).join(", ")}.`);
    if (closing) {
      const top = stack[stack.length - 1];
      if (top.tag !== tag || stack.length === 1) return fail(`</${rawTag}> closes nothing open.`);
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const [, name, double, single] of rawAttrs.matchAll(ATTR)) {
      const key = name.toLowerCase();
      if (![...COMMON, ...SHAPES[tag]].includes(key)) continue;
      const value = readAttr(tag, key, double ?? single ?? "");
      if (value instanceof Error) return fail(value.message);
      if (value !== undefined) attrs[key] = value;
    }
    if (tag === "tex") {
      if (tex !== null) return fail("One <tex> per scene.");
      tex = { x: attrs.x ?? TEX_DEFAULT.x, y: attrs.y ?? TEX_DEFAULT.y, size: attrs.size ?? TEX_SIZE, flip: attrs.flip === true, transform: stack.length > 1 ? stack.slice(1).map((node) => node.attrs.transform).filter(Boolean).join(" ") : "" };
      if (!selfClosing) stack.push({ tag: "tex", attrs: {}, children: [], skip: true });
      continue;
    }
    count += 1;
    if (count > MAX_SHAPES) return fail(`A scene is at most ${MAX_SHAPES} shapes: draw fewer, bigger ones.`);
    const node = { tag, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent.skip || parent.tag === "text") return fail(`<${rawTag}> cannot go inside <${parent.tag}>.`);
    parent.children.push(node);
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) return fail(`Groups nest at most ${MAX_DEPTH} deep.`);
      stack.push(node);
    }
  }
  if (stack.length > 1) return fail(`<${stack[stack.length - 1].tag}> is never closed.`);
  if (count === 0) return fail("The scene has no shapes: draw what the page is about.");
  return { shapes: root.children, tex, error: null };
}

/** One shape, written again from what was read. */
function shapeSvg(node, colors) {
  const a = node.attrs;
  const parts = [];
  const put = (name, value) => value !== undefined && parts.push(`${name}="${value}"`);
  for (const name of SHAPES[node.tag]) {
    const value = a[name];
    if (value === undefined || name === "flip") continue;
    if (name === "points") put("points", value.map(fmt).join(" "));
    else if (typeof value === "number") put(name, fmt(value));
    else put(name, esc(value));
  }
  if (a.transform) put("transform", esc(a.transform));
  if (a["stroke-width"] !== undefined) put("stroke-width", fmt(a["stroke-width"]));
  if (a.opacity !== undefined) put("opacity", fmt(a.opacity));
  if (a["stroke-dasharray"]) put("stroke-dasharray", a["stroke-dasharray"].map(fmt).join(" "));
  if (node.tag === "text") {
    // Words are ink, set in the page's own face, never stroked.
    put("fill", colors.ink);
    put("stroke", "none");
    put("font-family", "Instrument Sans, sans-serif");
    if (a["font-size"] === undefined) put("font-size", "44");
    return `<text ${parts.join(" ")}>${esc((node.text ?? "").trim())}</text>`;
  }
  if (a.fill !== undefined) put("fill", a.fill === "ink" ? colors.ink : a.fill === "paper" ? colors.paper : a.fill === "hatch" ? "url(#ink-hatch)" : "none");
  if (a.stroke === "none") put("stroke", "none");
  if (node.tag === "g") return `<g ${parts.join(" ")}>${node.children.map((child) => shapeSvg(child, colors)).join("")}</g>`;
  return `<${node.tag} ${parts.join(" ")}/>`;
}

/** The calm Tex, feet at (x, y), `size` tall, from the app's own geometry. */
function texSvg({ x, y, size, flip, transform }, colors) {
  // The board's figure stands 640 tall; its feet are at CY + 285.
  const s = size / 640;
  const parts = figureParts(CALM, { small: false, minStroke: 11 / s });
  const strands = parts.strands
    .map((st) => `<path d="${st.d}" stroke-width="${fmt(st.width)}"/><path d="${st.dry}" stroke-width="${fmt(st.width * 0.45)}" opacity=".7"/>`)
    .join("");
  const limbs = parts.limbs.map((limb) => `<path d="${limb.d}" stroke-width="${fmt(limb.width)}"/>`).join("");
  const g = parts.googly;
  // The eyes are drawn unmirrored about the figure's centre, so a flipped Tex still looks the same way.
  const eyes =
    `<g transform="translate(${g.x} ${g.y}) scale(${fmt(g.scale)})">` +
    g.whites.map((w) => `<ellipse cx="${w.cx}" cy="${w.cy}" rx="${w.rx}" ry="${w.ry}" fill="${colors.eye}" stroke-width="${fmt(g.outline)}"/>`).join("") +
    g.pupils.map((p) => `<circle cx="${fmt(p.cx)}" cy="${fmt(p.cy)}" r="${p.r}" fill="${colors.ink}" stroke="none"/>`).join("") +
    `</g>`;
  const body = `<g transform="translate(${fmt(x)} ${fmt(y)}) scale(${fmt(flip ? -s : s)} ${fmt(s)}) translate(-${CX} -665)">${strands}${limbs}</g>`;
  const face = `<g transform="translate(${fmt(x)} ${fmt(y)}) scale(${fmt(s)}) translate(-${CX} -665)">${eyes}</g>`;
  const outer = transform ? ` transform="${esc(transform)}"` : "";
  return `<g${outer} data-tex="calm">${body}${face}</g>`;
}

/** Ink speckles on the paper, seeded from the scene so the same scene is the same picture. */
function speckles(seedText, colors) {
  let s = 0;
  for (let i = 0; i < seedText.length; i++) s = (s * 31 + seedText.charCodeAt(i)) % 2147483647;
  s = s || 99;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  let out = "";
  for (let i = 0; i < 30; i++) {
    out += `<circle cx="${Math.round(rnd() * DRAWING_WIDTH)}" cy="${Math.round(rnd() * DRAWING_HEIGHT)}" r="${fmt(1 + rnd() * 2.4)}" fill="${colors.ink}" opacity="${fmt(0.1 + rnd() * 0.22)}"/>`;
  }
  return out;
}

/**
 * The drawing as one SVG document, `dark` for the dark page. `scene` is
 * `readScene`'s answer; every value in it was read as a number, a keyword or
 * escaped text, so nothing here is the model's markup.
 */
function drawingSvg(scene, { dark = false, seed = "" } = {}) {
  const colors = dark ? INKS.dark : INKS.light;
  const tex = texSvg(scene.tex ?? TEX_DEFAULT, colors);
  const shapes = scene.shapes.map((node) => shapeSvg(node, colors)).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DRAWING_WIDTH} ${DRAWING_HEIGHT}" width="${DRAWING_WIDTH}" height="${DRAWING_HEIGHT}">` +
    `<defs>` +
    // The app's brush (`RoughInk.web.tsx`): the edge moved by low noise, then pitted where the brush ran dry.
    `<filter id="ink-rough" x="-5%" y="-5%" width="110%" height="110%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="4" result="n"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="7" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="9" result="grain"/>` +
    `<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.5 1.95" result="holes"/>` +
    `<feComposite in="d" in2="holes" operator="in"/>` +
    `</filter>` +
    `<filter id="ink-paper"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" seed="2"/><feColorMatrix type="matrix" values="${colors.grain}"/></filter>` +
    `<pattern id="ink-hatch" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(-41)"><line x1="0" y1="0" x2="0" y2="22" stroke="${colors.ink}" stroke-width="6"/></pattern>` +
    `</defs>` +
    `<rect width="${DRAWING_WIDTH}" height="${DRAWING_HEIGHT}" fill="${colors.paper}"/>` +
    `<rect width="${DRAWING_WIDTH}" height="${DRAWING_HEIGHT}" filter="url(#ink-paper)"/>` +
    speckles(seed, colors) +
    `<g transform="translate(${SAFE.x} ${SAFE.y}) scale(${SAFE.scale})">` +
    `<g filter="url(#ink-rough)" stroke="${colors.ink}" fill="none" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">${shapes}${tex}</g>` +
    `</g></svg>`
  );
}

/** The page the screenshot Worker photographs: the drawing, and the page's face for its words. */
function drawingHtml(scene, options = {}) {
  const colors = options.dark ? INKS.dark : INKS.light;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&amp;display=block">` +
    `<style>html,body{margin:0;padding:0;background:${colors.paper}}svg{display:block}</style></head>` +
    `<body>${drawingSvg(scene, options)}</body></html>`
  );
}

module.exports = { readScene, drawingSvg, drawingHtml, SCENE_WIDTH, SCENE_HEIGHT, DRAWING_WIDTH, DRAWING_HEIGHT, MAX_SCENE_CHARS };
