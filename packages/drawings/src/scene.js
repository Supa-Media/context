/**
 * A drawing, laid out for a renderer that knows nothing about Excalidraw.
 *
 * ## Why the layout is here and not in the component
 *
 * The console renders drawings with `react-native-svg`, which draws the same on
 * iOS, Android and web. What it cannot do is decide *what* to draw: that means
 * knowing that a diamond is four points around a box, that an arrow's points
 * are relative to its own origin, that a shape's label lives in a different
 * element entirely, and that `angle` rotates about the centre rather than the
 * corner. All of that is arithmetic over the parsed scene, so it belongs beside
 * the parser, where it is tested without mounting anything.
 *
 * It also keeps one promise the gateway half depends on: `describeDrawing` and
 * this function read the same parse, so the text an agent is given and the
 * picture a person sees cannot drift into describing different drawings.
 *
 * ## What this deliberately does not reproduce
 *
 * Excalidraw's look comes from `roughjs`, which re-draws every edge as several
 * slightly wrong strokes from a seeded RNG. Reimplementing that is a large
 * amount of code whose output is *supposed* to be imprecise, and it changes
 * upstream. So shapes here are drawn true: same geometry, same colours, same
 * fills, clean edges. A preview that looks slightly too tidy is a fair trade
 * for one that is small enough to keep correct, and the canonical file is
 * untouched either way — anyone who wants the real rendering opens it in
 * Obsidian or on excalidraw.com, which is the point of keeping the file
 * portable.
 *
 * Hachure and cross-hatch fills are drawn as flat fills at reduced opacity,
 * for the same reason and with the same trade.
 *
 * ## Coordinates
 *
 * Element `x`/`y` are scene coordinates; a linear element's `points` are
 * relative to its own `x`/`y`, and its first point is `[0, 0]` by construction
 * but is not assumed to be. `width`/`height` are **signed** — a box dragged up
 * and to the left has negative ones — which is why nothing here computes a far
 * corner by addition alone.
 */

import { boundingBox } from "./excalidraw.js";

/** Excalidraw's font family ids. 5 and 6 are the newer Excalifont/Nunito pair. */
const FONT_FAMILIES = new Map([
  [1, "hand"],
  [2, "sans"],
  [3, "mono"],
  [4, "hand"],
  [5, "hand"],
  [6, "sans"],
  [7, "mono"],
  [8, "sans"],
]);

/** Excalidraw's default when a text element does not say. */
const DEFAULT_LINE_HEIGHT = 1.25;

/** Space left around the scene so strokes at the edge are not clipped. */
export const SCENE_PADDING = 16;

/**
 * Turn parsed elements into a flat list of primitives plus a viewBox.
 *
 * Returns `{ viewBox: { x, y, width, height }, nodes, truncated }`. Nodes are in
 * paint order — Excalidraw's array order is its z-order, and preserving it is
 * what makes a label on top of a filled box stay on top of it.
 */
export function buildScene(elements, { padding = SCENE_PADDING, maxNodes = 4_000 } = {}) {
  const live = (Array.isArray(elements) ? elements : []).filter(
    (element) => element && !element.isDeleted && element.type !== "frame"
  );
  const truncated = live.length > maxNodes;
  const drawable = truncated ? live.slice(0, maxNodes) : live;

  const box = boundingBox(drawable) ?? { x: 0, y: 0, width: 1, height: 1 };
  const nodes = [];
  for (const element of drawable) {
    const node = nodeFor(element);
    if (node) nodes.push(...(Array.isArray(node) ? node : [node]));
  }

  return {
    viewBox: {
      x: box.x - padding,
      y: box.y - padding,
      width: box.width + padding * 2,
      height: box.height + padding * 2,
    },
    nodes,
    truncated,
  };
}

/* -------------------------------- per shape ------------------------------- */

function nodeFor(element) {
  const style = styleOf(element);
  switch (element.type) {
    case "rectangle":
    case "image":
    case "embeddable":
    case "iframe":
      return rectangleNode(element, style);
    case "ellipse":
      return ellipseNode(element, style);
    case "diamond":
      return diamondNode(element, style);
    case "line":
    case "arrow":
      return linearNodes(element, style);
    case "freedraw":
      return freedrawNode(element, style);
    case "text":
      return textNode(element);
    default:
      return null;
  }
}

function rectangleNode(element, style) {
  const { x, y, width, height } = normalizedBox(element);
  return {
    kind: "rect",
    id: element.id,
    x,
    y,
    width,
    height,
    // `roundness` is Excalidraw's "is this a rounded rectangle" flag; the radius
    // it implies is proportional, capped so a small box does not become a pill.
    rx: element.roundness ? Math.min(32, Math.min(width, height) * 0.25) : 0,
    placeholder: element.type !== "rectangle",
    ...style,
    ...rotation(element),
  };
}

function ellipseNode(element, style) {
  const { x, y, width, height } = normalizedBox(element);
  return {
    kind: "ellipse",
    id: element.id,
    cx: x + width / 2,
    cy: y + height / 2,
    rx: width / 2,
    ry: height / 2,
    ...style,
    ...rotation(element),
  };
}

function diamondNode(element, style) {
  const { x, y, width, height } = normalizedBox(element);
  return {
    kind: "polygon",
    id: element.id,
    points: [
      [x + width / 2, y],
      [x + width, y + height / 2],
      [x + width / 2, y + height],
      [x, y + height / 2],
    ],
    ...style,
    ...rotation(element),
  };
}

/**
 * A line or an arrow: the polyline, plus a head at each end that has one.
 *
 * The head is a filled triangle rather than two strokes, because a stroked head
 * needs joins and caps to look right at every width and a filled one does not.
 */
function linearNodes(element, style) {
  const points = absolutePoints(element);
  if (points.length < 2) return null;

  const line = {
    kind: "path",
    id: element.id,
    d: pathThrough(points, Boolean(element.roundness)),
    // A line's `backgroundColor` fills the shape it encloses; an arrow's does
    // not, and filling one turns a bent arrow into a filled wedge.
    fill: element.type === "line" ? style.fill : "none",
    fillOpacity: style.fillOpacity,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    strokeDasharray: style.strokeDasharray,
    opacity: style.opacity,
    ...rotation(element),
  };

  const heads = [];
  if (element.startArrowhead) {
    heads.push(arrowhead(element, points[1], points[0], style, "start"));
  }
  const endArrowhead = element.type === "arrow" ? (element.endArrowhead ?? "arrow") : element.endArrowhead;
  if (endArrowhead) {
    heads.push(arrowhead(element, points[points.length - 2], points[points.length - 1], style, "end"));
  }

  return [line, ...heads.filter(Boolean)];
}

function arrowhead(element, from, tip, style, which) {
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const size = Math.max(8, 4 + style.strokeWidth * 3);
  const ux = dx / length;
  const uy = dy / length;
  const spread = 0.45; // radians off-axis, roughly Excalidraw's look
  const left = [
    tip[0] - size * (ux * Math.cos(spread) - uy * Math.sin(spread)),
    tip[1] - size * (uy * Math.cos(spread) + ux * Math.sin(spread)),
  ];
  const right = [
    tip[0] - size * (ux * Math.cos(spread) + uy * Math.sin(spread)),
    tip[1] - size * (uy * Math.cos(spread) - ux * Math.sin(spread)),
  ];

  return {
    kind: "polygon",
    id: `${element.id}:${which}`,
    points: [tip, left, right],
    fill: style.stroke,
    fillOpacity: 1,
    stroke: style.stroke,
    strokeWidth: 0,
    strokeDasharray: null,
    opacity: style.opacity,
    ...rotation(element),
  };
}

function freedrawNode(element, style) {
  const points = absolutePoints(element);
  if (points.length < 2) return null;
  return {
    kind: "path",
    id: element.id,
    d: pathThrough(points, true),
    fill: "none",
    fillOpacity: 0,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    strokeDasharray: null,
    opacity: style.opacity,
    ...rotation(element),
  };
}

/**
 * A text element, as one node carrying a baseline per line.
 *
 * The caller should not have to know that Excalidraw's `y` is the top of the
 * box while SVG's is a baseline, nor how `textAlign` and `verticalAlign`
 * interact — so both are resolved here and each line arrives with the exact
 * point to draw it at.
 */
function textNode(element) {
  const raw = typeof element.text === "string" ? element.text : "";
  if (!raw) return null;

  const fontSize = Number(element.fontSize) > 0 ? Number(element.fontSize) : 20;
  const lineHeight = Number(element.lineHeight) > 0 ? Number(element.lineHeight) : DEFAULT_LINE_HEIGHT;
  const step = fontSize * lineHeight;
  const { x, y, width, height } = normalizedBox(element);
  const align = element.textAlign === "center" ? "middle" : element.textAlign === "right" ? "end" : "start";
  const anchorX = align === "middle" ? x + width / 2 : align === "end" ? x + width : x;

  const lines = raw.split("\n");
  // `verticalAlign: middle` is what a label inside a shape uses, and without it
  // every container label sits at the top of its box instead of in it.
  const block = lines.length * step;
  const top = element.verticalAlign === "middle" ? y + (height - block) / 2 : y;

  return {
    kind: "text",
    id: element.id,
    anchor: align,
    fontSize,
    fontFamily: FONT_FAMILIES.get(Number(element.fontFamily)) ?? "hand",
    fill: color(element.strokeColor, "#1e1e1e"),
    opacity: opacity(element),
    lines: lines.map((text, index) => ({
      text,
      x: anchorX,
      // 0.8 of the step puts the baseline inside its own line box rather than
      // on its top edge, which is where a naive `y + fontSize` lands it.
      y: top + index * step + step * 0.8,
    })),
    ...rotation(element),
  };
}

/* --------------------------------- shared --------------------------------- */

/** x/y/width/height with the signs taken out. */
function normalizedBox(element) {
  const x = finite(element.x);
  const y = finite(element.y);
  const width = finite(element.width);
  const height = finite(element.height);
  return {
    x: width < 0 ? x + width : x,
    y: height < 0 ? y + height : y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}

function absolutePoints(element) {
  const points = Array.isArray(element.points) ? element.points : [];
  const x = finite(element.x);
  const y = finite(element.y);
  return points
    .filter((point) => Array.isArray(point) && point.length >= 2)
    .map((point) => [x + finite(point[0]), y + finite(point[1])]);
}

/**
 * An SVG path through the points.
 *
 * `smooth` draws a Catmull-Rom-ish curve through the midpoints, which is what
 * makes a freehand stroke and a curved arrow read as drawn rather than as a
 * chain of segments. A straight two-point line takes the same route and comes
 * out straight, so there is no special case for it.
 */
function pathThrough(points, smooth) {
  const round = (value) => Math.round(value * 100) / 100;
  if (!smooth || points.length === 2) {
    return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${round(x)} ${round(y)}`).join(" ");
  }

  let d = `M${round(points[0][0])} ${round(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q${round(cx)} ${round(cy)} ${round((cx + nx) / 2)} ${round((cy + ny) / 2)}`;
  }
  const last = points[points.length - 1];
  d += ` L${round(last[0])} ${round(last[1])}`;
  return d;
}

const DASH = new Map([
  ["dashed", [8, 8]],
  ["dotted", [2, 6]],
]);

function styleOf(element) {
  const strokeWidth = Number(element.strokeWidth) > 0 ? Number(element.strokeWidth) : 1;
  const background = element.backgroundColor;
  const filled = typeof background === "string" && background !== "" && background !== "transparent";
  return {
    stroke: color(element.strokeColor, "#1e1e1e"),
    strokeWidth,
    strokeDasharray: DASH.get(element.strokeStyle) ?? null,
    fill: filled ? background : "none",
    // Hachure and cross-hatch are drawn as flat fills, lightened so a filled
    // shape still reads as filled without claiming to be the real hatching.
    fillOpacity: filled ? (element.fillStyle === "solid" ? 1 : 0.45) : 0,
    opacity: opacity(element),
  };
}

function rotation(element) {
  const angle = Number(element.angle);
  if (!Number.isFinite(angle) || angle === 0) return { rotate: null };
  const { x, y, width, height } = normalizedBox(element);
  return {
    rotate: {
      degrees: (angle * 180) / Math.PI,
      cx: x + width / 2,
      cy: y + height / 2,
    },
  };
}

/** Excalidraw stores opacity as 0-100. */
function opacity(element) {
  const value = Number(element.opacity);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 : 1;
}

function color(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
